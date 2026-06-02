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
 * Two false-alarm sources are filtered out so the alert stays trustworthy:
 *   1. FAN-OUT (commit ad7edb7): when the same quote set is written against
 *      a primary + N secondary RFQs, each RFQ legitimately owns only a subset
 *      of the quoted MPNs, so NO_MPN_MATCH is EXPECTED per-RFQ — excluded from
 *      both the resolver-gap numerator and the rate denominator when fanOut.
 *   2. OT-DOWN (2026-05-26): a network/transport failure (OT REST API
 *      unreachable) is an infrastructure event, not a data problem. `failed[]`
 *      rows tagged network:true / reason OT_UNREACHABLE are split out; the
 *      data-quality thresholds evaluate on LOGICAL failures only, and a
 *      distinct `severity:'ot-down'` is returned so the caller routes to
 *      notifyOtUnreachable() (calm "loading paused, will resume" email +
 *      resume sidecar) instead of the red data alarm. During an OT outage
 *      resolveBP also returns null → VENDOR_NOT_FOUND skips that look like
 *      data gaps but aren't, so when ANY network failure is present those
 *      resolver-gap skips are folded into the reason rather than alarmed on.
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

const fs = require('fs');
const path = require('path');
const { OT_UNREACHABLE } = require('./ot-error');

/**
 * Evaluate a writer result for unhealthy failure / non-dup-skip patterns.
 *
 * @param {object} opts
 * @param {object} opts.result          writer result (bucket-style preferred;
 *                                       count-style errors[] is recognized but
 *                                       gives less signal — see notes below)
 * @param {number} [opts.failedThreshold=0.30]
 *                                       Rate above which LOGICAL "failed" alone
 *                                       fires a high-severity flag
 * @param {number} [opts.skipResolverThreshold=0.50]
 *                                       Rate above which non-dup skips
 *                                       (VENDOR_NOT_FOUND, NO_MPN_MATCH) fire
 *                                       a medium-severity flag
 * @param {number} [opts.minSubmitted=10]
 *                                       Don't fire on tiny batches (a single-
 *                                       quote 1/1 failure is not actionable
 *                                       at this layer; one quote's writer
 *                                       error is already breadcrumbed)
 * @param {boolean} [opts.fanOut=false]  this result is ONE of several RFQs the
 *                                       same quote set was written against
 * @returns {{
 *   flag: boolean,
 *   severity: 'none'|'medium'|'high'|'ot-down',
 *   otDown: boolean,
 *   reason: string|null,
 *   submitted: number,
 *   evaluated: number,
 *   written: number,
 *   skippedTotal: number,
 *   skippedDuplicates: number,
 *   skippedResolverGaps: number,
 *   skippedNoMpnMatch: number,
 *   failed: number,
 *   failedNetwork: number,
 *   failedLogical: number,
 *   fanOut: boolean,
 *   ratios: { failed: number, failedLogical: number, network: number, resolverSkip: number, dupSkip: number }
 * }}
 */
