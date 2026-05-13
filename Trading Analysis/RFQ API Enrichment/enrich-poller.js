#!/usr/bin/env node
/**
 * RFQ API Enrichment Poller — cron-driven automation with tiered priority.
 *
 * Runs on a schedule (default every 15 min). Reads a watermark timestamp from
 * ~/workspace/.last-rfq-enrich, queries adempiere.chuboe_rfq for rows created
 * since then, classifies each by tier, and processes accordingly:
 *
 *   Tier 1: Non-PPV (Shortage, EOL/LTB, Stock, etc.) — all regions → immediate
 *   Tier 2: PPV + APAC/EMEA contact → immediate
 *   Tier 3: PPV + MX contact → immediate
 *   Tier 4: PPV + US/CA contact (or unknown) → backlog, drained rolling
 *
 * Region is determined from the RFQ contact's location:
 *   chuboe_rfq.chuboe_user_id → ad_user.c_bpartner_location_id →
 *   c_bpartner_location → c_location → c_country
 *
 * Tier 4 backlog drains on every tick (oldest first) as long as DigiKey
 * daily quota allows. Weekends naturally clear the backlog faster.
 *
 * Usage:
 *   node enrich-poller.js            # normal cron invocation
 *   node enrich-poller.js --dry-run  # query only, no enrichment, no watermark update
 *   node enrich-poller.js --since '2026-04-08 16:00:00'  # override watermark for backfill
 *
 * Cron entry (install with `crontab -e`):
 *   See rfq-api-enrichment.md for the exact line (every 15 min).
 *
 * See rfq-api-enrichment.md for the full workflow spec.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { sendWithFallback } = require('../../shared/verified-send');
const { enrichRFQ } = require('./enrich-rfq');
const { assignPriority, isImmediate, PRIORITY } = require('./rfq-priority');
const { readQuotaState, isQuotaBlocked, hasAdequateQuota } = require('./rfq-quota-state');
const { addToBacklog, nextBatch, markAttempted, pruneBacklog, backlogStats } = require('./rfq-backlog');
const largeRfqGate = require('../../shared/large-rfq-gate');

const WATERMARK_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.last-rfq-enrich');
const ROLLUP_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.enrich-poller-rollup.json');
const JAKE_EMAIL = 'jake.harris@astutegroup.com';
const FROM_EMAIL = process.env.VORTEX_EMAIL || 'vortex@orangetsunami.com';
const FALLBACK_EMAIL = process.env.VORTEX_FALLBACK_SENDER || 'excess@orangetsunami.com';

// Reporting cadence — workspace standard (anomalies immediate + 3×/day digest).
// 11/16/20 UTC = 7am/12pm/4pm EDT, matching offer-digest. EST shifts these by 1h
// for ~5 months/year; that's an acceptable seasonal drift for a digest.
const DIGEST_UTC_HOURS = [11, 16, 20];

// How many Tier 4 backlog items to drain per tick. Aggressive so backlog
// doesn't accumulate — cache hits mean most won't burn much quota.
const BACKLOG_BATCH_SIZE = 10;
// Stop draining backlog when DigiKey remaining calls drops below this.
const QUOTA_FLOOR = 50;

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function readWatermark() {
  try {
    if (!fs.existsSync(WATERMARK_FILE)) return null;
    const txt = fs.readFileSync(WATERMARK_FILE, 'utf-8').trim();
    return txt || null;
  } catch (err) {
    log('WARN: failed to read watermark:', err.message);
    return null;
  }
}

function writeWatermark(iso) {
  try {
    fs.writeFileSync(WATERMARK_FILE, iso, 'utf-8');
  } catch (err) {
    log('WARN: failed to write watermark:', err.message);
  }
}

// ─── Digest rollup state ────────────────────────────────────────────────────
// Anomaly-immediate + digest-rollup pattern. Each tick that processes RFQs
// appends batchResults to the rollup; the digest fires at the first tick of
// each DIGEST_UTC_HOURS slot per day, then resets. The slot marker is written
// BEFORE the email attempt so a transient send failure doesn't cause the same
// digest to re-fire 15 minutes later (next slot covers the gap).
function readRollup() {
  try {
    const obj = JSON.parse(fs.readFileSync(ROLLUP_FILE, 'utf-8'));
    return {
      results: Array.isArray(obj.results) ? obj.results : [],
      windowSince: obj.windowSince || null,
      windowUntil: obj.windowUntil || null,
      lastDigestAt: obj.lastDigestAt || null,
      lastDigestUtcHour: obj.lastDigestUtcHour ?? null,
      lastDigestUtcDay: obj.lastDigestUtcDay || null,
    };
  } catch {
    return { results: [], windowSince: null, windowUntil: null,
             lastDigestAt: null, lastDigestUtcHour: null, lastDigestUtcDay: null };
  }
}

function writeRollup(r) {
  try {
    fs.writeFileSync(ROLLUP_FILE, JSON.stringify(r, null, 2), 'utf-8');
  } catch (err) {
    log('WARN: failed to write rollup:', err.message);
  }
}

/**
 * Select RFQs whose line_mpn rows landed inside (sinceIso, untilIso].
 *
 * TIMEZONE NOTE:
 *   iDempiere writes `created` as America/Chicago local time into a TZ-naive
 *   `timestamp without time zone` column. The replica session runs in UTC.
 *   We pass the watermark as a UTC ISO string, so we must convert `created`
 *   to UTC on-the-fly before comparing. Without this the filter silently
 *   misses every new RFQ — verified 2026-04-14 when GE Aerospace 1132340
 *   (loaded at 18:20 UTC = 13:20 CDT) never appeared in poll results whose
 *   watermark was 18:15 UTC.
 *
 *   Expression: (r.created AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC'
 *   - First AT TIME ZONE: "this naked timestamp is in Chicago" → returns tstz
 *   - Second AT TIME ZONE: "show me that in UTC" → returns naked timestamp in UTC
 *   Result is directly comparable to the ISO UTC watermark string.
 *
 * HEADER/LINE RACE:
 *   iDempiere commits the RFQ header and its line_mpn rows in separate
 *   transactions, typically ~1 minute apart. If the filter keys off
 *   `r.created`, an RFQ whose header lands before a poll but whose lines
 *   land after gets permanently orphaned: the first poll drops it via
 *   HAVING COUNT(line_mpn) = 0, and the next poll's watermark has already
 *   advanced past `r.created`.
 *
 *   Fix: anchor both the filter AND the watermark on MAX(line_mpn.created).
 *   An RFQ becomes eligible the moment its lines exist, regardless of how
 *   late that is relative to the header. `untilIso` (captured at poll start)
 *   bounds the upper edge so anything written during the poll itself is
 *   caught by the next one.
 *
 *   Incident: RFQ 1132998 (Sanmina, PSC150W-110-S24) lost ~11h of market
 *   enrichment on 2026-04-24. Poll ran at 03:15:01Z; header was at
 *   03:14:39Z but line_mpn landed at 03:15:47Z — 46s after the poll.
 *   Watermark then advanced past 03:15:01Z and the RFQ was never seen.
 *   Buyer keyed 3 VQs manually without API context.
 */
