/**
 * shared/workflow-actions/excess.js
 *
 * Workflow module for customer-excess offer loading. Consumed by
 * shared/email-workflow-poller.js when invoked with --workflow excess.
 *
 * Inbox: excess@orangetsunami.com
 * Doc:   Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md
 *
 * The agent reads each unseen email, applies the seller-forwarding contract
 * (subject hint > body hint > deepest non-Astute From-line), extracts lines
 * from xlsx/csv/pdf/html attachments + body, runs cross-forward dedup checks,
 * resolves the BP via shared/partner-lookup.js, and calls one of the routing
 * actions below.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { writeOffer } = require('../offer-writeback');
const writerAttribution = require('../writer-attribution');
const offerRouter = require('../offer-router');
const breadcrumbs = require('../breadcrumbs');
const pending = require('../workflow-pending-state');
const { createGate } = require('../large-payload-gate');
const { makeApprovalActions } = require('./_approval');

// ─── LARGE-OFFER GATE ────────────────────────────────────────────────────────
// Pauses the customer-excess-analysis dispatch for unusually large offers so
// the operator can preview before the analysis cog runs CQ/RFQ matching on
// every line. Default threshold 500 lines; override with LARGE_OFFER_THRESHOLD.
// Broker / franchise data-capture routes are NOT gated — they only write a
// breadcrumb and have no per-line cost worth gating.

const OFFER_GATE_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-offer-pending'
);

const offerGate = createGate({
  kind: 'offer',
  sentinelDir: OFFER_GATE_DIR,
  defaultThreshold: 500,
  envOverride: 'LARGE_OFFER_THRESHOLD',
});

// Type IDs whose route is 'customer-excess-analysis' (= the expensive path).
// Mirrored from offer-router.TYPE_ID_TO_ROUTE so we can decide whether to gate
// BEFORE invoking the router.
const ANALYSIS_TYPE_IDS = new Set([1000000, 1000003]);

function shouldGateRoute(offerType) {
  const typeId = offerRouter.resolveTypeId(offerType);
  return typeId != null && ANALYSIS_TYPE_IDS.has(typeId);
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Load an extracted offer to OT.
 *
 * Required payload:
 *   bpartnerId, offerType, lines[]
 *
 * Optional:
 *   description (auto-generated from BP name + date if omitted)
 *   sourceUid (for breadcrumb traceability)
 */
