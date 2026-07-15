/**
 * shared/workflow-actions/stockrfq.js
 *
 * Workflow module for Stock RFQ loading. Consumed by
 * shared/email-workflow-poller.js when invoked with --workflow stockrfq.
 *
 * Inbox: stockRFQ@orangetsunami.com
 * Doc:   Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md
 *
 * The agent reads each unseen email, decides whether it carries part demand,
 * extracts MPN+qty (+optional MFR/CPC/target price), resolves the customer
 * via shared/partner-lookup.js (partnerType='customer', IsEmployee filter on
 * by default), and calls one of the routing actions below.
 *
 * Replaces the static stock-rfq-runner daemon. The daemon's two-agent extract+
 * verify pattern is now in-session: the agent IS the extractor, and re-reads
 * source on ambiguity.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeRFQ } = require('../rfq-writer');
const breadcrumbs = require('../breadcrumbs');
const writerAttribution = require('../writer-attribution');
const { createGate } = require('../large-payload-gate');
const { makeApprovalActions } = require('./_approval');
const pending = require('../workflow-pending-state');
const { probeOT } = require('../ot-health');
const { notifyOtUnreachable } = require('../failure-rate-gate');
const otBudget = require('../ot-api-budget');
const { resolveOutreachRecipients, recipientsFooter, externalSenderLabel } = require('../outreach-recipients');

// Park a resume sidecar for an RFQ that couldn't be written because OT was
// unreachable. The vq-loading-resumer (extended) replays `ot_unreachable_retry`
// sidecars once OT recovers: stockrfq ones re-run writeRFQ — fresh when
// existing_rfq_id is null (header never wrote → nothing orphaned), or backfill
// against existing_rfq_id when OT died mid-write (header wrote, lines/mpns
// didn't). The full payload is preserved verbatim so the replay is exact.
function parkStockRfqResumeSidecar(ctx, payload, pendingInfo = {}) {
  try {
    pending.writeSidecar('stockrfq', `stockrfq-otdown-${(ctx && ctx.uid) || 'na'}`, {
      kind: 'ot_unreachable_retry',
      source_workflow: 'stockrfq',
      original_uid: (ctx && ctx.uid) || null,
      source_message_id: payload.messageId || (ctx && ctx.currentMessageId) || null,
      existing_rfq_id: pendingInfo.rfqId || null,
      existing_search_key: pendingInfo.searchKey || null,
      payload,                       // full payload — resumer re-runs writeRFQ (fresh or backfill)
      customer_name: payload.customerName || null,
      sender_email: payload.senderEmail ? payload.senderEmail.toLowerCase() : null,
      line_count: (payload.lines || []).length,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    breadcrumbs.write({ cog: 'stockrfq-agent', event: 'ot-resume-sidecar-failed', uid: ctx && ctx.uid, error: e.message });
  }
}

const UNQUALIFIED_BROKER_ID = 1006505;       // c_bpartner_id
const UNQUALIFIED_BROKER_KEY = '1008499';    // search_key (for human-readable references)
const JAKE_USER_ID = 1000004;

// ─── LARGE STOCK-RFQ GATE ────────────────────────────────────────────────────
// Gates writeRFQ itself for broker RFQs above threshold. Unlike excess (where
// writeOffer is small and only the downstream analysis is gated), writeRFQ
// scales linearly with line count — a 10k-line broker RFQ would post ~20k+
// OT rows in a single agent invocation, running for many minutes and
// potentially polluting OT if the RFQ turns out to be a junk scrape.
//
// Default threshold 1000 lines (broker stock RFQs are typically <500; the
// rare 5k+ scrapes are the ones we want to preview). Override with
// LARGE_STOCK_RFQ_THRESHOLD env var.

const STOCK_RFQ_GATE_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-stockrfq-pending'
);

const stockRfqGate = createGate({
  kind: 'stockrfq',
  sentinelDir: STOCK_RFQ_GATE_DIR,
  defaultThreshold: 1000,
  envOverride: 'LARGE_STOCK_RFQ_THRESHOLD',
});

// Stable, short, in-subject-friendly identifier derived from the source
// Message-ID. UID-based ids reuse across IMAP cycles; messageId is globally
// unique. Fallback: SHA1 of the lines list (stable across re-runs of the
// same RFQ even without Message-ID).
function deriveStockRfqGateId(payload) {
  const m = payload && payload.messageId;
  if (m) {
    return 'm-' + crypto.createHash('sha1').update(String(m)).digest('hex').slice(0, 10);
  }
  const lineHash = crypto.createHash('sha1')
    .update(JSON.stringify((payload.lines || []).map(l => l.mpn).sort()))
    .digest('hex').slice(0, 10);
  return 'h-' + lineHash;
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Load an extracted RFQ to OT.
 *
 * Required payload:
 *   bpartnerId   (integer; use 1006505 for Unqualified Broker fallback)
 *   type         ('Stock' is the default for this inbox; broker-blast / shortage / PPV all map to Stock)
 *   lines[]      [{ mpn, mfrText?, mfrId?, qty, targetPrice?, dateCode?, cpc? }, ...]
 *
 * Optional:
 *   description    (override; otherwise built as `<customerName> — Stock RFQ`)
 *   salesrepId     (default: 1000004 — Jake)
 *   userId         (default: 1000004 — Jake; serves as contact fallback when sender's ad_user is unknown)
 *   sourceUid      (for breadcrumb traceability)
 *   messageId      (the source email's RFC822 Message-ID. The agent should pass
 *                   it (from `read`'s `message_id` field) so the outbound CQ
 *                   agent can later match `In-Reply-To` headers back to this
 *                   RFQ via the breadcrumb log without a full IMAP scan.)
 *   customerName   (the agent should ALWAYS pass this — for matched BPs use the
 *                   resolver's `result.name`; for the Unqualified Broker fallback
 *                   use the parsed customer name from the email. The handler uses
 *                   it for the header description, the BPName field, and for
 *                   prepending to per-line descriptions on the Unqualified path.)
 *   priceCheck     (bool; set by the agent when shared/price-check-heuristic.js
 *                   classifies the RFQ as a likely price-fishing pattern — APAC
 *                   broker + exact stock match + non-dry broker market. When true,
 *                   the handler prepends `[PRICE CHECK?]` to both header and line
 *                   descriptions so the trader sees the flag in OT.)
 *   priceCheckReason  (string; the heuristic's reason — written into breadcrumb only.)
 *   senderEmail    (the deepest-quoted broker From: address, e.g.,
 *                   "iris@liyijing.com.cn". The agent ALREADY parses this for the
 *                   customer-resolver step — passing it through lets the outbound
 *                   CQ agent disambiguate same-MPN/qty candidates from different
 *                   brokers without re-reading the source UID in IMAP. Stored on
 *                   the breadcrumb only.)
 *   senderDomain   (the email-domain portion of senderEmail, e.g., "liyijing.com.cn".
 *                   Pre-extracted convenience for the CQ-side breadcrumb grep.)
 *   brokerMessageId  (the broker's ORIGINAL Message-ID — the deepest non-Astute,
 *                   non-Outlook-server MID in the inbound message's References /
 *                   Message-ID chain. Used by the CQ agent's path-(a) thread-match
 *                   to look up "did we already load an RFQ for this exact broker
 *                   email?" — the existing `messageId` field stores the Outlook-
 *                   server-generated MID assigned at auto-forward time, which the
 *                   outbound reply's References chain does NOT contain.)
 */
