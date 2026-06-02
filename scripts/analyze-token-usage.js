#!/usr/bin/env node
/**
 * analyze-token-usage.js — read REAL per-agent token usage from Claude Code's
 * session transcripts (JSONL). No agent change required: Claude Code already
 * records `message.usage` (input/output/cache_read/cache_creation tokens) on
 * every assistant turn of every `claude -p` run.
 *
 * Two lenses:
 *   - Retrospective (default): the historical transcript dir where agents ran
 *     with cwd=astute-workinstructions (mixed with any manual runs from there).
 *   - Go-forward: after the cwd move (2026-05-26), agents run from
 *     ~/agent-runtime, so their transcripts land in a dedicated project dir —
 *     pure agent usage, no interactive sessions mixed in.
 *
 * USAGE:
 *   node analyze-token-usage.js [--dir <project-transcript-dir>] [--since YYYY-MM-DD] [--by-day]
 *
 * Defaults to the astute-workinstructions project dir. Pass
 *   --dir ~/.claude/projects/-home-analytics-user-agent-runtime
 * once the agents have run post-reset for the clean view.
 *
 * Token cost weighting (for the "weighted input-equiv" column): cache reads bill
 * ~0.1x and cache writes ~1.25x of base input; output is reported separately
 * because it bills several× input. These are volume estimates, NOT dollars —
 * a Pro/Max subscription does not expose per-call cost.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const DEFAULT_DIR = path.join(PROJECTS, '-home-analytics-user-workspace-astute-workinstructions');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DIR = arg('dir', DEFAULT_DIR).replace(/^~/, HOME);
const SINCE = arg('since', null);
const BY_DAY = process.argv.includes('--by-day');

// Classify a transcript to an agent from its first user message (the piped prompt).
function classify(firstUserText) {
  const t = (firstUserText || '').slice(0, 600);
  if (/OutboundPending folder/i.test(t)) return 'stockrfq-cq-agent';
  if (/vq@orangetsunami|VQ Loading|supplier quote/i.test(t)) return 'vq-loading-agent';
  if (/excess@orangetsunami|customer excess/i.test(t)) return 'excess-agent';
  if (/rfqloading@|routes? customer RFQ|large-RFQ approval/i.test(t)) return 'rfqloading-agent';
  if (/stockRFQ@orangetsunami\.com inbox|Stock RFQ/i.test(t)) return 'stockrfq-agent';
  return '(other / interactive)';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ');
  return '';
}

const blank = () => ({ sessions: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const byAgent = {};
const byDay = {}; // day -> agent -> bucket

let files = [];
try {
  files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));
} catch (e) {
  console.error(`Cannot read transcript dir: ${DIR}\n${e.message}`);
  process.exit(1);
}

for (const file of files) {
  let lines;
  try { lines = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n'); } catch { continue; }
  let firstUserText = null;
  let day = null;
  const bucket = blank();
  let sawAssistant = false;

  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!day && o.timestamp) day = o.timestamp.slice(0, 10);
    if (o.type === 'user' && firstUserText === null && o.message) {
      firstUserText = textOf(o.message.content);
    }
    if (o.type === 'assistant' && o.message && o.message.usage) {
      const u = o.message.usage;
      bucket.input += u.input_tokens || 0;
      bucket.output += u.output_tokens || 0;
      bucket.cacheRead += u.cache_read_input_tokens || 0;
      bucket.cacheCreate += u.cache_creation_input_tokens || 0;
      sawAssistant = true;
    }
  }

  if (!sawAssistant) continue;            // queue-only / empty transcript
  if (SINCE && day && day < SINCE) continue;
  const agent = classify(firstUserText);

  const agg = (byAgent[agent] = byAgent[agent] || blank());
  agg.sessions += 1;
  agg.input += bucket.input; agg.output += bucket.output;
  agg.cacheRead += bucket.cacheRead; agg.cacheCreate += bucket.cacheCreate;

  if (BY_DAY && day) {
    byDay[day] = byDay[day] || {};
    const d = (byDay[day][agent] = byDay[day][agent] || blank());
    d.sessions += 1; d.input += bucket.input; d.output += bucket.output;
    d.cacheRead += bucket.cacheRead; d.cacheCreate += bucket.cacheCreate;
  }
}

const fmt = (n) => (n / 1e6).toFixed(2) + 'M';
// Weighted input-equivalent: base input + 1.25× cache writes + 0.1× cache reads.
const weightedIn = (b) => b.input + 1.25 * b.cacheCreate + 0.1 * b.cacheRead;

function row(name, b) {
  return [
    name.padEnd(26),
    `sess ${String(b.sessions).padStart(5)}`,
    `in ${fmt(b.input).padStart(8)}`,
    `cacheR ${fmt(b.cacheRead).padStart(9)}`,
    `cacheW ${fmt(b.cacheCreate).padStart(8)}`,
    `out ${fmt(b.output).padStart(7)}`,
    `wIn≈ ${fmt(weightedIn(b)).padStart(8)}`,
  ].join('  ');
}

console.log(`\nToken usage from transcripts in:\n  ${DIR}`);
console.log(`Files scanned: ${files.length}${SINCE ? `   (since ${SINCE})` : ''}\n`);
console.log('Per agent (input tokens are the dominant cost driver; output bills several× higher):\n');
const order = Object.entries(byAgent).sort((a, b) => weightedIn(b[1]) - weightedIn(a[1]));
for (const [name, b] of order) console.log('  ' + row(name, b));

const tot = blank();
for (const b of Object.values(byAgent)) { tot.sessions += b.sessions; tot.input += b.input; tot.output += b.output; tot.cacheRead += b.cacheRead; tot.cacheCreate += b.cacheCreate; }
console.log('\n  ' + row('TOTAL', tot));

if (BY_DAY) {
  console.log('\nPer day × agent (weighted input-equiv):');
  for (const day of Object.keys(byDay).sort()) {
    const parts = Object.entries(byDay[day])
      .sort((a, b) => weightedIn(b[1]) - weightedIn(a[1]))
      .map(([n, b]) => `${n.replace('-agent', '')}: ${fmt(weightedIn(b))} (${b.sessions})`);
    console.log(`  ${day}  ` + parts.join('  |  '));
  }
}
console.log('\nNote: "wIn≈" = input + 1.25×cache-write + 0.1×cache-read (token volume estimate, not $).');
console.log('Subscription plans do not expose per-call cost; this is a volume proxy.\n');
