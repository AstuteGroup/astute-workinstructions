/**
 * shared/breadcrumbs.js — single-file event log for the offer pipeline.
 *
 * Every cog in the offer pipeline (poller, type router, data-capture stubs,
 * analysis cog, reply parser) appends a one-line JSON record describing what
 * it did. The digest builder reads recent breadcrumbs to assemble the 3×/day
 * operator email.
 *
 * Format: one JSON object per line (JSONL), to ~/workspace/.offer-pipeline/breadcrumbs.jsonl
 *
 * Per-record shape (minimum):
 *   {
 *     ts:      "2026-05-04T15:32:11.123Z",
 *     cog:     "offer-poller" | "type-router" | "broker-capture" | ...,
 *     event:   "loaded" | "needs-partner" | "needs-review" | "routed-to-analysis" | ...,
 *     account: "excess" | "broker" | ...,           // inbox if relevant
 *     uid:     12345,                               // email UID if relevant
 *     offerId: 9000123,                             // OT chuboe_offer_id if relevant
 *     searchKey: "1024645",                         // OT search key if relevant
 *     partner: { id, name, source },                // if resolved
 *     ...event-specific fields
 *   }
 *
 * RETENTION: caller-controlled. The standard policy is weekly delete of any
 * breadcrumb older than 7 days — see `prune()`. The offer-pipeline cron
 * (rotation) calls this once a week.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.offer-pipeline');
const BREADCRUMB_FILE = path.join(ROOT, 'breadcrumbs.jsonl');

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

/**
 * Append a breadcrumb line. Caller is responsible for the shape; we just stamp
 * `ts` and serialize.
 */
function write(record) {
  ensureRoot();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  fs.appendFileSync(BREADCRUMB_FILE, line + '\n');
}

/**
 * Read all breadcrumbs newer than `sinceMs` (ms since epoch). Default = last
 * 4 hours so the digest can render its window cleanly.
 */
function readSince(sinceMs = Date.now() - 4 * 60 * 60 * 1000) {
  if (!fs.existsSync(BREADCRUMB_FILE)) return [];
  const raw = fs.readFileSync(BREADCRUMB_FILE, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (!obj.ts) continue;
    const t = Date.parse(obj.ts);
    if (isNaN(t)) continue;
    if (t >= sinceMs) out.push(obj);
  }
  return out;
}

/**
 * Read every breadcrumb regardless of age (for replay / debugging).
 */
function readAll() {
  return readSince(0);
}

/**
 * Drop anything older than `cutoffMs` (default = 7 days). Rewrites the file
 * in place. Cheap because the file is small (one line per pipeline event).
 */
function prune(cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000) {
  if (!fs.existsSync(BREADCRUMB_FILE)) return { kept: 0, dropped: 0 };
  const lines = fs.readFileSync(BREADCRUMB_FILE, 'utf8').split('\n');
  let kept = 0, dropped = 0;
  const keep = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (!obj.ts) { continue; }
    if (Date.parse(obj.ts) >= cutoffMs) { keep.push(line); kept++; }
    else { dropped++; }
  }
  fs.writeFileSync(BREADCRUMB_FILE, keep.join('\n') + (keep.length ? '\n' : ''));
  return { kept, dropped };
}

module.exports = {
  write,
  readSince,
  readAll,
  prune,
  BREADCRUMB_FILE,
  ROOT,
};