async function findNewRFQs(sinceIso, untilIso) {
  const { rows } = await pool.query(`
    SELECT r.value AS rfq_number,
           r.chuboe_rfq_id,
           (r.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') AS created,
           MAX(rlm.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') AS line_mpn_created,
           bp.name AS customer,
           rt.name AS rfq_type,
           COUNT(rlm.chuboe_rfq_line_mpn_id) AS line_mpns
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_rfq_line rl
           ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm
           ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
          AND rlm.isactive='Y'
          AND rlm.chuboe_mpn_clean IS NOT NULL
          AND rlm.chuboe_mpn_clean <> ''
    WHERE r.isactive='Y'
    GROUP BY r.value, r.chuboe_rfq_id, r.created, bp.name, rt.name
    HAVING COUNT(rlm.chuboe_rfq_line_mpn_id) > 0
       AND MAX(rlm.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') >  $1::timestamp
       AND MAX(rlm.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') <= $2::timestamp
    ORDER BY MAX(rlm.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') ASC
  `, [sinceIso, untilIso]);
  return rows;
}

/**
 * Render the batch summary as simple HTML for the notification email.
 */
function renderSummaryHtml(batchResults, sinceIso, untilIso, backlog, quotaState) {
  const totalRfqs = batchResults.length;
  const totalLines = batchResults.reduce((s, r) => s + (r.lines || 0), 0);
  const totalApiCalls = batchResults.reduce((s, r) => s + (r.apiCalls || 0), 0);
  const totalCacheHits = batchResults.reduce((s, r) => s + (r.cacheHits || 0), 0);
  const totalRows = batchResults.reduce((s, r) => s + (r.apiResultRowsWritten || 0), 0);
  const totalVqs = batchResults.reduce((s, r) => s + (r.vqsWritten || 0), 0);
  const totalFlagged = batchResults.reduce((s, r) => s + (r.vqsFlagged || 0), 0);
  const totalErrors = batchResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
  const totalSilentSkips = batchResults.reduce((s, r) => s + (r.silentSkips || 0), 0);
  const totalDurationSec = batchResults.reduce((s, r) => s + ((r.durationMs || 0) / 1000), 0);
  const cacheHitPct = totalLines > 0 ? Math.round(100 * totalCacheHits / totalLines) : 0;

  // Per-RFQ-type rollup. PPV has 30d TTL vs Stock's 14d vs everything-else's
  // 7d, so the headline cache-hit % conflates very different stability
  // profiles. Buyer-relevant: are we caching PPV (high-volume, stable
  // franchise parts) effectively, vs caching Stock (mostly broker MPNs that
  // franchise doesn't carry) effectively. Counts > percentages — a 70% rate
  // on 20 lines is a different story than 70% on 200.
  const byType = {};
  for (const r of batchResults) {
    const t = r.rfqType || '?';
    if (!byType[t]) byType[t] = { lines: 0, apiCalls: 0, cacheHits: 0, vqs: 0, silentSkips: 0, rfqs: 0 };
    byType[t].rfqs++;
    byType[t].lines += r.lines || 0;
    byType[t].apiCalls += r.apiCalls || 0;
    byType[t].cacheHits += r.cacheHits || 0;
    byType[t].vqs += r.vqsWritten || 0;
    byType[t].silentSkips += r.silentSkips || 0;
  }

  // Priority breakdown
  const priorityCounts = { P1: 0, P2: 0, P3: 0, P3B: 0 };
  for (const r of batchResults) {
    if (r._fromBacklog) priorityCounts.P3B++;
    else priorityCounts[r._priority || 'P1']++;
  }

  // Anomaly warnings
  const allWarnings = batchResults.flatMap(r =>
    (r.warnings || []).map(w => ({ ...w, rfq: r.rfq, customer: r.customer }))
  );
  const warningBanner = allWarnings.length === 0 ? '' : `
    <div style="border:2px solid #c00;padding:10px 14px;background:#fff5f5;margin-bottom:14px;font-size:13px">
      <b style="color:#c00;font-size:14px">⚠ ${allWarnings.length} ANOMALY WARNING${allWarnings.length === 1 ? '' : 'S'} — investigate before next tick</b>
      <ul style="margin:6px 0 0 18px;padding:0">
        ${allWarnings.map(w => `<li><b>[${w.severity}] ${w.pattern}</b> — RFQ ${w.rfq} (${w.customer || '?'}): ${w.detail}</li>`).join('')}
      </ul>
    </div>
  `;

  const rows = batchResults.map(r => {
    const tierLabel = r._fromBacklog ? 'P3(B)' : (r._priority || '?');
    // "Distributors touched" — how many distinct distributors we actually called
    // for this RFQ. Cache hits don't count. 0 = we skipped APIs entirely
    // (all-cache run or run aborted). 7 = we exercised the full distributor set.
    const distTouched = r.distributorStats ? Object.keys(r.distributorStats).length : 0;
    const distErrored = r.distributorStats
      ? Object.values(r.distributorStats).filter(s => s.errors > 0).length
      : 0;
    const distCell = distTouched === 0
      ? '<span style="color:#888">0 (cache only)</span>'
      : (distErrored > 0
          ? `${distTouched} <span style="color:#c00">(${distErrored} err)</span>`
          : `${distTouched}`);
    return `
    <tr>
      <td>${r.rfq}</td>
      <td>${r.customer || '?'}</td>
      <td>${r.rfqType || '?'}</td>
      <td>${tierLabel}</td>
      <td style="text-align:right">${r.ttlDaysApplied}d</td>
      <td style="text-align:right">${r.lines}</td>
      <td style="text-align:right">${r.apiCalls}</td>
      <td style="text-align:right">${r.cacheHits}</td>
      <td style="text-align:center">${distCell}</td>
      <td style="text-align:right">${r.apiResultRowsWritten}</td>
      <td style="text-align:right">${r.vqsWritten}</td>
      <td style="text-align:right">${r.qtyMatches}/${r.partialCoverage}/${r.noCoverage}</td>
      <td style="text-align:right">${r.errors?.length || 0}</td>
    </tr>
  `}).join('');

  // Quota + backlog info
  const quotaRemaining = quotaState?.remainingCalls != null ? quotaState.remainingCalls : '?';
  const quotaUpdated = quotaState?.updatedAt ? new Date(quotaState.updatedAt).toISOString().slice(11, 16) : '?';

  // Per-distributor health — aggregate across all RFQs in this batch
  const distAgg = {};
  for (const r of batchResults) {
    if (!r.distributorStats) continue;
    for (const [name, s] of Object.entries(r.distributorStats)) {
      if (!distAgg[name]) distAgg[name] = { calls: 0, found: 0, withStock: 0, errors: 0 };
      distAgg[name].calls += s.calls;
      distAgg[name].found += s.found;
      distAgg[name].withStock += s.withStock;
      distAgg[name].errors += s.errors;
    }
  }
  const distRows = Object.entries(distAgg)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([name, s]) => {
      const errPct = s.calls > 0 ? Math.round(100 * s.errors / s.calls) : 0;
      const foundPct = s.calls > 0 ? Math.round(100 * s.found / s.calls) : 0;
      const errFlag = errPct >= 50 ? ` <span style="color:#c00">⚠ ${errPct}% errors</span>` : '';
      return `<tr><td>${name}</td><td style="text-align:right">${s.calls.toLocaleString()}</td><td style="text-align:right">${s.found.toLocaleString()} (${foundPct}%)</td><td style="text-align:right">${s.withStock.toLocaleString()}</td><td style="text-align:right">${s.errors}${errFlag}</td></tr>`;
    }).join('');
  const distHealthSection = Object.keys(distAgg).length === 0 ? '' : `
    <br/><h4>Distributor health (live API calls only — cache hits not counted)</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0"><th>Distributor</th><th>Calls</th><th>Found (carrying)</th><th>With stock</th><th>Errors</th></tr>
      ${distRows}
    </table>`;

  // Rolling 24h API health — pulls from the wrapper-level failure log and the
  // auth-failure state file. Distinct from distHealthSection above (which
  // covers only this digest window's live calls). This view tells the
  // operator "what's been broken across all my workflows in the last 24h"
  // — including failures from rfq-loader-daemon, vortex-poller, market-offer
  // matching, etc., not just enrich-poller.
  const apiHealthSection = renderApiHealthSection();

  return `
    <html><body style="font-family:Arial,sans-serif">
    <h3>RFQ API Enrichment — batch summary</h3>
    <p>Window: ${sinceIso} → ${untilIso}</p>
    ${warningBanner}
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f0f0f0"><th colspan="2">Totals</th></tr>
      <tr><td>RFQs processed</td><td style="text-align:right">${totalRfqs}</td></tr>
      <tr><td>Priorities</td><td style="text-align:right">P1(express):${priorityCounts.P1} P2(main):${priorityCounts.P2} P3(backlog-new):${priorityCounts.P3} P3(backlog-drain):${priorityCounts.P3B}</td></tr>
      <tr><td>Line-MPNs</td><td style="text-align:right">${totalLines.toLocaleString()}</td></tr>
      <tr><td>Live API calls</td><td style="text-align:right">${totalApiCalls.toLocaleString()}</td></tr>
      <tr><td>Cache hits</td><td style="text-align:right">${totalCacheHits.toLocaleString()} (${cacheHitPct}%)</td></tr>
      <tr><td>api_result rows written</td><td style="text-align:right">${totalRows.toLocaleString()}</td></tr>
      <tr><td>VQs written</td><td style="text-align:right">${totalVqs.toLocaleString()}</td></tr>
      <tr><td>VQs flagged</td><td style="text-align:right">${totalFlagged.toLocaleString()}</td></tr>
      <tr><td>Silent writer skips</td><td style="text-align:right">${totalSilentSkips.toLocaleString()}${totalSilentSkips > 0 ? ' <span style="color:#a60">(stock available, no VQ written — see breakdown below)</span>' : ''}</td></tr>
      <tr><td>Errors</td><td style="text-align:right">${totalErrors}</td></tr>
      <tr><td>Duration</td><td style="text-align:right">${totalDurationSec.toFixed(1)}s</td></tr>
      <tr><td>DigiKey quota</td><td style="text-align:right">${quotaRemaining} remaining (as of ${quotaUpdated} UTC)</td></tr>
      <tr><td>Tier 4 backlog</td><td style="text-align:right">${backlog.pending} pending (${backlog.totalLineMpns} MPNs, oldest ${backlog.oldestAgeHours}h)</td></tr>
    </table>
    <br/>
    <h4>By RFQ Type (counts)</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0">
        <th>RFQ Type</th><th>RFQs</th><th>Line-MPNs</th><th>API calls</th><th>Cache hits</th><th>VQs</th><th>Silent skips</th>
      </tr>
      ${Object.entries(byType).sort((a, b) => b[1].lines - a[1].lines).map(([t, s]) => `
        <tr>
          <td><b>${t}</b></td>
          <td style="text-align:right">${s.rfqs}</td>
          <td style="text-align:right">${s.lines.toLocaleString()}</td>
          <td style="text-align:right">${s.apiCalls.toLocaleString()}</td>
          <td style="text-align:right">${s.cacheHits.toLocaleString()}</td>
          <td style="text-align:right">${s.vqs.toLocaleString()}</td>
          <td style="text-align:right">${s.silentSkips > 0 ? `<span style="color:#a60">${s.silentSkips}</span>` : '0'}</td>
        </tr>
      `).join('')}
    </table>
    ${totalSilentSkips > 0 ? renderSilentSkipSamples(batchResults) : ''}
    <br/>
    <h4>Per RFQ</h4>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#f0f0f0">
        <th>RFQ</th><th>Customer</th><th>Type</th><th>Tier</th><th>TTL</th>
        <th>Lines</th><th>API</th><th>Cache</th><th>Dist&nbsp;hit</th><th>Rows</th><th>VQs</th>
        <th>FULL/PART/NONE</th><th>Err</th>
      </tr>
      ${rows}
    </table>
    ${distHealthSection}
    ${apiHealthSection}
    </body></html>
  `;
}

