/**
 * shared/workflow-actions/stockrfq-cq.js
 *
 * Workflow module for the outbound CQ loader. Consumed by
 * shared/email-workflow-poller.js when invoked with --workflow stockrfq-cq.
 *
 * Inbox:        stockRFQ@orangetsunami.com
 * Source folder: OutboundPending  (populated by stockrfq-agent's Step 0
 *                                  outbound_pending action)
 * Doc:          Trading Analysis/Stock RFQ Loading/stock-rfq-cq-loading.md
 *
 * Closes the loop on operator outbound quote replies:
 *   stockrfq-agent (INBOX → OutboundPending)
 *     → stockrfq-cq-agent (OutboundPending → CQ-Processed)
 *         → chuboe_cq_line written via shared/cq-writer.js,
 *           attached to the source RFQ in OT.
 */

'use strict';

const { writeRFQ } = require('../rfq-writer');
const { writeCQBatch } = require('../cq-writer');
const breadcrumbs = require('../breadcrumbs');

const UNQUALIFIED_BROKER_ID = 1006505;
const UNQUALIFIED_BROKER_KEY = '1008499';
const JAKE_USER_ID = 1000004;

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Write one or more CQ lines against an EXISTING RFQ.
 *
 * IDEMPOTENCY: the agent is responsible for verifying — before calling this
 * action — that no active chuboe_cq_line already covers (rfq_line, mpn, qty,
 * price). cq-writer's naturalKeyFields option is for 5xx retry-safety only;
 * it does NOT prevent duplicate posts of distinct API calls.
 *
 * Required payload:
 *   rfqSearchKey  (string; chuboe_rfq.value, e.g., "1134111")
 *   lines[]       [{ mpn, qty, price (number; cq-writer maps → resale),
 *                    mfrText, leadTime, dateCode?, packaging?, rohs?,
 *                    coo?, moq?, notePublic?, notePrivate?, cpc?,
 *                    description? }, ...]
 *
 * Optional:
 *   bpartnerId     (override RFQ header customer for the CQ; rarely used —
 *                   normally the customer is inherited from the RFQ header)
 *   sourceUid      (for breadcrumb traceability)
 *   sourceMessageId (RFC822 Message-ID; the agent's path-(a) match result)
 *   matchPath      ('header'|'subject'|'mpn-fuzzy'; for breadcrumb diagnostics)
 */
async function action_add_cq(payload, ctx) {
  const {
    rfqSearchKey,
    lines,
    bpartnerId,
    sourceUid,
    sourceMessageId,
    matchPath,
  } = payload;

  // cq-writer's MANDATORY_FIELDS use `resale` (not `price`). Map.
  const writerLines = lines.map(l => ({
    ...l,
    resale: l.resale != null ? l.resale : l.price,
  }));

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { rfqSearchKey, lineCount: writerLines.length, matchPath },
    };
  }

  const result = await writeCQBatch(rfqSearchKey, writerLines, {
    bpartnerId: bpartnerId || undefined,
  });

  breadcrumbs.write({
    cog: 'stockrfq-cq-agent',
    event: 'cq-loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    sourceMessageId: sourceMessageId || null,
    matchPath: matchPath || 'unknown',
    rfqSearchKey,
    cqsWritten: result.written.length,
    cqsFlagged: result.flagged.length,
    cqsFailed: result.failed.length,
  });

  return {
    rfqSearchKey,
    written: result.written,
    flagged: result.flagged,
    failed: result.failed,
    summary: result.summary,
  };
}

/**
 * Write a NEW RFQ (capturing the missing inbound demand signal) and then
 * write the operator's quote as a CQ row attached to it. Used when the
 * outbound message has no findable source RFQ — i.e., the broker's
 * original RFQ never came through the inbound path (lost forward, came
 * through a different inbox, etc.), and the only signal we have for the
 * demand is the operator's quote-back.
 *
 * Without this path, the agent would have to choose between:
 *   - skip → losing the demand signal entirely
 *   - needs_review → manual triage for every such case
 *
 * Required payload:
 *   bpartnerId     (resolved broker BP, or 1006505 for Unqualified Broker)
 *   customerName   (display name; used for header + line description on
 *                   the Unqualified Broker path)
 *   lines[]       [{ mpn, qty, price, mfrText, leadTime, dateCode?, ... }, ...]
 *                 — same shape as add_cq; the handler splits each line into
 *                 an RFQ line (mpn/qty/mfrText/cpc) and a CQ line (all of it).
 *
 * Optional:
 *   originalSenderEmail   (broker's address from deepest quoted From:; audit)
 *   originalCompanyName   (broker's company; audit)
 *   sourceUid             (for breadcrumb)
 *   sourceMessageId       (Message-ID of this outbound message)
 */
