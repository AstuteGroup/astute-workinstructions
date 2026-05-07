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
  },
};
