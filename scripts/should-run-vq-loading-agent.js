#!/usr/bin/env node
/**
 * Gate for vq-loading-agent — decides whether this 5-min tick should
 * actually invoke the LLM agent or skip silently.
 *
 * RULE (mirrors should-run-stockrfq-agent.js):
 *   - BURST window: run if any clarify_vendor / need_info_vendor / needs_vendor
 *     sidecar in ~/workspace/.vq-loading-pending/ was touched in the last
 *     10 minutes (operator likely replying now).
 *   - STEADY cadence: run if current minute is 0, 15, 30, or 45.
 *   - Otherwise: skip (exit 1) — cron `&&` short-circuits claude -p.
 *
 * No large-payload gate for vq-loading — VQ writes are local to OT, no API
 * quota at risk. So no sentinel-dir burst trigger here; only the pending-
 * state sidecars (clarifications) drive burst.
 *
 * Exit 0 → tick should run.
 * Exit 1 → tick should skip.
 *
 * Override burst window with VQ_LOADING_BURST_WINDOW_MIN env (default 10).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/analytics_user';
const PENDING_DIR = path.resolve(HOME, 'workspace/.vq-loading-pending');
const BURST_WINDOW_MIN = parseInt(process.env.VQ_LOADING_BURST_WINDOW_MIN, 10) || 10;
const STEADY_BOUNDARY_MIN = [0, 15, 30, 45];

function freshFile(filepath, cutoffMs) {
  try {
    const st = fs.statSync(filepath);
    return (Date.now() - st.mtimeMs) <= cutoffMs;
  } catch { return false; }
}

function inBurstWindow() {
  const cutoffMs = BURST_WINDOW_MIN * 60 * 1000;
  if (!fs.existsSync(PENDING_DIR)) return false;
  for (const f of fs.readdirSync(PENDING_DIR)) {
    if (!f.endsWith('.json')) continue;
    if (freshFile(path.join(PENDING_DIR, f), cutoffMs)) return true;
  }
  return false;
}

function onSteadyBoundary() {
  return STEADY_BOUNDARY_MIN.includes(new Date().getMinutes());
}

const burst = inBurstWindow();
const steady = onSteadyBoundary();
if (burst || steady) {
  console.error(`vq-loading-agent: running (burst=${burst}, steady=${steady})`);
  process.exit(0);
}
console.error(`vq-loading-agent: skip (no burst window, not on 15m boundary)`);
process.exit(1);
