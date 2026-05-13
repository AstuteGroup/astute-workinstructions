/**
 * shared/workflow-actions/_template.js
 *
 * Scaffold for a NEW email-driven workflow. Copy this file to
 * `<workflow-name>.js`, delete what doesn't apply, and add a matching entry to
 * `shared/workflow-registry.js`. The parity check (scripts/check-workflow-parity.js)
 * will tell you the moment you've forgotten something.
 *
 * Pre-wired in this template (just keep what you need):
 *   - replyStitching         via workflow-pending-state sidecar + keepsPending on need_info
 *   - needInfoClarifications via action_need_info — pre-built reply + sidecar write
 *   - largePayloadGate       via shared/large-rfq-gate (rename to large-payload-gate
 *                            once the generalization lands)
 *   - approvalReplyAction    via action_approve_large_X / action_reject_large_X
 *   - breadcrumbWrites       via shared/breadcrumbs
 *   - writeQueue             via TODO — pick a queue module (rfq-load-queue,
 *                            crossref-queue, or build a new one if neither fits)
 *
 * To enable a capability:
 *   1. Keep the relevant action(s) below.
 *   2. Set capabilities.<name> = true in workflow-registry.js for this workflow.
 *   3. Run `node scripts/check-workflow-parity.js` — it verifies the wiring matches.
 *
 * To declare a deviation (intentional NO):
 *   1. Delete the relevant action(s) below.
 *   2. Set capabilities.<name> = false AND add a non-empty deviations.<name>
 *      string in workflow-registry.js explaining WHY this workflow doesn't need it.
 *
 * If capabilities.<name> = false WITHOUT a deviation entry, the parity check
 * lists it as an OPEN GAP — meaning "yes, this workflow should have it eventually."
 * Use that for the migration backlog.
 */

'use strict';

// ─── DEPENDENCIES (keep what you use; delete the rest) ───────────────────────

// Inbound write target — pick the right writer for your domain.
// const { writeRFQ } = require('../rfq-writer');
// const { writeOffer } = require('../offer-writeback');
// const { writeVQFromAPI } = require('../vq-writer');
// const { writeCQBatch } = require('../cq-writer');

// Optional pre-write staging queue (for high-throughput or burst-prone inbox).
// const { enqueue } = require('../rfq-load-queue');

// Optional large-payload approval gate.
// const largePayloadGate = require('../large-rfq-gate');

// Reply-stitching sidecar (REQUIRED if you keep action_need_info / action_clarify_*).
const pending = require('../workflow-pending-state');

// Structured event log for digest + drift visibility (recommended).
const breadcrumbs = require('../breadcrumbs');

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Load an extracted record to OT.
 *
 * Required payload: depends on the writer you chose above.
 *   - rfq-writer:    { bpartnerId, type, lines, ... }
 *   - offer-writeback: { bpartnerId, offerType, lines, ... }
 *   - vq-writer:     ...
 *   - cq-writer:     ...
 *
 * Optional: { description, sourceUid }
 */
async function action_load(payload, ctx) {
  const { bpartnerId, lines, sourceUid /* ... */ } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, lineCount: lines.length },
    };
  }

  // PRE-WRITE IDEMPOTENCY CHECK (recommended). Replace the writer-internal
  // natural-key dedup with an explicit lookup. Example:
  //
  //   const existing = await checkForExisting(bpartnerId, lines);
  //   if (existing) {
  //     breadcrumbs.write({ cog: ctx.workflow, event: 'dup-skipped', uid: ctx.uid });
  //     return { skipped: true, existingId: existing.id };
  //   }

  // const result = await writeX({ bpartnerId, lines, ... });

  breadcrumbs.write({
    cog: ctx.workflow,
    event: 'loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    bpartnerId,
    // recordId: result.id,
    // linesWritten: result.linesWritten,
  });

  return { /* result fields */ };
}

