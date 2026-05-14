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

const { execFileSync } = require('child_process');
const path = require('path');

const { enqueue } = require('../rfq-load-queue');
const largeRfqGate = require('../large-rfq-gate');
const pending = require('../workflow-pending-state');
const { makeApprovalActions } = require('./_approval');

// On rejection: invoke cancel-rfq-queue-items.js so any items already in the
// api retry queue for this RFQ's MPNs stop immediately. Without this hook,
// rejecting only blocks NEW enrichment — items enqueued before the rejection
// (often thousands, since rate-limit storms enqueue per-MPN) keep grinding
// through their full attempt budget. Real incident: RFQ 1134261 rejected
// 2026-05-13, 14,783 in-flight items kept retrying through 2026-05-14.
//
// The cancel script writes a {RFQ}.cancel-mpns.json manifest next to the
// rejection sentinel AND does an immediate queue purge under the queue lock.
// process-api-queue.js also reads the manifest each tick as a safety net.
async function cancelRejectedRfqRetries(rfqNumber, ctx, { reason } = {}) {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'cancel-rfq-queue-items.js');
  const args = [script, String(rfqNumber)];
  if (reason) args.push('--reason', reason);
  try {
    const out = execFileSync(process.execPath, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000,
    });
    const cancelledLine = out.split('\n').find(l => /Cancelled \d+ pending items/.test(l));
    const match = cancelledLine && cancelledLine.match(/Cancelled (\d+) pending items.*?: (\d+) → (\d+)/);
    if (match) {
      return { cancelled: Number(match[1]), pending_before: Number(match[2]), pending_after: Number(match[3]) };
    }
    return { ok: true, output_tail: out.slice(-400) };
  } catch (err) {
    return { error: err.message };
  }
}

const { action_approve: action_approve_large_rfq, action_reject: action_reject_large_rfq } =
  makeApprovalActions(largeRfqGate, {
    workflow: 'rfq-loading',
    payloadKey: 'rfq_number',
    recordLabel: 'Large RFQ',
    downstreamLabel: 'enrich-poller',
    downstreamLeadTime: 'within 15 min',
    supportsCacheOnly: true,
    onReject: cancelRejectedRfqRetries,
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
 * Email the OPERATOR (Jake) requesting the missing fields. The sidecar
 * persists the partial extraction so Jake's reply (or a forwarded customer
 * reply with the answer) round-trips and stitches on the next agent tick.
 *
 * POLICY (2026-05-14): info-requests NEVER go to the external sender. The
 * original-sender variant was removed alongside the stockrfq clarify_partner
 * leak. The `recipient` field on the payload is IGNORED and retained only
 * for backward compatibility with the agent prompt.
 *
 * Reply-To = rfqloading@ so Jake's reply (with the answers) loops back to
 * this inbox and the sidecar-stitch path picks it up next tick.
 *
 * Required payload: { missing[] }
 * Optional / accepted: { recipient, subject, extracted, outerFrom }
 *   recipient   IGNORED — handler always sends to Jake
 *   outerFrom   the external customer's email — shown in the triage email
 *   subject     the original message's subject line (for the RE:)
 *   extracted   whatever the agent already parsed (lines, bpartnerId, type)
 *               persisted to the sidecar for the merge on the next round
 */
async function action_need_info(payload, ctx) {
  const { missing, subject, extracted, outerFrom, investigation_summary } = payload;
  const missingList = Array.isArray(missing) ? missing : [];
  const linesCount = Array.isArray(extracted && extracted.lines) ? extracted.lines.length : 0;

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: missingList,
      investigation_summary: investigation_summary || null,
    });
  }
  if (!ctx.dryRun) {
    breadcrumbs.write({
      cog: 'rfq-loading-agent',
      event: 'escalated-need_info',
      uid: ctx.uid,
      missing: missingList,
      investigation_summary: investigation_summary || null,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;
  const missingItems = missingList.map(m => `<li>${esc(missingLabel(m))}</li>`).join('');
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">RFQ Loading — info needed</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>External sender:</b> ${esc(outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
   <b>Lines parsed so far:</b> ${linesCount}</p>
<p><b>Missing fields:</b></p>
<ul>${missingItems || '<li>(none specified)</li>'}</ul>
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply to ${esc(ctx.inbox)} with the missing values</b> — the next agent tick will merge your answers with the parsed lines and enqueue the RFQ. One-line prose answers are fine.
</p>
<p style="color:#666;font-size:11px">To discard instead of answering: reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code> on the first line. The next tick will move this to NotRFQ and clear the pending state.</p>
<p style="color:#666;font-size:11px">Message moved to NeedInfo folder. Sidecar: <code>~/workspace/.rfq-loading-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_notify_jake: { subject, outerFrom, missing: missingList, linesCount },
      would_write_sidecar: { anchor: ctx.anchorMessageId, extracted, missing: missingList },
    };
  }
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `RFQ Loading — needs info: ${subject || '(no subject)'}`,
    html,
    { html: true, replyTo: ctx.inbox },
  );
  return {
    notified: ctx.jakeEmail,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

function missingLabel(key) {
  switch (key) {
    case 'mpn':      return 'MPN list — couldn\'t extract part numbers';
    case 'qty':      return 'Quantities — missing for some line items';
    case 'rfq_type': return 'RFQ type (Shortage / PPV / EOL/LTB / 3PL/VMI / Hot Parts)';
    case 'contact':  return 'Contact — sender doesn\'t match a contact on file';
    case 'customer': return 'Company / account to load under';
    default:         return key;
  }
}

/**
 * Email Jake diagnostics for manual triage.
 *
 * Required payload: { reason }
 * Optional: { details, subject, from }
 */
async function action_needs_review(payload, ctx) {
  const { reason, details, subject, from, investigation_summary } = payload;
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
  breadcrumbs.write({
    cog: 'rfq-loading-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    reason,
    investigation_summary: investigation_summary || null,
  });
  return { notified: ctx.jakeEmail };
}

// action_approve_large_rfq + action_reject_large_rfq are produced by
// makeApprovalActions(largeRfqGate, ...) at the top of this file. Generic
// payload coercion, sentinel write, and operator ack live in
// shared/workflow-actions/_approval.js so excess/VQ/Stock RFQ get the same
// behavior the moment they add their own gate.

/**
 * Operator-initiated discard of a pending escalation. Triggered when Jake
 * replies to a need_info email with a directive like SKIP / IGNORE / DROP /
 * DISCARD. The agent parses the directive in the stitch-logic step via
 * shared/workflow-reply-grammars.parseSidecarReplyDirective and routes here.
 *
 * Side effects:
 *   - Silent move to NotRFQ (signal we considered + declined to load).
 *   - The poller clears the sidecar automatically (action is NOT keepsPending).
 *
 * Required payload: { reason }
 */
const breadcrumbs = require('../breadcrumbs');
async function action_drop_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'operator-dropped' };
  }
  breadcrumbs.write({
    cog: 'rfq-loading-agent',
    event: 'operator-dropped',
    uid: ctx.uid,
    reason: payload.reason || 'operator-dropped',
    pending_kind: ctx.pendingSidecar && ctx.pendingSidecar.kind || null,
  });
  return { reason: payload.reason || 'operator-dropped' };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      requires: ['missing'],
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
    drop_pending: {
      folder: 'NotRFQ',
      requires: ['reason'],
      handler: action_drop_pending,
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
