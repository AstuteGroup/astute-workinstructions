#!/usr/bin/env node
/**
 * Gate for stockrfq-cq-agent — decides whether this 15-min tick should
 * actually invoke the LLM agent or skip silently.
 *
 * Unlike should-run-stockrfq-agent.js (a TIME-based throttle: the inbound
 * agent fires every 5m and is gated down to a 15m steady boundary), the
 * cq-agent's cron is ALREADY every 15m, so a time gate buys nothing. Its
 * waste is launching `claude` every 15m even when the OutboundPending folder
 * is empty — ~96 full LLM launches/day, most of them no-ops.
 *
 * This is therefore a CONTENT gate: it runs the exact same primitive the
 * agent runs as its STEP 2 —
 *     email-workflow-poller.js list --workflow stockrfq-cq
 * — in plain Node (zero LLM tokens), and:
 *   - unseen messages present  → exit 0 (run the agent)
 *   - zero unseen messages     → exit 1 (skip this tick)
 *
 * FAIL-OPEN: on ANY gate error (spawn failure, IMAP error, unparseable
 * output) we exit 0 and let the agent run. Missing CQ work is worse than an
 * occasional wasted launch; the agent's own STEP 2 will surface the same
 * error properly. The poller loads ~/workspace/.env via a __dirname-relative
 * path, so this gate is cwd-independent.
 *
 * Exit 0 → tick should run.   Exit 1 → tick should skip.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const POLLER = path.resolve(__dirname, '../shared/email-workflow-poller.js');

function unseenCount() {
  const out = execFileSync('node', [POLLER, 'list', '--workflow', 'stockrfq-cq'], {
    encoding: 'utf-8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'inherit'], // let poller's stderr pass through
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  });
  // The poller prints a JSON array of unseen envelopes on stdout, but dotenv
  // also writes a `[dotenv@17...] injecting env ...` banner there whose leading
  // '[' would fool a naive array match. Strip dotenv banner lines first, then
  // extract the JSON array from what remains.
  const clean = out
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('[dotenv@'))
    .join('\n');
  const m = clean.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in poller output');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error('poller output is not an array');
  return arr.length;
}

try {
  const n = unseenCount();
  if (n > 0) {
    console.error(`stockrfq-cq-agent: running (${n} unseen in OutboundPending)`);
    process.exit(0);
  }
  console.error('stockrfq-cq-agent: skip (0 unseen in OutboundPending)');
  process.exit(1);
} catch (err) {
  // Fail open — never drop CQ work because the gate stumbled.
  console.error(`stockrfq-cq-agent: gate error, failing open (running): ${err.message}`);
  process.exit(0);
}