async function action_load_rfq(payload, ctx) {
  const { lines } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: {
        bpartnerId: payload.bpartnerId, type: payload.type,
        lineCount: lines.length, description: payload.description,
      },
    };
  }

  // ── Message-ID idempotency guard ─────────────────────────────────────────
  // If this exact email's Message-ID has already produced a successful
  // `loaded` breadcrumb under this cog, don't re-write. Defends against
  // manual folder-move replays, accidental re-polls, and the IMAP-UID
  // reassign trap (UIDs change on folder move; messageId doesn't).
  //
  // chuboe_rfq has no row-level natural key that distinguishes "same email
  // replayed" from "customer asked again next week" — same bpartner can
  // legitimately repeat MPN sets. So the dedup belongs at the handler layer
  // keyed on the source email, not at the writer layer keyed on row content.
  // See shared/breadcrumbs.js hasMessageIdAlreadyLoaded() header.
  //
  // Prefer ctx.currentMessageId (parsed by the poller from the email source,
  // deterministic) over payload.messageId (agent-supplied, can drop under
  // pressure — see [[feedback_agent_xor_payload_pattern]]).
  const dedupMessageId = ctx.currentMessageId || payload.messageId;
  if (dedupMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(dedupMessageId, {
      cog: 'stockrfq-agent',
      events: ['loaded'],
    });
    if (dupCheck.loaded) {
      breadcrumbs.write({
        cog: 'stockrfq-agent',
        event: 'already-loaded-skip',
        uid: ctx.uid,
        messageId: dedupMessageId,
        prior_uid: dupCheck.breadcrumb.uid,
        prior_rfq_id: dupCheck.breadcrumb.rfqId,
        prior_search_key: dupCheck.breadcrumb.searchKey,
        prior_ts: dupCheck.breadcrumb.ts,
      });
      return {
        already_processed: true,
        messageId: dedupMessageId,
        prior: {
          rfqId: dupCheck.breadcrumb.rfqId,
          searchKey: dupCheck.breadcrumb.searchKey,
          ts: dupCheck.breadcrumb.ts,
          uid: dupCheck.breadcrumb.uid,
        },
      };
    }
  }

  // ── Large stock-RFQ gate ────────────────────────────────────────────────
  // writeRFQ scales linearly with line count — a 10k-line broker RFQ would
  // post ~20k+ OT rows in a single agent invocation, running for many
  // minutes and potentially polluting OT if the RFQ turns out to be a junk
  // scrape. Gate above threshold pending operator approval; once approved,
  // the approve_large_stock_rfq factory action's onApprove callback reads
  // the sentinel and calls doWriteRFQ.
  const gateId = deriveStockRfqGateId(payload);

  if (stockRfqGate.isRejected(gateId)) {
    breadcrumbs.write({
      cog: 'stockrfq-agent', event: 'gate-rejected',
      uid: ctx.uid, gateId, lineCount: lines.length,
    });
    return { gated: 'rejected', gateId };
  }
  if (stockRfqGate.isPending(gateId)) {
    breadcrumbs.write({
      cog: 'stockrfq-agent', event: 'gate-pending',
      uid: ctx.uid, gateId, lineCount: lines.length,
    });
    return { gated: 'pending', gateId };
  }
  if (stockRfqGate.isCleared(gateId) && !stockRfqGate.isProcessed(gateId)) {
    // Rare: original + approval reply landed in the same tick before
    // .processed could be written. Run the write inline.
    const result = await doWriteRFQ(payload, ctx);
    stockRfqGate.markProcessed(gateId);
    return { ...result, gated: 'cleared-written', gateId };
  }
  if (lines.length > stockRfqGate.threshold() && !stockRfqGate.hasSentinel(gateId)) {
    stockRfqGate.writeSentinel(gateId, {
      gateId,
      payload,             // full payload preserved verbatim for onApprove
      ctx_uid: ctx.uid,
      lineCount: lines.length,
      customer: payload.customerName || null,
      messageId: payload.messageId || null,
    });
    breadcrumbs.write({
      cog: 'stockrfq-agent', event: 'gate-queued',
      uid: ctx.uid, gateId,
      lineCount: lines.length, threshold: stockRfqGate.threshold(),
      customer: payload.customerName || null,
    });
    try {
      const subject = `[APPROVAL NEEDED] Large Stock RFQ ${gateId} — ${lines.length.toLocaleString('en-US')} lines (${payload.customerName || 'unknown broker'})`;
      const html = renderStockRfqApprovalEmailHtml(gateId, payload, stockRfqGate.threshold());
      await sendStockRfqApprovalEmail({ subject, html });
    } catch (e) {
      console.error(`[stockrfq.load_rfq] approval-email send failed for gateId ${gateId}: ${e.message}`);
    }
    return { gated: 'queued-for-approval', gateId, lineCount: lines.length };
  }

  // Under threshold — write directly.
  return doWriteRFQ(payload, ctx);
}