/**
 * Render the "Silent writer skips" section. Surfaces line-MPNs where the
 * franchise envelope had distributors with stock but writeVQFromAPI produced
 * zero written rows AND zero restricted skips. These are writer-side gate
 * misses (Verical BP mapping, MFR canonicalization, missing-MFR-text RFQs,
 * zero-qty lines) that previously failed silently. Up to 12 samples shown
 * per digest — drill in to identify common root causes.
 */
function renderSilentSkipSamples(batchResults) {
  const samples = [];
  for (const r of batchResults) {
    if (!Array.isArray(r.silentSkipSamples)) continue;
    for (const s of r.silentSkipSamples) {
      samples.push({ ...s, rfq: r.rfq, rfqType: r.rfqType, customer: r.customer });
      if (samples.length >= 12) break;
    }
    if (samples.length >= 12) break;
  }
  if (samples.length === 0) return '';
  const rows = samples.map(s => `
    <tr>
      <td>${s.rfq}</td>
      <td>${s.rfqType || '?'}</td>
      <td>${(s.customer || '?').slice(0, 28)}</td>
      <td><code>${s.mpn}</code></td>
      <td>${s.mfr || '<i>(blank)</i>'}</td>
      <td>${s.distys.join(', ')}</td>
      <td style="text-align:right">${s.flagged}/${s.failed}</td>
      <td>${s.fromCache ? 'cache' : 'live'}</td>
    </tr>
  `).join('');
  return `
    <br/>
    <h4 style="color:#a60">Silent writer skips (sample)</h4>
    <p style="font-size:12px;margin:0 0 6px 0">Envelope returned stock, writer wrote nothing. Not restricted-MFR (which is by-design). Look for: Verical BP missing, MFR canonicalization edges, missing-MFR-text RFQs, zero-qty RFQ lines.</p>
    <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#fdf5e8">
        <th>RFQ</th><th>Type</th><th>Customer</th><th>MPN</th><th>RFQ MFR</th><th>Distys with stock</th><th>Flagged/Failed</th><th>Source</th>
      </tr>
      ${rows}
    </table>
  `;
}

