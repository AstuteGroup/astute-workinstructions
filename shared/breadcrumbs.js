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

/**
 * Has this Message-ID already been successfully loaded by any handler?
 *
 * Used as a cross-workflow idempotency guard: each email-driven workflow
 * checks this before re-invoking its writer, so manual re-routes / replays
 * / accidental re-polls do not create duplicate RFQs, offers, etc.
 *
 * The breadcrumb log is the source of truth (no active prune as of 2026-05-22,
 * so the history is durable — if a prune cron is later added, retention must
 * exceed the longest replay window we want to defend against).
 *
 * @param {string} messageId - RFC822 Message-ID to look up (including angle brackets)
 * @param {object} [opts]
 * @param {string[]} [opts.events] - Event names that count as "successfully loaded".
 *   Default: ['loaded', 'cq-loaded', 'cq-loaded-with-rfq', 'offer-loaded',
 *             'rfq-loaded']. Match is exact, not substring.
 * @param {string|string[]} [opts.cog] - Optional cog filter (e.g.,
 *   'vq-loading-agent' or ['stockrfq-agent','rfq-loading-agent']).
 * @param {string} [opts.field] - Which breadcrumb field to match against.
 *   Default: 'messageId'. Can be set to 'brokerMessageId' to match the broker's
 *   original Message-ID instead of Outlook's auto-forward wrapper.
 * @returns {{loaded: boolean, breadcrumb: object|null}}
 */
function hasMessageIdAlreadyLoaded(messageId, opts = {}) {
  if (!messageId || typeof messageId !== 'string') {
    return { loaded: false, breadcrumb: null };
  }
  const DEFAULT_EVENTS = [
    'loaded',
    'cq-loaded',
    'cq-loaded-with-rfq',
    'offer-loaded',
    'rfq-loaded',
  ];
  const events = new Set(Array.isArray(opts.events) && opts.events.length ? opts.events : DEFAULT_EVENTS);
  const cogs = opts.cog
    ? new Set(Array.isArray(opts.cog) ? opts.cog : [opts.cog])
    : null;
  const field = opts.field || 'messageId';

  if (!fs.existsSync(BREADCRUMB_FILE)) return { loaded: false, breadcrumb: null };
  const raw = fs.readFileSync(BREADCRUMB_FILE, 'utf8');
  // Reverse scan so the most recent match wins (callers see the latest load).
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (!events.has(obj.event)) continue;
    if (cogs && !cogs.has(obj.cog)) continue;
    if (obj[field] !== messageId) continue;
    return { loaded: true, breadcrumb: obj };
  }
  return { loaded: false, breadcrumb: null };
}

/**
 * Find breadcrumbs matching a UID and event filter.
 *
 * Used for detecting repeat deferrals — if we already wrote a 'load-deferred-budget'
 * breadcrumb for this UID, the retry attempt should not re-notify.
 *
 * @param {number|string} uid - Email UID to look up
 * @param {object} [opts]
 * @param {string|string[]} [opts.events] - Event names to match (exact match)
 * @param {string|string[]} [opts.cog] - Cog filter
 * @param {number} [opts.sinceMs] - Only consider breadcrumbs newer than this (default: 24h)
 * @returns {{found: boolean, breadcrumb: object|null}}
 */
function findByUid(uid, opts = {}) {
  if (uid == null) return { found: false, breadcrumb: null };
  const uidNum = Number(uid);
  const events = opts.events
    ? new Set(Array.isArray(opts.events) ? opts.events : [opts.events])
    : null;
  const cogs = opts.cog
    ? new Set(Array.isArray(opts.cog) ? opts.cog : [opts.cog])
    : null;
  const sinceMs = opts.sinceMs ?? (Date.now() - 24 * 60 * 60 * 1000);

  if (!fs.existsSync(BREADCRUMB_FILE)) return { found: false, breadcrumb: null };
  const raw = fs.readFileSync(BREADCRUMB_FILE, 'utf8');
  const lines = raw.split('\n');
  // Reverse scan for most recent match
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (obj.uid !== uidNum && obj.uid !== String(uid)) continue;
    if (events && !events.has(obj.event)) continue;
    if (cogs && !cogs.has(obj.cog)) continue;
    if (obj.ts && Date.parse(obj.ts) < sinceMs) continue;
    return { found: true, breadcrumb: obj };
  }
  return { found: false, breadcrumb: null };
}

module.exports = {
  write,
  readSince,
  readAll,
  prune,
  hasMessageIdAlreadyLoaded,
  findByUid,
  BREADCRUMB_FILE,
  ROOT,
};