async function action_load_offer(payload, ctx) {
  const { bpartnerId, offerType, lines, description, sourceUid, partnerName } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, offerType, lineCount: lines.length, description },
    };
  }

  // ── Message-ID idempotency guard ─────────────────────────────────────────
  // chuboe_offer has no row-level natural key — same customer can legitimately
  // send overlapping excess offers next week. Dedup belongs at the handler
  // layer, keyed on the source email's Message-ID. See [[feedback_parallel_writer_audit]]
  // and shared/breadcrumbs.js hasMessageIdAlreadyLoaded().
  //
  // Uses ctx.currentMessageId (poller-parsed, deterministic). The agent does
  // NOT need to pass messageId in the payload — the poller surfaces it on
  // every handler invocation via the ctx object.
  const dedupMessageId = ctx.currentMessageId;
  if (dedupMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(dedupMessageId, {
      cog: 'offer-poller',
      events: ['loaded'],
    });
    if (dupCheck.loaded) {
      breadcrumbs.write({
        cog: 'offer-poller',
        event: 'already-loaded-skip',
        uid: ctx.uid,
        messageId: dedupMessageId,
        prior_uid: dupCheck.breadcrumb.uid,
        prior_offer_id: dupCheck.breadcrumb.offerId,
        prior_search_key: dupCheck.breadcrumb.searchKey,
        prior_ts: dupCheck.breadcrumb.ts,
      });
      return {
        already_processed: true,
        messageId: dedupMessageId,
        prior: {
          offerId: dupCheck.breadcrumb.offerId,
          searchKey: dupCheck.breadcrumb.searchKey,
          ts: dupCheck.breadcrumb.ts,
          uid: dupCheck.breadcrumb.uid,
        },
      };
    }
  }

  const result = await writeOffer({
    bpartnerId,
    offerTypeId: offerType,
    description: description || `${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-bp${bpartnerId}-excessAgent`,
    writeMpnRecords: true,
    lines,
  });

  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    // messageId persisted so the next tick's hasMessageIdAlreadyLoaded() can
    // detect replays. Was missing pre-2026-05-22.
    messageId: ctx.currentMessageId || null,
    bpartnerId,
    offerType,
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
  });

  // Per-row error attribution. offer-writeback returns errors[] as bare strings;
  // persistWriterDetails handles both bucket-style and count-style.
  writerAttribution.persistWriterDetails({
    workflow: 'excess',
    ctx,
    result,
  });

  // ── Large-offer gate around offer-router.dispatch ────────────────────────
  // For analysis-routed offers above threshold, defer dispatch pending
  // operator approval. Offer is ALREADY in OT — gating only the analysis
  // cog, not the data write. Broker/franchise data-capture types skip the
  // gate (the route is just a breadcrumb).
  //
  // Sentinel state machine (shared/large-payload-gate.js):
  //   rejected      → skip dispatch permanently
  //   pending       → already queued for approval; skip dispatch this tick
  //   cleared       → operator approved; dispatch + markProcessed
  //   no sentinel + over-threshold + gate-eligible route → queue for approval
  //   no sentinel + under-threshold or non-gated route   → dispatch normally
  //
  // Why writeOffer always runs: the legacy static offer-poller chained
  // writeOffer → router inline. The new agentic loader writes the offer and
  // stops if downstream is gated, leaving the analysis pipeline addressable
  // by operator approval. Dispatch failures are breadcrumbed by the router
  // itself (`event: 'downstream-failed'`); errors don't fail the load action.
  const gateId = result.searchKey;
  const gateEligible = shouldGateRoute(offerType);
  const overThreshold = result.linesWritten > offerGate.threshold();
  let gateStatus = 'not-gated';

  if (gateEligible && offerGate.isRejected(gateId)) {
    gateStatus = 'rejected';
    breadcrumbs.write({
      cog: 'offer-poller', event: 'gate-rejected', uid: ctx.uid,
      offerId: result.offerId, searchKey: gateId,
    });
  } else if (gateEligible && offerGate.isPending(gateId)) {
    gateStatus = 'pending';
    breadcrumbs.write({
      cog: 'offer-poller', event: 'gate-pending', uid: ctx.uid,
      offerId: result.offerId, searchKey: gateId,
    });
  } else if (gateEligible && offerGate.isCleared(gateId) && !offerGate.isProcessed(gateId)) {
    gateStatus = 'cleared-dispatch';
    try {
      await offerRouter.dispatch({
        offerId: result.offerId,
        searchKey: result.searchKey,
        offerType,
        partner: { id: bpartnerId, name: partnerName },
        lineCount: result.linesWritten,
        source: 'excess-agent-cleared',
      });
      offerGate.markProcessed(gateId);
    } catch (e) {
      console.error(`[excess.load_offer] dispatch (cleared) failed for offer ${result.offerId}: ${e.message}`);
    }
  } else if (gateEligible && overThreshold && !offerGate.hasSentinel(gateId)) {
    gateStatus = 'queued-for-approval';
    const sentinel = offerGate.writeSentinel(gateId, {
      // Resume payload for offerRouter.dispatch (read on approval):
      offerId: result.offerId,
      searchKey: result.searchKey,
      offerType,
      bpartnerId,
      partnerName: partnerName || null,
      lineCount: result.linesWritten,
      // Operator-context fields (read by renderOfferApprovalEmailHtml):
      customer: partnerName || null,
      line_mpns: result.linesWritten,
      route: 'customer-excess-analysis',
    });
    breadcrumbs.write({
      cog: 'offer-poller', event: 'gate-queued', uid: ctx.uid,
      offerId: result.offerId, searchKey: gateId,
      lineCount: result.linesWritten, threshold: offerGate.threshold(),
    });
    try {
      const subject = `[APPROVAL NEEDED] Large Offer ${gateId} — ${result.linesWritten.toLocaleString('en-US')} lines (${partnerName || 'unknown partner'})`;
      const html = renderOfferApprovalEmailHtml(sentinel, offerGate.threshold());
      await sendOfferApprovalEmail({ subject, html });
    } catch (e) {
      console.error(`[excess.load_offer] approval-email send failed for offer ${result.offerId}: ${e.message}`);
    }
  } else {
    // Under threshold or non-gated route — dispatch normally.
    try {
      await offerRouter.dispatch({
        offerId: result.offerId,
        searchKey: result.searchKey,
        offerType,
        partner: { id: bpartnerId, name: partnerName },
        lineCount: result.linesWritten,
        source: 'excess-agent',
      });
    } catch (e) {
      console.error(`[excess.load_offer] offer-router.dispatch failed for offer ${result.offerId}: ${e.message}`);
    }
  }

  return {
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
    gateStatus,
  };
}

