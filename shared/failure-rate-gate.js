/**
 * shared/failure-rate-gate.js
 *
 * Cross-workflow gate that fires when a bulk write returns an unexpectedly
 * high rate of failures (or, secondarily, of non-dup skips that signal a
 * resolver gap).
 *
 * Why this exists
 * ---------------
 * Ivy's UID 8541 (RFQ 1133479, 5/21) showed `failed:73 / submitted:79` —
 * 92% failure. The handler wrote a `loaded` breadcrumb with that count and
 * silently moved the email to Processed. The operator only noticed because
 * Ivy followed up by email ~24h later.
 *
 * Most of those 73 turned out to be misclassified PRE_EXISTING_DUPLICATEs
 * (fixed in commit 80c9c38), but even the real-failure case (e.g., MFR
 * resolver broken, BP table out of sync) deserves an immediate operator
 * alert rather than a silent write-and-move-on.
 *
 * This module is the second-line defense: an opinionated rate gate applied
 * AFTER the writer returns. It is a notification helper, not a flow blocker
 * — the writes (or skips) have already happened. The signal lets the
 * operator decide whether to investigate before the next batch lands.
 *
 * Output is a structured `{flag, severity, reason, ratios, ...}` so callers
 * (handlers, digests) can decide whether to email, move to NeedsReview,
 * or just breadcrumb.
 *
 * Defaults are deliberately conservative — better a few false-positive
 * pings than another 24h silent miss.
 */

'use strict';

/**
 * Evaluate a writer result for unhealthy failure / non-dup-skip patterns.
 *
 * @param {object} opts
 * @param {object} opts.result          writer result (bucket-style preferred;
 *                                       count-style errors[] is recognized but
 *                                       gives less signal — see notes below)
 * @param {number} [opts.failedThreshold=0.30]
 *                                       Rate above which "failed" alone fires
 *                                       a high-severity flag
 * @param {number} [opts.skipResolverThreshold=0.50]
 *                                       Rate above which non-dup skips
 *                                       (VENDOR_NOT_FOUND, NO_MPN_MATCH) fire
 *                                       a medium-severity flag
 * @param {number} [opts.minSubmitted=10]
 *                                       Don't fire on tiny batches (a single-
 *                                       quote 1/1 failure is not actionable
 *                                       at this layer; one quote's writer
 *                                       error is already breadcrumbed)
 * @returns {{
 *   flag: boolean,
 *   severity: 'none'|'medium'|'high',
 *   reason: string|null,
 *   submitted: number,
 *   written: number,
 *   skippedTotal: number,
 *   skippedDuplicates: number,
 *   skippedResolverGaps: number,
 *   failed: number,
 *   ratios: { failed: number, resolverSkip: number, dupSkip: number }
 * }}
 */
