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
const { execSync } = require('child_process');

const { writeOffer, deactivatePriorOffers } = require('../offer-writeback');
const writerAttribution = require('../writer-attribution');
const offerRouter = require('../offer-router');
const { evaluateFailureRate } = require('../failure-rate-gate');
const breadcrumbs = require('../breadcrumbs');
const pending = require('../workflow-pending-state');
const { createGate } = require('../large-payload-gate');
const { makeApprovalActions } = require('./_approval');

// ─── LAM KITTING INVENTORY DEACTIVATION ───────────────────────────────────────
// LAM Kitting Inventory is a snapshot of current consignment stock. Each new
// load supersedes all prior active offers of the same type. Deactivate old
// offers before writing the new one.
const LAM_KITTING_OFFER_TYPE_ID = 1000025;
const LAM_RESEARCH_BP_ID = 1000730;

// ─── PARTNER NAME LOOKUP ──────────────────────────────────────────────────────
// Look up partner name from bpartnerId if not provided in payload.
// Fallback for when agent doesn't pass partnerName. Matches the fix applied to
// rfq-loader-daemon.js (2026-06-11).
function lookupPartnerName(bpartnerId) {
  if (!bpartnerId) return null;
  try {
    const sql = `SELECT name FROM adempiere.c_bpartner WHERE c_bpartner_id = ${parseInt(bpartnerId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

/**
 * Look up offer type name from type ID.
 */
function lookupOfferTypeName(offerTypeId) {
  if (!offerTypeId) return null;
  // Handle string type names passed directly
  if (typeof offerTypeId === 'string' && isNaN(parseInt(offerTypeId, 10))) {
    return offerTypeId; // Already a name like "Customer Excess"
  }
  try {
    const sql = `SELECT name FROM adempiere.chuboe_offer_type WHERE chuboe_offer_type_id = ${parseInt(offerTypeId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

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
const ANALYSIS_TYPE_IDS = new Set([1000000, 1000003, 1000025]);

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
  const { bpartnerId, offerType, lines, description, sourceUid,
          originalSender, originalCc, originalSubject } = payload;

  // Resolve partnerName from payload OR look up from DB (fallback for when
  // agent doesn't pass partnerName). Matches rfq-loader-daemon.js pattern.
  const partnerName = payload.partnerName || lookupPartnerName(bpartnerId);

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

  // ── LAM Kitting Inventory: deactivate prior offers before writing ──────────
  // LAM Kitting is a point-in-time snapshot. Each new load supersedes the prior
  // active inventory. Without this, multiple active offers accumulate and the
  // RFQ matcher sees stale inventory lines.
  let priorDeactivation = null;
  if (offerType === LAM_KITTING_OFFER_TYPE_ID || offerType === 'LAM Kitting Inventory') {
    const typeId = offerType === 'LAM Kitting Inventory' ? LAM_KITTING_OFFER_TYPE_ID : offerType;
    priorDeactivation = await deactivatePriorOffers(LAM_RESEARCH_BP_ID, typeId);
    if (priorDeactivation.offersDeactivated > 0) {
      breadcrumbs.write({
        cog: 'offer-poller',
        event: 'lam-kitting-prior-deactivated',
        uid: ctx.uid,
        offersDeactivated: priorDeactivation.offersDeactivated,
        linesDeactivated: priorDeactivation.linesDeactivated,
        deactivatedOffers: priorDeactivation.deactivatedOffers.map(o => o.value),
      });
    }
  }

  // NOTE: writeMpnRecords deliberately omitted (default false).
  // The iDempiere bean callout on chuboe_offer_line auto-creates the
  // chuboe_offer_line_mpn record. Writing it ourselves caused duplicates.
  const result = await writeOffer({
    bpartnerId,
    offerTypeId: offerType,
    description: description || `${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-bp${bpartnerId}-excessAgent`,
    lines,
  });

  // ── Budget exhaustion: defer for retry ──────────────────────────────────────
  // If offer-writeback returned rateLimited, propagate it so the poller leaves
  // the email UNSEEN for the next poll cycle.
  //
  // REPEAT-DEFERRAL CHECK: If we already have a breadcrumb for this UID from a
  // prior tick, don't notify again — the agent should exit silently.
  if (result.rateLimited) {
    const priorDeferral = breadcrumbs.findByUid(ctx.uid, {
      cog: 'offer-poller',
      events: ['load-deferred-budget'],
      sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    });
    const alreadyDeferred = priorDeferral.found;

    if (!alreadyDeferred) {
      breadcrumbs.write({
        cog: 'offer-poller',
        event: 'load-deferred-budget',
        uid: ctx.uid,
        sourceUid: sourceUid || ctx.uid,
        messageId: ctx.currentMessageId || null,
        bpartnerId,
        offerType,
        lineCount: lines.length,
        reason: result.rateLimitReason,
      });
    }

    return {
      rateLimited: true,
      alreadyDeferred,
      rateLimitReason: result.rateLimitReason,
      rateLimitTier: result.rateLimitTier || 'global',
      lineCount: lines.length,
    };
  }

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
    chunkedMode: result.chunkedMode || false,
  });

  // ── Failure rate evaluation ─────────────────────────────────────────────────
  // Check if the load had an unhealthy failure rate. Alert operator if so.
  // Uses count-style result (linesWritten, errors[]) like rfq-loader-daemon.
  try {
    const gateEval = evaluateFailureRate({
      result: {
        linesWritten: result.linesWritten,
        errors: result.errors,
      },
      minSubmitted: 10,
    });

    if (gateEval.flag && gateEval.severity !== 'none') {
      console.error(`[excess.load_offer] High failure rate detected: ${gateEval.reason}`);
      breadcrumbs.write({
        cog: 'offer-poller',
        event: 'high-failure-rate',
        uid: ctx.uid,
        offerId: result.offerId,
        searchKey: result.searchKey,
        severity: gateEval.severity,
        reason: gateEval.reason,
        linesAttempted: lines.length,
        linesWritten: result.linesWritten,
        errorCount: result.errors.length,
        ratios: gateEval.ratios,
      });

      // Send alert email to operator
      const alertSubject = `⚠️ Offer Load Alert: ${result.searchKey || 'unknown'} — ${gateEval.severity} failure rate`;
      const alertBody = `Market Offer load completed with high failure rate.

Offer #: ${result.searchKey || '(not created)'}
Partner: ${partnerName || '(unknown)'}
Severity: ${gateEval.severity}
Reason: ${gateEval.reason}

Lines attempted: ${lines.length}
Lines written: ${result.linesWritten}
Errors: ${result.errors.length}
Failure rate: ${(gateEval.ratios.failed * 100).toFixed(1)}%

Sample errors:
${result.errors.slice(0, 5).map(e => `  • ${e}`).join('\n')}
${result.errors.length > 5 ? `  ... +${result.errors.length - 5} more` : ''}

— Excess Offer System (automated alert)`;

      await ctx.notifier.sendEmail(ctx.jakeEmail, alertSubject, alertBody);
    }
  } catch (e) {
    console.error(`[excess.load_offer] Failure rate evaluation error: ${e.message}`);
  }

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

  // ── Send confirmation email to INTERNAL Astute people only ─────────────────
  // DO NOT send to external customers. Only notify the internal forwarder + CC.
  if (result.offerId && !ctx.dryRun) {
    try {
      const isInternal = (email) => email && email.toLowerCase().includes('@astutegroup.com');

      // Build recipient list: internal forwarder first, then internal CCs, then Jake
      const internalRecipients = [];
      if (isInternal(originalSender)) {
        internalRecipients.push(originalSender);
      }
      if (Array.isArray(originalCc)) {
        for (const cc of originalCc) {
          if (isInternal(cc) && !cc.includes('excessinc@') && !internalRecipients.includes(cc.toLowerCase())) {
            internalRecipients.push(cc);
          }
        }
      }
      if (ctx.jakeEmail && !internalRecipients.map(e => e.toLowerCase()).includes(ctx.jakeEmail.toLowerCase())) {
        internalRecipients.push(ctx.jakeEmail);
      }

      if (internalRecipients.length > 0) {
        const toEmail = internalRecipients[0];
        const ccList = internalRecipients.slice(1);

        // Look up metadata for confirmation
        const offerTypeName = lookupOfferTypeName(offerType) || '(unknown)';

        const confirmSubject = originalSubject
          ? `Re: ${originalSubject}`
          : `Market Offer ${result.searchKey} loaded`;

        // Build confirmation body with all metadata
        let confirmBody = `Excess offer loaded.

Partner: ${partnerName || '(unknown)'}
Market Offer #: ${result.searchKey}
Type: ${offerTypeName}
Contact: Jake Harris
Lines loaded: ${result.linesWritten}`;

        if (description) {
          confirmBody += `\nDescription: ${description}`;
        }

        confirmBody += `

This offer is now in Orange Tsunami and available for matching against open RFQs.

— Excess Offer System (automated)`;

        // Thread confirmation into the original email chain using Message-ID
        // Fallback to anchorMessageId when currentMessageId is null (fetch failed)
        const threadingOpts = {
          cc: ccList.length > 0 ? ccList : undefined,
        };
        const threadId = ctx.currentMessageId || ctx.anchorMessageId;
        if (threadId) {
          threadingOpts.inReplyTo = threadId;
          threadingOpts.references = threadId;
        }
        await ctx.notifier.sendEmail(toEmail, confirmSubject, confirmBody, threadingOpts);

        breadcrumbs.write({
          cog: 'offer-poller',
          event: 'confirmation-sent',
          uid: ctx.uid,
          offerId: result.offerId,
          searchKey: result.searchKey,
          partner: partnerName,
          offerType: offerTypeName,
          linesLoaded: result.linesWritten,
          to: toEmail,
          cc: ccList,
        });
      }
    } catch (e) {
      console.error(`[excess.load_offer] confirmation email failed: ${e.message}`);
    }
  }

  return {
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
    gateStatus,
    priorDeactivation: priorDeactivation ? {
      offersDeactivated: priorDeactivation.offersDeactivated,
      linesDeactivated: priorDeactivation.linesDeactivated,
    } : null,
  };
}

/**
 * Partner couldn't be resolved. Email operator with PARTNER reply prompt;
 * the reply-parser cog (or operator manual move) brings the message back
 * into INBOX with a partner override.
 *
 * Required payload: { subject, outerFrom, hints }
 * Optional: { extracted } — line data to display so operator can identify customer
 *   hints: free-text describing what was tried (e.g., "subject had no
 *          search-key pattern; body From: chain led to internal Astute employee")
 */
async function action_needs_partner(payload, ctx) {
  const { subject, outerFrom, hints, extracted, investigation_summary } = payload;
  const linesCount = Array.isArray(extracted && extracted.lines) ? extracted.lines.length : 0;

  // Build extracted-lines table so operator can see what data is waiting
  const extractedLinesHtml = formatExtractedLinesTable(extracted);

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Customer Excess — partner unresolved</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   <b>Lines parsed:</b> ${fmt(linesCount)}</p>
<p><b>What was tried:</b><br/>${esc(hints || '(no hints provided)')}</p>
${investigationBlock}
${extractedLinesHtml}
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply with:</b><br/>
   <code>PARTNER: ${ctx.uid} = &lt;BP search key 6-8 digits OR company name&gt;</code>
</p>
<p style="color:#666;font-size:11px">Message moved to NeedsPartner folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { subject, outerFrom } };
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
    ctx.jakeEmail,
    `Customer Excess — NeedsPartner: ${subject || '(no subject)'}`,
    html,
    opts,
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

  // Build extracted-lines table so operator can see what data is waiting
  const extractedLinesHtml = formatExtractedLinesTable(extracted);

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

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

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
${investigationBlock}
${extractedLinesHtml}
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
  // Email threading headers — escalation lands in same thread as original
  // Fallback to anchorMessageId when currentMessageId is null (fetch failed)
  const opts = { html: true, replyTo: ctx.inbox };
  const threadId = ctx.currentMessageId || ctx.anchorMessageId;
  if (threadId) {
    opts.inReplyTo = threadId;
    const refs = Array.isArray(ctx.currentReferences) ? [...ctx.currentReferences] : [];
    if (!refs.includes(threadId)) refs.push(threadId);
    if (refs.length > 0) opts.references = refs;
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Customer Excess — clarify partner: ${subject || '(no subject)'}`,
    html,
    opts,
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

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Customer Excess — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${investigationBlock}
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { reason } };
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
    ctx.jakeEmail,
    `Customer Excess — needs review: ${subject || '(no subject)'}`,
    html,
    opts,
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

/**
 * Format extracted offer lines as an HTML table for operator decision-making.
 * Without this, escalation emails show "Line count: 50" but don't tell the
 * operator WHAT those lines contain — making it hard to identify the customer.
 *
 * Added 2026-06-08 per operator feedback on VQ uid 8937 — same pattern applies here.
 */
function formatExtractedLinesTable(extracted) {
  const lines = Array.isArray(extracted && extracted.lines) ? extracted.lines : [];
  if (lines.length === 0) {
    return '<p style="color:#666;font-style:italic">No lines extracted yet.</p>';
  }

  // Build compact table showing the key fields an operator needs
  const rows = lines.slice(0, 15).map((ln, i) => {
    const mpn = ln.mpn || ln.MPN || '?';
    const mfr = ln.mfr || ln.MFR || '';
    const qty = ln.qty != null ? fmt(ln.qty) : '?';
    const price = ln.price != null ? `$${Number(ln.price).toFixed(4)}` : '';
    const dc = ln.dateCode || ln.dc || '';
    const coo = ln.coo || '';
    return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
      <td style="padding:4px 8px;border:1px solid #ddd;font-family:monospace">${esc(mpn)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(mfr)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${esc(qty)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${esc(price)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(dc)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(coo)}</td>
    </tr>`;
  }).join('');

  const truncateNote = lines.length > 15
    ? `<p style="color:#666;font-size:11px">Showing first 15 of ${fmt(lines.length)} extracted lines.</p>`
    : '';

  return `
<p style="margin-top:16px"><b>Extracted line data:</b></p>
<table style="border-collapse:collapse;font-size:12px;width:100%">
  <thead>
    <tr style="background:#e0e0e0">
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">MPN</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">MFR</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:right">Qty</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:right">Price</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">DC</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">COO</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
${truncateNote}`;
}

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