/**
 * Partner couldn't be resolved. Email operator with PARTNER reply prompt;
 * the reply-parser cog (or operator manual move) brings the message back
 * into INBOX with a partner override.
 *
 * Required payload: { subject, outerFrom, hints }
 *   hints: free-text describing what was tried (e.g., "subject had no
 *          search-key pattern; body From: chain led to internal Astute employee")
 */
async function action_needs_partner(payload, ctx) {
  const { subject, outerFrom, hints, investigation_summary } = payload;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Customer Excess — partner unresolved</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}</p>
<p><b>What was tried:</b><br/>${esc(hints || '(no hints provided)')}</p>
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply with:</b><br/>
   <code>PARTNER: ${ctx.uid} = &lt;BP search key 6-8 digits OR company name&gt;</code>
</p>
<p style="color:#666;font-size:11px">Message moved to NeedsPartner folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { subject, outerFrom } };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Customer Excess — NeedsPartner: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );

  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'escalated-needs_partner',
    uid: ctx.uid,
    subject,
    outerFrom,
    investigation_summary: investigation_summary || null,
  });

  return { notified: ctx.jakeEmail };
}

/**
 * Email the OPERATOR (Jake) asking them to identify the unknown partner so
 * the offer can be loaded. The pending-state sidecar persists the partial
 * extraction (lines + offerType + everything else parsed); when Jake replies
 * to excess@ with the company name, the next-tick agent merges his reply
 * with the sidecar and routes to load_offer.
 *
 * POLICY (2026-05-14): info-requests NEVER go to the external sender,
 * regardless of how identifiable they look. The original-sender variant was
 * removed after a fishing-aware broker confirmation leak. The `recipient`
 * field on the payload is IGNORED and retained only for backward
 * compatibility with the agent prompt.
 *
 * Use this when:
 *   - Lines were successfully extracted from the offer
 *   - Sender domain doesn't match any BP in OT
 *   - We haven't already round-tripped twice on this thread (retry cap = 2)
 *
 * Reply-To = excess@ so Jake's reply loops back to this inbox and the
 * sidecar-stitch path picks it up on the next agent tick.
 *
 * Required payload: { subject, extracted, hints }
 * Ignored (but accepted): { recipient } — handler always sends to Jake
 *   subject     the original message's subject line (for the RE:)
 *   extracted   { lines: [...], offerType, ...whatever was parsed }
 *               persisted to the sidecar for the merge on the next round
 *   hints       short string describing what was tried + why partner didn't
 *               resolve (e.g., "subject had no search-key pattern; sender
 *               domain liyijing.com.cn not in BP table")
 *   outerFrom   (optional) the external sender's email — shown in the
 *               triage email so Jake can see who sent it
 */
