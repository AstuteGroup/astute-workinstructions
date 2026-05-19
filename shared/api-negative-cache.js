/**
 * Franchise API Negative Cache
 *
 * Persistent, global, cross-RFQ cache of franchise API results — primarily
 * "not carried" outcomes, so we stop burning quota re-asking the same
 * distributors about the same parts week after week.
 *
 * Scope: ONE authoritative store for all 10 franchise distributors.
 * Key: (mpn_normalized, mfr_normalized, disty) — NO rfq, NO session scope.
 * A cached miss from 2025 satisfies a 2026 query.
 *
 * API (stable):
 *   check({ mpn, mfr, disty })  → null | { result, cached_at, expires_at, source }
 *   record({ mpn, mfr, disty, result, envelopeHash?, priceBreaksN?, stockQty?, costUnit?, context? })
 *     → applies per-disty rules (TTL, confirm_count, envelope gates, context gates)
 *   sampleForProbing({ disty, n, biasHotMfrs })  → [entries]
 *   logProbe({ entryId, result, elapsedMs, errorCode })  → flip detection + cascade invalidation
 *   invalidateByMfr({ mfr, disty?, reason })  → int
 *   invalidateByAcquisition({ oldMfr, newMfr, reason })  → int
 *   stats({ disty? })  → counts by result/invalidation
 *
 * Per-disty rules live in DISTY_RULES below. Additions to the distributor
 * list should update BOTH franchise-api.js DISTRIBUTORS and DISTY_RULES here.
 *
 * Storage: SQLite via better-sqlite3 at shared/data/negative-cache.sqlite
 * (gitignored). Designed for ~300K entries with sub-ms lookups.
 *
 * Shadow mode: when NEG_CACHE_SHADOW=1, check() returns null unconditionally
 * but record() still writes. Lets us audit false-negative rate before the
 * cache goes hot. See scripts/neg-cache-shadow-report.js.
 *
 * Drift detection (Phase 2 — not yet built):
 *   - Daily probe sampler: re-query N random cached negatives per disty,
 *     auto-cascade-invalidate same-MFR entries on flip.
 *   - Monthly linecard refresh (decision 2026-04-20): pull each disty's
 *     franchise MFR list, diff vs last snapshot, invalidate cached entries
 *     on adds/drops. Monthly cadence chosen because (a) franchise churn is
 *     ~10-20 adds/quarter/disty, (b) probe sampler catches per-MPN drift
 *     continuously, (c) acquisitions are event-driven via
 *     invalidateByAcquisition. Weekly was overkill; quarterly aligns with
 *     180d TTL but delays add-detection.
 *   - Acquisition cascade: triggered from shared/mfr-equivalence when
 *     mfr-acquisitions.json is updated — invalidates entries for both
 *     old and new MFR names immediately.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.resolve(__dirname, 'data/negative-cache.sqlite');
const DB_PATH = process.env.NEG_CACHE_DB || DEFAULT_DB_PATH;
const SHADOW_MODE = process.env.NEG_CACHE_SHADOW === '1';

const DAY_MS = 24 * 60 * 60 * 1000;

// Per-disty rules. Keys match franchise-api.js DISTRIBUTORS.
// ttlDays: how long a cached entry stays valid
// confirmCount: how many consecutive misses needed before caching (Future is noisy)
// minMissGapMs: minimum time between misses for confirm_count to advance
// requireEnvelope: response must match this shape or miss is ignored
// requireContext: the calling context must match (e.g. Waldom inStockOnly=false)
// excludeReasons: don't cache when the miss came from these paths
// requireRequestedQty: callers MUST pass requestedQty on record() and qty on check();
//   used by single-tier sources (e.g. Heilind BOM tool) where price is only valid
//   at one qty point. Default tolerance ±25% on retrieval — see check() docs.
const DISTY_RULES = {
  digikey:    { ttlDays: 180, confirmCount: 1 },
  arrow:      { ttlDays: 180, confirmCount: 1 },
  rutronik:   { ttlDays: 180, confirmCount: 1, excludeReasons: ['json_error'] },
  future:     { ttlDays: 30,  confirmCount: 2, minMissGapMs: 24 * 60 * 60 * 1000 },
  newark:     { ttlDays: 180, confirmCount: 1 },
  tti:        { ttlDays: 180, confirmCount: 1 },
  mouser:     { ttlDays: 180, confirmCount: 1 },
  master:     { ttlDays: 180, confirmCount: 1 },
  waldom:     { ttlDays: 180, confirmCount: 1, requireContext: { inStockOnly: false } },
  sager:      { ttlDays: 180, confirmCount: 1, requireEnvelope: { status: 'Success' } },
  heilind:    { ttlDays: 180, confirmCount: 1, requireRequestedQty: true },
  oemsecrets: null,  // dormant + aggregator semantics — skip
};

// Carried (hit) TTL is shorter — prices/stock move. We still cache for dedup
// within a single run plus short-window re-asks. No confirm count needed.
const CARRIED_TTL_DAYS = 7;

// matched_no_price: a third result state for sources whose catalog hit returns
// no live pricing (Heilind BOM tool's "DAC PN populated, Price1=0" outcome).
// Fixed 60d TTL across all RFQ types — this is a property of the catalog /
// quote engine, not of how urgently we need the price. After 60d we re-probe
// in case the quote engine's pricing record got fixed.
const MATCHED_NO_PRICE_TTL_DAYS = 60;

// Default qty tolerance for requireRequestedQty disties on check(). ±25%
// generally stays within one of Heilind's published tier boundaries (typically
// 10× apart: 1 / 10 / 100 / 1000 / 10000). Tighter than this re-scrapes too
// often; looser risks crossing a tier boundary and returning stale pricing.
const DEFAULT_QTY_TOLERANCE = 0.25;

// ---------------------------------------------------------------------------
// MPN / MFR normalization
// ---------------------------------------------------------------------------

function normalizeMpn(mpn) {
  if (!mpn) return '';
  return String(mpn).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// MFR normalization uses shared/mfr-equivalence.js when available.
// Falls back to uppercase+trim so the cache still works during bootstrap.
let _canonicalMfr = null;
function canonicalMfr(mfr) {
  if (!mfr) return '';
  if (_canonicalMfr === null) {
    try {
      _canonicalMfr = require('./mfr-equivalence').canonicalMfr;
    } catch {
      _canonicalMfr = false;  // mark unavailable so we stop retrying
    }
  }
  if (_canonicalMfr) {
    try { return (_canonicalMfr(mfr) || '').toUpperCase().trim(); }
    catch { /* fall through */ }
  }
  return String(mfr).trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// DB init