/**
 * Core writeRFQ flow shared between the direct path (under threshold) and
 * the approval path (gate cleared via onApproveStockRfq). Performs line
 * normalization, description tagging, breadcrumbs. Idempotent given the
 * same payload.
 */
async function doWriteRFQ(payload, ctx) {
  const {
    bpartnerId, type, lines, description, salesrepId, userId,
    sourceUid, messageId, customerName, priceCheck, priceCheckReason,
    senderEmail, senderDomain, brokerMessageId,
  } = payload;

  // If Unqualified Broker, prepend customer name to each line's description
  // (matches static daemon behavior; keeps the broker name discoverable in OT).
  // Matched-BP RFQs skip the line-level prepend — the BP FK already identifies
  // the customer and prepending bloats every line description.
  let normalizedLines = lines;
  if (bpartnerId === UNQUALIFIED_BROKER_ID && customerName) {
    normalizedLines = lines.map(l => ({
      ...l,
      description: l.description
        ? `${customerName} - ${l.description}`
        : customerName,
    }));
  }

  // Header description: prefer explicit `description` in payload; otherwise build
  // from customerName. Buyers see this in OT — uniform agent-stamp strings hide
  // who the email came from, especially on the Unqualified Broker fallback path.
  let headerDescription = description
    || (customerName ? `${customerName} — Stock RFQ` : 'Stock RFQ');

  // Price-check tag: APAC broker + exact stock match + non-dry market.
  // Stamps both header AND per-line descriptions so the trader sees it in OT.
  if (priceCheck === true) {
    headerDescription = `[PRICE CHECK?] ${headerDescription}`;
    normalizedLines = normalizedLines.map(l => ({
      ...l,
      description: l.description ? `[PRICE CHECK?] ${l.description}` : '[PRICE CHECK?]',
    }));
  }

  // Derive senderDomain from senderEmail if the agent didn't pre-extract.
  const derivedDomain = senderDomain
    || (senderEmail && senderEmail.includes('@')
        ? senderEmail.split('@')[1].toLowerCase()
        : null);

  // ── OT-health pre-flight ─────────────────────────────────────────────────
  // If OT is unreachable, do NOT attempt the write — that's what orphans a
  // header+line when the line_mpn POST then times out (RFQ 1135619). Park a
  // resume sidecar with the full payload and breadcrumb a NON-'loaded' event
  // so the Message-ID dedup guard never traps the recovery (see deferred-work
  // "writeRFQ failure during OT outage … false `loaded` breadcrumb"). Probe
  // failure itself is non-fatal — fall through and let the writer try.
  try {
    const health = await probeOT();
    if (!health.up) {
      parkStockRfqResumeSidecar(ctx, payload, { rfqId: null, searchKey: null });
      breadcrumbs.write({
        cog: 'stockrfq-agent', event: 'load-deferred-ot-down',
        uid: ctx.uid, sourceUid: sourceUid || ctx.uid, messageId: messageId || null,
        bpartnerId, customerName: customerName || null,
        lineCount: normalizedLines.length, reason: health.reason,
      });
      await notifyOtUnreachable({
        workflow: 'Stock RFQ', ctx,
        affected: { targets: [], senders: [senderEmail].filter(Boolean),
          totalDeferred: normalizedLines.length, subject: payload.subject || null },
      });
      return { rfqId: null, searchKey: null, linesWritten: 0,
        errors: [`OT unreachable at pre-flight (${health.reason}) — deferred for resume`], deferred: true };
    }
  } catch (_) { /* probe error shouldn't block the write attempt */ }

  // ── TIER 1: Global budget check ──
  // Stock RFQ has lowest priority (P1) — throttled first when budget is tight.
  // EXCEPTION: Sidecar replays (skipBudgetCheck=true) bypass budget — they're
  // recovery operations for writes that were already authorized. Blocking them
  // just makes sidecars pile up forever.
  const estimatedWrites = normalizedLines.length * 3;

  if (!payload.skipBudgetCheck) {
    const globalCheck = otBudget.checkBudget({
      table: 'chuboe_rfq',
      count: estimatedWrites,
      caller: 'stockrfq-agent',
      isBackfill: false,  // Stock RFQ doesn't use backfill coordination
    });

    if (!globalCheck.allowed) {
      // REPEAT-DEFERRAL CHECK: If we already have a breadcrumb for this UID from a
      // prior tick, don't notify again — the agent should exit silently.
      const priorDeferral = breadcrumbs.findByUid(ctx.uid, {
        cog: 'stockrfq-agent',
        events: ['load-deferred-budget'],
        sinceMs: Date.now() - 24 * 60 * 60 * 1000,
      });
      const alreadyDeferred = priorDeferral.found;

      if (!alreadyDeferred) {
        breadcrumbs.write({
          cog: 'stockrfq-agent',
          event: 'load-deferred-budget',
          uid: ctx.uid,
          sourceUid: sourceUid || ctx.uid,
          messageId: messageId || null,
          bpartnerId,
          customerName: customerName || null,
          lineCount: normalizedLines.length,
          reason: globalCheck.reason,
        });
      }

      return {
        rfqId: null,
        searchKey: null,
        linesWritten: 0,
        errors: [`Global budget exhausted: ${globalCheck.reason} — processing deferred`],
        rateLimited: true,
        alreadyDeferred,
        rateLimitReason: globalCheck.reason,
        rateLimitTier: 'global',
      };
    }
  }

  // Reserve budget before write
  otBudget.reserve('chuboe_rfq', estimatedWrites, 'stockrfq-agent');
  const writeStartTime = Date.now();

  const result = await writeRFQ({
    bpartnerId,
    type: type || 'Stock',
    description: headerDescription,
    bpName: customerName || undefined,
    salesrepId: salesrepId || JAKE_USER_ID,
    userId: userId || JAKE_USER_ID,
    lines: normalizedLines,
    // Backfill on resume: when the resumer replays an RFQ that was partially
    // written during an OT outage, it passes the existing rfqId so writeRFQ
    // skips the header and writes only the missing lines/line_mpns.
    existingRfqId: payload.existingRfqId || undefined,
    existingSearchKey: payload.existingSearchKey || undefined,
    // Sidecar replays bypass budget checks — recovery shouldn't compete
    skipBudgetCheck: payload.skipBudgetCheck || false,
  });

  // Classify the outcome. otDown = OT died mid-write (header may have written,
  // lines/mpns may not). writeFailed = any failure (otDown or logical). Only a
  // clean write earns the 'loaded' event — a false 'loaded' on failure makes
  // the dedup guard block recovery on re-poll.
  const otDown = !!result.otUnreachable;
  const writeFailed = otDown || result.rfqId == null || (result.errors && result.errors.length > 0);

  // ── Record writes to global budget ──
  const writeDuration = Date.now() - writeStartTime;
  const actualWritten = (result.linesWritten || 0) * 2;  // lines + line_mpns (header not counted)
  if (actualWritten > 0) {
    otBudget.recordWrites('chuboe_rfq', actualWritten, {
      caller: 'stockrfq-agent',
      success: !writeFailed,
      durationMs: writeDuration,
    });
  }

  if (result.errors && result.errors.length > 0) {
    for (let i = 0; i < result.errors.length; i++) {
      otBudget.recordFailure();
    }
  }

  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: otDown ? 'load-failed-ot-down' : (writeFailed ? 'load-failed' : 'loaded'),
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    messageId: messageId || null,
    brokerMessageId: brokerMessageId || null,
    senderEmail: senderEmail ? senderEmail.toLowerCase() : null,
    senderDomain: derivedDomain,
    bpartnerId,
    customerName: customerName || null,
    type: type || 'Stock',
    rfqId: result.rfqId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
    priceCheck: priceCheck === true,
    priceCheckReason: priceCheck === true ? (priceCheckReason || null) : undefined,
  });

  // Per-row failure attribution. rfq-writer returns errors[] as bare strings
  // (count-style); persistWriterDetails handles both shapes. Persisted to disk
  // so an error string isn't lost the moment the handler returns.
  writerAttribution.persistWriterDetails({
    workflow: 'stockrfq',
    ctx,
    result,
  });

  // OT died mid-write: park a resume sidecar so the resumer backfills the
  // missing lines/mpns against the (partial) existing rfqId, and send the calm
  // notification. result.pending carries {rfqId, searchKey} (rfqId null if even
  // the header didn't write → resumer re-runs fresh).
  if (otDown) {
    parkStockRfqResumeSidecar(ctx, payload, result.pending || { rfqId: result.rfqId, searchKey: result.searchKey });
    await notifyOtUnreachable({
      workflow: 'Stock RFQ', ctx,
      affected: { targets: result.searchKey ? [result.searchKey] : [],
        senders: [senderEmail].filter(Boolean),
        totalDeferred: normalizedLines.length, subject: payload.subject || null },
    });
  }

  return {
    rfqId: result.rfqId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
    deferred: otDown,
  };
}

