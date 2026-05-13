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
const pending = require('../workflow-pending-state');
const { makeApprovalActions } = require('./_approval');

const { action_approve: action_approve_large_rfq, action_reject: action_reject_large_rfq } =
  makeApprovalActions(largeRfqGate, {
    workflow: 'rfq-loading',
    payloadKey: 'rfq_number',
    recordLabel: 'Large RFQ',
    downstreamLabel: 'enrich-poller',
    downstreamLeadTime: 'within 15 min',
    supportsCacheOnly: true,
  });

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
 * Auto-reply to the customer requesting missing fields. Replies route back to
 * the loader inbox (rfqloading@) so the next-tick agent can pick up the reply
 * and stitch it with the partial extraction stored in the sidecar.
 *
 * Required payload: { recipient, missing[] }
 * Optional: { subject, extracted } — `extracted` is whatever the agent already
 *           parsed from the original (lines, bpartnerId, type, etc.). It is
 *           persisted to the sidecar so the next round merges with the reply.
 */
async function action_need_info(payload, ctx) {
  const { recipient, missing, subject, extracted } = payload;
  const body = buildNeedInfoReply(missing);

  // Persist partial state so the reply (which typically won't re-quote the
  // original parts list) can be merged with what we already know.
  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: recipient || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: Array.isArray(missing) ? missing : [],
    });
  }

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_reply: { to: recipient, cc: ctx.jakeEmail, replyTo: ctx.inbox, missing },
      draft: body,
      would_write_sidecar: { anchor: ctx.anchorMessageId, extracted, missing },
    };
  }
  await ctx.notifier.sendEmail(
    recipient,
    `RE: ${subject || 'Your RFQ'} — details needed`,
    body,
    { cc: ctx.jakeEmail, replyTo: ctx.inbox },
  );
  return {
    replied_to: recipient,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: sidecarRecord ? sidecarRecord.retry_count : null,
  };
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

// action_approve_large_rfq + action_reject_large_rfq are produced by
// makeApprovalActions(largeRfqGate, ...) at the top of this file. Generic
// payload coercion, sentinel write, and operator ack live in
// shared/workflow-actions/_approval.js so excess/VQ/Stock RFQ get the same
// behavior the moment they add their own gate.

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
      keepsPending: true,
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
