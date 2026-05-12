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
    messageId,
    customerName,
    priceCheck,
    priceCheckReason,
  } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, type, lineCount: lines.length, description },
    };
  }

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

  const result = await writeRFQ({
    bpartnerId,
    type: type || 'Stock',
    description: headerDescription,
    bpName: customerName || undefined,
    salesrepId: salesrepId || JAKE_USER_ID,
    userId: userId || JAKE_USER_ID,
    lines: normalizedLines,
  });

  breadcrumbs.write({
    cog: 'stockrfq-agent',
    event: 'loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    messageId: messageId || null,
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
  },
  // Constants exposed so the agent / .md can reference them
  constants: {
    UNQUALIFIED_BROKER_ID,
    UNQUALIFIED_BROKER_KEY,
    JAKE_USER_ID,
  },
};