async function action_clarify_partner(payload, ctx) {
  const { subject, extracted, hints, outerFrom, investigation_summary } = payload;
  const linesCount = Array.isArray(extracted && extracted.lines) ? extracted.lines.length : 0;
  const offerType = (extracted && extracted.offerType) || null;
  const sampleLines = Array.isArray(extracted && extracted.lines)
    ? extracted.lines.slice(0, 5)
    : [];

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: ['partner'],
      hints: hints || null,
      investigation_summary: investigation_summary || null,
    });
  }

  const sampleBlock = sampleLines.length
    ? `<p><b>First ${sampleLines.length} of ${fmt(linesCount)} line(s):</b></p><ul>${sampleLines.map(l =>
        `<li>${esc(l.mpn || l.MPN || '')}${l.mfr || l.MFR ? ' — ' + esc(l.mfr || l.MFR) : ''}${l.qty ? ' qty ' + fmt(l.qty) : ''}</li>`
      ).join('')}</ul>`
    : '';

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Customer Excess — partner clarification needed</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>External sender:</b> ${esc(outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
   <b>Offer type:</b> ${esc(offerType || '(default)')}<br/>
   <b>Line count:</b> ${fmt(linesCount)}</p>
<p><b>Why partner didn't resolve:</b><br/>${esc(hints || '(no hints provided)')}</p>
${sampleBlock}
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply to ${esc(ctx.inbox)} with the company name</b> (one line is fine — e.g., <code>Customer is Liyijing Electronics</code>). The next agent tick will merge your reply with the parsed lines and load the offer. Or use the structured directive: <code>PARTNER: ${ctx.uid} = &lt;BP search key OR company name&gt;</code>
</p>
<p style="color:#666;font-size:11px">To discard instead of answering: reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code> on the first line. The next tick will move this to NotOffer and clear the pending state.</p>
<p style="color:#666;font-size:11px">Message moved to NeedInfo folder. Sidecar: <code>~/workspace/.excess-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_notify_jake: { subject, outerFrom, hints, linesCount },
      would_write_sidecar: { anchor: ctx.anchorMessageId, missing: ['partner'] },
    };
  }

  // Reply-To MUST be the excess inbox — Jake's reply needs to land here for
  // the agent to pick up the pending_state on next tick.
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Customer Excess — clarify partner: ${subject || '(no subject)'}`,
    html,
    { html: true, replyTo: ctx.inbox },
  );

  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'escalated-clarify_partner',
    uid: ctx.uid,
    notified: ctx.jakeEmail,
    external_sender: outerFrom || null,
    subject,
    hints: hints || null,
    retry_count: retryCount,
    investigation_summary: investigation_summary || null,
  });

  return {
    notified: ctx.jakeEmail,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

/**
 * Email an operator diagnostic for manual triage. Used when:
 *   - Lines couldn't be extracted (no parseable attachment, signature-only body)
 *   - writeOffer threw / had errors
 *   - Ambiguous offer-type that even the agent can't resolve
 *
 * Required payload: { reason, subject, outerFrom }
 * Optional: { details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, outerFrom, details, investigation_summary } = payload;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Customer Excess — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { reason } };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Customer Excess — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );

  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    subject,
    outerFrom,
    reason,
    investigation_summary: investigation_summary || null,
  });

  return { notified: ctx.jakeEmail };
}

/**
 * Silent move — message is not an offer (junk, automation noise, sender
 * confirmation like "Upload MO_*", out-of-office, bounce, etc.).
 *
 * Required payload: { reason } — short string for the breadcrumb
 */
async function action_not_offer(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'not-offer',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Operator-initiated discard of a pending escalation. Triggered when Jake
 * replies to a needs_partner / clarify_partner email with a directive like
 * SKIP / IGNORE / DROP / DISCARD. The agent parses the directive in the
 * stitch-logic step via shared/workflow-reply-grammars.parseSidecarReplyDirective
 * and routes here.
 *
 * Side effects:
 *   - Silent move to NotOffer (signal we considered + declined to load).
 *   - Breadcrumb 'operator-dropped' so digest can show how often this fires.
 *   - The poller clears the sidecar automatically (action is NOT keepsPending).
 *
 * Required payload: { reason } — usually the directive Jake typed.
 */
async function action_drop_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'operator-dropped' };
  }
  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'operator-dropped',
    uid: ctx.uid,
    reason: payload.reason || 'operator-dropped',
    pending_kind: ctx.pendingSidecar && ctx.pendingSidecar.kind || null,
  });
  return { reason: payload.reason || 'operator-dropped' };
}

/**
 * Cross-forward duplicate detected. Same source email already produced a
 * loaded offer within the dedup window. Move to Processed (terminal) but
 * don't write a duplicate offer.
 *
 * Required payload: { existingSearchKey } — the prior offer's search key
 */
async function action_dup_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, existingSearchKey: payload.existingSearchKey };
  }
  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'dup-skipped',
    uid: ctx.uid,
    existingOfferSearchKey: payload.existingSearchKey,
  });
  return { existingSearchKey: payload.existingSearchKey };
}

// ─── LARGE-OFFER APPROVAL EMAIL ─────────────────────────────────────────────

function renderOfferApprovalEmailHtml(sentinel, thresholdN) {
  const lineCount = Number(sentinel.lineCount || sentinel.line_mpns || 0);
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;max-width:780px">
<h2 style="color:#b58900;margin-bottom:6px">[APPROVAL NEEDED] Large Offer ${esc(sentinel.searchKey)}</h2>
<p style="margin-top:0;color:#666;font-size:12px">From the customer-excess analysis gate — line count exceeds threshold (${fmt(thresholdN)})</p>

<p>Offer <b>${esc(sentinel.searchKey)}</b> from <b>${esc(sentinel.customer || sentinel.partnerName || '?')}</b> just wrote <b>${fmt(lineCount)} lines</b> to OT.</p>

<p style="background:#fff3cd;padding:10px 14px;border-left:4px solid #b58900;margin:14px 0">
<b>The offer is in OT, but downstream analysis is paused.</b><br/>
The customer-excess-analysis cog runs per-line CQ matching, RFQ matching, and intent classification — for a ${fmt(lineCount)}-line offer that's heavy. Approve to dispatch; reject to skip the analysis pass.
</p>

<h3 style="margin-bottom:6px">Offer Context</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr><td style="color:#666;padding:3px 14px 3px 0">Offer Search Key</td><td>${esc(sentinel.searchKey)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Offer ID</td><td>${esc(sentinel.offerId)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Customer</td><td>${esc(sentinel.customer || sentinel.partnerName || '?')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Offer Type</td><td>${esc(sentinel.offerType)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Route</td><td>${esc(sentinel.route || 'customer-excess-analysis')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Line count</td><td>${fmt(lineCount)}</td></tr>
</table>

<h3 style="margin-top:24px">How to respond</h3>
<p><b>Reply by email</b> — the excess agent reads replies on the next tick (every 30m):</p>
<ul style="font-family:'Courier New',monospace;font-size:12px;background:#f5f5f5;padding:10px 24px;border-radius:4px">
  <li><b>YES</b> — dispatch analysis on all lines</li>
  <li><b>LIMIT 500</b> — approve with a soft cap (downstream cog can read this from the .cleared sentinel)</li>
  <li><b>NO</b> — reject; skip analysis permanently</li>
</ul>

<p style="color:#888;font-size:11px;margin-top:18px">
Gate threshold: ${fmt(thresholdN)} lines. Override per-run with <code>LARGE_OFFER_THRESHOLD=N</code>. Sentinel: <code>~/workspace/.large-offer-pending/${esc(sentinel.searchKey)}.json</code>
</p>
</body></html>`;
}

