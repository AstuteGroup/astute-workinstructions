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

const { writeRFQ } = require('../rfq-writer');
const breadcrumbs = require('../breadcrumbs');

const UNQUALIFIED_BROKER_ID = 1006505;       // c_bpartner_id
const UNQUALIFIED_BROKER_KEY = '1008499';    // search_key (for human-readable references)
const JAKE_USER_ID = 1000004;

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
 *   description    (defaults to email subject sanitized)
 *   salesrepId     (default: 1000004 — Jake)
 *   userId         (default: 1000004 — Jake; serves as contact fallback when sender's ad_user is unknown)
 *   sourceUid      (for breadcrumb traceability)
 *   customerName   (for description suffix when bpartnerId is the Unqualified Broker)
 */
async function action_load_rfq(payload, ctx) {
  const {
    bpartnerId,
    type,
    lines,
    description,
    salesrepId,
    userId,
    sourceUid,
    customerName,
  } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, type, lineCount: lines.length, description },
    };
  }

  // If Unqualified Broker, prepend customer name to each line's description
  // (matches static daemon behavior; keeps the broker name discoverable in OT).
  let normalizedLines = lines;
  if (bpartnerId === UNQUALIFIED_BROKER_ID && customerName) {
    normalizedLines = lines.map(l => ({
      ...l,
      description: l.description
        ? `${customerName} - ${l.description}`
        : customerName,
    }));
  }

  const result = await writeRFQ({
    bpartnerId,
    type: type || 'Stock',
    description: description || `excessAgent stock RFQ ${new Date().toISOString().slice(0, 10)}`,
    salesrepId: salesrepId || JAKE_USER_ID,
    userId: userId || JAKE_USER_ID,
    lines: normalizedLines,
  });

  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    bpartnerId,
    type: type || 'Stock',
    rfqId: result.rfqId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
  });

  return {
    rfqId: result.rfqId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
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
  const { reason, subject, outerFrom, details } = payload;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Stock RFQ — needs manual review</h2>
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
    `Stock RFQ — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );

  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'needs-review',
    uid: ctx.uid,
    subject,
    outerFrom,
    reason,
  });

  return { notified: ctx.jakeEmail };
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
  },
  // Constants exposed so the agent / .md can reference them
  constants: {
    UNQUALIFIED_BROKER_ID,
    UNQUALIFIED_BROKER_KEY,
    JAKE_USER_ID,
  },
};