// ---------------------------------------------------------------------------

let _db = null;

function getDB() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      id INTEGER PRIMARY KEY,
      mpn TEXT NOT NULL,
      mpn_normalized TEXT NOT NULL,
      mfr_raw TEXT,
      mfr_normalized TEXT,
      disty TEXT NOT NULL,
      result TEXT NOT NULL,             -- 'not_carried' | 'carried' | 'matched_no_price'
      -- Lifecycle
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      confirm_count INTEGER NOT NULL DEFAULT 1,
      -- Probe tracking
      probe_count INTEGER NOT NULL DEFAULT 0,
      probes_confirming INTEGER NOT NULL DEFAULT 0,
      probes_flipping INTEGER NOT NULL DEFAULT 0,
      last_probe_at INTEGER,
      -- Enrichment metadata for drift analysis
      envelope_hash TEXT,
      price_breaks_n INTEGER,
      stock_qty INTEGER,
      cost_unit REAL,
      -- Invalidation
      invalidated_at INTEGER,
      invalidation_reason TEXT,
      UNIQUE(mpn_normalized, mfr_normalized, disty)
    );

    CREATE INDEX IF NOT EXISTS idx_cache_expires
      ON cache_entries(expires_at) WHERE invalidated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cache_mfr
      ON cache_entries(mfr_normalized, disty);
    CREATE INDEX IF NOT EXISTS idx_cache_last_seen
      ON cache_entries(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_cache_result_disty
      ON cache_entries(result, disty) WHERE invalidated_at IS NULL;

    CREATE TABLE IF NOT EXISTS probe_log (
      id INTEGER PRIMARY KEY,
      cache_entry_id INTEGER NOT NULL REFERENCES cache_entries(id),
      probed_at INTEGER NOT NULL,
      result TEXT NOT NULL,              -- 'not_carried' | 'carried' | 'error'
      error_code TEXT,
      elapsed_ms INTEGER,
      flipped INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_probe_entry ON probe_log(cache_entry_id);
    CREATE INDEX IF NOT EXISTS idx_probe_time ON probe_log(probed_at);

    CREATE TABLE IF NOT EXISTS linecard_snapshots (
      id INTEGER PRIMARY KEY,
      disty TEXT NOT NULL,
      snapshot_at INTEGER NOT NULL,
      mfr_list_hash TEXT,
      mfr_count INTEGER,
      snapshot_path TEXT
    );

    CREATE TABLE IF NOT EXISTS linecard_diffs (
      id INTEGER PRIMARY KEY,
      disty TEXT NOT NULL,
      diff_at INTEGER NOT NULL,
      mfr_added TEXT,
      mfr_dropped TEXT,
      entries_invalidated INTEGER
    );

    CREATE TABLE IF NOT EXISTS acquisition_cascades (
      id INTEGER PRIMARY KEY,
      cascaded_at INTEGER NOT NULL,
      mfr_from TEXT NOT NULL,
      mfr_to TEXT NOT NULL,
      entries_invalidated INTEGER,
      reason TEXT
    );

    -- Shadow-mode audit log. Written even when SHADOW_MODE is on, so we can
    -- measure how often the cache would have served a skip and audit the
    -- actual live API outcome for false-negative detection.
    CREATE TABLE IF NOT EXISTS shadow_log (
      id INTEGER PRIMARY KEY,
      logged_at INTEGER NOT NULL,
      disty TEXT NOT NULL,
      mpn_normalized TEXT NOT NULL,
      mfr_normalized TEXT,
      cached_result TEXT,                -- what the cache would have returned
      actual_result TEXT,                -- what the live API call returned
      matched INTEGER                    -- 1 if live agrees with cache, 0 = false negative
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_time ON shadow_log(logged_at);
  `);

  // Migration: add requested_qty column for single-tier sources (Heilind etc.).
  // Nullable so existing rows from non-qty-aware paths continue to work.
  const cols = _db.prepare(`PRAGMA table_info(cache_entries)`).all();
  if (!cols.some(c => c.name === 'requested_qty')) {
    _db.exec(`ALTER TABLE cache_entries ADD COLUMN requested_qty INTEGER`);
  }

  return _db;
}

// ---------------------------------------------------------------------------
// Core: check / record
// ---------------------------------------------------------------------------

/**
 * Look up whether we have a valid cached outcome for this (mpn, mfr, disty).
 *
 * For disties with `requireRequestedQty: true` (e.g. heilind), the caller MUST
 * pass `qty` — otherwise the lookup returns null (we won't serve a single-tier
 * cached price for a query that didn't tell us what qty it cares about).
 * Optional `qtyTolerance` overrides the default ±25% window.
 *
 * @param {object} opts
 * @param {string} opts.mpn
 * @param {string} [opts.mfr]
 * @param {string} opts.disty
 * @param {number} [opts.qty]              - current query qty; required for single-tier disties
 * @param {number} [opts.qtyTolerance]     - default 0.25 (±25%)
 * @returns {null | { result, cached_at, expires_at, requested_qty, source, id }}
 */
function check({ mpn, mfr, disty, qty, qtyTolerance = DEFAULT_QTY_TOLERANCE }) {
  if (!DISTY_RULES[disty]) return null;           // unknown or disabled disty

  const rule = DISTY_RULES[disty];
  if (rule.requireRequestedQty && (qty === undefined || qty === null)) {
    return null;  // single-tier disty queried without qty — can't serve safely
  }

  const mpnN = normalizeMpn(mpn);
  if (!mpnN) return null;
  const mfrN = canonicalMfr(mfr);

  const db = getDB();
  let sql = `
    SELECT id, result, first_seen_at, last_seen_at, expires_at, confirm_count, requested_qty
    FROM cache_entries
    WHERE mpn_normalized = ? AND mfr_normalized = ? AND disty = ?
      AND invalidated_at IS NULL
      AND expires_at > ?`;
  const params = [mpnN, mfrN, disty, Date.now()];

  if (qty !== undefined && qty !== null) {
    // Qty-proximity filter — cached entry is reusable when the query qty
    // falls within ±tolerance of the entry's requested_qty (entry is the
    // anchor, not the query). E.g., entry at qty=1000 with ±25% tolerance
    // covers queries in [750, 1250]. Query at 1300 misses (30% above 1000).
    sql += ` AND requested_qty IS NOT NULL
             AND ? BETWEEN requested_qty * ? AND requested_qty * ?`;
    params.push(qty, 1 - qtyTolerance, 1 + qtyTolerance);
  }

  const row = db.prepare(sql).get(...params);
  if (!row) return null;

  // For disties requiring confirmation, only serve once confirmed
  if (rule.confirmCount > 1 && row.confirm_count < rule.confirmCount) return null;

  const hit = {
    id: row.id,
    result: row.result,
    cached_at: row.first_seen_at,
    expires_at: row.expires_at,
    requested_qty: row.requested_qty,
    source: 'neg-cache',
  };

  // Shadow mode: report what we WOULD have served, but return null so the
  // caller still hits the live API. The caller may call peek() afterward to
  // log the comparison.
  if (SHADOW_MODE) return null;
  return hit;
}

/**
 * Non-serving variant of check(): returns the cached entry even in shadow
 * mode. For use by shadow-audit loggers that need to compare "what cache
 * had" to "what the live API returned" without actually serving the hit.
 */
function peek({ mpn, mfr, disty, qty, qtyTolerance = DEFAULT_QTY_TOLERANCE }) {
  if (!DISTY_RULES[disty]) return null;
  const mpnN = normalizeMpn(mpn);
  if (!mpnN) return null;
  const mfrN = canonicalMfr(mfr);
  const db = getDB();
  let sql = `
    SELECT id, result, first_seen_at, expires_at, confirm_count, requested_qty
    FROM cache_entries
    WHERE mpn_normalized = ? AND mfr_normalized = ? AND disty = ?
      AND invalidated_at IS NULL
      AND expires_at > ?`;
  const params = [mpnN, mfrN, disty, Date.now()];
  if (qty !== undefined && qty !== null) {
    sql += ` AND requested_qty IS NOT NULL
             AND ? BETWEEN requested_qty * ? AND requested_qty * ?`;
    params.push(qty, 1 - qtyTolerance, 1 + qtyTolerance);
  }
  const row = db.prepare(sql).get(...params);
  if (!row) return null;
  const rule = DISTY_RULES[disty];
  if (rule.confirmCount > 1 && row.confirm_count < rule.confirmCount) return null;
  return {
    id: row.id,
    result: row.result,
    cached_at: row.first_seen_at,
    expires_at: row.expires_at,
    requested_qty: row.requested_qty,
    source: 'neg-cache-peek',
  };
}

/**
 * Record an API outcome. Applies per-disty rules.
 *
 * @param {object} opts
 * @param {string} opts.mpn
 * @param {string} [opts.mfr]
 * @param {string} opts.disty
 * @param {'not_carried' | 'carried' | 'matched_no_price'} opts.result
 * @param {object} [opts.envelope]       - raw response envelope fields for rule gates
 * @param {object} [opts.context]        - calling context (e.g. inStockOnly for Waldom)
 * @param {string} [opts.reason]         - internal branch tag (e.g. 'json_error') for excludeReasons
 * @param {number} [opts.priceBreaksN]
 * @param {number} [opts.stockQty]
 * @param {number} [opts.costUnit]
 * @param {number} [opts.requestedQty]   - the qty we submitted to the source; REQUIRED for
 *                                         disties with requireRequestedQty (e.g. heilind)
 * @returns {{ cached: boolean, entry_id?: number, skipped_reason?: string }}
 */
function record(opts) {
  const { mpn, mfr, disty, result } = opts;
  const rule = DISTY_RULES[disty];
  if (!rule) return { cached: false, skipped_reason: 'disty_not_tracked' };

  // Rule gates BEFORE any DB write
  if (opts.reason && rule.excludeReasons && rule.excludeReasons.includes(opts.reason)) {
    return { cached: false, skipped_reason: `exclude_reason:${opts.reason}` };
  }
  if (rule.requireEnvelope && opts.envelope) {
    for (const [k, v] of Object.entries(rule.requireEnvelope)) {
      if (opts.envelope[k] !== v) {
        return { cached: false, skipped_reason: `envelope_mismatch:${k}` };
      }
    }
  }
  if (rule.requireContext && opts.context) {
    for (const [k, v] of Object.entries(rule.requireContext)) {
      if (opts.context[k] !== v) {
        return { cached: false, skipped_reason: `context_mismatch:${k}` };
      }
    }
  }
  if (rule.requireRequestedQty &&
      (opts.requestedQty === undefined || opts.requestedQty === null)) {
    return { cached: false, skipped_reason: 'missing_requested_qty' };
  }

  const mpnN = normalizeMpn(mpn);
  if (!mpnN) return { cached: false, skipped_reason: 'invalid_mpn' };
  const mfrN = canonicalMfr(mfr);
  const now = Date.now();
  const ttlDays =
    result === 'carried' ? CARRIED_TTL_DAYS :
    result === 'matched_no_price' ? MATCHED_NO_PRICE_TTL_DAYS :
    rule.ttlDays;
  const expires = now + ttlDays * DAY_MS;

  const envelopeHash = opts.envelope
    ? crypto.createHash('sha1').update(Object.keys(opts.envelope).sort().join('|')).digest('hex').slice(0, 12)
    : null;

  const db = getDB();
  const existing = db.prepare(`
    SELECT id, result, confirm_count, last_seen_at
    FROM cache_entries
    WHERE mpn_normalized = ? AND mfr_normalized = ? AND disty = ?
  `).get(mpnN, mfrN, disty);

  const requestedQty = (opts.requestedQty !== undefined && opts.requestedQty !== null)
    ? Math.trunc(Number(opts.requestedQty))
    : null;

  if (existing) {
    // Reinforce if the result agrees and the min-gap (if any) is satisfied
    if (existing.result === result) {
      const gapOk = !rule.minMissGapMs || (now - existing.last_seen_at) >= rule.minMissGapMs;
      const newConfirm = gapOk ? existing.confirm_count + 1 : existing.confirm_count;
      db.prepare(`
        UPDATE cache_entries
        SET last_seen_at = ?, expires_at = ?, confirm_count = ?,
            envelope_hash = COALESCE(?, envelope_hash),
            price_breaks_n = COALESCE(?, price_breaks_n),
            stock_qty = COALESCE(?, stock_qty),
            cost_unit = COALESCE(?, cost_unit),
            requested_qty = COALESCE(?, requested_qty),
            invalidated_at = NULL, invalidation_reason = NULL
        WHERE id = ?
      `).run(now, expires, newConfirm, envelopeHash,
             opts.priceBreaksN ?? null, opts.stockQty ?? null, opts.costUnit ?? null,
             requestedQty, existing.id);
      return { cached: true, entry_id: existing.id };
    }
    // Flip — the last result disagrees. Reset confirm and record the new.
    db.prepare(`
      UPDATE cache_entries
      SET result = ?, last_seen_at = ?, expires_at = ?, confirm_count = 1,
          envelope_hash = ?, price_breaks_n = ?, stock_qty = ?, cost_unit = ?,
          requested_qty = ?,
          invalidated_at = NULL, invalidation_reason = NULL
      WHERE id = ?
    `).run(result, now, expires, envelopeHash,
           opts.priceBreaksN ?? null, opts.stockQty ?? null, opts.costUnit ?? null,
           requestedQty, existing.id);
    return { cached: true, entry_id: existing.id, flipped: true };
  }

  const info = db.prepare(`
    INSERT INTO cache_entries
      (mpn, mpn_normalized, mfr_raw, mfr_normalized, disty, result,
       first_seen_at, last_seen_at, expires_at, confirm_count,
       envelope_hash, price_breaks_n, stock_qty, cost_unit, requested_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(mpn, mpnN, mfr || null, mfrN, disty, result,
         now, now, expires,
         envelopeHash, opts.priceBreaksN ?? null, opts.stockQty ?? null, opts.costUnit ?? null,
         requestedQty);

  return { cached: true, entry_id: Number(info.lastInsertRowid) };
}

/**
 * Record a shadow-mode observation: the cache WOULD have served `cachedResult`
 * (or no entry) but the live API returned `actualResult`. Lets us audit
 * false negatives before flipping SHADOW_MODE off.
 */
function logShadow({ mpn, mfr, disty, cachedResult, actualResult }) {
  const db = getDB();
  const mpnN = normalizeMpn(mpn);
  const mfrN = canonicalMfr(mfr);
  const matched = cachedResult && actualResult && cachedResult === actualResult ? 1 : 0;
  db.prepare(`
    INSERT INTO shadow_log (logged_at, disty, mpn_normalized, mfr_normalized,
                             cached_result, actual_result, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), disty, mpnN, mfrN, cachedResult || null, actualResult || null, matched);
}

// ---------------------------------------------------------------------------
// Invalidation (linecard diff / acquisition cascade / manual)
// ---------------------------------------------------------------------------

function invalidateByMfr({ mfr, disty, reason }) {
  const db = getDB();
  const mfrN = canonicalMfr(mfr);
  const now = Date.now();
  const sql = disty
    ? `UPDATE cache_entries SET invalidated_at = ?, invalidation_reason = ?
       WHERE mfr_normalized = ? AND disty = ? AND invalidated_at IS NULL`
    : `UPDATE cache_entries SET invalidated_at = ?, invalidation_reason = ?
       WHERE mfr_normalized = ? AND invalidated_at IS NULL`;
  const params = disty ? [now, reason || 'manual', mfrN, disty] : [now, reason || 'manual', mfrN];
  const info = db.prepare(sql).run(...params);
  return info.changes;
}

function invalidateByAcquisition({ oldMfr, newMfr, reason }) {
  const db = getDB();
  const now = Date.now();
  const oldN = canonicalMfr(oldMfr);
  const newN = canonicalMfr(newMfr);
  const info = db.prepare(`
    UPDATE cache_entries
    SET invalidated_at = ?, invalidation_reason = 'acquisition_cascade'
    WHERE (mfr_normalized = ? OR mfr_normalized = ?) AND invalidated_at IS NULL
  `).run(now, oldN, newN);
  db.prepare(`
    INSERT INTO acquisition_cascades (cascaded_at, mfr_from, mfr_to, entries_invalidated, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, oldN, newN, info.changes, reason || 'manual');
  return info.changes;
}

// ---------------------------------------------------------------------------
// Probe sampling (called by the daily cron)
// ---------------------------------------------------------------------------

/**
 * Pick N cached negatives to probe. Biases toward high-search-volume MFRs
 * (proxy: recently-seen MFRs with many entries across disties).
 */
function sampleForProbing({ disty, n = 20, biasHotMfrs = true }) {
  const db = getDB();
  // Probe both 'not_carried' AND 'matched_no_price' — both represent
  // negative outcomes worth re-checking. 'carried' entries refresh through
  // normal demand, not probing.
  const sql = biasHotMfrs
    ? `
        SELECT c.id, c.mpn, c.mpn_normalized, c.mfr_raw, c.mfr_normalized, c.disty,
               c.result, c.requested_qty, c.first_seen_at, c.last_seen_at
        FROM cache_entries c
        LEFT JOIN (
          SELECT mfr_normalized, COUNT(*) AS cnt
          FROM cache_entries
          WHERE invalidated_at IS NULL
          GROUP BY mfr_normalized
        ) h ON h.mfr_normalized = c.mfr_normalized
        WHERE c.disty = ?
          AND c.result IN ('not_carried', 'matched_no_price')
          AND c.invalidated_at IS NULL
          AND c.expires_at > ?
        ORDER BY COALESCE(h.cnt, 0) DESC, RANDOM()
        LIMIT ?
      `
    : `
        SELECT id, mpn, mpn_normalized, mfr_raw, mfr_normalized, disty,
               result, requested_qty, first_seen_at, last_seen_at
        FROM cache_entries
        WHERE disty = ? AND result IN ('not_carried', 'matched_no_price')
          AND invalidated_at IS NULL AND expires_at > ?
        ORDER BY RANDOM()
        LIMIT ?
      `;
  return db.prepare(sql).all(disty, Date.now(), n);
}

function logProbe({ entryId, result, elapsedMs, errorCode }) {
  const db = getDB();
  const entry = db.prepare(`SELECT result, mfr_normalized, disty FROM cache_entries WHERE id = ?`).get(entryId);
  if (!entry) return { flipped: false, cascaded: 0 };

  const flipped = result !== 'error' && result !== entry.result;
  db.prepare(`
    INSERT INTO probe_log (cache_entry_id, probed_at, result, elapsed_ms, error_code, flipped)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entryId, Date.now(), result, elapsedMs || null, errorCode || null, flipped ? 1 : 0);

  if (result === 'error') {
    db.prepare(`UPDATE cache_entries SET probe_count = probe_count + 1, last_probe_at = ? WHERE id = ?`)
      .run(Date.now(), entryId);
    return { flipped: false, cascaded: 0 };
  }

  db.prepare(`
    UPDATE cache_entries
    SET probe_count = probe_count + 1,
        probes_confirming = probes_confirming + ?,
        probes_flipping = probes_flipping + ?,
        last_probe_at = ?
    WHERE id = ?
  `).run(flipped ? 0 : 1, flipped ? 1 : 0, Date.now(), entryId);

  if (flipped && entry.result === 'not_carried') {
    // MFR-level cascade ONLY when the MFR is known. Empty MFR means the
    // entry was backfilled from old cache files (which didn't record MFR);
    // cascading on empty would invalidate every backfilled entry for this
    // disty — far too aggressive. In that case just flip the single entry.
    if (entry.mfr_normalized && entry.mfr_normalized.length > 0) {
      const cascaded = invalidateByMfr({
        mfr: entry.mfr_normalized,
        disty: entry.disty,
        reason: 'probe_flip',
      });
      return { flipped: true, cascaded };
    }
    // Flip just this one entry by invalidating it directly
    db.prepare(`UPDATE cache_entries SET invalidated_at = ?, invalidation_reason = ? WHERE id = ?`)
      .run(Date.now(), 'probe_flip_no_mfr', entryId);
    return { flipped: true, cascaded: 0 };
  }
  return { flipped, cascaded: 0 };
}

// ---------------------------------------------------------------------------
// Stats (read-only)
// ---------------------------------------------------------------------------

function stats({ disty } = {}) {
  const db = getDB();
  const where = disty ? `WHERE disty = ?` : '';
  const params = disty ? [disty] : [];
  const rows = db.prepare(`
    SELECT disty, result,
           SUM(CASE WHEN invalidated_at IS NULL AND expires_at > ${Date.now()} THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN invalidated_at IS NOT NULL THEN 1 ELSE 0 END) AS invalidated,
           SUM(CASE WHEN expires_at <= ${Date.now()} AND invalidated_at IS NULL THEN 1 ELSE 0 END) AS expired,
           COUNT(*) AS total
    FROM cache_entries ${where}
    GROUP BY disty, result
    ORDER BY disty, result
  `).all(...params);
  return rows;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  check,
  peek,
  record,
  logShadow,
  invalidateByMfr,
  invalidateByAcquisition,
  sampleForProbing,
  logProbe,
  stats,
  // Introspection / testing
  _normalizeMpn: normalizeMpn,
  _canonicalMfr: canonicalMfr,
  _DISTY_RULES: DISTY_RULES,
  _getDB: getDB,
  SHADOW_MODE,
};