function evaluateFailureRate(opts = {}) {
  const result = opts.result || {};
  const failedThreshold = opts.failedThreshold != null ? opts.failedThreshold : 0.30;
  const skipResolverThreshold = opts.skipResolverThreshold != null ? opts.skipResolverThreshold : 0.50;
  const minSubmitted = opts.minSubmitted != null ? opts.minSubmitted : 10;
  // fanOut: this result is ONE of several RFQs the same quote set was written
  // against (primary + secondaries). See NO_MPN_MATCH handling below.
  const fanOut = !!opts.fanOut;

  const written = Array.isArray(result.written) ? result.written.length : 0;
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const failedRows = Array.isArray(result.failed) ? result.failed : [];

  // Split failed rows: network/transport (OT down — retryable, NOT a data
  // problem) vs logical (bad FK, missing field, bean-callout reject — real).
  // Writers tag network failures with network:true / reason OT_UNREACHABLE
  // (see shared/ot-error.js).
  let failedNetwork = 0;
  let failedLogical = 0;
  for (const f of failedRows) {
    if (f && (f.network === true || f.reason === OT_UNREACHABLE)) failedNetwork++;
    else failedLogical++;
  }
  const failed = failedRows.length;

  // Categorize skipped rows by reason
  const DUP_REASONS = new Set([
    'PRE_EXISTING_DUPLICATE',  // vq-writer
    'DUP_EXISTING_CQ',         // cq-writer
  ]);
  let dupSkips = 0;
  let vendorNotFoundSkips = 0;
  let noMpnMatchSkips = 0;
  for (const s of skipped) {
    if (DUP_REASONS.has(s.reason)) dupSkips++;
    else if (s.reason === 'VENDOR_NOT_FOUND') vendorNotFoundSkips++;
    else if (s.reason === 'NO_MPN_MATCH') noMpnMatchSkips++;
  }

  // NO_MPN_MATCH means "this quote matches no line on THIS RFQ." In a fan-out
  // load (the same quote set written against primary + N secondary RFQs), each
  // RFQ legitimately owns only a subset of the quoted MPNs, so a high
  // NO_MPN_MATCH rate per-RFQ is EXPECTED — not a resolver gap. Counting it
  // inflated the skip ratio and fired false "high skip rate" alerts (UID 8655,
  // 5/25: 11/20 = 55% on RFQs 1135458 + 1133971, each carrying only 1 of the 3
  // quoted MPNs). When fanOut, drop NO_MPN_MATCH from BOTH the resolver-gap
  // numerator AND the ratio denominator — those quotes were never "for" this
  // RFQ. In a single-RFQ load it still counts: there, a wall of NO_MPN_MATCH
  // can mean the agent extracted wrong MPNs or cited the wrong RFQ, and that
  // signal is worth keeping.
  const resolverSkips = vendorNotFoundSkips + (fanOut ? 0 : noMpnMatchSkips);
  const submitted = written + skipped.length + failed;
  // Denominator for the rate decision. In fan-out we judge health only over
  // the quotes that actually belonged to this RFQ.
  const evaluated = fanOut ? (submitted - noMpnMatchSkips) : submitted;

  const baseReturn = () => ({
    submitted, evaluated, written, skippedTotal: skipped.length,
    skippedDuplicates: dupSkips, skippedResolverGaps: resolverSkips,
    skippedNoMpnMatch: noMpnMatchSkips, failed, failedNetwork, failedLogical, fanOut,
  });

  // Guarded denominator: ot-down can fire on a tiny/empty batch (a single
  // network-failed quote still needs queuing), so compute ratios before the
  // minSubmitted gate without risking a /0.
  const denom = evaluated || 1;
  const ratioFailed = failed / denom;
  const ratioFailedLogical = failedLogical / denom;
  const ratioNetwork = failedNetwork / denom;
  const ratioResolverSkip = resolverSkips / denom;
  const ratioDupSkip = dupSkips / denom;
  const ratios = { failed: ratioFailed, failedLogical: ratioFailedLogical, network: ratioNetwork, resolverSkip: ratioResolverSkip, dupSkip: ratioDupSkip };
  const fanNote = fanOut && noMpnMatchSkips > 0 ? ` (fan-out: ${noMpnMatchSkips} NO_MPN_MATCH excluded)` : '';

  // OT-DOWN takes routing precedence and is INDEPENDENT of batch size. Any
  // network failure means OT was unreachable during this batch — an
  // infrastructure event. Checked BEFORE the minSubmitted gate so a fan-out
  // secondary that owns only a couple of MPNs (tiny `evaluated`) still parks a
  // resume sidecar for its network-failed quotes instead of silently dropping
  // them. It does NOT alarm; the caller parks a resume sidecar + sends the
  // calm "loading paused" notification. Resolver-gap skips in the same batch
  // are also suspect (resolveBP returns null when it can't reach OT), so we
  // fold them into the reason rather than alarming. (Genuine logical failures,
  // if any, re-surface and alarm on the resume run once OT is back.)
  if (failedNetwork > 0) {
    const resolverNote = resolverSkips
      ? `; ${resolverSkips} resolver gap(s) also suspect (resolveBP could not reach OT)`
      : '';
    return {
      flag: true, severity: 'ot-down', otDown: true,
      reason: `OT unreachable — ${failedNetwork}/${evaluated} write(s) deferred (network/transport failure)${resolverNote}${fanNote}`,
      ...baseReturn(), ratios,
    };
  }

  // Don't fire DATA alarms on tiny batches — one-quote loads carry their own
  // breadcrumb and don't benefit from a rate-based meta-alert. (Use the
  // post-exclusion count so a fan-out RFQ that only owns a couple of the
  // quoted MPNs doesn't get judged on a denominator full of other RFQs' parts.)
  if (evaluated < minSubmitted) {
    return { flag: false, severity: 'none', otDown: false, reason: null, ...baseReturn(), ratios };
  }

  // High failure rate (LOGICAL only) wins: writer-side breakage is a strict
  // superset of "operator must investigate now."
  if (ratioFailedLogical >= failedThreshold) {
    return {
      flag: true, severity: 'high', otDown: false,
      reason: `failed rate ${(ratioFailedLogical*100).toFixed(1)}% >= threshold ${(failedThreshold*100).toFixed(0)}% (${failedLogical}/${evaluated})${fanNote}`,
      ...baseReturn(), ratios,
    };
  }

  // Medium: most of the batch skipped due to resolver gaps (vendor not in BP
  // table, or — single-RFQ only — MPN unmatched). Likely root cause: BP table
  // out of sync, agent extracting wrong field, RFQ misaligned. Not as urgent
  // as a writer failure but worth surfacing.
  if (ratioResolverSkip >= skipResolverThreshold) {
    return {
      flag: true, severity: 'medium', otDown: false,
      reason: `non-dup skip rate ${(ratioResolverSkip*100).toFixed(1)}% >= threshold ${(skipResolverThreshold*100).toFixed(0)}% (resolver-gap ${resolverSkips}/${evaluated})${fanNote}`,
      ...baseReturn(), ratios,
    };
  }

  // Healthy: most quotes either wrote or skipped as legit duplicates / other-RFQ.
  return { flag: false, severity: 'none', otDown: false, reason: null, ...baseReturn(), ratios };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Run the gate and, on a DATA flag (high/medium), side-effect:
 *   - write a 'high-failure-rate-detected' breadcrumb on the caller's cog
 *   - email the operator (ctx.jakeEmail) via ctx.notifier
 *
 * On an OT-DOWN flag it breadcrumbs 'ot-unreachable-detected' and returns
 * WITHOUT sending an alarm — the caller is responsible for the calm
 * notification + resume sidecar (it has the sender/quote context). Best-
 * effort. Never throws. Returns the gate evaluation regardless.
 *
 * @param {object} opts
 * @param {string} opts.cog        breadcrumb cog ('vq-loading-agent', 'stockrfq-cq-agent', ...)
 * @param {string} opts.workflow   workflow label for the email subject
 * @param {object} opts.ctx        handler ctx
 * @param {string|number} opts.target  RFQ search key / offer id / etc. — surfaced in alert
 * @param {object} opts.result     writer result
 * @param {object} [opts.thresholds]   optional override forwarded to evaluateFailureRate
 * @param {boolean} [opts.fanOut]      forwarded to evaluateFailureRate
 * @returns {Promise<object>}      gate evaluation
 */
async function notifyHighFailureRate(opts) {
  const breadcrumbs = require('./breadcrumbs');
  const { cog, workflow, ctx, target, result, thresholds, fanOut } = opts;
  const gateEval = evaluateFailureRate({ result, fanOut, ...(thresholds || {}) });
  if (!gateEval.flag) return gateEval;

  // OT-down: infrastructure event, not data. Breadcrumb + return; the caller
  // sends the calm notification and parks the resume sidecar.
  if (gateEval.severity === 'ot-down') {
    try {
      breadcrumbs.write({
        cog, event: 'ot-unreachable-detected',
        uid: ctx && ctx.uid,
        messageId: (ctx && ctx.currentMessageId) || null,
        target,
        reason: gateEval.reason,
        submitted: gateEval.submitted,
        evaluated: gateEval.evaluated,
        written: gateEval.written,
        failedNetwork: gateEval.failedNetwork,
        failedLogical: gateEval.failedLogical,
        skippedResolverGaps: gateEval.skippedResolverGaps,
      });
    } catch (_) { /* best-effort */ }
    return gateEval;
  }

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
      evaluated: gateEval.evaluated,
      fanOut: gateEval.fanOut,
      written: gateEval.written,
      skippedTotal: gateEval.skippedTotal,
      skippedDuplicates: gateEval.skippedDuplicates,
      skippedResolverGaps: gateEval.skippedResolverGaps,
      skippedNoMpnMatch: gateEval.skippedNoMpnMatch,
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
  <tr><td>skipped (no MPN match${gateEval.fanOut ? ' — fan-out, excluded from rate' : ''})</td><td align="right">${gateEval.skippedNoMpnMatch}</td></tr>
  <tr><td>skipped (resolver gaps)</td><td align="right">${gateEval.skippedResolverGaps}</td></tr>
  <tr><td><b>failed (logical)</b></td><td align="right"><b>${gateEval.failedLogical}</b></td></tr>
  <tr><td>rate evaluated over</td><td align="right">${gateEval.evaluated}</td></tr>
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

// ── Calm "OT unreachable — loading paused" notification ──────────────────────
//
// Throttled to one email per OT_NOTIFY_THROTTLE_MS window so a multi-hour
// outage with active inbound doesn't flood the operator. The state file holds
// the last-sent timestamp; a flood within the window is collapsed (the
// individual resume sidecars are still parked regardless — the email is just
// the heads-up).
const OT_NOTIFY_STATE = path.join(
  process.env.HOME || '/home/analytics_user', 'workspace', '.ot-unreachable-last-notify.json');
const OT_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;  // 30 min

function _readLastNotify() {
  try { return JSON.parse(fs.readFileSync(OT_NOTIFY_STATE, 'utf8')).ts || 0; }
  catch (_) { return 0; }
}
function _writeLastNotify(ts) {
  try { fs.writeFileSync(OT_NOTIFY_STATE, JSON.stringify({ ts }) + '\n'); }
  catch (_) { /* best-effort */ }
}

/**
 * Send ONE calm "OT unreachable — loading paused, will resume automatically"
 * email to the operator. Lists the affected inbound email + RFQ targets and
 * the deferred-quote count. Operator-only (per the standing
 * info-requests-go-to-operator policy — we name the senders, we don't email
 * them). Throttled. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.workflow              workflow label
 * @param {object} opts.ctx                   handler ctx (notifier, jakeEmail, uid, currentMessageId)
 * @param {object} opts.affected
 * @param {string[]} [opts.affected.targets]  RFQ search keys touched by this email
 * @param {string[]} [opts.affected.senders]  inbound sender addresses (named, not emailed)
 * @param {number} opts.affected.totalDeferred  count of quotes/lines queued for retry
 * @param {string} [opts.affected.subject]    inbound subject
 * @param {boolean} [opts.force]              bypass the throttle (e.g. for tests)
 * @returns {Promise<{sent:boolean, throttled:boolean}>}
 */
async function notifyOtUnreachable({ workflow, ctx, affected = {}, force = false }) {
  if (!ctx || !ctx.notifier || !ctx.jakeEmail) return { sent: false, throttled: false };

  const now = Date.now();
  if (!force) {
    const last = _readLastNotify();
    if (now - last < OT_NOTIFY_THROTTLE_MS) {
      return { sent: false, throttled: true };
    }
  }

  const targets = Array.isArray(affected.targets) ? affected.targets : [];
  const senders = Array.isArray(affected.senders) ? affected.senders.filter(Boolean) : [];
  const totalDeferred = affected.totalDeferred != null ? affected.totalDeferred : 0;

  const subj = `[${workflow}] OT unreachable — loading paused, will resume automatically`;
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h3 style="color:#1a6">OT REST API unreachable — loading paused (not a data problem)</h3>
<p>The iDempiere/OT REST API could not be reached while processing the email below, so
<b>${escHtml(totalDeferred)}</b> quote(s)/line(s) were <b>not written</b>. They have been
<b>queued for automatic retry</b> and will load on their own once OT is back — no action needed.</p>
<table border="0" cellpadding="3" cellspacing="0" style="font-size:13px">
  <tr><td style="color:#666">Workflow</td><td>${escHtml(workflow)}</td></tr>
  <tr><td style="color:#666">Inbound subject</td><td>${escHtml(affected.subject || '(n/a)')}</td></tr>
  <tr><td style="color:#666">Source UID</td><td>${escHtml((ctx && ctx.uid) || '(n/a)')}</td></tr>
  <tr><td style="color:#666">Affected sender(s)</td><td>${senders.length ? escHtml(senders.join(', ')) : '(n/a)'}</td></tr>
  <tr><td style="color:#666">Affected RFQ(s)</td><td>${targets.length ? escHtml(targets.join(', ')) : '(n/a)'}</td></tr>
  <tr><td style="color:#666">Deferred</td><td><b>${escHtml(totalDeferred)}</b> quote(s)/line(s)</td></tr>
</table>
<p style="color:#666;font-size:12px;margin-top:12px">This is the only notification you'll get for this outage window
(throttled to one per 30&nbsp;min). The resumer cron probes OT health and replays the queued loads when it recovers;
already-written rows are de-duplicated. Senders are named here for context only — they were not emailed.</p>
</body></html>`;

  let sent = false;
  try {
    sent = await ctx.notifier.sendEmail(ctx.jakeEmail, subj, html, { html: true });
  } catch (_) { sent = false; }
  if (sent) _writeLastNotify(now);
  return { sent, throttled: false };
}

module.exports = {
  evaluateFailureRate,
  notifyHighFailureRate,
  notifyOtUnreachable,
};
