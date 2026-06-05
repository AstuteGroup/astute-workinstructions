/**
 * Stock RFQ Activity Digest
 * =========================
 *
 * Rolling 30-day activity log of stock RFQ inbound demand, emailed every 4h.
 *
 * Cadence: 00/04/08/12/16/20 UTC (6 ticks/day), anchored at 00 UTC.
 *
 * Each tick shows:
 *   - Stat band: Last 4h / Today (since 00 ET) / Last 30d
 *   - Top 10 MPNs over the LAST 30 DAYS (durable demand signal) with Last-4h
 *     and Today deltas inline. Drives the heat tag.
 *   - Top 10 MPNs TODAY (since 00 ET) — what's fresh this slice, separate ranking
 *   - Top 10 customers over the last 30 days
 *
 * Asked-by column dedupes customer names with `(xN)` counts when a customer
 * has filed multiple distinct RFQs for the MPN in the window.
 *
 * Two distinct supply-side enrichment columns:
 *
 *   Stock column (Astute-owned inventory — what we currently post on
 *   inventory reports / static reports):
 *     - Free Stock        — Astute Electronics Inc (BP 1000332)
 *     - Franchise Stock   — Astute - Franchise Stock (BP 1000325)
 *     - Consignment       — Astute-{customer} Excess BPs (GE/Taxan/Spartronics/Eaton/LAM)
 *     - LAM Dead          — BP 1000332 + "LAM_Dead_Inventory" description suffix
 *
 *   Excess Match (90d) column (3rd-party Customer Excess via the offer-poller
 *   pipeline from excess@orangetsunami.com — NOT on currently-posted inventory
 *   reports; provided here as a heads-up for HOT-tagged MPNs only):
 *     - Customer Excess   — offer types 1000000/1000003, last 90 days
 *
 * Excludes offer type 1000025 (LAM Kitting Inventory — one-off LAM consigned-
 * stock report, never on the supply side).
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
const publish = args.includes('--publish');
const sinceOverride = (args.find(a => a.startsWith('--since=')) || '').split('=')[1];

// Site staging dir for --publish; overridable for tests.
const SITE_DIR = process.env.STOCK_RFQ_SITE_DIR
  || '/home/analytics_user/workspace/.stock-rfq-digest-site';

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// ─── INVENTORY BUCKETING (stock-match column) ────────────────────────────────
//
// Per `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js`
// WAREHOUSE_WRITEBACK map: a single (BP, OfferType, description-suffix) tuple
// identifies each warehouse group. We bucket by BP because BPs are stable
// and warehouse/location is derivable from offer_type + description.
const ASTUTE_ELECTRONICS_BP   = 1000332;  // Free Stock + LAM Dead
const ASTUTE_FRANCHISE_BP     = 1000325;  // Franchise Stock
const CONSIGNMENT_BPS = {
  1003236: 'GE',
  1003621: 'Taxan',
  1005225: 'Spartronics',
  1010966: 'Eaton',
  1011267: 'LAM',
};
const FREE_STOCK_LOCATIONS_BY_TYPE = {
  1000006: 'Stevenage',
  1000008: 'Austin',
  1000009: 'Hong Kong',
  1000014: 'Philippines',
};
const LAM_KITTING_INVENTORY_TYPE = 1000025;  // excluded — one-off LAM report
const CUSTOMER_EXCESS_TYPES = [1000000, 1000003];  // Customer Excess + Lead Time Buy

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
const todayStart    = sinceOverride ? new Date(sinceOverride) : etMidnight(now);
const lastTickStart = nMinutesAgo(now, 240);                          // 4h
const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60_000); // 24h rolling
const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60_000); // 30d rolling
// `cumSince` is kept as a legacy alias for the today-since-00-ET anchor used
// by the second MPN table and stat-band "Today" column.
const cumSince = todayStart;

// ─── QUERIES ─────────────────────────────────────────────────────────────────

async function queryWindowStats(fromTs, toTs = now) {
  const r = await pool.query(`
    SELECT
      COUNT(DISTINCT r.chuboe_rfq_id)               AS rfq_count,
      COUNT(DISTINCT mpn.chuboe_mpn_clean)          AS unique_mpns,
      COUNT(DISTINCT r.c_bpartner_id)               AS unique_bps,
      COUNT(DISTINCT r.chuboe_rfq_id) FILTER (
        WHERE r.c_bpartner_id = $3
      )                                              AS unqualified_rfqs,
      COUNT(DISTINCT r.chuboe_rfq_id) FILTER (
        WHERE r.c_bpartner_id <> $3
      )                                              AS matched_rfqs
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

// Top MPNs over [fromTs, toTs).
//
// All counts are at the RFQ level — `COUNT(DISTINCT chuboe_rfq_id)`, never
// COUNT(*) over the line-mpn join. Counting line-mpn rows inflated the headline
// "Lines" number whenever an RFQ carried alternates or re-listed the same MPN,
// and it diverged from the 30d-Repeat RFQ count for no operationally useful
// reason. One MPN appearing on one broker email = one count.
//
// `tickStart` is an OPTIONAL inner window inside [fromTs, toTs). When set,
// each row also returns `tick_rfqs` (distinct RFQs in the inner window) so the
// 30d table can show "what's hot RIGHT NOW within the 30d signal" inline. Pass
// `tickStart` = lastTickStart for the 30d-primary table; pass null for the
// today-only table to skip the extra FILTER.
//
// `todayStart` is similarly OPTIONAL — when set, each row returns
// `today_rfqs` (distinct RFQs since 00 ET) for inline delta visibility.
//
// Asked-by column: dedupes customer names with `(xN)` suffix when a customer
// has more than one distinct RFQ in the window. CTE-based to keep the count-
// per-customer aggregation independent of the headline GROUP BY.
async function queryTopMpns(fromTs, toTs = now, opts = {}) {
  const limit = opts.limit || TOP_N;
  const tickStart = opts.tickStart || null;
  const todayStartTs = opts.todayStart || null;

  const r = await pool.query(`
    WITH lines AS (
      SELECT
        mpn.chuboe_mpn,
        mpn.chuboe_mpn_clean,
        mpn.chuboe_mfr_text,
        mpn.priceentered,
        r.chuboe_rfq_id,
        r.c_bpartner_id,
        rl.qty,
        COALESCE(NULLIF(r.bpname, ''), bp.name) AS customer_name,
        (r.created AT TIME ZONE 'America/Chicago') AS created_ct
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
    ),
    per_mpn_customer AS (
      SELECT
        chuboe_mpn_clean,
        customer_name,
        COUNT(DISTINCT chuboe_rfq_id) AS rfq_count
      FROM lines
      WHERE customer_name IS NOT NULL AND customer_name <> ''
      GROUP BY chuboe_mpn_clean, customer_name
    ),
    customer_agg AS (
      SELECT
        chuboe_mpn_clean,
        STRING_AGG(
          customer_name || CASE WHEN rfq_count > 1 THEN ' (x' || rfq_count || ')' ELSE '' END,
          ', ' ORDER BY rfq_count DESC, customer_name
        ) AS customer_names
      FROM per_mpn_customer
      GROUP BY chuboe_mpn_clean
    ),
    mpn_summary AS (
      SELECT
        l.chuboe_mpn                                                       AS mpn,
        MAX(l.chuboe_mfr_text)                                             AS mfr,
        l.chuboe_mpn_clean                                                 AS mpn_clean,
        COUNT(DISTINCT l.chuboe_rfq_id)                                    AS rfq_count,
        MAX(COALESCE(l.qty, 0))                                            AS max_qty,
        COUNT(DISTINCT l.c_bpartner_id)                                    AS distinct_bps,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (WHERE l.c_bpartner_id <> $3) AS matched_rfqs,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (WHERE l.c_bpartner_id = $3)  AS unqualified_rfqs,
        MAX(NULLIF(l.priceentered, 0))                                     AS max_target_price,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (
          WHERE $6::timestamp IS NOT NULL AND l.created_ct >= $6::timestamp
        )                                                                  AS tick_rfqs,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (
          WHERE $7::timestamp IS NOT NULL AND l.created_ct >= $7::timestamp
        )                                                                  AS today_rfqs
      FROM lines l
      GROUP BY l.chuboe_mpn, l.chuboe_mpn_clean
    )
    SELECT s.*, c.customer_names
    FROM mpn_summary s
    LEFT JOIN customer_agg c ON c.chuboe_mpn_clean = s.mpn_clean
    ORDER BY s.rfq_count DESC, s.max_qty DESC
    LIMIT $5
  `, [
    fromTs, toTs, UNQUALIFIED_BROKER_ID, STOCK_RFQ_TYPE_ID, limit,
    tickStart, todayStartTs,
  ]);
  return r.rows;
}

// APAC country codes to exclude from "qualified Western" demand signal.
const APAC_COUNTRY_CODES = ['CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'VN', 'TH', 'ID', 'MY', 'PH', 'IN'];

// Top MPNs from QUALIFIED NON-APAC customers only.
// Excludes: Unqualified Broker (1006505) + APAC-based BPs (by country on BP location).
// Used for the 24h rolling "real Western demand" signal section.
async function queryTopMpnsQualifiedOnly(fromTs, toTs = now, opts = {}) {
  const limit = opts.limit || 5;
  const tickStart = opts.tickStart || null;
  const todayStartTs = opts.todayStart || null;

  const r = await pool.query(`
    WITH apac_bps AS (
      -- BPs with ANY location in an APAC country
      SELECT DISTINCT bp.c_bpartner_id
      FROM adempiere.c_bpartner bp
      JOIN adempiere.c_bpartner_location bpl ON bpl.c_bpartner_id = bp.c_bpartner_id AND bpl.isactive = 'Y'
      JOIN adempiere.c_location l ON l.c_location_id = bpl.c_location_id
      JOIN adempiere.c_country c ON c.c_country_id = l.c_country_id
      WHERE c.countrycode = ANY($8::text[])
    ),
    lines AS (
      SELECT
        mpn.chuboe_mpn,
        mpn.chuboe_mpn_clean,
        mpn.chuboe_mfr_text,
        mpn.priceentered,
        r.chuboe_rfq_id,
        r.c_bpartner_id,
        rl.qty,
        COALESCE(NULLIF(r.bpname, ''), bp.name) AS customer_name,
        (r.created AT TIME ZONE 'America/Chicago') AS created_ct
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line rl       ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn mpn  ON mpn.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      LEFT JOIN adempiere.c_bpartner bp       ON bp.c_bpartner_id = r.c_bpartner_id
      WHERE r.chuboe_rfq_type_id = $4
        AND r.created AT TIME ZONE 'America/Chicago' >= $1
        AND r.created AT TIME ZONE 'America/Chicago' < $2
        AND r.c_bpartner_id <> $3
        AND r.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM apac_bps)
        AND r.isactive = 'Y'
        AND rl.isactive = 'Y'
        AND mpn.isactive = 'Y'
    ),
    per_mpn_customer AS (
      SELECT
        chuboe_mpn_clean,
        customer_name,
        COUNT(DISTINCT chuboe_rfq_id) AS rfq_count
      FROM lines
      WHERE customer_name IS NOT NULL AND customer_name <> ''
      GROUP BY chuboe_mpn_clean, customer_name
    ),
    customer_agg AS (
      SELECT
        chuboe_mpn_clean,
        STRING_AGG(
          customer_name || CASE WHEN rfq_count > 1 THEN ' (x' || rfq_count || ')' ELSE '' END,
          ', ' ORDER BY rfq_count DESC, customer_name
        ) AS customer_names
      FROM per_mpn_customer
      GROUP BY chuboe_mpn_clean
    ),
    mpn_summary AS (
      SELECT
        l.chuboe_mpn                                                       AS mpn,
        MAX(l.chuboe_mfr_text)                                             AS mfr,
        l.chuboe_mpn_clean                                                 AS mpn_clean,
        COUNT(DISTINCT l.chuboe_rfq_id)                                    AS rfq_count,
        MAX(COALESCE(l.qty, 0))                                            AS max_qty,
        COUNT(DISTINCT l.c_bpartner_id)                                    AS distinct_bps,
        COUNT(DISTINCT l.chuboe_rfq_id)                                    AS matched_rfqs,
        0                                                                  AS unqualified_rfqs,
        MAX(NULLIF(l.priceentered, 0))                                     AS max_target_price,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (
          WHERE $6::timestamp IS NOT NULL AND l.created_ct >= $6::timestamp
        )                                                                  AS tick_rfqs,
        COUNT(DISTINCT l.chuboe_rfq_id) FILTER (
          WHERE $7::timestamp IS NOT NULL AND l.created_ct >= $7::timestamp
        )                                                                  AS today_rfqs
      FROM lines l
      GROUP BY l.chuboe_mpn, l.chuboe_mpn_clean
    )
    SELECT s.*, c.customer_names
    FROM mpn_summary s
    LEFT JOIN customer_agg c ON c.chuboe_mpn_clean = s.mpn_clean
    ORDER BY s.rfq_count DESC, s.max_qty DESC
    LIMIT $5
  `, [fromTs, toTs, UNQUALIFIED_BROKER_ID, STOCK_RFQ_TYPE_ID, limit, tickStart, todayStartTs, APAC_COUNTRY_CODES]);
  return r.rows;
}

async function queryTopCustomers(fromTs, toTs = now, limit = TOP_N) {
  // Ranked by distinct RFQs, not line_mpn rows. Stock RFQs from brokers are
  // 1-5 lines typical; a single fat misclassified customer RFQ (e.g. a 4k-line
  // CM RFQ typed as Stock) used to swamp the customer table under line-count
  // ranking. RFQ count is the durable demand signal.
  const r = await pool.query(`
    SELECT
      r.c_bpartner_id,
      MAX(bp.name)                                  AS bp_name,
      STRING_AGG(DISTINCT NULLIF(r.bpname, ''), ' | ') AS parsed_names,
      COUNT(DISTINCT r.chuboe_rfq_id)               AS rfq_count,
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
    ORDER BY rfq_count DESC
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
    .sort((a, b) => Number(b.rfq_count) - Number(a.rfq_count));

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

// Astute-owned inventory matches for each top MPN. Buckets:
//   - 'Free Stock'      — BP 1000332, excluding "LAM_Dead_Inventory" desc suffix
//   - 'LAM Dead'        — BP 1000332 with "LAM_Dead_Inventory" desc suffix
//   - 'Franchise Stock' — BP 1000325
//   - 'Consignment'     — BPs 1003236 / 1003621 / 1005225 / 1010966 / 1011267
// Customer Excess (offer types 1000000/1000003) is handled separately in
// `queryExcessMatches` because it's a different data product (3rd-party
// excess via the offer-poller pipeline) with different freshness semantics.
// Excludes offer type 1000025 (LAM Kitting Inventory). Up to TOP_MATCHES_PER_MPN
// matches per MPN, ordered by qty desc.
const TOP_MATCHES_PER_MPN = 3;
async function queryAstuteStock(mpnCleans) {
  if (!mpnCleans.length) return new Map();
  const astuteOwnedBps = [
    ASTUTE_ELECTRONICS_BP,
    ASTUTE_FRANCHISE_BP,
    ...Object.keys(CONSIGNMENT_BPS).map(Number),
  ];
  const r = await pool.query(`
    WITH matches AS (
      SELECT
        ol.chuboe_mpn_clean,
        o.c_bpartner_id,
        bp.name         AS bp_name,
        ol.qty,
        ol.priceentered,
        CASE
          WHEN o.c_bpartner_id = $2 AND COALESCE(o.description,'') LIKE '%LAM_Dead_Inventory%'
            THEN 'LAM Dead'
          WHEN o.c_bpartner_id = $2  THEN 'Free Stock'
          WHEN o.c_bpartner_id = $3  THEN 'Franchise Stock'
          WHEN o.c_bpartner_id = ANY($4::int[]) THEN 'Consignment'
          ELSE NULL
        END AS bucket,
        CASE
          WHEN o.c_bpartner_id = $2 AND COALESCE(o.description,'') LIKE '%LAM_Dead_Inventory%'
            THEN 'Austin (Dead)'
          WHEN o.c_bpartner_id = $2 THEN COALESCE(
            (CASE o.chuboe_offer_type_id
               WHEN 1000006 THEN 'Stevenage'
               WHEN 1000008 THEN 'Austin'
               WHEN 1000009 THEN 'Hong Kong'
               WHEN 1000014 THEN 'Philippines'
            END), 'Astute Electronics')
          WHEN o.c_bpartner_id = $3 THEN 'Franchise (Austin)'
          WHEN o.c_bpartner_id = 1003236 THEN 'GE (Austin)'
          WHEN o.c_bpartner_id = 1003621 THEN 'Taxan (Austin)'
          WHEN o.c_bpartner_id = 1005225 THEN 'Spartronics (Austin)'
          WHEN o.c_bpartner_id = 1010966 THEN 'Eaton (PH)'
          WHEN o.c_bpartner_id = 1011267 THEN 'LAM (PH)'
          ELSE bp.name
        END AS location_label
      FROM adempiere.chuboe_offer o
      JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id
      LEFT JOIN adempiere.c_bpartner bp   ON bp.c_bpartner_id = o.c_bpartner_id
      WHERE o.isactive = 'Y' AND ol.isactive = 'Y'
        AND o.chuboe_offer_type_id <> ${LAM_KITTING_INVENTORY_TYPE}
        AND o.c_bpartner_id = ANY($4::int[])
        AND ol.chuboe_mpn_clean = ANY($1::text[])
        AND COALESCE(ol.qty, 0) > 0
    ),
    aggregated AS (
      SELECT
        chuboe_mpn_clean, bucket, location_label, bp_name, c_bpartner_id,
        SUM(qty)                       AS total_qty,
        COUNT(*)                       AS lot_count,
        MIN(NULLIF(priceentered, 0))   AS min_price
      FROM matches
      WHERE bucket IS NOT NULL
      GROUP BY chuboe_mpn_clean, bucket, location_label, bp_name, c_bpartner_id
    ),
    ranked AS (
      SELECT a.*,
        ROW_NUMBER() OVER (
          PARTITION BY chuboe_mpn_clean
          ORDER BY total_qty DESC NULLS LAST, bucket
        ) AS rn
      FROM aggregated a
    )
    SELECT chuboe_mpn_clean, bucket, location_label, bp_name, c_bpartner_id,
           total_qty AS qty, lot_count, min_price
    FROM ranked
    WHERE rn <= ${TOP_MATCHES_PER_MPN}
    ORDER BY chuboe_mpn_clean, qty DESC NULLS LAST
  `, [
    mpnCleans,
    ASTUTE_ELECTRONICS_BP,
    ASTUTE_FRANCHISE_BP,
    astuteOwnedBps,
  ]);
  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.chuboe_mpn_clean)) map.set(row.chuboe_mpn_clean, []);
    map.get(row.chuboe_mpn_clean).push(row);
  }
  return map;
}

// Customer Excess matches in the last 90 days. Restricted to HOT MPNs (the
// caller filters mpnCleans before calling) so we don't dilute the digest with
// excess data on lukewarm parts. 90-day window because the offer-poller
// pipeline runs continuously — old excess offers go stale and shouldn't
// suggest false supply paths.
async function queryExcessMatches(mpnCleans) {
  if (!mpnCleans.length) return new Map();
  const r = await pool.query(`
    WITH matches AS (
      SELECT
        ol.chuboe_mpn_clean,
        o.c_bpartner_id,
        bp.name AS bp_name,
        ol.qty,
        ol.priceentered
      FROM adempiere.chuboe_offer o
      JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id
      LEFT JOIN adempiere.c_bpartner bp   ON bp.c_bpartner_id = o.c_bpartner_id
      WHERE o.isactive = 'Y' AND ol.isactive = 'Y'
        AND o.chuboe_offer_type_id = ANY($2::int[])
        AND ol.chuboe_mpn_clean = ANY($1::text[])
        AND COALESCE(ol.qty, 0) > 0
        AND o.created AT TIME ZONE 'America/Chicago' >= NOW() - INTERVAL '90 days'
    ),
    aggregated AS (
      SELECT
        chuboe_mpn_clean, bp_name, c_bpartner_id,
        SUM(qty)                       AS total_qty,
        COUNT(*)                       AS lot_count,
        MIN(NULLIF(priceentered, 0))   AS min_price
      FROM matches
      GROUP BY chuboe_mpn_clean, bp_name, c_bpartner_id
    ),
    ranked AS (
      SELECT a.*,
        ROW_NUMBER() OVER (
          PARTITION BY chuboe_mpn_clean
          ORDER BY total_qty DESC NULLS LAST
        ) AS rn
      FROM aggregated a
    )
    SELECT chuboe_mpn_clean, bp_name, c_bpartner_id,
           total_qty AS qty, lot_count, min_price
    FROM ranked
    WHERE rn <= ${TOP_MATCHES_PER_MPN}
    ORDER BY chuboe_mpn_clean, qty DESC NULLS LAST
  `, [mpnCleans, CUSTOMER_EXCESS_TYPES]);
  const map = new Map();
  for (const row of r.rows) {
    if (!map.has(row.chuboe_mpn_clean)) map.set(row.chuboe_mpn_clean, []);
    map.get(row.chuboe_mpn_clean).push(row);
  }
  return map;
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
  const matchedRfqs = Number(row.matched_rfqs);
  const totalRfqs = Number(row.rfq_count);
  const hist = repeat ? Number(repeat.historical_bps) : 0;

  if (distinctBps >= 3 || hist >= 3) return { tag: 'HOT', note: '≥3 distinct customers (today or 30d)' };
  if (matchedRfqs >= 1 && matchedRfqs >= totalRfqs / 2) return { tag: 'REAL', note: 'mostly from matched BPs' };
  if (matchedRfqs === 0) return { tag: 'BOGUS-LEAN', note: 'all from Unqualified' };
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

function bucketColor(bucket) {
  return {
    'Free Stock':      '#0a6',
    'Franchise Stock': '#069',
    'Consignment':     '#960',
    'Customer Excess': '#609',
    'LAM Dead':        '#888',
  }[bucket] || '#444';
}

function renderStockCell(matches) {
  if (!matches || matches.length === 0) {
    return '<span class="small" style="color:#888">—</span>';
  }
  return matches.map(m => {
    const color = bucketColor(m.bucket);
    const lots = Number(m.lot_count) > 1 ? ` <span class="small">(${m.lot_count} lots)</span>` : '';
    return `<span style="color:${color};font-weight:bold">${escHtml(m.bucket)}</span> · `
         + `${escHtml(m.location_label)} · ${fmtInt(m.qty)}${lots}`;
  }).join('<br/>');
}

// Customer Excess (90d) cell — only populated for HOT MPNs. For non-HOT rows
// the caller passes `null` and we render the dash. Different visual treatment
// than Stock — purple-tinted "Excess" label since these are 3rd-party offers
// from the offer-poller / customer-excess-analysis pipeline, not Astute-owned.
function renderExcessCell(matches, isHot) {
  if (!isHot) {
    return '<span class="small" style="color:#bbb">— (non-HOT)</span>';
  }
  if (!matches || matches.length === 0) {
    return '<span class="small" style="color:#888">none (90d)</span>';
  }
  return matches.map(m => {
    const lots = Number(m.lot_count) > 1 ? ` <span class="small">(${m.lot_count} lots)</span>` : '';
    return `<span style="color:#609;font-weight:bold">Excess</span> · `
         + `${escHtml(m.bp_name || '(unknown bp)')} · ${fmtInt(m.qty)}${lots}`;
  }).join('<br/>');
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

function renderMpnRow(r, i, ctx) {
  const { repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
          includeTickCol, includeTodayCol } = ctx;
  const klass = classifyMpn(r, repeatMap);
  const isHot = klass.tag === 'HOT';
  const repeat = repeatMap.get(r.mpn_clean);
  const repeatTxt = repeat
    ? `${fmtInt(repeat.historical_bps)} BPs / ${fmtInt(repeat.historical_rfqs)} RFQs`
    : '<span class="small">no recent</span>';
  const tickCell = includeTickCol
    ? `<td>${Number(r.tick_rfqs) > 0 ? `<b>${fmtInt(r.tick_rfqs)}</b>` : '<span class="small">0</span>'}</td>`
    : '';
  const todayCell = includeTodayCol
    ? `<td>${Number(r.today_rfqs) > 0 ? `<b>${fmtInt(r.today_rfqs)}</b>` : '<span class="small">0</span>'}</td>`
    : '';
  return `<tr>
    <td>${i + 1}</td>
    <td><b>${escHtml(r.mpn)}</b></td>
    <td>${escHtml(r.mfr || '')}</td>
    <td>${tagBadge(klass.tag)}<br/><span class="small">${escHtml(klass.note)}</span></td>
    <td>${fmtInt(r.rfq_count)}</td>
    ${tickCell}${todayCell}
    <td>${fmtInt(r.max_qty)}</td>
    <td>${fmtInt(r.distinct_bps)} <span class="small">(${fmtInt(r.matched_rfqs)} matched / ${fmtInt(r.unqualified_rfqs)} unq)</span></td>
    <td>${repeatTxt}</td>
    <td>${renderStockCell(stockMap.get(r.mpn_clean))}</td>
    <td>${renderExcessCell(excessMap.get(r.mpn_clean), isHot)}</td>
    <td>${renderFranchiseCell(franchiseMap.get(r.mpn_clean))}</td>
    <td>${renderOemsecretsCell(oemsecretsMap.get(r.mpn_clean))}</td>
    <td class="small">${escHtml((r.customer_names || '').slice(0, 200))}</td>
  </tr>`;
}

function renderMpnTable(rows, ctx, headerLabel, emptyMsg) {
  let html = `<h2>${escHtml(headerLabel)}</h2>`;
  if (!rows.length) return html + `<p class="small">${escHtml(emptyMsg)}</p>`;
  const tickHeader  = ctx.includeTickCol  ? '<th>Last 4h</th>'  : '';
  const todayHeader = ctx.includeTodayCol ? '<th>Today</th>' : '';
  html += `<table><tr><th>#</th><th>MPN</th><th>Mfr</th><th>Tag</th>`
       + `<th>RFQs</th>${tickHeader}${todayHeader}<th>Highest RFQ Qty</th>`
       + `<th>Distinct Customers</th><th>30d Repeat</th>`
       + `<th>Stock</th><th>Excess Match (90d)</th>`
       + `<th>Best Franchise (14d)</th>`
       + `<th>Aggregator (OEMSecrets, 14d)</th><th>Asked by</th></tr>`;
  rows.forEach((r, i) => { html += renderMpnRow(r, i, ctx); });
  html += `</table>`;
  return html;
}


function renderStatBand(label, stats) {
  return `<h3>${escHtml(label)}</h3>`
       + `<div class="stat"><b>${fmtInt(stats.rfq_count)}</b>RFQs</div>`
       + `<div class="stat"><b>${fmtInt(stats.unique_mpns)}</b>Unique MPNs</div>`
       + `<div class="stat"><b>${fmtInt(stats.unique_bps)}</b>Customers</div>`
       + `<div class="stat"><b>${fmtInt(stats.matched_rfqs)}</b>Matched RFQs</div>`
       + `<div class="stat"><b>${fmtInt(stats.unqualified_rfqs)}</b>Unqualified RFQs</div>`;
}

const DIGEST_CSS = `body{font-family:Arial,sans-serif;font-size:13px;color:#222}
  h2{color:#234;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
  h3{color:#456;margin:12px 0 4px;font-size:14px}
  table{border-collapse:collapse;margin:6px 0 12px}
  th{background:#eef;text-align:left;padding:4px 8px;border:1px solid #ccd;font-size:12px}
  td{padding:3px 8px;border:1px solid #eee;font-size:12px;vertical-align:top}
  .stat{display:inline-block;padding:6px 12px;margin:2px;background:#f6f6f6;border-radius:4px}
  .stat b{display:block;font-size:18px;color:#234}
  .small{color:#888;font-size:11px}`;

// Body content (everything between <body> and </body>) — shared between the
// email wrapper (renderHtml) and the website wrapper (renderSiteHtml).
function renderBodyInner(model) {
  const {
    tickStats, todayStats, thirtyStats,
    topMpns30d, topMpnsToday, topCustomers, topQualified24h,
    repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
    windowLabel,
  } = model;

  let html = '';
  html += `<h2>Stock RFQ Activity Digest — ${escHtml(windowLabel)}</h2>`;

  // Stat band — three windows
  html += renderStatBand('Last 4h',                tickStats);
  html += renderStatBand('Today (since 00 ET)',    todayStats);
  html += renderStatBand('Last 30 days',           thirtyStats);

  // Top 5 Qualified Non-APAC (24h rolling) — real Western demand signal.
  // Excludes: Unqualified Broker (1006505) + APAC-based BPs (CN/HK/TW/JP/KR/SG/VN/TH/ID/MY/PH/IN).
  // Full enrichment columns (Stock, Excess, Franchise, OEMSecrets) for opportunity ID.
  const ctxQualified24h = {
    repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
    includeTickCol: true, includeTodayCol: true,
  };
  html += renderMpnTable(
    topQualified24h || [], ctxQualified24h,
    'Top 5 Requested Parts — 24h Rolling (Western Customers Only)',
    'No Western-customer RFQs in the last 24 hours.',
  );

  // Primary: Top MPNs over 30d (durable demand signal). Inline Last-4h and
  // Today columns so a 30d-hot MPN that's also moving today stands out.
  const ctx30d = {
    repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
    includeTickCol: true, includeTodayCol: true,
  };
  html += renderMpnTable(
    topMpns30d, ctx30d,
    `Top ${TOP_N} MPNs — Last 30 Days`,
    'No stock RFQs in the last 30 days.',
  );

  // Secondary: Top MPNs since 00 ET (today's slice — what's fresh).
  const ctxToday = {
    repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
    includeTickCol: true, includeTodayCol: false,
  };
  html += renderMpnTable(
    topMpnsToday, ctxToday,
    `Top ${TOP_N} MPNs — Today (since 00 ET)`,
    'No stock RFQs since 00 ET.',
  );

  // Top Customers (30d only — customer demand is slower-moving than MPN heat)
  html += `<h2>Top ${TOP_N} Customers by Volume (Last 30 Days)</h2>`;
  if (topCustomers.length === 0) {
    html += `<p class="small">No stock RFQ lines in the last 30 days.</p>`;
  } else {
    html += `<table><tr><th>#</th><th>BP</th><th>Parsed Name(s)</th><th>Tag</th><th>RFQs</th><th>w/ Target</th></tr>`;
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
        <td>${fmtInt(r.with_target_count)}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  html += `<p class="small">Windows — Last 4h: ${fmtEt(lastTickStart)} → ${fmtEt(now)}. `
       + `Today: ${fmtEt(todayStart)} → ${fmtEt(now)}. `
       + `Last 30d: ${fmtEt(thirtyDaysAgo)} → ${fmtEt(now)}.</p>`;
  return html;
}

// Email-style wrapper: self-contained HTML doc for the notifier.
function renderHtml(model) {
  return `<html><head><style>${DIGEST_CSS}</style></head><body>${renderBodyInner(model)}</body></html>`;
}

// ─── SITE RENDERING (--publish path) ─────────────────────────────────────────
//
// renderSiteFrame wraps arbitrary body HTML with:
//   - mobile-friendly viewport + UTF-8
//   - the Netlify Identity widget (login modal + JWT cookie)
//   - a top nav (Latest / Archive / Sign out)
//   - a client-side gate: <main> stays display:none until the widget confirms
//     a logged-in user.
//
// SECURITY NOTE — this is a *client-side* gate. The HTML is still served
// publicly by URL; a determined party with the URL and curl could download
// the raw markup. That's acceptable for internal sourcing intel behind an
// unguessable subdomain, but if we ever need true server-side protection
// the upgrade path is either Netlify Pro role-based redirects or a
// Cloudflare Access tunnel in front of the site.
const SITE_FRAME_CSS = `
  body{margin:0;padding:0;background:#fafafa}
  nav.topbar{background:#234;color:#fff;padding:10px 20px;display:flex;
    justify-content:space-between;align-items:center;font-family:Arial,sans-serif}
  nav.topbar a{color:#fff;text-decoration:none;margin-right:16px;font-size:13px}
  nav.topbar a:hover{text-decoration:underline}
  nav.topbar .title{font-weight:bold;font-size:14px}
  main{padding:0 20px 40px 20px;max-width:1200px;margin:0 auto;background:#fff}
  #login-prompt{padding:80px 20px;text-align:center;color:#666;font-family:Arial,sans-serif}
  #login-prompt button{background:#234;color:#fff;border:none;padding:10px 24px;
    font-size:14px;cursor:pointer;border-radius:4px;margin-top:12px}
  .nav-btn{background:none;border:1px solid #fff;color:#fff;padding:4px 10px;
    font-size:12px;cursor:pointer;border-radius:3px;margin-left:8px}
  .nav-btn:hover{background:rgba(255,255,255,0.15)}
  .footer{color:#888;font-size:11px;margin-top:24px;padding:12px 0;
    border-top:1px solid #eee;text-align:center}`;

function renderSiteFrame(bodyHtml, opts) {
  opts = opts || {};
  const showArchiveLink = opts.showArchiveLink !== false;
  const generatedLabel = opts.generatedLabel || '';
  const title = opts.title || 'Stock RFQ Activity Digest';
  const backLink = showArchiveLink
    ? `<a href="/archive/">Archive</a>`
    : `<a href="/">&larr; Back to latest</a>`;

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>${DIGEST_CSS}${SITE_FRAME_CSS}</style>
  <script src="https://identity.netlify.com/v1/netlify-identity-widget.js" defer></script>
</head>
<body>
  <nav class="topbar">
    <span class="title">${escHtml(title)}</span>
    <span>
      <a href="/">Latest</a>
      ${backLink}
      <button class="nav-btn" id="logout-btn" style="display:none">Sign out</button>
    </span>
  </nav>
  <main id="content" style="display:none">
    ${bodyHtml}
    <div class="footer">Generated ${escHtml(generatedLabel)} &middot; stock-rfq-activity-digest</div>
  </main>
  <div id="login-prompt" style="display:none">
    <p>Sign in to view the Stock RFQ Activity Digest.</p>
    <button id="login-btn">Sign in</button>
  </div>
  <script>
  (function() {
    var content = document.getElementById('content');
    var prompt  = document.getElementById('login-prompt');
    var logout  = document.getElementById('logout-btn');
    function gate(user) {
      if (user) {
        content.style.display = '';
        prompt.style.display  = 'none';
        logout.style.display  = '';
      } else {
        content.style.display = 'none';
        prompt.style.display  = '';
        logout.style.display  = 'none';
      }
    }
    function wire() {
      if (!window.netlifyIdentity) { setTimeout(wire, 50); return; }
      netlifyIdentity.on('init', gate);
      netlifyIdentity.on('login', function() { netlifyIdentity.close(); location.reload(); });
      netlifyIdentity.on('logout', function() { location.reload(); });
      document.getElementById('login-btn').addEventListener('click', function() {
        netlifyIdentity.open('login');
      });
      logout.addEventListener('click', function() { netlifyIdentity.logout(); });
    }
    wire();
  })();
  </script>
</body></html>`;
}

function renderSiteHtml(model, opts) {
  return renderSiteFrame(renderBodyInner(model), opts);
}

function renderArchiveListHtml(snapshots, opts) {
  let body = `<h2>Archive — Last 30 Days</h2>`;
  if (!snapshots || snapshots.length === 0) {
    body += `<p class="small">No archived digests yet.</p>`;
  } else {
    body += `<table><tr><th>#</th><th>Date</th><th>Time (ET)</th><th>Snapshot</th></tr>`;
    snapshots.forEach((s, i) => {
      body += `<tr><td>${i + 1}</td><td>${escHtml(s.dateEt)}</td>`
           +  `<td>${escHtml(s.timeEt)}</td>`
           +  `<td><a href="${escHtml(s.href)}">View</a></td></tr>`;
    });
    body += `</table>`;
    body += `<p class="small">Snapshots older than 30 days are pruned automatically. Each tick is captured every 4 hours (00/04/08/12/16/20 UTC).</p>`;
  }
  return renderSiteFrame(body, Object.assign({}, opts, {
    showArchiveLink: false,
    title: 'Stock RFQ Digest — Archive',
  }));
}

// ─── PUBLISH (write site dir + deploy to Netlify) ────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function makeUtcTsKey(d) {
  // Format: 2026-05-14T2025Z — UTC date + HHMM. Sortable, file-safe.
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
       + `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}Z`;
}

function parseTsKey(fname) {
  // archive filename → Date (or null if unparseable)
  const m = fname.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z\.html$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0));
}

async function publishSite(model, nowDate, opts) {
  opts = opts || {};
  const fsp = fs.promises;
  const siteDir = opts.siteDir;
  const archiveDir = path.join(siteDir, 'archive');
  await fsp.mkdir(archiveDir, { recursive: true });

  const generatedLabel = fmtEt(nowDate);
  const tsKey = makeUtcTsKey(nowDate);

  // 1. Render and write the current snapshot to both index.html and archive.
  const html = renderSiteHtml(model, { generatedLabel, showArchiveLink: true });
  await fsp.writeFile(path.join(siteDir, 'index.html'), html);
  await fsp.writeFile(path.join(archiveDir, `${tsKey}.html`), html);

  // 2. Prune archive files older than 30 days.
  const cutoffMs = nowDate.getTime() - 30 * 24 * 60 * 60 * 1000;
  const existing = await fsp.readdir(archiveDir);
  for (const fname of existing) {
    if (!fname.endsWith('.html') || fname === 'index.html') continue;
    const ts = parseTsKey(fname);
    if (!ts) continue;
    if (ts.getTime() < cutoffMs) {
      await fsp.unlink(path.join(archiveDir, fname));
    }
  }

  // 3. Regenerate archive/index.html — sorted newest first.
  const archiveFiles = (await fsp.readdir(archiveDir))
    .filter(f => f.endsWith('.html') && f !== 'index.html' && parseTsKey(f))
    .sort()
    .reverse();
  const snapshots = archiveFiles.map(f => {
    const d = parseTsKey(f);
    return {
      href: `/archive/${f}`,
      dateEt: new Intl.DateTimeFormat('en-CA', {
        timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d),
      timeEt: new Intl.DateTimeFormat('en-US', {
        timeZone: REPORT_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
        timeZoneName: 'short',
      }).format(d),
    };
  });
  await fsp.writeFile(
    path.join(archiveDir, 'index.html'),
    renderArchiveListHtml(snapshots, { generatedLabel }),
  );

  // 4. 404 page (still gated by Identity).
  const notFoundBody = `<h2>Not found</h2>
    <p>That snapshot has either aged out of the 30-day archive or never existed.</p>
    <p><a href="/">&larr; Back to the latest digest</a></p>`;
  await fsp.writeFile(
    path.join(siteDir, '404.html'),
    renderSiteFrame(notFoundBody, { generatedLabel, showArchiveLink: true }),
  );

  const fileCount = archiveFiles.length + 3; // index + archive/index + 404

  // 5. Deploy (or skip in dry-run / missing creds).
  if (opts.dryRun) {
    console.log(`[publish] dry-run: staged ${fileCount} files at ${siteDir} (skipping Netlify deploy)`);
    return { dryRun: true, fileCount, siteDir };
  }
  if (!opts.siteId || !opts.token) {
    console.warn(`[publish] NETLIFY_SITE_ID or NETLIFY_AUTH_TOKEN missing — staged ${fileCount} files at ${siteDir} but skipped deploy`);
    return { skipped: true, fileCount, siteDir };
  }
  const { deployDirectory } = require('../../shared/netlify-deploy');
  const result = await deployDirectory({
    dir: siteDir,
    siteId: opts.siteId,
    token: opts.token,
    title: `stock-rfq-digest ${tsKey}`,
  });
  console.log(`[publish] deployed ${result.uploadedCount}/${result.fileCount} new files → ${result.url}`);
  return result;
}

// ─── ENTRY ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const [tickStats, todayStats, thirtyStats, topMpns30d, topMpnsToday, topCustomers, topQualified24h] = await Promise.all([
      queryWindowStats(lastTickStart),
      queryWindowStats(todayStart),
      queryWindowStats(thirtyDaysAgo),
      queryTopMpns(thirtyDaysAgo, now, { tickStart: lastTickStart, todayStart }),
      queryTopMpns(todayStart,    now, { tickStart: lastTickStart }),
      queryTopCustomers(thirtyDaysAgo),
      queryTopMpnsQualifiedOnly(twentyFourHoursAgo, now, { limit: 5, tickStart: lastTickStart, todayStart }),
    ]);

    // Union of MPNs from all three tables — supporting queries (repeat / franchise /
    // OEMSecrets / stock-match) run against the combined set so no table loses
    // enrichment for MPNs not in the other tables.
    const mpnCleans = Array.from(new Set([
      ...topMpns30d.map(r => r.mpn_clean),
      ...topMpnsToday.map(r => r.mpn_clean),
      ...topQualified24h.map(r => r.mpn_clean),
    ]));
    // Repeat-demand map first — needed both for HOT classification (filtering
    // the excess-match query) and for the OEMSecrets candidate gate.
    const repeatMap = await queryRepeatDemand(mpnCleans);

    // HOT MPNs (per classifyMpn — ≥3 distinct customers in window OR ≥3 in
    // 30d historical). Excess matches only run against this subset; not worth
    // pulling 90d excess data for lukewarm one-off MPNs.
    const allTopRows = [...topMpns30d, ...topMpnsToday];
    const hotMpnCleans = Array.from(new Set(
      allTopRows
        .filter(r => classifyMpn(r, repeatMap).tag === 'HOT')
        .map(r => r.mpn_clean)
    ));

    const [franchiseMap, stockMap, excessMap] = await Promise.all([
      queryFranchiseContext(mpnCleans),
      queryAstuteStock(mpnCleans),
      queryExcessMatches(hotMpnCleans),
    ]);
    // OEMSecrets fallback driven by the 30d signal — durable HOT-OOS candidates.
    const oem = await fetchOemsecretsForOosHotMpns(topMpns30d, franchiseMap, repeatMap);
    const oemsecretsMap = oem.resultMap;
    console.log(`OEMSecrets: ${oem.budgetUsed} fresh call(s), ${oem.candidates} OOS+HOT candidate(s) considered`);
    console.log(`HOT MPNs: ${hotMpnCleans.length}, Excess matches: ${excessMap.size} HOT MPNs with 90d excess`);

    const cumDateEt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(todayStart);
    const windowLabel = `${fmtEtTimeOnly(now)} tick (30d rolling, today ${cumDateEt})`;
    const model = {
      tickStats, todayStats, thirtyStats,
      topMpns30d, topMpnsToday, topCustomers, topQualified24h,
      repeatMap, franchiseMap, oemsecretsMap, stockMap, excessMap,
      windowLabel,
    };
    const html = renderHtml(model);

    if (dryRun) {
      console.log(html);
      console.log('\n--- DRY RUN — no email sent ---');
      console.log(`Tick stats:    ${JSON.stringify(tickStats)}`);
      console.log(`Today stats:   ${JSON.stringify(todayStats)}`);
      console.log(`30d stats:     ${JSON.stringify(thirtyStats)}`);
      console.log(`Top MPNs 30d:  ${topMpns30d.length} rows`);
      console.log(`Top MPNs tdy:  ${topMpnsToday.length} rows`);
      console.log(`Qualified 24h: ${topQualified24h.length} rows (no Unqualified Broker)`);
      console.log(`Top Custs:     ${topCustomers.length} rows`);
      console.log(`Stock matches: ${stockMap.size} MPNs with Astute-owned stock`);
      console.log(`Excess matches: ${excessMap.size} HOT MPNs with 90d Customer Excess`);
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

    // --publish: write site dir + deploy to Netlify. Runs independently of
    // the email path so a notifier failure doesn't skip the deploy and vice
    // versa. Honors --dry-run (stages files but skips the actual deploy).
    if (publish) {
      try {
        await publishSite(model, now, {
          siteDir: SITE_DIR,
          siteId:  process.env.NETLIFY_SITE_ID,
          token:   process.env.NETLIFY_AUTH_TOKEN,
          dryRun,
        });
      } catch (err) {
        console.error('[publish] failed:', err.message);
        process.exitCode = 1;
      }
    }
  } catch (e) {
    console.error('Stock RFQ digest failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
