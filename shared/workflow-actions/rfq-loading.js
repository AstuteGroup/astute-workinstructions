/**
 * shared/workflow-actions/rfq-loading.js
 *
 * Workflow module for general-customer RFQ loading. Consumed by
 * shared/email-workflow-poller.js when invoked with --workflow rfq-loading.
 *
 * Inbox: rfqloading@orangetsunami.com
 * Doc:   Trading Analysis/RFQ Loading/rfq-loading.md
 */

'use strict';

const { enqueue } = require('../rfq-load-queue');
const largeRfqGate = require('../large-rfq-gate');

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Enqueue an extracted RFQ to the rfq-load-queue (picked up by the
 * fast-loader daemon within 5 min).
 *
 * Required payload: { bpartnerId, type, userId, lines[] }
 * Optional: { description }
 */
async function action_enqueue(payload, ctx) {
  const { bpartnerId, type, userId, description, lines } = payload;
  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_enqueue: { bpartnerId, type, userId, lineCount: lines.length },
    };
  }
  const job_id = enqueue({
    bpartnerId, type, userId, description,
    salesrepId: 1000004,
    lines,
  });
  return { job_id };
}

/**
 * Auto-reply to the customer requesting missing fields. Jake on CC + Reply-To.
 *
 * Required payload: { recipient, missing[] }
 * Optional: { subject }
 */
async function action_need_info(payload, ctx) {
  const { recipient, missing, subject } = payload;
  const body = buildNeedInfoReply(missing);
  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_reply: { to: recipient, cc: ctx.jakeEmail, missing },
      draft: body,
    };
  }
  await ctx.notifier.sendEmail(
    recipient,
    `RE: ${subject || 'Your RFQ'} — details needed`,
    body,
    { cc: ctx.jakeEmail, replyTo: ctx.jakeEmail },
  );
  return { replied_to: recipient };
}

/**
 * Email Jake diagnostics for manual triage.
 *
 * Required payload: { reason }
 * Optional: { details, subject, from }
 */
async function action_needs_review(payload, ctx) {
  const { reason, details, subject, from } = payload;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">RFQ Loading — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/><b>From:</b> ${esc(from)}<br/><b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview in ${ctx.inbox} inbox.</p>
</body></html>`;
  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { reason } };
  }
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `RFQ Loading — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );
  return { notified: ctx.jakeEmail };
}

/**
 * Approve a large-RFQ enrichment request (from a reply to an
 * `[APPROVAL NEEDED] Large RFQ N` email — the gate sends these from
 * rfqloading@, so replies land in this inbox).
 *
 * Required payload: { rfq_number }
 * Optional: { max_lines, note }
 *
 * The gate handles missing sentinels gracefully — markApproved just writes
 * the .cleared file. If no sentinel exists (e.g., race condition or stale
 * reply), enrich-poller's `listClearedUnprocessed` won't pick it up because
 * the sentinel JSON is missing; the operator gets the ack regardless.
 */
