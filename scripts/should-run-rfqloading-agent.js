#!/usr/bin/env node
/**
 * Gate for rfqloading-agent — decides whether this 5-min tick should
 * actually invoke the LLM agent or skip silently.
 *
 * RULE:
 *   - BURST window: if any large-RFQ pending sentinel was queued in the
 *     last 10 minutes, run the agent every 5m so an operator reply gets
 *     picked up fast (test confirmed turnaround at +5 / +10 min).
 *   - STEADY cadence: every 30 minutes (current minute === 0 or 30) the
 *     agent always runs, so customer RFQs that arrive at any time get
 *     processed within ~30m.
 *   - Otherwise: skip this tick (exit 1) — the cron `&&` short-circuit
 *     prevents `claude -p` from being invoked, saving LLM cost.
 *
 * Exit 0 → tick should run (caller invokes claude).
 * Exit 1 → tick should skip (caller short-circuits).
 *
 * Inputs:
 *   ~/workspace/.large-rfq-pending/{rfq#}.json — sentinel files with
 *   `queued_at` ISO timestamp. Cleared/rejected sentinels don't trigger
 *   burst (no reply expected). Already-processed sentinels don't either.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PENDING_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-rfq-pending'
);
const BURST_WINDOW_MIN = parseInt(process.env.RFQLOADING_BURST_WINDOW_MIN, 10) || 10;
const STEADY_BOUNDARY_MIN = [0, 30];

function inBurstWindow() {
  if (!fs.existsSync(PENDING_DIR)) return false;
  const now = Date.now();
  const cutoffMs = BURST_WINDOW_MIN * 60 * 1000;
  for (const f of fs.readdirSync(PENDING_DIR)) {
    if (!f.endsWith('.json')) continue;
    const rfqNumber = f.slice(0, -'.json'.length);
    // Skip cleared / rejected / already-processed — no reply expected.
    if (fs.existsSync(path.join(PENDING_DIR, `${rfqNumber}.cleared`))) continue;
    if (fs.existsSync(path.join(PENDING_DIR, `${rfqNumber}.rejected`))) continue;
    if (fs.existsSync(path.join(PENDING_DIR, `${rfqNumber}.processed`))) continue;
    try {
      const sentinel = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf-8'));
      const queuedMs = new Date(sentinel.queued_at).getTime();
      if (Number.isFinite(queuedMs) && (now - queuedMs) <= cutoffMs) return true;
    } catch { /* malformed sentinel, ignore */ }
  }
  return false;
}

function onSteadyBoundary() {
  return STEADY_BOUNDARY_MIN.includes(new Date().getMinutes());
}

const burst = inBurstWindow();
const steady = onSteadyBoundary();
if (burst || steady) {
  console.error(`rfqloading-agent: running (burst=${burst}, steady=${steady})`);
  process.exit(0);
} else {
  console.error(`rfqloading-agent: skip (no burst window, not on 30m boundary)`);
  process.exit(1);
}