/**
 * Email an operator diagnostic for manual triage. Used when:
 *   - Lines couldn't be extracted (no parseable MPN/qty pairs, signature-only body)
 *   - writeRFQ threw / had errors
 *   - Sender + parts data exist but agent isn't confident enough to load
 *
 * Required payload: { reason, subject, outerFrom }
 * Optional: { details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, outerFrom, details, investigation_summary } = payload;

  // Resolve internal recipients (operator + internal forwarders)
  const envelope = resolveOutreachRecipients(payload, ctx);

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Stock RFQ — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(externalSenderLabel(envelope, outerFrom))}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${investigationBlock}
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
${recipientsFooter(envelope)}
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify: { to: envelope.to, reason } };
  }

  // Email threading headers — escalation lands in same thread as original
  // Fallback to anchorMessageId when currentMessageId is null (fetch failed)
  const opts = { html: true };
  const threadId = ctx.currentMessageId || ctx.anchorMessageId;
  if (threadId) {
    opts.inReplyTo = threadId;
    const refs = Array.isArray(ctx.currentReferences) ? [...ctx.currentReferences] : [];
    if (!refs.includes(threadId)) refs.push(threadId);
    if (refs.length > 0) opts.references = refs;
  }

  await ctx.notifier.sendEmail(
    envelope.to,
    `Stock RFQ — needs review: ${subject || '(no subject)'}`,
    html,
    opts,
  );

  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'needs-review',
    uid: ctx.uid,
    subject,
    outerFrom,
    reason,
    investigation_summary: investigation_summary || null,
    recipients: envelope.recipientList,
    external_sender_not_emailed: envelope.externalSender || null,
  });

  return {
    notified: envelope.to,
    recipients: envelope.recipientList,
    external_sender_not_emailed: envelope.externalSender || null,
  };
}

/**
 * Silent move — message has no part demand (orders, shipping notifications,
 * follow-ups, OOO, marketing/news, automation noise).
 *
 * Required payload: { reason } — short string for the breadcrumb
 */