async function action_approve_large_rfq(payload, ctx) {
  const { rfq_number, max_lines, cache_only, note } = payload;
  if (ctx.dryRun) {
    return { dry_run: true, would_approve: { rfq_number, max_lines, cache_only, note } };
  }
  const maxLines = Number.isFinite(Number(max_lines)) && Number(max_lines) > 0
    ? Number(max_lines) : null;
  const cacheOnly = cache_only === true || cache_only === 'true';
  largeRfqGate.markApproved(rfq_number, {
    maxLines,
    cacheOnly,
    approvedBy: ctx.from || ctx.jakeEmail || 'email',
    note,
  });
  const tags = [];
  if (maxLines) tags.push(`capped at ${maxLines.toLocaleString('en-US')} lines`);
  if (cacheOnly) tags.push('cache-only (no live API calls)');
  const tagLine = tags.length ? ` (${tags.join('; ')})` : '';
  const ackHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Got it — <b>RFQ ${esc(rfq_number)}</b> approved for enrichment${tagLine}.</p>
<p>The next enrich-poller tick (within 15 min) will pick it up. You'll see it in the standard digest.</p>
${cacheOnly ? '<p style="color:#666;font-size:12px">Cache-only mode: lines without a recent envelope will be skipped silently — no API spend.</p>' : ''}
<p style="color:#888;font-size:11px">Sentinel: <code>~/workspace/.large-rfq-pending/${esc(rfq_number)}.cleared</code></p>
</body></html>`;
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `[CONFIRMED] Large RFQ ${rfq_number} approved${tagLine}`,
    ackHtml,
    { html: true }
  );
  return { approved: rfq_number, maxLines, cacheOnly };
}

/**
 * Reject a large-RFQ enrichment request.
 *
 * Required payload: { rfq_number }
 * Optional: { reason }
 */
async function action_reject_large_rfq(payload, ctx) {
  const { rfq_number, reason } = payload;
  if (ctx.dryRun) {
    return { dry_run: true, would_reject: { rfq_number, reason } };
  }
  largeRfqGate.markRejected(rfq_number, {
    reason,
    rejectedBy: ctx.from || ctx.jakeEmail || 'email',
  });
  const reasonLine = reason ? `<p>Reason: ${esc(reason)}</p>` : '';
  const ackHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Got it — <b>RFQ ${esc(rfq_number)}</b> rejected. The enrich-poller will skip this RFQ permanently.</p>
${reasonLine}
<p style="color:#888;font-size:11px">Sentinel: <code>~/workspace/.large-rfq-pending/${esc(rfq_number)}.rejected</code> — delete this file to un-reject if needed.</p>
</body></html>`;
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `[CONFIRMED] Large RFQ ${rfq_number} rejected`,
    ackHtml,
    { html: true }
  );
  return { rejected: rfq_number };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildNeedInfoReply(missing) {
  const lines = [];
  if (missing.includes('mpn'))      lines.push('• **MPN list** — I couldn\'t extract part numbers from the message. Could you reply with an MPN + quantity table?');
  if (missing.includes('qty'))      lines.push('• **Quantities** — quantities weren\'t listed for some line items. Could you confirm the qty for each part?');
  if (missing.includes('rfq_type')) lines.push('• **RFQ type** — is this a Shortage, PPV, EOL/LTB, or another program? (Options: Shortage, PPV, EOL/LTB, 3PL/VMI, Hot Parts)');
  if (missing.includes('contact'))  lines.push('• **Contact confirmation** — I couldn\'t match your address to a contact on file. Is this the best email for this RFQ?');
  if (missing.includes('customer')) lines.push('• **Company** — could you confirm the company name and account I should load this under?');
  return [
    `Hi,`, ``,
    `Thanks for sending this RFQ. Before I can load it into our system, I need a few details:`, ``,
    ...lines, ``,
    `Once I have these I'll get the RFQ loaded and routed to the right person here.`, ``,
    `Thanks,`, `Astute Group RFQ Loading`,
  ].join('\n');
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'rfqloading@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'rfqloading@orangetsunami.com',
    fromName: 'RFQ Loading',
  },
  actions: {
    enqueue: {
      folder: 'Processed',
      requires: ['bpartnerId', 'type', 'userId', 'lines'],
      handler: action_enqueue,
    },
    need_info: {
      folder: 'NeedInfo',
      requires: ['recipient', 'missing'],
      handler: action_need_info,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_rfq: {
      folder: 'NotRFQ',
      handler: null,  // move-only, no side effects
    },
    approve_large_rfq: {
      folder: 'LargeRFQApprovals',
      requires: ['rfq_number'],
      handler: action_approve_large_rfq,
    },
    reject_large_rfq: {
      folder: 'LargeRFQApprovals',
      requires: ['rfq_number'],
      handler: action_reject_large_rfq,
    },
  },
};