async function action_add_cq_with_rfq(payload, ctx) {
  const {
    bpartnerId,
    customerName,
    lines,
    originalSenderEmail,
    originalCompanyName,
    sourceUid,
    sourceMessageId,
  } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, customerName, lineCount: lines.length, withRfq: true },
    };
  }

  // 1. Write the RFQ first — captures the inbound demand signal we missed.
  const rfqLines = lines.map(l => ({
    mpn: l.mpn,
    qty: l.qty,
    mfrText: l.mfrText,
    cpc: l.cpc || l.mpn,
    targetPrice: l.targetPrice, // may be undefined; that's OK
    description: l.description,
    dateCode: l.dateCode,
  }));

  // Prepend customerName to each line description on the Unqualified path,
  // matching the inbound action_load_rfq behavior.
  const normalizedRfqLines = (bpartnerId === UNQUALIFIED_BROKER_ID && customerName)
    ? rfqLines.map(l => ({
        ...l,
        description: l.description ? `${customerName} - ${l.description}` : customerName,
      }))
    : rfqLines;

  const headerDescription = customerName
    ? `${customerName} — Stock RFQ (captured via outbound CQ reply)`
    : 'Stock RFQ (captured via outbound CQ reply)';

  const rfqResult = await writeRFQ({
    bpartnerId,
    type: 'Stock',
    description: headerDescription,
    bpName: customerName || undefined,
    salesrepId: JAKE_USER_ID,
    userId: JAKE_USER_ID,
    lines: normalizedRfqLines,
  });

  // 2. Now write the CQ against the freshly-created RFQ.
  const cqLines = lines.map(l => ({
    ...l,
    resale: l.resale != null ? l.resale : l.price,
  }));

  const cqResult = await writeCQBatch(rfqResult.searchKey, cqLines, {});

  breadcrumbs.write({
    cog: 'stockrfq-cq-agent',
    event: 'cq-loaded-with-rfq',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    sourceMessageId: sourceMessageId || null,
    bpartnerId,
    customerName,
    originalSenderEmail: originalSenderEmail || null,
    rfqId: rfqResult.rfqId,
    searchKey: rfqResult.searchKey,
    rfqLinesWritten: rfqResult.linesWritten,
    cqsWritten: cqResult.written.length,
    cqsFlagged: cqResult.flagged.length,
    cqsFailed: cqResult.failed.length,
  });

  return {
    rfqId: rfqResult.rfqId,
    rfqSearchKey: rfqResult.searchKey,
    rfqLinesWritten: rfqResult.linesWritten,
    cqsWritten: cqResult.written,
    cqsFlagged: cqResult.flagged,
    cqsFailed: cqResult.failed,
  };
}

/**
 * Inquiry-only or no-quote-content reply. Silent move to CQ-Skipped.
 *
 * Required payload: { reason }
 *   Typical reasons:
 *     - "inquiry-only: 'what's your target price?'"
 *     - "no price content in body"
 *     - "already-written: cq <id> covers (mpn, qty, price) on rfq <searchKey>"
 */
async function action_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: 'stockrfq-cq-agent',
    event: 'cq-skip',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Match ambiguous or content unparseable. Move to CQ-NeedsReview, email Jake.
 *
 * Required payload: { reason }
 * Optional: { subject, candidates, details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, candidates, details } = payload;
  const candidatesBlock = Array.isArray(candidates) && candidates.length
    ? `<p><b>Candidate RFQs:</b></p><ul>${candidates.map(c =>
        `<li>${esc(c.searchKey || c.rfqId)} — ${esc(c.customer || '')} — ${esc(c.mpn || '')} qty ${esc(c.qty || '')}</li>`
      ).join('')}</ul>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Stock RFQ CQ — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${candidatesBlock}
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to CQ-NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { reason } };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Stock RFQ CQ — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );

  breadcrumbs.write({
    cog: 'stockrfq-cq-agent',
    event: 'cq-needs-review',
    uid: ctx.uid,
    subject,
    reason,
    candidateCount: Array.isArray(candidates) ? candidates.length : 0,
  });

  return { notified: ctx.jakeEmail };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'stockRFQ@orangetsunami.com',
  sourceFolder: 'OutboundPending',   // read/move FROM here (vs default INBOX)
  notifierConfig: {
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Stock RFQ CQ Loader',
  },
  actions: {
    add_cq: {
      folder: 'CQ-Processed',
      requires: ['rfqSearchKey', 'lines'],
      handler: action_add_cq,
    },
    add_cq_with_rfq: {
      folder: 'CQ-Processed',
      requires: ['bpartnerId', 'customerName', 'lines'],
      handler: action_add_cq_with_rfq,
    },
    skip: {
      folder: 'CQ-Skipped',
      requires: ['reason'],
      handler: action_skip,
    },
    needs_review: {
      folder: 'CQ-NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
  },
  constants: {
    UNQUALIFIED_BROKER_ID,
    UNQUALIFIED_BROKER_KEY,
    JAKE_USER_ID,
  },
};
