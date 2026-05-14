#!/usr/bin/env node
/**
 * Gate for excess-agent — decides whether this 5-min tick should actually
 * invoke the LLM agent or skip silently.
 *
 * RULE (mirrors should-run-rfqloading-agent.js):
 *   - BURST window: run if any pending sentinel/sidecar was queued in the
 *     last 10 minutes. Sources:
 *       ~/workspace/.large-offer-pending/<sk>.json   (large-offer gate)
 *       ~/workspace/.excess-pending/<msgid>.json     (clarify_partner sidecar)
 *   - STEADY cadence: run if current minute is 0 or 30 (every 30m boundary).
 *   - Otherwise: skip (exit 1) — cron `&&` short-circuits claude -p.
 *
 * Exit 0 → tick should run.
 * Exit 1 → tick should skip.
 *
 * Override burst window with EXCESS_BURST_WINDOW_MIN env (default 10).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/analytics_user';
const GATE_DIR    = path.resolve(HOME, 'workspace/.large-offer-pending');
const PENDING_DIR = path.resolve(HOME, 'workspace/.excess-pending');
const BURST_WINDOW_MIN = parseInt(process.env.EXCESS_BURST_WINDOW_MIN, 10) || 10;
const STEADY_BOUNDARY_MIN = [0, 30];

function freshFile(filepath, cutoffMs) {
  try {
    const st = fs.statSync(filepath);
    return (Date.now() - st.mtimeMs) <= cutoffMs;
  } catch { return false; }
}

function inBurstWindow() {
  const cutoffMs = BURST_WINDOW_MIN * 60 * 1000;
  const now = Date.now();

  // Large-offer sentinels: pending if .json exists and no terminal flag.
  if (fs.existsSync(GATE_DIR)) {
    for (const f of fs.readdirSync(GATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (fs.existsSync(path.join(GATE_DIR, `${id}.cleared`))) continue;
      if (fs.existsSync(path.join(GATE_DIR, `${id}.rejected`))) continue;
      if (fs.existsSync(path.join(GATE_DIR, `${id}.processed`))) continue;
      try {
        const sentinel = JSON.parse(fs.readFileSync(path.join(GATE_DIR, f), 'utf-8'));
        const queuedMs = new Date(sentinel.queued_at).getTime();
        if (Number.isFinite(queuedMs) && (now - queuedMs) <= cutoffMs) return true;
      } catch { /* malformed sentinel, ignore */ }
    }
  }

  // Clarify-partner sidecars: any recent file is a pending operator-or-sender round-trip.
  if (fs.existsSync(PENDING_DIR)) {
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      if (freshFile(path.join(PENDING_DIR, f), cutoffMs)) return true;
    }
  }

  return false;
}

function onSteadyBoundary() {
  return STEADY_BOUNDARY_MIN.includes(new Date().getMinutes());
}

const burst = inBurstWindow();
const steady = onSteadyBoundary();
if (burst || steady) {
  console.error(`excess-agent: running (burst=${burst}, steady=${steady})`);
  process.exit(0);
}
console.error(`excess-agent: skip (no burst window, not on 30m boundary)`);
process.exit(1);
