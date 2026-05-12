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

const { writeOffer } = require('../offer-writeback');
const offerRouter = require('../offer-router');
const breadcrumbs = require('../breadcrumbs');

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

  // Dispatch to offer-router so the downstream cog (customer-excess-analysis
  // for type 1000000/1000003, broker-data-capture for 1000001, franchise-
  // data-capture for 1000002) fires. The router writes its own breadcrumb
  // and invokes the analyzer. Wrap in try/catch: the offer is already in OT
  // by this point, so a downstream failure shouldn't fail the load action —
  // it's separately retryable. Errors are also breadcrumbed by the router
  // itself (`event: 'downstream-failed'`) so the digest surfaces them.
  //
  // Why this is needed: the legacy static offer-poller (pre-2026-05-08)
  // chained writeOffer → router inline in the same process. The new agentic
  // loader only writes the offer and stops — leaving the analysis pipeline
  // starved (verified 5/12: 12 offers / 2,383 lines un-analyzed since 5/8).
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
    // Router-internal failures are already breadcrumbed via 'downstream-failed';
    // log to stderr for cron visibility but don't surface to the agent.
    console.error(`[excess.load_offer] offer-router.dispatch failed for offer ${result.offerId}: ${e.message}`);
  }

  return {
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  },
};