async function sendOfferApprovalEmail({ subject, html, to }) {
  const { sendWithFallback } = require('../verified-send');
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    console.warn('[excess.gate] WORKMAIL_PASS not set — skipping approval email');
    return { delivered: 'none', bounceDetected: false };
  }
  // From excess@ so operator replies land back in the excess inbox where the
  // agent will pick them up and route to approve_large_offer / reject_large_offer.
  return sendWithFallback({
    primary:  { from: process.env.LARGE_OFFER_GATE_FROM || 'excess@orangetsunami.com',     pass, displayName: 'Customer Excess' },
    fallback: { from: process.env.LARGE_OFFER_GATE_FALLBACK || 'rfqloading@orangetsunami.com', pass, displayName: 'Customer Excess' },
    mail: { to: to || 'jake.harris@Astutegroup.com', subject, html },
    log: () => {},
  });
}

// ─── APPROVAL ACTIONS (via factory) ──────────────────────────────────────────

/**
 * Domain-specific dispatch on approval. Reads the sentinel for the offer's
 * resume payload (offerId/searchKey/offerType/partner) and runs
 * offerRouter.dispatch. Idempotent via markProcessed — if the operator approves
 * twice, the second run hits isProcessed=true and we skip silently below.
 *
 * Returns metadata the factory merges into the action's return value.
 */