async function action_not_rfq(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'not-rfq',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Cross-resend duplicate detected. Same broker just sent the same RFQ (matching
 * bpartnerId + type + line_count + first/last MPN within 6h). Move to Processed
 * (terminal) but skip writeRFQ — the existing chuboe_rfq covers this demand.
 *
 * Mirrors excess's action_dup_skip. The agent does the SQL check before
 * routing; this handler just breadcrumbs the decision so the digest can show
 * how often resends fire.
 *
 * Required payload: { existingSearchKey } — the prior RFQ's search key
 */
async function action_dup_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, existingSearchKey: payload.existingSearchKey };
  }
  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'dup-skipped',
    uid: ctx.uid,
    existingSearchKey: payload.existingSearchKey,
  });
  return { existingSearchKey: payload.existingSearchKey };
}

/**
 * Move outbound-reply messages (operator quoted back / asked follow-up
 * questions) to `OutboundPending` for the future add_cq agent to consume.
 *
 * These are NOT new RFQs — the originating broker RFQ is already in OT (or
 * will be loaded separately via the inbound path). Routing them away from
 * load_rfq prevents phantom-RFQ duplication.
 *
 * Required payload: { reason } — short string for the breadcrumb
 *   (typically the inner From: address + a hint, e.g.,
 *    "edgar.santana@astutegroup.com — operator reply on PIC18F14K22T-I/SS thread")
 */
