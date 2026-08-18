#!/usr/bin/env node
/**
 * Content gate for rfqloading-agent — decides whether this 5-min tick should
 * actually invoke the LLM agent or skip silently.
 *
 * This is a CONTENT gate: it runs the email-workflow-poller to check for
 * unseen messages in the rfqloading@ inbox:
 *   - unseen messages present  → exit 0 (run the agent)
 *   - zero unseen messages     → exit 1 (skip this tick)
 *
 * FAIL-OPEN: on ANY gate error (spawn failure, IMAP error, unparseable
 * output) we exit 0 and let the agent run. Missing RFQ work is worse than an
 * occasional wasted launch; the agent's own list step will surface the same
 * error properly.
 *
 * Exit 0 → tick should run.   Exit 1 → tick should skip.
 *
 * History:
 *   2026-08-18 — Converted from burst/steady TIME gate to CONTENT gate.
 *                Agent now fires every 5m; gate skips when inbox is empty.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const POLLER = path.resolve(__dirname, '../shared/email-workflow-poller.js');

function unseenCount() {
  const out = execFileSync('node', [POLLER, 'list', '--workflow', 'rfq-loading'], {
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
    console.error(`rfqloading-agent: running (${n} unseen)`);
    process.exit(0);
  }
  console.error('rfqloading-agent: skip (0 unseen)');
  process.exit(1);
} catch (err) {
  // Fail open — never drop RFQ work because the gate stumbled.
  console.error(`rfqloading-agent: gate error, failing open (running): ${err.message}`);
  process.exit(0);
}