/**
 * Render the rolling 24h Franchise API health section for the digest.
 *
 * Sources:
 *   ~/workspace/.api-failures.ndjson           — every cog failure (wrapper-logged)
 *   shared/data/auth-failure-state.json        — current outage / mute state
 *
 * Per-disty breakdown: total failures (last 24h), by category, last error sample,
 * current state (healthy / outage-active / muted). Returns '' if no failures
 * AND no active outages (i.e., everything's healthy — no need to noise the digest).
 */
function renderApiHealthSection() {
  try {
    const home = process.env.HOME || '/home/analytics_user';
    const failuresPath = path.join(home, 'workspace/.api-failures.ndjson');
    const statePath = path.resolve(__dirname, '../../shared/data/auth-failure-state.json');

    // Parse failure log (last 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const byDisty = {};
    if (fs.existsSync(failuresPath)) {
      const lines = fs.readFileSync(failuresPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (new Date(entry.ts).getTime() < cutoff) continue;
          const d = entry.distributor;
          if (!byDisty[d]) byDisty[d] = { count: 0, byCategory: {}, lastTs: null, lastErr: null, lastMpn: null };
          byDisty[d].count++;
          byDisty[d].byCategory[entry.category] = (byDisty[d].byCategory[entry.category] || 0) + 1;
          if (!byDisty[d].lastTs || entry.ts > byDisty[d].lastTs) {
            byDisty[d].lastTs = entry.ts;
            byDisty[d].lastErr = entry.errorMessage;
            byDisty[d].lastMpn = entry.mpn;
          }
        } catch { /* skip malformed lines */ }
      }
    }

    // Parse current alert state (active outages + manual mutes)
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch {}

    const allDistys = new Set([...Object.keys(byDisty), ...Object.keys(state)]);
    if (allDistys.size === 0) return '';  // nothing to report

    const rows = [...allDistys].sort().map(d => {
      const stats = byDisty[d] || { count: 0, byCategory: {}, lastTs: null, lastErr: null, lastMpn: null };
      const s = state[d];
      let stateLabel = '<span style="color:#080">healthy</span>';
      if (s) {
        if (s.suppressed) {
          stateLabel = `<span style="color:#888">🔇 muted (${s.suppressedReason ? s.suppressedReason.slice(0, 60) : 'no reason'})</span>`;
        } else if (s.firstCleanAt) {
          const minIntoWindow = Math.round((Date.now() - new Date(s.firstCleanAt).getTime()) / 60000);
          stateLabel = `<span style="color:#a60">recovering (${minIntoWindow}min clean)</span>`;
        } else if (s.lastFailureAt) {
          const minSinceLast = Math.round((Date.now() - s.lastFailureAt) / 60000);
          stateLabel = `<span style="color:#c00">outage active (last fail ${minSinceLast}min ago)</span>`;
        }
      }
      const catBreakdown = Object.entries(stats.byCategory)
        .map(([k, v]) => `${k}:${v}`).join(' ') || '—';
      const lastSample = stats.lastErr
        ? `<code style="font-size:11px">${stats.lastErr.slice(0, 100).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</code>`
        : '—';
      return `<tr>
        <td>${d}</td>
        <td style="text-align:right">${stats.count.toLocaleString()}</td>
        <td>${catBreakdown}</td>
        <td>${stateLabel}</td>
        <td>${stats.lastMpn || '—'}</td>
        <td>${lastSample}</td>
      </tr>`;
    }).join('');

    return `
      <br/><h4>Franchise API health — rolling 24h (all workflows)</h4>
      <p style="font-size:11px;color:#666;margin:0 0 4px 0">
        Failures across every cog (mouser, digikey, tti, arrow, etc.) sourced from <code>~/workspace/.api-failures.ndjson</code>.
        State column shows current alerter status from <code>shared/data/auth-failure-state.json</code>.
        "Recovering" means an outage was detected and we're inside the 4h sustained-clean observation window before declaring recovery.
      </p>
      <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
        <tr style="background:#f0f0f0">
          <th>Distributor</th><th>Failures (24h)</th><th>By category</th><th>State</th><th>Last MPN</th><th>Last error sample</th>
        </tr>
        ${rows}
      </table>`;
  } catch (err) {
    return `<br/><p style="color:#888;font-size:11px">[Franchise API health section render failed: ${(err.message || String(err)).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}]</p>`;
  }
}