/**
 * Ask the sender for missing details — clarification round-trip.
 *
 * Reply-stitching: ctx.anchorMessageId is used as the sidecar key. When the
 * sender replies (typically without re-quoting the original parts list), the
 * poller will attach `pending_state` to the next-tick read so the agent merges
 * what was already extracted with the reply body.
 *
 * Required payload: { recipient, missing[] }
 * Optional: { subject, extracted } — partial extraction to persist for merge
 */
async function action_need_info(payload, ctx) {
  const { recipient, missing, subject, extracted } = payload;
  const body = buildNeedInfoReply(missing);

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

  // CRITICAL: replyTo MUST be the workflow inbox (ctx.inbox), NOT jakeEmail.
  // Otherwise the sender's reply lands in Jake's inbox and the agent never
  // sees it, breaking the stitch round-trip.
  await ctx.notifier.sendEmail(
    recipient,
    `RE: ${subject || 'Your message'} — details needed`,
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
 * Email operator for manual triage. Used for parse failures, ambiguous routing,
 * writer errors.
 *
 * Required payload: { reason }
 * Optional: { subject, outerFrom, details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, outerFrom, details } = payload;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">${esc(ctx.workflow)} — needs manual review</h2>
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
    `${ctx.workflow} — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true },
  );
  breadcrumbs.write({
    cog: ctx.workflow,
    event: 'needs-review',
    uid: ctx.uid,
    reason,
  });
  return { notified: ctx.jakeEmail };
}

/**
 * Silent move — message is not in scope for this workflow.
 *
 * Required payload: { reason }
 */
async function action_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: ctx.workflow,
    event: 'skip',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Approve a large-payload-gated payload (operator replied YES to the approval
 * email). Delete this action if largePayloadGate doesn't apply to this workflow.
 *
 * Required payload: { record_number }
 * Optional: { max_lines, cache_only, note }
 */
// async function action_approve_large(payload, ctx) {
//   const { record_number, max_lines, cache_only, note } = payload;
//   if (ctx.dryRun) {
//     return { dry_run: true, would_approve: { record_number, max_lines, cache_only, note } };
//   }
//   largePayloadGate.markApproved(record_number, {
//     maxLines: Number.isFinite(Number(max_lines)) && Number(max_lines) > 0 ? Number(max_lines) : null,
//     cacheOnly: cache_only === true || cache_only === 'true',
//     approvedBy: ctx.from || ctx.jakeEmail || 'email',
//     note,
//   });
//   await ctx.notifier.sendEmail(
//     ctx.jakeEmail,
//     `[CONFIRMED] ${ctx.workflow} ${record_number} approved`,
//     `<p>Approved. Next poller tick will pick it up.</p>`,
//     { html: true },
//   );
//   return { approved: record_number };
// }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildNeedInfoReply(missing) {
  // Customize per workflow — these are placeholders.
  const lines = [];
  if (Array.isArray(missing)) {
    for (const m of missing) {
      lines.push(`• **${m}** — could you provide this?`);
    }
  }
  return [
    `Hi,`, ``,
    `Thanks for your message. Before I can process it I need:`, ``,
    ...lines, ``,
    `Once I have these I'll get it loaded.`, ``,
    `Thanks,`,
    `Astute Group`,
  ].join('\n');
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'TODO@orangetsunami.com',
  // sourceFolder: 'INBOX',  // optional override (e.g. 'OutboundPending')
  notifierConfig: {
    fromEmail: 'TODO@orangetsunami.com',
    fromName: 'TODO Workflow',
  },
  actions: {
    load: {
      folder: 'Processed',
      requires: ['bpartnerId', 'lines'],  // adjust to your payload
      handler: action_load,
    },
    need_info: {
      folder: 'NeedInfo',
      requires: ['recipient', 'missing'],
      keepsPending: true,   // REQUIRED for stitching round-trip
      handler: action_need_info,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    skip: {
      folder: 'Skipped',
      requires: ['reason'],
      handler: action_skip,
    },
    // Uncomment if largePayloadGate applies to this workflow:
    // approve_large: {
    //   folder: 'Approvals',
    //   requires: ['record_number'],
    //   handler: action_approve_large,
    // },
  },
};