function evaluateFailureRate(opts = {}) {
  const result = opts.result || {};
  const failedThreshold = opts.failedThreshold != null ? opts.failedThreshold : 0.30;
  const skipResolverThreshold = opts.skipResolverThreshold != null ? opts.skipResolverThreshold : 0.50;
  const minSubmitted = opts.minSubmitted != null ? opts.minSubmitted : 10;

  const written = Array.isArray(result.written) ? result.written.length : 0;
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const failed = Array.isArray(result.failed) ? result.failed.length : 0;

  // Categorize skipped rows by reason
  const DUP_REASONS = new Set([
    'PRE_EXISTING_DUPLICATE',  // vq-writer
    'DUP_EXISTING_CQ',         // cq-writer
  ]);
  const RESOLVER_GAP_REASONS = new Set([
    'VENDOR_NOT_FOUND',
    'NO_MPN_MATCH',
  ]);
  let dupSkips = 0;
  let resolverSkips = 0;
  for (const s of skipped) {
    if (DUP_REASONS.has(s.reason)) dupSkips++;
    else if (RESOLVER_GAP_REASONS.has(s.reason)) resolverSkips++;
  }

  const submitted = written + skipped.length + failed;

  // Don't fire on tiny batches — one-quote loads carry their own breadcrumb
  // and don't benefit from a rate-based meta-alert.
  if (submitted < minSubmitted) {
    return { flag: false, severity: 'none', reason: null,
      submitted, written, skippedTotal: skipped.length, skippedDuplicates: dupSkips,
      skippedResolverGaps: resolverSkips, failed,
      ratios: { failed: 0, resolverSkip: 0, dupSkip: 0 },
    };
  }

  const ratioFailed = failed / submitted;
  const ratioResolverSkip = resolverSkips / submitted;
  const ratioDupSkip = dupSkips / submitted;

  // High failure rate wins: writer-side breakage is a strict superset of
  // "operator must investigate now."
  if (ratioFailed >= failedThreshold) {
    return {
      flag: true, severity: 'high',
      reason: `failed rate ${(ratioFailed*100).toFixed(1)}% >= threshold ${(failedThreshold*100).toFixed(0)}% (${failed}/${submitted})`,
      submitted, written, skippedTotal: skipped.length, skippedDuplicates: dupSkips,
      skippedResolverGaps: resolverSkips, failed,
      ratios: { failed: ratioFailed, resolverSkip: ratioResolverSkip, dupSkip: ratioDupSkip },
    };
  }

  // Medium: most of the batch skipped due to resolver gaps (vendor/MPN
  // unmatched). Likely root cause: BP table out of sync, agent extracting
  // wrong field, RFQ misaligned. Not as urgent as a writer failure but
  // worth surfacing.
  if (ratioResolverSkip >= skipResolverThreshold) {
    return {
      flag: true, severity: 'medium',
      reason: `non-dup skip rate ${(ratioResolverSkip*100).toFixed(1)}% >= threshold ${(skipResolverThreshold*100).toFixed(0)}% (resolver-gap ${resolverSkips}/${submitted})`,
      submitted, written, skippedTotal: skipped.length, skippedDuplicates: dupSkips,
      skippedResolverGaps: resolverSkips, failed,
      ratios: { failed: ratioFailed, resolverSkip: ratioResolverSkip, dupSkip: ratioDupSkip },
    };
  }

  // Healthy: most quotes either wrote or skipped as legit duplicates.
  return {
    flag: false, severity: 'none', reason: null,
    submitted, written, skippedTotal: skipped.length, skippedDuplicates: dupSkips,
    skippedResolverGaps: resolverSkips, failed,
    ratios: { failed: ratioFailed, resolverSkip: ratioResolverSkip, dupSkip: ratioDupSkip },
  };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Run the gate and, on flag, side-effect:
 *   - write a 'high-failure-rate-detected' breadcrumb on the caller's cog
 *   - email the operator (ctx.jakeEmail) via ctx.notifier
 *
 * Best-effort. Never throws. Returns the gate evaluation regardless.
 *
 * @param {object} opts
 * @param {string} opts.cog        breadcrumb cog ('vq-loading-agent', 'stockrfq-cq-agent', ...)
 * @param {string} opts.workflow   workflow label for the email subject
 * @param {object} opts.ctx        handler ctx
 * @param {string|number} opts.target  RFQ search key / offer id / etc. — surfaced in alert
 * @param {object} opts.result     writer result
 * @param {object} [opts.thresholds]   optional override forwarded to evaluateFailureRate
 * @returns {Promise<object>}      gate evaluation
 */
async function notifyHighFailureRate(opts) {
  const breadcrumbs = require('./breadcrumbs');
  const { cog, workflow, ctx, target, result, thresholds } = opts;
  const gateEval = evaluateFailureRate({ result, ...(thresholds || {}) });
  if (!gateEval.flag) return gateEval;

  try {
    breadcrumbs.write({
      cog,
      event: 'high-failure-rate-detected',
      severity: gateEval.severity,
      uid: ctx && ctx.uid,
      messageId: (ctx && ctx.currentMessageId) || null,
      target,
      reason: gateEval.reason,
      submitted: gateEval.submitted,
      written: gateEval.written,
      skippedTotal: gateEval.skippedTotal,
      skippedDuplicates: gateEval.skippedDuplicates,
      skippedResolverGaps: gateEval.skippedResolverGaps,
      failed: gateEval.failed,
    });
  } catch (_) { /* best-effort */ }

  if (ctx && ctx.notifier && ctx.jakeEmail) {
    const subj = `[${workflow}] High ${gateEval.severity === 'high' ? 'failure' : 'skip'} rate on ${target} — investigate`;
    const color = gateEval.severity === 'high' ? '#c00' : '#b80';
    const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h3 style="color:${color}">Rate gate fired (${gateEval.severity})</h3>
<p>${escHtml(gateEval.reason)}</p>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">
  <tr><th align="left">Bucket</th><th align="right">Count</th></tr>
  <tr><td>submitted</td><td align="right">${gateEval.submitted}</td></tr>
  <tr><td>written</td><td align="right">${gateEval.written}</td></tr>
  <tr><td>skipped (duplicates, OK)</td><td align="right">${gateEval.skippedDuplicates}</td></tr>
  <tr><td>skipped (resolver gaps)</td><td align="right">${gateEval.skippedResolverGaps}</td></tr>
  <tr><td><b>failed</b></td><td align="right"><b>${gateEval.failed}</b></td></tr>
</table>
<p style="margin-top:12px">Target: <code>${escHtml(target)}</code><br/>
Source UID: ${escHtml(ctx.uid)}<br/>
Message-ID: <code>${escHtml((ctx && ctx.currentMessageId) || '(none)')}</code></p>
<p>Per-row reasons in <code>~/workspace/.writer-attribution.jsonl</code> (filter by messageId).</p>
</body></html>`;
    try {
      await ctx.notifier.sendEmail(ctx.jakeEmail, subj, html, { html: true });
    } catch (_) { /* best-effort */ }
  }

  return gateEval;
}

module.exports = {
  evaluateFailureRate,
  notifyHighFailureRate,
};