async function sendEmail(subject, html) {
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    log('WARN: WORKMAIL_PASS not set — skipping email');
    return;
  }
  const result = await sendWithFallback({
    primary:  { from: FROM_EMAIL,     pass, displayName: 'RFQ API Enrichment' },
    fallback: { from: FALLBACK_EMAIL, pass, displayName: 'RFQ API Enrichment' },
    mail: { to: JAKE_EMAIL, subject, html },
    log,
  });
  log(`sendEmail: delivered via ${result.delivered}` +
      (result.bounceDetected ? ' (primary bounced, fallback used)' : ''));
}

// Single-instance guard — cron fires every 15 min, but a tick may still be
// running Honeywell-scale backlog work. Without a PID file, stacked enrichers
// accumulate (20+ seen in production), all racing the same backlog items.
// The guard matches the rfq-loader-daemon.js pattern: check PID, exit 0 if
// alive, claim if stale. Dry runs bypass the guard for diagnostic use.
const PID_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.enrich-poller.pid');

function claimPid() {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 0); // existence check
      log(`Enricher already running (PID ${existingPid}), exiting cleanly.`);
      return false;
    } catch (e) {
      log(`Stale PID file (${existingPid} not running), claiming.`);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  return true;
}

function releasePid() {
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
}

async function main() {
  const argv = process.argv.slice(2);
  const DRY_RUN = argv.includes('--dry-run');
  const sinceOverrideIdx = argv.indexOf('--since');
  const sinceOverride = sinceOverrideIdx >= 0 ? argv[sinceOverrideIdx + 1] : null;

  // Single-instance guard (skipped for dry runs)
  if (!DRY_RUN) {
    if (!claimPid()) {
      process.exit(0);
    }
    // Release PID on graceful exit and any signal
    process.on('exit', releasePid);
    process.on('SIGINT', () => { releasePid(); process.exit(130); });
    process.on('SIGTERM', () => { releasePid(); process.exit(143); });
  }

  // Phase 0: Prune backlog (drop items >7 days old and completed items)
  const pruned = pruneBacklog();
  if (pruned > 0) log(`Pruned ${pruned} stale/completed backlog items`);

  // Resolve watermark. First run (no watermark, no override) → last 1 hour.
  let sinceIso;
  if (sinceOverride) {
    sinceIso = sinceOverride;
  } else {
    sinceIso = readWatermark();
    if (!sinceIso) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      sinceIso = oneHourAgo.toISOString();
      log('No watermark — using last 1 hour:', sinceIso);
    }
  }
  const untilIso = new Date().toISOString();
  log(`Polling for RFQs with line_mpn created in (${sinceIso}, ${untilIso}]`);

  let newRFQs;
  try {
    newRFQs = await findNewRFQs(sinceIso, untilIso);
  } catch (err) {
    log('FATAL: query failed:', err.message);
    await pool.end();
    process.exit(1);
  }

  // Phase 0.5: Large-RFQ Approval Gate
  // RFQs with > threshold line MPNs are paused until an operator explicitly
  // approves via CLI. Three sub-steps:
  //   a) Process newly-detected large RFQs: write sentinel + email operator, exclude.
  //   b) Pick up previously-approved sentinels that haven't been processed yet
  //      (approval can land after the watermark moved past, so they wouldn't
  //      be in this tick's findNewRFQs result).
  //   c) Filter out RFQs that are pending/rejected.
  const gateThreshold = largeRfqGate.threshold();
  const filteredNew = [];
  for (const r of newRFQs) {
    const lineMpns = Number(r.line_mpns) || 0;
    if (lineMpns <= gateThreshold) { filteredNew.push(r); continue; }
    if (largeRfqGate.isRejected(r.rfq_number)) {
      log(`Large-RFQ gate: ${r.rfq_number} previously rejected — skipping permanently.`);
      continue;
    }
    if (largeRfqGate.isCleared(r.rfq_number)) {
      // Approved + showed up in this tick's window — include directly.
      if (largeRfqGate.isProcessed(r.rfq_number)) continue;  // already done
      const cleared = largeRfqGate.isCleared(r.rfq_number);
      r._approval = cleared;
      r._gateApproved = true;
      filteredNew.push(r);
      continue;
    }
    if (largeRfqGate.isPending(r.rfq_number)) {
      log(`Large-RFQ gate: ${r.rfq_number} (${lineMpns} lines) still pending operator approval — skipping.`);
      continue;
    }
    // First sight: fire the approval email + write sentinel, exclude this tick.
    if (DRY_RUN) {
      log(`Large-RFQ gate: ${r.rfq_number} (${lineMpns} lines) — WOULD send approval email + write sentinel (dry-run, no side effects).`);
      continue;
    }
    try {
      const ctx = await largeRfqGate.fetchRFQContext(pool, r.chuboe_rfq_id);
      const sentinel = largeRfqGate.writeSentinel({
        rfq_number: r.rfq_number,
        chuboe_rfq_id: r.chuboe_rfq_id,
        customer: r.customer,
        rfq_type: r.rfq_type,
        salesrep: ctx.salesrep,
        line_mpns: lineMpns,
        targets_summary: ctx.targets_summary,
        sample_mpns: ctx.sample_mpns,
        top_mfrs: ctx.top_mfrs,
      });
      const html = largeRfqGate.renderApprovalEmailHtml(sentinel, ctx, gateThreshold);
      const subject = `[APPROVAL NEEDED] Large RFQ ${r.rfq_number} from ${r.customer || '?'} — ${lineMpns.toLocaleString('en-US')} lines`;
      // Send from rfqloading@ so replies land in the inbox polled by the
      // rfq-loading workflow agent (approve_large_rfq / reject_large_rfq
      // actions wire YES/NO back to the gate). Override with
      // LARGE_RFQ_GATE_FROM env var if needed.
      await largeRfqGate.sendApprovalEmail({ subject, html, log });
      log(`Large-RFQ gate: ${r.rfq_number} (${lineMpns} lines) — sentinel written, approval email sent from rfqloading@. Excluding from this tick.`);
    } catch (err) {
      log(`Large-RFQ gate: ERROR firing for ${r.rfq_number}: ${err.message}. Excluding from this tick (will retry next tick).`);
      // Roll back sentinel so the next tick will try again — better to re-fire
      // than to silently leave the RFQ pending without notification.
      try { fs.unlinkSync(largeRfqGate.sentinelPath(r.rfq_number)); } catch {}
    }
    // Excluded from filteredNew regardless of email success.
  }
  newRFQs = filteredNew;

  // Pick up any previously-approved sentinels that didn't fall into this
  // tick's findNewRFQs window. Re-shape them into the same row format.
  const clearedSentinels = largeRfqGate.listClearedUnprocessed();
  if (clearedSentinels.length > 0) {
    log(`Large-RFQ gate: ${clearedSentinels.length} approved sentinel(s) waiting for processing.`);
    for (const s of clearedSentinels) {
      newRFQs.push({
        rfq_number: s.rfq_number,
        chuboe_rfq_id: s.chuboe_rfq_id,
        customer: s.customer,
        rfq_type: s.rfq_type,
        line_mpns: s.line_mpns,
        created: s.queued_at,
        line_mpn_created: s.queued_at,
        _approval: s._approval,
        _gateApproved: true,
      });
    }
  }

  // Phase 1: Assign priority (P1 Express / P2 Main / P3 Backlog) based on
  // size + type. Region is no longer a signal — Astute operates 24/7 across
  // Mexico, Texas, China, India, Singapore, South Korea so there are no true
  // "off hours" to defer to. See Section J8 of trading-analysis-roadmap.md.
  for (const r of newRFQs) {
    r.priority = assignPriority(r.rfq_type, r.line_mpns);
    // Force-immediate any gate-approved RFQ regardless of size — the operator
    // explicitly opted in.
    if (r._gateApproved && r.priority === PRIORITY.BACKLOG) {
      r.priority = PRIORITY.MAIN;
    }
  }

  // Sort immediate work so P1 (express) runs before P2 (main), FIFO within tier
  const immediate = newRFQs
    .filter(r => isImmediate(r.priority))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
      return new Date(a.created) - new Date(b.created);
    });
  const backlogNew = newRFQs.filter(r => r.priority === PRIORITY.BACKLOG);

  if (newRFQs.length > 0) {
    const pCounts = newRFQs.reduce((acc, r) => { acc[r.priority] = (acc[r.priority] || 0) + 1; return acc; }, {});
    log(`Found ${newRFQs.length} new RFQ(s): P1=${pCounts.P1 || 0}, P2=${pCounts.P2 || 0}, P3=${pCounts.P3 || 0}`);
    for (const r of newRFQs) {
      log(`  ${r.rfq_number} — ${r.customer || '?'} (${r.rfq_type}) ${r.priority} — ${r.line_mpns} MPNs`);
    }
  } else {
    log('No new RFQs.');
  }

  // Phase 2: Queue new Tier 4 to backlog
  if (backlogNew.length > 0) {
    const added = addToBacklog(backlogNew);
    log(`Queued ${added} new P3 RFQ(s) to backlog`);
  }

  if (DRY_RUN) {
    const bl = backlogStats();
    log(`DRY RUN — skipping enrichment. Backlog: ${bl.pending} pending (${bl.totalLineMpns} MPNs)`);
    await pool.end();
    return;
  }

  // Phase 3: Process Tier 1-3 immediately
  const batchResults = [];
  for (const r of immediate) {
    log(`Enriching ${r.rfq_number} (${r.rfq_type} ${r.priority}, ${r.line_mpns} MPNs)${r._gateApproved ? ' [gate-approved]' : ''}...`);
    try {
      const enrichOpts = { priority: r.priority };
      const maxLines = r._approval?.maxLines;
      if (Number.isFinite(maxLines) && maxLines > 0) {
        enrichOpts.maxLines = maxLines;
        log(`  applying --max-lines cap from approval: ${maxLines}`);
      }
      const result = await enrichRFQ(String(r.rfq_number), enrichOpts);
      result._priority = r.priority;
      if (r._gateApproved) {
        result._gateApproved = true;
        largeRfqGate.markProcessed(r.rfq_number);
      }
      batchResults.push(result);
      log(`  done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs, ${result.errors?.length || 0} err`);
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      batchResults.push({
        rfq: r.rfq_number, customer: r.customer, rfqType: r.rfq_type,
        _priority: r.priority, error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
      });
    }
  }

  // Phase 4: Drain Tier 4 backlog
  //
  // Important: we ALWAYS attempt the drain. The DigiKey quota state is one
  // signal among many — if DigiKey is throttled, the other 6 distributors
  // (Mouser, TTI, Newark, Farnell, Arrow, Future) still have independent
  // quotas. searchAllDistributors gracefully handles per-distributor errors
  // (captured in distributorHealth), so a 429 on DigiKey just means that
  // particular distributor returns no data — the rest of the run proceeds.
  //
  // We log the DigiKey state as a heads-up but do NOT use it to gate.
  const dkBlocked = isQuotaBlocked();
  const dkQuota = readQuotaState();
  const dkRemaining = dkQuota?.remainingCalls ?? '?';

  const candidates = nextBatch(BACKLOG_BATCH_SIZE);
  if (candidates.length > 0) {
    const dkNote = dkBlocked
      ? ` (note: DigiKey 429-blocked — other 6 distributors will still run)`
      : ` (DigiKey: ${dkRemaining} remaining)`;
    log(`Draining Tier 4 backlog: ${candidates.length} candidate(s)${dkNote}`);
  }
  for (const item of candidates) {
    log(`  Backlog: enriching ${item.rfq_number} (${item.customer}, ${item.line_mpns} MPNs, queued ${item.queuedAt})...`);
    try {
      const result = await enrichRFQ(String(item.rfq_number), { priority: 'P3' });
      result._priority = 'P3';
      result._fromBacklog = true;
      batchResults.push(result);
      markAttempted(item.rfq_number, 'success');
      log(`    done: ${result.apiCalls} API, ${result.cacheHits} cache, ${result.vqsWritten} VQs`);
    } catch (err) {
      log(`    ERROR: ${err.message}`);
      markAttempted(item.rfq_number, 'error');
      batchResults.push({
        rfq: item.rfq_number, customer: item.customer, rfqType: item.rfq_type,
        _priority: 'P3', _fromBacklog: true, error: err.message,
        lines: 0, apiCalls: 0, cacheHits: 0, apiResultRowsWritten: 0,
        vqsWritten: 0, qtyMatches: 0, partialCoverage: 0, noCoverage: 0,
        errors: [{ stage: 'enrich', message: err.message }], durationMs: 0,
      });
    }
  }

  // Phase 5: Email reporting — anomaly immediate + 3×/day digest cadence
  //
  // Workspace reporting standard (see MEMORY.md feedback_reporting_cadence_standard):
  //   - Anomalies (warnings or errors) email immediately, every tick.
  //   - Quiet ticks roll into the rollup and only deliver at the next digest slot.
  //   - Digest slots: 11/16/20 UTC = 7am/12pm/4pm EDT (DIGEST_UTC_HOURS).
  //
  // Anomaly emails do NOT empty the rollup — the digest still gives a comprehensive
  // periodic view. Operator gets a fast signal (anomaly) and a complete one (digest).
  {
    const totalErrors = batchResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
    const totalWarnings = batchResults.reduce((s, r) => s + (r.warnings?.length || 0), 0);
    const isAnomalous = totalWarnings > 0 || totalErrors > 0;

    const rollup = readRollup();
    if (batchResults.length > 0) {
      rollup.results.push(...batchResults);
      if (!rollup.windowSince) rollup.windowSince = sinceIso;
      rollup.windowUntil = untilIso;
    }

    // ── Anomaly path (immediate) ──
    if (batchResults.length > 0 && isAnomalous) {
      try {
        const bl = backlogStats();
        let subject = totalWarnings > 0
          ? `⚠ RFQ API Enrichment — ${batchResults.length} RFQs, ${totalWarnings} ANOMALY WARNING${totalWarnings === 1 ? '' : 'S'} (${totalErrors} errors)`
          : `RFQ API Enrichment — ${batchResults.length} RFQs, ${totalErrors} errors`;
        if (bl.pending > 0) subject += ` [backlog: ${bl.pending}]`;
        const quotaState = readQuotaState();
        const html = renderSummaryHtml(batchResults, sinceIso, untilIso, bl, quotaState);
        await sendEmail(subject, html);
        log('Anomaly email sent (immediate)');
      } catch (err) {
        log('WARN: anomaly email send failed:', err.message);
      }
    }

    // ── Digest path (3×/day at 11/16/20 UTC) ──
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcDay = now.toISOString().slice(0, 10);
    const inDigestSlot = DIGEST_UTC_HOURS.includes(utcHour);
    const slotAlreadyFired = rollup.lastDigestUtcDay === utcDay && rollup.lastDigestUtcHour === utcHour;

    if (inDigestSlot && !slotAlreadyFired && rollup.results.length > 0) {
      // Snapshot then mark slot fired BEFORE sending. If email send fails, we
      // forfeit this digest rather than re-fire 15 min later — the next slot
      // (5h away) catches up. Persistent send infra failures shouldn't loop.
      const digestResults = rollup.results.slice();
      const digestWindowSince = rollup.windowSince;
      const digestWindowUntil = rollup.windowUntil;

      rollup.results = [];
      rollup.windowSince = null;
      rollup.windowUntil = null;
      rollup.lastDigestAt = new Date().toISOString();
      rollup.lastDigestUtcHour = utcHour;
      rollup.lastDigestUtcDay = utcDay;
      writeRollup(rollup);

      try {
        const bl = backlogStats();
        const tErr = digestResults.reduce((s, r) => s + (r.errors?.length || 0), 0);
        const tWarn = digestResults.reduce((s, r) => s + (r.warnings?.length || 0), 0);
        let subject = `RFQ API Enrichment digest — ${digestResults.length} RFQs since ${digestWindowSince ? digestWindowSince.slice(5, 16) + 'Z' : '?'}`;
        if (tWarn > 0) subject = `⚠ ${subject} (${tWarn} warnings)`;
        if (tErr > 0) subject = `${subject} [${tErr} errors]`;
        if (bl.pending > 0) subject += ` [backlog: ${bl.pending}]`;
        const quotaState = readQuotaState();
        const html = renderSummaryHtml(digestResults, digestWindowSince, digestWindowUntil, bl, quotaState);
        await sendEmail(subject, html);
        log(`Digest email sent (UTC slot ${utcHour}h, ${digestResults.length} RFQs covered)`);
      } catch (err) {
        log('WARN: digest email send failed (slot still marked):', err.message);
      }
    } else {
      // Persist any rollup append from this tick (no digest fired)
      writeRollup(rollup);
      if (newRFQs.length === 0 && batchResults.length === 0) {
        const bl = backlogStats();
        if (bl.pending > 0) {
          const dkNote = isQuotaBlocked() ? ' (DigiKey 429-blocked, but other distributors should still be running)' : '';
          log(`Backlog has ${bl.pending} items pending${dkNote}`);
        }
      }
    }
  }

  // Advance watermark after everything completes.
  if (!DRY_RUN) {
    writeWatermark(untilIso);
    log(`Watermark advanced to ${untilIso}`);
  }

  await pool.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    log('FATAL:', err.stack || err.message);
    try {
      await sendEmail(
        'RFQ API Enrichment — FATAL ERROR',
        `<pre>${(err.stack || err.message || String(err)).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`
      );
    } catch (_) { /* best effort */ }
    process.exit(1);
  });
}