async function action_outbound_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'outbound reply' };
  }
  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'outbound-pending',
    uid: ctx.uid,
    reason: payload.reason || 'outbound reply',
  });
  return { reason: payload.reason || 'outbound reply' };
}

// ─── LARGE STOCK-RFQ APPROVAL EMAIL ─────────────────────────────────────────

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

function renderStockRfqApprovalEmailHtml(gateId, payload, thresholdN) {
  const lineCount = (payload.lines || []).length;
  const customer = payload.customerName || '(unknown broker)';
  const sample = (payload.lines || []).slice(0, 10).map(l =>
    `<tr><td style="padding:3px 14px 3px 0">${esc(l.mpn || '')}</td>` +
    `<td style="padding:3px 14px 3px 0">${esc(l.mfrText || '—')}</td>` +
    `<td style="text-align:right">${fmt(l.qty)}</td></tr>`
  ).join('') || '<tr><td colspan="3" style="color:#888">—</td></tr>';

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;max-width:780px">
<h2 style="color:#b58900;margin-bottom:6px">[APPROVAL NEEDED] Large Stock RFQ ${esc(gateId)}</h2>
<p style="margin-top:0;color:#666;font-size:12px">From the stockrfq-agent load gate — line count exceeds threshold (${fmt(thresholdN)})</p>

<p>A stock RFQ from <b>${esc(customer)}</b> arrived with <b>${fmt(lineCount)} lines</b>. Loading it would post roughly <b>${fmt(lineCount * 2)} rows</b> to OT (1 header + ${fmt(lineCount)} rfq_line + ${fmt(lineCount)} rfq_line_mpn) over the next several minutes.</p>

<p style="background:#fff3cd;padding:10px 14px;border-left:4px solid #b58900;margin:14px 0">
<b>The RFQ is NOT yet in OT.</b> The agent paused before writeRFQ because the line count is above the auto-load threshold. Approve to write; reject to discard the RFQ entirely.
</p>

<h3 style="margin-bottom:6px">RFQ Context</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr><td style="color:#666;padding:3px 14px 3px 0">Gate ID</td><td><code>${esc(gateId)}</code></td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Broker / Customer</td><td>${esc(customer)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">RFQ type</td><td>${esc(payload.type || 'Stock')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Line count</td><td>${fmt(lineCount)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Source UID</td><td>${esc(payload.sourceUid || '—')}</td></tr>
</table>

<h3 style="margin-bottom:6px;margin-top:18px">Sample Lines (first 10)</h3>
<table style="border-collapse:collapse;font-size:12px">
  <tr>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MPN</th>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MFR text</th>
    <th style="text-align:right;border-bottom:1px solid #ccc">Qty</th>
  </tr>
  ${sample}
</table>

<h3 style="margin-top:24px">How to respond</h3>
<p><b>Reply by email</b> — the stockrfq-agent reads replies on the next tick (every 30m):</p>
<ul style="font-family:'Courier New',monospace;font-size:12px;background:#f5f5f5;padding:10px 24px;border-radius:4px">
  <li><b>YES</b> — write the RFQ to OT (all ${fmt(lineCount)} lines)</li>
  <li><b>NO</b> — reject; the RFQ is discarded permanently</li>
</ul>

<p style="color:#888;font-size:11px;margin-top:18px">
Gate threshold: ${fmt(thresholdN)} lines. Override per-run with <code>LARGE_STOCK_RFQ_THRESHOLD=N</code>. Sentinel: <code>~/workspace/.large-stockrfq-pending/${esc(gateId)}.json</code>
</p>
</body></html>`;
}

async function sendStockRfqApprovalEmail({ subject, html, to }) {
  const { sendWithFallback } = require('../verified-send');
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    console.warn('[stockrfq.gate] WORKMAIL_PASS not set — skipping approval email');
    return { delivered: 'none', bounceDetected: false };
  }
  // From stockRFQ@ so operator replies land back in the stockrfq inbox where
  // the agent will pick them up and route to approve_large_stock_rfq /
  // reject_large_stock_rfq.
  return sendWithFallback({
    primary:  { from: process.env.LARGE_STOCKRFQ_GATE_FROM || 'stockRFQ@orangetsunami.com', pass, displayName: 'Stock RFQ Loader' },
    fallback: { from: process.env.LARGE_STOCKRFQ_GATE_FALLBACK || 'rfqloading@orangetsunami.com', pass, displayName: 'Stock RFQ Loader' },
    mail: { to: to || 'jake.harris@Astutegroup.com', subject, html },
    log: () => {},
  });
}

// ─── APPROVAL ACTIONS (via factory) ──────────────────────────────────────────

/**
 * Domain-specific work on approval: read the sentinel for the stored RFQ
 * payload, write it to OT via doWriteRFQ. Idempotent via gate.markProcessed
 * (the factory's action_approve handler marks the gate cleared, then this
 * hook fires; we mark processed after the write succeeds).
 *
 * Missing sentinel (race / stale reply) → returns {written:false,
 * reason:'no-sentinel'} without throwing. The cleared file is still on disk
 * for audit.
 */
async function onApproveStockRfq(id /*, ctx, approvalOpts */) {
  if (stockRfqGate.isProcessed(id)) {
    return { written: false, reason: 'already-processed' };
  }
  const sentinelPath = stockRfqGate.sentinelPath(id);
  if (!fs.existsSync(sentinelPath)) {
    return { written: false, reason: 'no-sentinel' };
  }
  let sentinel;
  try {
    sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8'));
  } catch (e) {
    return { written: false, reason: `sentinel-read-failed: ${e.message}` };
  }
  if (!sentinel.payload) {
    return { written: false, reason: 'sentinel-missing-payload' };
  }
  // Synthesize a minimal ctx so doWriteRFQ can breadcrumb (the real ctx from
  // the approve action has different uid; preserve the original UID from the
  // sentinel for audit chain).
  const writeCtx = { uid: sentinel.ctx_uid || null, dryRun: false };
  try {
    const result = await doWriteRFQ(sentinel.payload, writeCtx);
    stockRfqGate.markProcessed(id);
    return { written: true, rfqId: result.rfqId, searchKey: result.searchKey, linesWritten: result.linesWritten };
  } catch (e) {
    breadcrumbs.write({
      cog: 'stockrfq-agent', event: 'approve-write-failed',
      gateId: id, error: e.message,
    });
    return { written: false, reason: `write-failed: ${e.message}` };
  }
}

const { action_approve: action_approve_large_stock_rfq, action_reject: action_reject_large_stock_rfq } =
  makeApprovalActions(stockRfqGate, {
    workflow: 'stockrfq',
    payloadKey: 'gate_id',
    recordLabel: 'Large Stock RFQ',
    downstreamLabel: 'stockrfq-agent',
    downstreamLeadTime: 'on this tick',
    supportsCacheOnly: false,
    onApprove: onApproveStockRfq,
  });

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'stockRFQ@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Stock RFQ Loader',
  },
  actions: {
    load_rfq: {
      folder: 'Processed',
      requires: ['bpartnerId', 'lines'],
      handler: action_load_rfq,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_rfq: {
      folder: 'NotRFQ',
      requires: ['reason'],
      handler: action_not_rfq,
    },
    outbound_pending: {
      folder: 'OutboundPending',
      requires: ['reason'],
      handler: action_outbound_pending,
    },
    dup_skip: {
      folder: 'Processed',
      requires: ['existingSearchKey'],
      handler: action_dup_skip,
    },
    approve_large_stock_rfq: {
      folder: 'LargeStockRFQApprovals',
      requires: ['gate_id'],
      handler: action_approve_large_stock_rfq,
    },
    reject_large_stock_rfq: {
      folder: 'LargeStockRFQApprovals',
      requires: ['gate_id'],
      handler: action_reject_large_stock_rfq,
    },
  },
  // Constants exposed so the agent / .md can reference them
  constants: {
    UNQUALIFIED_BROKER_ID,
    UNQUALIFIED_BROKER_KEY,
    JAKE_USER_ID,
  },
  // Exposed for the resumer: replays a parked OT-down RFQ. Pass the stored
  // payload (optionally with existingRfqId/existingSearchKey for a mid-write
  // backfill) + a synthetic ctx. Re-probes OT and re-parks if still down.
  doWriteRFQ,
};
