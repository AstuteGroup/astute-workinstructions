/**
 * shared/workflow-actions/_approval.js
 *
 * Factory for the approve_X / reject_X action pair used by any workflow that
 * gates oversized payloads via shared/large-payload-gate.js. RFQ Loading was
 * the first to need this; once excess or VQ Loading add a large-payload gate,
 * they wire their actions through the same factory.
 *
 * Use:
 *   const largeRfqGate = require('../large-rfq-gate');
 *   const { makeApprovalActions } = require('./_approval');
 *   const { action_approve, action_reject } = makeApprovalActions(largeRfqGate, {
 *     workflow: 'rfq-loading',
 *     payloadKey: 'rfq_number',          // payload field that carries the id
 *     recordLabel: 'Large RFQ',           // human label in subject + body
 *     downstreamLeadTime: 'within 15 min',// "next ... tick" timing hint
 *     downstreamLabel: 'enrich-poller',   // what the next consumer is
 *     supportsCacheOnly: true,            // RFQ supports the cache-only directive
 *   });
 *   // then bind to your action names:
 *   actions: {
 *     approve_large_rfq: { folder: 'LargeRFQApprovals', requires: ['rfq_number'], handler: action_approve },
 *     reject_large_rfq:  { folder: 'LargeRFQApprovals', requires: ['rfq_number'], handler: action_reject },
 *   }
 *
 * The factory handles:
 *   - payload coercion (max_lines → number, cache_only → bool)
 *   - gate.markApproved / gate.markRejected calls
 *   - dry-run shape
 *   - operator acknowledgment email (subject + HTML body)
 *
 * Each workflow chooses its action names (approve_large_rfq, approve_large_offer,
 * etc.) and payload key — the factory doesn't impose either.
 */

'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeApprovalActions(gate, {
  workflow,
  payloadKey,
  recordLabel,
  downstreamLeadTime = 'on the next poll tick',
  downstreamLabel = 'downstream consumer',
  supportsCacheOnly = false,
  onApprove,
  onReject,
} = {}) {
  if (!gate || typeof gate.markApproved !== 'function') {
    throw new Error('_approval: gate must expose markApproved / markRejected / sentinelPath');
  }
  if (!payloadKey || typeof payloadKey !== 'string') {
    throw new Error('_approval: payloadKey is required (e.g. "rfq_number")');
  }
  if (!recordLabel || typeof recordLabel !== 'string') {
    throw new Error('_approval: recordLabel is required (e.g. "Large RFQ")');
  }

  /**
   * Approve a gate-pending record. Reads the id from payload[payloadKey].
   *
   * Required payload: { [payloadKey]: <id> }
   * Optional:
   *   max_lines    cap on lines to process when downstream runs (passed through
   *                to gate.markApproved as maxLines)
   *   cache_only   if the workflow supportsCacheOnly, write VQs from cache only
   *                with no live API spend
   *   note         free-text note stored on the .cleared sentinel
   */
  async function action_approve(payload, ctx) {
    const id = payload[payloadKey];
    const { max_lines, cache_only, note } = payload;

    if (ctx.dryRun) {
      const wouldApprove = { [payloadKey]: id, max_lines, note };
      if (supportsCacheOnly) wouldApprove.cache_only = cache_only;
      return { dry_run: true, would_approve: wouldApprove };
    }

    const maxLines = Number.isFinite(Number(max_lines)) && Number(max_lines) > 0
      ? Number(max_lines) : null;
    const cacheOnly = supportsCacheOnly
      && (cache_only === true || cache_only === 'true');

    gate.markApproved(id, {
      maxLines,
      cacheOnly,
      approvedBy: ctx.from || ctx.jakeEmail || 'email',
      note,
    });

    // Optional domain-specific work — e.g., excess dispatches the offer-router
    // here. Runs AFTER markApproved so re-runs (e.g., on retry) see the cleared
    // sentinel. Errors here are surfaced to the agent but do NOT roll back the
    // approval — the operator's intent is recorded; failed downstream work is
    // operator-recoverable. Adds the result to the action return for visibility.
    let onApproveResult;
    if (typeof onApprove === 'function') {
      try {
        onApproveResult = await onApprove(id, ctx, { maxLines, cacheOnly, note });
      } catch (e) {
        onApproveResult = { onApprove_error: e.message };
      }
    }

    const tags = [];
    if (maxLines) tags.push(`capped at ${maxLines.toLocaleString('en-US')} lines`);
    if (cacheOnly) tags.push('cache-only (no live API calls)');
    const tagLine = tags.length ? ` (${tags.join('; ')})` : '';
    const cacheLine = cacheOnly
      ? '<p style="color:#666;font-size:12px">Cache-only mode: lines without a recent envelope will be skipped silently — no API spend.</p>'
      : '';

    const ackHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Got it — <b>${esc(recordLabel)} ${esc(id)}</b> approved${tagLine}.</p>
<p>The next ${esc(downstreamLabel)} tick (${esc(downstreamLeadTime)}) will pick it up.</p>
${cacheLine}
<p style="color:#888;font-size:11px">Sentinel: <code>${esc(gate.clearedPath(id))}</code></p>
</body></html>`;

    await ctx.notifier.sendEmail(
      ctx.jakeEmail,
      `[CONFIRMED] ${recordLabel} ${id} approved${tagLine}`,
      ackHtml,
      { html: true },
    );

    return { approved: id, maxLines, cacheOnly, onApprove: onApproveResult };
  }

  /**
   * Reject a gate-pending record. Reads the id from payload[payloadKey].
   *
   * Required payload: { [payloadKey]: <id> }
   * Optional:
   *   reason   free-text reason stored on the .rejected sentinel
   */
  async function action_reject(payload, ctx) {
    const id = payload[payloadKey];
    const { reason } = payload;

    if (ctx.dryRun) {
      return { dry_run: true, would_reject: { [payloadKey]: id, reason } };
    }

    gate.markRejected(id, {
      reason,
      rejectedBy: ctx.from || ctx.jakeEmail || 'email',
    });

    let onRejectResult;
    if (typeof onReject === 'function') {
      try {
        onRejectResult = await onReject(id, ctx, { reason });
      } catch (e) {
        onRejectResult = { onReject_error: e.message };
      }
    }

    const reasonLine = reason ? `<p>Reason: ${esc(reason)}</p>` : '';
    const ackHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Got it — <b>${esc(recordLabel)} ${esc(id)}</b> rejected. The ${esc(downstreamLabel)} will skip this record permanently.</p>
${reasonLine}
<p style="color:#888;font-size:11px">Sentinel: <code>${esc(gate.rejectedPath(id))}</code> — delete this file to un-reject if needed.</p>
</body></html>`;

    await ctx.notifier.sendEmail(
      ctx.jakeEmail,
      `[CONFIRMED] ${recordLabel} ${id} rejected`,
      ackHtml,
      { html: true },
    );

    return { rejected: id, onReject: onRejectResult };
  }

  return { action_approve, action_reject };
}

module.exports = { makeApprovalActions };
