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
    bpartnerId,
    offerType,
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
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
  const { subject, outerFrom, hints } = payload;
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
    event: 'needs-partner',
    uid: ctx.uid,
    subject,
    outerFrom,
  });

  return { notified: ctx.jakeEmail };
}

/**
 * Email the EXTERNAL SENDER asking them to confirm their company so we can
 * resolve the partner BP. Parallel to rfq-loading's action_need_info, but
 * specialized for the "we got an offer but can't tell who you are" case.
 *
 * Use this (instead of needs_partner) when:
 *   - The external sender is a real person (not a bounce / automated)
 *   - Lines were successfully extracted from the offer
 *   - Sender domain doesn't match any BP in OT
 *   - We haven't already round-tripped twice on this thread (retry cap = 2)
 *
 * The handler writes a pending-state sidecar with the partial extraction
 * (lines + offerType + everything we DO know) so when the sender replies
 * with their company name, the next-tick agent merges what they said with
 * what we already parsed and routes to load_offer.
 *
 * Reply-To = excess@ so replies loop back to this inbox. cc Jake so the
 * operator can see the round-trip happening.
 *
 * Required payload: { recipient, subject, extracted, hints }
 *   recipient   the external sender's email
 *   subject     the original message's subject line (for the RE:)
 *   extracted   { lines: [...], offerType, ...whatever was parsed }
 *               persisted to the sidecar for the merge on the next round
 *   hints       short string describing what was tried + why partner didn't
 *               resolve (e.g., "subject had no search-key pattern; sender
 *               domain liyijing.com.cn not in BP table") — for breadcrumb
 *               + audit only, not shown in the customer-facing reply
 */
async function action_clarify_partner(payload, ctx) {
  const { recipient, subject, extracted, hints } = payload;
  const body = buildClarifyPartnerReply();

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: recipient || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: ['partner'],
      hints: hints || null,
    });
  }

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_reply: { to: recipient, cc: ctx.jakeEmail, replyTo: ctx.inbox },
      draft: body,
      would_write_sidecar: { anchor: ctx.anchorMessageId, missing: ['partner'] },
    };
  }

  // Reply-To MUST be the excess inbox — otherwise the sender's reply lands
  // in Jake's inbox and the agent never sees it, breaking the stitch.
  await ctx.notifier.sendEmail(
    recipient,
    `RE: ${subject || 'Your message'} — company confirmation needed`,
    body,
    { cc: ctx.jakeEmail, replyTo: ctx.inbox },
  );

  breadcrumbs.write({
    cog: 'offer-poller',
    event: 'clarify-partner',
    uid: ctx.uid,
    recipient,
    subject,
    hints: hints || null,
    retry_count: sidecarRecord ? sidecarRecord.retry_count : null,
  });

  return {
    replied_to: recipient,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: sidecarRecord ? sidecarRecord.retry_count : null,
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
  const { reason, subject, outerFrom, details } = payload;
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
    event: 'needs-review',
    uid: ctx.uid,
    subject,
    outerFrom,
    reason,
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

function buildClarifyPartnerReply() {
  return [
    `Hi,`, ``,
    `Thanks for sending the excess inventory list. To get this loaded into our system, I need to confirm which company account it belongs to — your sender domain isn't currently mapped in our records.`, ``,
    `Could you reply with:`,
    `  • Your company name (and any short/legal variations we'd find on a PO or invoice)`,
    `  • Your role / title (helps us route to the right contact on our side)`, ``,
    `Once I have that I'll get the list loaded and routed appropriately.`, ``,
    `Thanks,`,
    `Astute Group Customer Excess Team`,
  ].join('\n');
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
      requires: ['recipient', 'subject', 'extracted'],
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
