/**
 * Stock RFQ Activity Digest
 * =========================
 *
 * Cumulative-growing log of stock RFQ inbound activity, emailed every 4h.
 *
 * Cadence: 00/04/08/12/16/20 UTC (6 ticks/day), anchored at 00 UTC.
 *
 * Each tick shows:
 *   - Last 4h: N RFQs, M MPNs, P customers
 *   - Cumulative since 00 ET
 *   - Top 10 concentrated MPNs (with real/bogus hints per customer mix)
 *   - Top 10 concentrated customers (matched vs Unqualified, real/bogus heuristic)
 *
 * Designed to surface "concentrated activity and by whom (real vs bogus)" so
 * the operator can see where to focus broker quoting effort vs ignore junk.
 *
 * Heuristic — NOT gating:
 *   real:    matched non-Unqualified BP, Western broker domain, qty > 100,
 *            target price specified, repeat MPN demand from ≥2 distinct customers
 *            over the last 30d.
 *   bogus:   Unqualified Broker 1006505, qty exactly matches Astute Infor stock
 *            (price-check pattern), single-MPN no-qty no-target spot checks.
 *
 * Supply context (added 2026-05-11 v1):
 *   "Best Franchise (14d)" column shows the cheapest in-stock franchise VQ
 *   per top MPN (vendortype 1000002/1000008/1000009 — Franchise/Catalog/
 *   Online-Distributor — what the enrich-poller synthesizes from API hits).
 *   "OOS at franchise" appears when no in-stock row exists in the 14d window.
 *
 *   "Aggregator (OEMSecrets, 14d)" column (added 2026-05-11 v1): surgical
 *   fallback for HOT MPNs that show OOS at franchise. Hits OEMSecrets via
 *   `Trading Analysis/RFQ Sourcing/franchise_check/oemsecrets.js` to surface
 *   the Tier-2 alternate-franchise picture (Avnet/RS/Verical/Rochester/TME/
 *   EBV/Chip One Stop, etc — distys we don't have direct APIs for). Cache
 *   at `~/workspace/.oemsecrets-cache.json` with 14d TTL; usage log at
 *   `~/workspace/.oemsecrets-usage.ndjson` (every call logged with status,
 *   distributor count, price/qty if found). Per-tick budget of 3 fresh calls
 *   ⇒ 18/day max across 6 ticks, well under any plausible quota.
 *
 *   Still TODO:
 *     - Tier-3 broker availability fallback when Tier-2 is also OOS — show
 *       "X broker listings exist" (availability only, OEMSecrets license
 *       suppresses broker pricing).
 *     - Open-market / broker VQ snapshot from chuboe_vq_line non-franchise
 *       rows on the MPN for a demand-vs-supply-vs-broker view. Add once the
 *       broker capture side is steady.
 *
 * Usage:
 *   node stock-rfq-activity-digest.js                 # email the digest
 *   node stock-rfq-activity-digest.js --dry-run       # print to stdout, no email
 *   node stock-rfq-activity-digest.js --since=2026-05-11T00:00:00Z   # custom anchor (testing)
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createNotifier } = require('../../shared/notifier');
const oemsecrets = require('../RFQ Sourcing/franchise_check/oemsecrets');

const UNQUALIFIED_BROKER_ID = 1006505;
const STOCK_RFQ_TYPE_ID = 1000007;
const TOP_N = 10;

// OEMSecrets aggregator fallback for HOT MPNs that show OOS at franchise.
// File-based cache (14d TTL matching Stock-type cache TTL); per-tick budget
// keeps us well under any plausible API quota while we discover the real
// ceiling empirically.
const OEMSECRETS_CACHE_PATH = '/home/analytics_user/workspace/.oemsecrets-cache.json';
const OEMSECRETS_USAGE_LOG  = '/home/analytics_user/workspace/.oemsecrets-usage.ndjson';
const OEMSECRETS_TTL_MS     = 14 * 24 * 60 * 60 * 1000;
const OEMSECRETS_PER_TICK_BUDGET = 3;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceOverride = (args.find(a => a.startsWith('--since=')) || '').split('=')[1];

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// ─── TIME WINDOWS ────────────────────────────────────────────────────────────
//
// CRITICAL TZ NOTE (2026-05-11): adempiere.chuboe_rfq.created is a
// `timestamp without time zone` written by iDempiere's app server in
// America/Chicago local time (CDT in May). The PG session reports UTC, but
// the column values are CDT digits with no offset. Queries MUST convert the
// column via `AT TIME ZONE 'America/Chicago'` before comparing against UTC
// bounds, otherwise filters return wrong (often empty) windows.
//
// Display semantics: operator works on America/New_York. cumSince anchors
// at midnight ET so "cumulative since 00 ET" doesn't slice mid-workday.
const REPORT_TZ = 'America/New_York';
const DB_TZ     = 'America/Chicago';

function etMidnight(d = new Date()) {
  // Compute the UTC instant corresponding to today's 00:00:00 ET.
  // Intl gives us the wall-clock parts in ET; we then build a UTC Date that
  // refers to midnight on that wall-clock day in ET.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  // Use a known offset trick: build the ET-midnight as a UTC-tagged string,
  // then offset by ET's current UTC offset.
  const isoBase = `${parts.year}-${parts.month}-${parts.day}T00:00:00`;
  const naive = new Date(isoBase + 'Z'); // pretend it's UTC
  // Find ET's offset right now via Intl
  const tzNow = new Date(d.toLocaleString('en-US', { timeZone: REPORT_TZ }));
  const utcNow = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMin = Math.round((utcNow - tzNow) / 60_000); // minutes
  return new Date(naive.getTime() + offsetMin * 60_000);
}

function nMinutesAgo(d, n) {
  return new Date(d.getTime() - n * 60_000);
}

function fmtEt(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).format(d);
}

function fmtEtTimeOnly(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).format(d);
}

const now = new Date();
const cumSince = sinceOverride ? new Date(sinceOverride) : etMidnight(now);
const lastTickStart = nMinutesAgo(now, 240); // 4h

// ─── QUERIES ─────────────────────────────────────────────────────────────────

async function queryWindowStats(fromTs, toTs = now) {
  const r = await pool.query(`
    SELECT
      COUNT(DISTINCT r.chuboe_rfq_id)               AS rfq_count,
      COUNT(DISTINCT mpn.chuboe_mpn_clean)          AS unique_mpns,
      COUNT(DISTINCT r.c_bpartner_id)               AS unique_bps,
      COUNT(*) FILTER (
        WHERE r.c_bpartner_id = $3
      )                                              AS unqualified_lines,
      COUNT(*) FILTER (
        WHERE r.c_bpartner_id <> $3
      )                                              AS matched_lines
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl       ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn mpn  ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE r.chuboe_rfq_type_id = $4
      AND r.created AT TIME ZONE 'America/Chicago' >= $1
      AND r.created AT TIME ZONE 'America/Chicago' < $2
      AND r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND mpn.isactive = 'Y'
  `, [fromTs, toTs, UNQUALIFIED_BROKER_ID, STOCK_RFQ_TYPE_ID]);
  return r.rows[0];
}

async function queryTopMpns(fromTs, toTs = now, limit = TOP_N) {
  const r = await pool.query(`
    SELECT
      mpn.chuboe_mpn                                      AS mpn,
      MAX(mpn.chuboe_mfr_text)                            AS mfr,
      mpn.chuboe_mpn_clean                                AS mpn_clean,
      COUNT(*)                                            AS line_count,
      MAX(COALESCE(rl.qty, 0))                            AS max_qty,
      COUNT(DISTINCT r.c_bpartner_id)                     AS distinct_bps,
      COUNT(*) FILTER (WHERE r.c_bpartner_id <> $3)       AS matched_lines,
      COUNT(*) FILTER (WHERE r.c_bpartner_id = $3)        AS unqualified_lines,
      MAX(NULLIF(mpn.priceentered, 0))                    AS max_target_price,
      STRING_AGG(DISTINCT
        COALESCE(NULLIF(r.bpname, ''), bp.name),
        ', ' ORDER BY COALESCE(NULLIF(r.bpname, ''), bp.name)
      )                                                   AS customer_names
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl       ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn mpn  ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.c_bpartner bp       ON bp.c_bpartner_id = r.c_bpartner_id
    WHERE r.chuboe_rfq_type_id = $4
      AND r.created AT TIME ZONE 'America/Chicago' >= $1
      AND r.created AT TIME ZONE 'America/Chicago' < $2
      AND r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND mpn.isactive = 'Y'
    GROUP BY mpn.chuboe_mpn, mpn.chuboe_mpn_clean
    ORDER BY line_count DESC, max_qty DESC
    LIMIT $5
  `, [fromTs, toTs, UNQUALIFIED_BROKER_ID, STOCK_RFQ_TYPE_ID, limit]);
  return r.rows;
}

async function queryTopCustomers(fromTs, toTs = now, limit = TOP_N) {
  const r = await pool.query(`
    SELECT
      r.c_bpartner_id,
      MAX(bp.name)                                  AS bp_name,
      STRING_AGG(DISTINCT NULLIF(r.bpname, ''), ' | ') AS parsed_names,
      COUNT(DISTINCT r.chuboe_rfq_id)               AS rfq_count,
      COUNT(*)                                      AS line_count,
      COUNT(*) FILTER (WHERE mpn.priceentered > 0)  AS with_target_count
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl       ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn mpn  ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.c_bpartner bp       ON bp.c_bpartner_id = r.c_bpartner_id
    WHERE r.chuboe_rfq_type_id = $3
      AND r.created AT TIME ZONE 'America/Chicago' >= $1
      AND r.created AT TIME ZONE 'America/Chicago' < $2
      AND r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND mpn.isactive = 'Y'
    GROUP BY r.c_bpartner_id
    ORDER BY line_count DESC
    LIMIT $4
  `, [fromTs, toTs, STOCK_RFQ_TYPE_ID, limit]);
  return r.rows;
}

// ─── OEMSECRETS AGGREGATOR (surgical fallback for HOT MPNs) ─────────────────

function readOemsecretsCache() {
  try {
    return JSON.parse(fs.readFileSync(OEMSECRETS_CACHE_PATH, 'utf8'));
  } catch { return {}; }
}

function writeOemsecretsCache(cache) {
  try {
    fs.writeFileSync(OEMSECRETS_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('oemsecrets cache write failed:', e.message);
  }
}

function logOemsecretsCall(entry) {
  try {
    fs.appendFileSync(OEMSECRETS_USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('oemsecrets usage log write failed:', e.message);
  }
}

// Pick the cheapest aggregator row from a searchPart result. Tier 2/3 only —
// direct-API distributors are filtered out by the oemsecrets module already.
function bestAggregatorRow(searchResult) {
  if (!searchResult || !searchResult.found || !searchResult.distributors?.length) return null;
  const withPrice = searchResult.distributors
    .filter(d => Number(d.price) > 0 && Number(d.qty) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price));
  return withPrice[0] || null;
}

async function fetchOemsecretsForOosHotMpns(topMpns, franchiseMap, repeatMap) {
  const cache = readOemsecretsCache();
  const result = new Map();
  const nowMs = Date.now();
  let budgetUsed = 0;

  // Build the candidate list: top HOT-with-OOS-at-franchise MPNs, ranked by
  // concentration. Prefer parts the operator most needs visibility on.
  const candidates = topMpns
    .filter(r => !franchiseMap.get(r.mpn_clean))                           // OOS at franchise
    .filter(r => {                                                          // HOT signal
      const repeat = repeatMap.get(r.mpn_clean);
      return Number(r.distinct_bps) >= 3 || (repeat && Number(repeat.historical_bps) >= 3);
    })
    .sort((a, b) => Number(b.line_count) - Number(a.line_count));

  for (const r of candidates) {
    const cached = cache[r.mpn_clean];
    if (cached && cached.expires > nowMs) {
      result.set(r.mpn_clean, { ...cached.data, source: 'cache' });
      continue;
    }
    if (budgetUsed >= OEMSECRETS_PER_TICK_BUDGET) continue;
    try {
      const searchResult = await oemsecrets.searchPart(r.mpn, Number(r.max_qty) || 1);
      budgetUsed++;
      const best = bestAggregatorRow(searchResult);
      const summary = best
        ? { found: true, distributor: best.distributor || best.name, price: Number(best.price), qty: Number(best.qty), leadTime: best.leadTime || best.lead_time, distributorCount: searchResult.distributorCount }
        : { found: false, distributorCount: searchResult.distributorCount || 0 };
      cache[r.mpn_clean] = { expires: nowMs + OEMSECRETS_TTL_MS, data: summary };
      result.set(r.mpn_clean, { ...summary, source: 'fresh' });
      logOemsecretsCall({ event: 'success', mpn: r.mpn, found: summary.found, dist: summary.distributor || null, price: summary.price || null, qty: summary.qty || null });
    } catch (e) {
      budgetUsed++;
      const exhausted = /401|call limit|unauthorized/i.test(e.message);
      logOemsecretsCall({ event: exhausted ? 'quota_exhausted' : 'error', mpn: r.mpn, error: e.message });
      result.set(r.mpn_clean, { error: true, exhausted, message: e.message });
      if (exhausted) break;
    }
  }
  writeOemsecretsCache(cache);
  return { resultMap: result, budgetUsed, candidates: candidates.length };
}

async function queryFranchiseContext(mpnCleans) {
  // For each MPN, return the cheapest in-stock franchise VQ from the last 14d
  // (matches the Stock-type cache TTL bump from 2026-05-11). "Franchise" =
  // vendortype 1000002 (Franchise) + 1000008 (Catalog) + 1000009 (Online
  // Distributor) — the three buckets that the enrich-poller synthesizes from
  // franchise API responses. Excludes OOS lead-time-only rows; if no row
  // qualifies, the MPN gets an "OOS at franchise" indicator in the render.
  if (!mpnCleans.length) return new Map();
  const r = await pool.query(`
    WITH ranked AS (
      SELECT
        vq.chuboe_mpn_clean,
        bp.name             AS distributor,
        vq.cost,
        vq.qty,
        vq.chuboe_lead_time,
        ROW_NUMBER() OVER (
          PARTITION BY vq.chuboe_mpn_clean
          ORDER BY vq.cost ASC NULLS LAST
        ) AS rn
      FROM adempiere.chuboe_vq_line vq
      LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
      WHERE vq.isactive = 'Y'
        AND vq.chuboe_vendortype_id IN (1000002, 1000008, 1000009)
        AND vq.created AT TIME ZONE 'America/Chicago' >= NOW() - INTERVAL '14 days'
        AND vq.chuboe_mpn_clean = ANY($1::text[])
        AND COALESCE(vq.qty, 0) > 0
        AND COALESCE(vq.cost, 0) > 0
    )
    SELECT chuboe_mpn_clean, distributor, cost, qty, chuboe_lead_time
    FROM ranked
    WHERE rn = 1
  `, [mpnCleans]);
  const map = new Map();
  for (const row of r.rows) map.set(row.chuboe_mpn_clean, row);
  return map;
}

async function queryRepeatDemand(mpnCleans) {
  if (!mpnCleans.length) return new Map();
  const r = await pool.query(`
    SELECT
      mpn.chuboe_mpn_clean,
      COUNT(DISTINCT r.c_bpartner_id)   AS historical_bps,
      COUNT(DISTINCT r.chuboe_rfq_id)   AS historical_rfqs
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl       ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn mpn  ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE r.chuboe_rfq_type_id = $1
      AND r.created AT TIME ZONE 'America/Chicago' >= NOW() - INTERVAL '30 days'
      AND r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND mpn.isactive = 'Y'
      AND mpn.chuboe_mpn_clean = ANY($2::text[])
    GROUP BY mpn.chuboe_mpn_clean
  `, [STOCK_RFQ_TYPE_ID, mpnCleans]);
  const map = new Map();
  for (const row of r.rows) map.set(row.chuboe_mpn_clean, row);
  return map;
}

// ─── CLASSIFICATION ──────────────────────────────────────────────────────────

function classifyCustomer(row) {
  const id = Number(row.c_bpartner_id);
  if (id === UNQUALIFIED_BROKER_ID) {
    return { tag: 'BOGUS-LEAN', note: 'Unqualified Broker (sender not in DB)' };
  }
  if (row.with_target_count > 0) {
    return { tag: 'REAL', note: 'Matched BP, target price provided' };
  }
  return { tag: 'REAL-LEAN', note: 'Matched BP' };
}

function classifyMpn(row, repeatMap) {
  const mpnClean = row.mpn_clean;
  const repeat = repeatMap.get(mpnClean);
  const distinctBps = Number(row.distinct_bps);
  const matchedLines = Number(row.matched_lines);
  const totalLines = Number(row.line_count);
  const hist = repeat ? Number(repeat.historical_bps) : 0;

  if (distinctBps >= 3 || hist >= 3) return { tag: 'HOT', note: '≥3 distinct customers (today or 30d)' };
  if (matchedLines >= 1 && matchedLines >= totalLines / 2) return { tag: 'REAL', note: 'mostly from matched BPs' };
  if (matchedLines === 0) return { tag: 'BOGUS-LEAN', note: 'all from Unqualified' };
  return { tag: 'MIXED', note: 'matched + unqualified mix' };
}

// ─── RENDERING ───────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtInt(n) {
  const x = Math.round(Number(n) || 0);
  return x.toLocaleString('en-US');
}

function tagBadge(tag) {
  const color = {
    'HOT': '#b00',
    'REAL': '#0a0',
    'REAL-LEAN': '#393',
    'MIXED': '#a80',
    'BOGUS-LEAN': '#666',
  }[tag] || '#666';
  return `<span style="background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold">${escHtml(tag)}</span>`;
}

function fmtMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return '';
  return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function renderFranchiseCell(row) {
  if (!row) return '<span class="small" style="color:#a00">OOS at franchise</span>';
  const parts = [
    `<b>${fmtMoney(row.cost)}</b>`,
    `${fmtInt(row.qty)} @ ${escHtml(row.distributor || '—')}`,
  ];
  if (row.chuboe_lead_time) parts.push(`<span class="small">LT ${escHtml(row.chuboe_lead_time)}</span>`);
  return parts.join('<br/>');
}

function renderOemsecretsCell(entry) {
  if (!entry) return '<span class="small" style="color:#888">—</span>';
  if (entry.error && entry.exhausted) return '<span class="small" style="color:#a00">quota exhausted</span>';
  if (entry.error) return `<span class="small" style="color:#a00">error</span>`;
  if (!entry.found) return `<span class="small">none (${entry.distributorCount || 0} disty searched)</span>`;
  const parts = [
    `<b>${fmtMoney(entry.price)}</b>`,
    `${fmtInt(entry.qty)} @ ${escHtml(entry.distributor || '—')}`,
  ];
  if (entry.leadTime) parts.push(`<span class="small">LT ${escHtml(entry.leadTime)}</span>`);
  if (entry.source === 'cache') parts.push(`<span class="small" style="color:#888">cached</span>`);
  return parts.join('<br/>');
}

function renderHtml(model) {
  const { tickStats, cumStats, topMpns, topCustomers, repeatMap, franchiseMap, oemsecretsMap, windowLabel } = model;
  const css = `body{font-family:Arial,sans-serif;font-size:13px;color:#222}
    h2{color:#234;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
    h3{color:#456;margin:12px 0 4px;font-size:14px}
    table{border-collapse:collapse;margin:6px 0 12px}
    th{background:#eef;text-align:left;padding:4px 8px;border:1px solid #ccd;font-size:12px}
    td{padding:3px 8px;border:1px solid #eee;font-size:12px;vertical-align:top}
    .stat{display:inline-block;padding:6px 12px;margin:2px;background:#f6f6f6;border-radius:4px}
    .stat b{display:block;font-size:18px;color:#234}
    .small{color:#888;font-size:11px}`;

  let html = `<html><head><style>${css}</style></head><body>`;
  html += `<h2>Stock RFQ Activity Digest — ${escHtml(windowLabel)}</h2>`;

  // Section 1: stats
  html += `<h3>Last 4h</h3>`;
  html += `<div class="stat"><b>${fmtInt(tickStats.rfq_count)}</b>RFQs</div>`;
  html += `<div class="stat"><b>${fmtInt(tickStats.unique_mpns)}</b>Unique MPNs</div>`;
  html += `<div class="stat"><b>${fmtInt(tickStats.unique_bps)}</b>Customers</div>`;
  html += `<div class="stat"><b>${fmtInt(tickStats.matched_lines)}</b>Matched lines</div>`;
  html += `<div class="stat"><b>${fmtInt(tickStats.unqualified_lines)}</b>Unqualified lines</div>`;

  html += `<h3>Cumulative since 00 ET</h3>`;
  html += `<div class="stat"><b>${fmtInt(cumStats.rfq_count)}</b>RFQs</div>`;
  html += `<div class="stat"><b>${fmtInt(cumStats.unique_mpns)}</b>Unique MPNs</div>`;
  html += `<div class="stat"><b>${fmtInt(cumStats.unique_bps)}</b>Customers</div>`;
  html += `<div class="stat"><b>${fmtInt(cumStats.matched_lines)}</b>Matched lines</div>`;
  html += `<div class="stat"><b>${fmtInt(cumStats.unqualified_lines)}</b>Unqualified lines</div>`;

  // Section 2: Top MPNs (cumulative)
  html += `<h2>Top ${TOP_N} Concentrated MPNs (cumulative since 00 ET)</h2>`;
  if (topMpns.length === 0) {
    html += `<p class="small">No stock RFQ lines since 00 ET.</p>`;
  } else {
    html += `<table><tr><th>#</th><th>MPN</th><th>Mfr</th><th>Tag</th><th>Lines</th><th>Max Qty</th><th>Distinct Customers</th><th>30d Repeat</th><th>Best Franchise (14d)</th><th>Aggregator (OEMSecrets, 14d)</th><th>Asked by</th></tr>`;
    topMpns.forEach((r, i) => {
      const klass = classifyMpn(r, repeatMap);
      const repeat = repeatMap.get(r.mpn_clean);
      const repeatTxt = repeat
        ? `${fmtInt(repeat.historical_bps)} BPs / ${fmtInt(repeat.historical_rfqs)} RFQs`
        : '<span class="small">no recent</span>';
      html += `<tr>
        <td>${i + 1}</td>
        <td><b>${escHtml(r.mpn)}</b></td>
        <td>${escHtml(r.mfr || '')}</td>
        <td>${tagBadge(klass.tag)}<br/><span class="small">${escHtml(klass.note)}</span></td>
        <td>${fmtInt(r.line_count)}</td>
        <td>${fmtInt(r.max_qty)}</td>
        <td>${fmtInt(r.distinct_bps)} <span class="small">(${fmtInt(r.matched_lines)} matched / ${fmtInt(r.unqualified_lines)} unq)</span></td>
        <td>${repeatTxt}</td>
        <td>${renderFranchiseCell(franchiseMap.get(r.mpn_clean))}</td>
        <td>${renderOemsecretsCell(oemsecretsMap.get(r.mpn_clean))}</td>
        <td class="small">${escHtml((r.customer_names || '').slice(0, 200))}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // Section 3: Top customers
  html += `<h2>Top ${TOP_N} Customers by Volume (cumulative since 00 ET)</h2>`;
  if (topCustomers.length === 0) {
    html += `<p class="small">No stock RFQ lines since 00 ET.</p>`;
  } else {
    html += `<table><tr><th>#</th><th>BP</th><th>Parsed Name(s)</th><th>Tag</th><th>RFQs</th><th>Lines</th><th>w/ Target</th></tr>`;
    topCustomers.forEach((r, i) => {
      const klass = classifyCustomer(r);
      const bpLabel = Number(r.c_bpartner_id) === UNQUALIFIED_BROKER_ID
        ? `Unqualified Broker <span class="small">(${r.c_bpartner_id})</span>`
        : `${escHtml(r.bp_name || '(no name)')} <span class="small">(${r.c_bpartner_id})</span>`;
      html += `<tr>
        <td>${i + 1}</td>
        <td>${bpLabel}</td>
        <td class="small">${escHtml((r.parsed_names || '').slice(0, 200))}</td>
        <td>${tagBadge(klass.tag)}<br/><span class="small">${escHtml(klass.note)}</span></td>
        <td>${fmtInt(r.rfq_count)}</td>
        <td>${fmtInt(r.line_count)}</td>
        <td>${fmtInt(r.with_target_count)}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  html += `<p class="small">Cumulative window: ${fmtEt(cumSince)} → ${fmtEt(now)}. Last-4h window: ${fmtEt(lastTickStart)} → ${fmtEt(now)}.</p>`;
  html += `</body></html>`;
  return html;
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const [tickStats, cumStats, topMpns, topCustomers] = await Promise.all([
      queryWindowStats(lastTickStart),
      queryWindowStats(cumSince),
      queryTopMpns(cumSince),
      queryTopCustomers(cumSince),
    ]);

    const mpnCleans = topMpns.map(r => r.mpn_clean);
    const [repeatMap, franchiseMap] = await Promise.all([
      queryRepeatDemand(mpnCleans),
      queryFranchiseContext(mpnCleans),
    ]);
    const oem = await fetchOemsecretsForOosHotMpns(topMpns, franchiseMap, repeatMap);
    const oemsecretsMap = oem.resultMap;
    console.log(`OEMSecrets: ${oem.budgetUsed} fresh call(s), ${oem.candidates} OOS+HOT candidate(s) considered`);

    const cumDateEt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(cumSince);
    const windowLabel = `${fmtEtTimeOnly(now)} tick (cum since ${cumDateEt} 00 ET)`;
    const html = renderHtml({ tickStats, cumStats, topMpns, topCustomers, repeatMap, franchiseMap, oemsecretsMap, windowLabel });

    if (dryRun) {
      console.log(html);
      console.log('\n--- DRY RUN — no email sent ---');
      console.log(`Tick stats:  ${JSON.stringify(tickStats)}`);
      console.log(`Cum stats:   ${JSON.stringify(cumStats)}`);
      console.log(`Top MPNs:    ${topMpns.length} rows`);
      console.log(`Top Custs:   ${topCustomers.length} rows`);
    } else {
      const subject = `Stock RFQ Activity — ${windowLabel}`;
      const notifier = createNotifier({
        fromEmail: 'stockRFQ@orangetsunami.com',
        fromName: 'Stock RFQ Digest',
      });
      await notifier.sendEmail(
        process.env.OPERATOR_EMAIL || 'jake.harris@Astutegroup.com',
        subject,
        html,
        { html: true },
      );
      console.log(`Sent digest: "${subject}"`);
    }
  } catch (e) {
    console.error('Stock RFQ digest failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