async function onApproveOffer(id /*, ctx, approvalOpts */) {
  if (offerGate.isProcessed(id)) {
    return { dispatched: false, reason: 'already-processed' };
  }
  const sentinelPath = offerGate.sentinelPath(id);
  if (!fs.existsSync(sentinelPath)) {
    return { dispatched: false, reason: 'no-sentinel' };
  }
  let sentinel;
  try {
    sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8'));
  } catch (e) {
    return { dispatched: false, reason: `sentinel-read-failed: ${e.message}` };
  }
  try {
    await offerRouter.dispatch({
      offerId: sentinel.offerId,
      searchKey: sentinel.searchKey,
      offerType: sentinel.offerType,
      partner: { id: sentinel.bpartnerId, name: sentinel.partnerName },
      lineCount: sentinel.lineCount,
      source: 'excess-agent-approved',
    });
    offerGate.markProcessed(id);
    return { dispatched: true, offerId: sentinel.offerId };
  } catch (e) {
    // Don't markProcessed — operator can re-run or we can add a retry tick later
    breadcrumbs.write({
      cog: 'excess-agent', event: 'approve-dispatch-failed',
      offerSearchKey: id, error: e.message,
    });
    return { dispatched: false, reason: `dispatch-failed: ${e.message}` };
  }
}

const { action_approve: action_approve_large_offer, action_reject: action_reject_large_offer } =
  makeApprovalActions(offerGate, {
    workflow: 'excess',
    payloadKey: 'offer_search_key',
    recordLabel: 'Large Offer',
    downstreamLabel: 'excess-agent',
    downstreamLeadTime: 'within 30 min',
    supportsCacheOnly: false,
    onApprove: onApproveOffer,
  });

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'excess@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'excess@orangetsunami.com',
    fromName: 'Customer Excess',
  },
  actions: {
    load_offer: {
      folder: 'Processed',
      requires: ['bpartnerId', 'offerType', 'lines'],
      handler: action_load_offer,
    },
    needs_partner: {
      folder: 'NeedsPartner',
      requires: ['subject', 'outerFrom'],
      handler: action_needs_partner,
    },
    clarify_partner: {
      folder: 'NeedInfo',
      requires: ['subject', 'extracted'],
      keepsPending: true,
      handler: action_clarify_partner,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_offer: {
      folder: 'NotOffer',
      requires: ['reason'],
      handler: action_not_offer,
    },
    dup_skip: {
      folder: 'Processed',
      requires: ['existingSearchKey'],
      handler: action_dup_skip,
    },
    drop_pending: {
      folder: 'NotOffer',
      requires: ['reason'],
      handler: action_drop_pending,
    },
    approve_large_offer: {
      folder: 'LargeOfferApprovals',
      requires: ['offer_search_key'],
      handler: action_approve_large_offer,
    },
    reject_large_offer: {
      folder: 'LargeOfferApprovals',
      requires: ['offer_search_key'],
      handler: action_reject_large_offer,
    },
  },
};
