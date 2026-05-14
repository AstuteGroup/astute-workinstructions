/**
 * Large-RFQ Approval Gate (instance of the generic large-payload-gate)
 *
 * Pauses auto-enrichment for RFQs above a configured line-count threshold
 * until an operator explicitly approves. Prevents quota-burn on big
 * internal-shortage scrapes (e.g., RFQ 1134261 burned 7,974 API calls in
 * a single tick) and gives the operator a chance to review the demand
 * profile before the full ~10-API-calls-per-line spend kicks off.
 *
 * State machine (sentinel/cleared/rejected/processed): provided by
 * shared/large-payload-gate.js. This module adds the RFQ-specific helpers:
 * fetchRFQContext, scanCacheCoverage, renderApprovalEmailHtml, sendApprovalEmail,
 * and the CLI.
 *
 * State directory: ~/workspace/.large-rfq-pending/
 *   {rfq_number}.json       sentinel: pending, contains full RFQ context
 *   {rfq_number}.cleared    approval flag (optional { maxLines, cacheOnly } body)
 *   {rfq_number}.rejected   rejection flag (skip permanently)
 *   {rfq_number}.processed  internal: enrichment ran on the cleared sentinel
 *
 * Threshold: 5000 line MPNs by default. Override with LARGE_RFQ_THRESHOLD env var.
 *
 * Single source of truth for the cleared-RFQ list: this directory. Don't add
 * a parallel approval registry elsewhere.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { createGate } = require('./large-payload-gate');

const PENDING_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-rfq-pending'
);
const DEFAULT_THRESHOLD = 5000;

const gate = createGate({
  kind: 'rfq',
  sentinelDir: PENDING_DIR,
  defaultThreshold: DEFAULT_THRESHOLD,
  envOverride: 'LARGE_RFQ_THRESHOLD',
});

// Backcompat: callers (enrich-poller) call writeSentinel(meta) with meta.rfq_number
// as the id. Wrap the generic writeSentinel(id, meta) to preserve that signature.
function writeSentinel(meta) {
  if (!meta || !meta.rfq_number) {
    throw new Error('large-rfq-gate.writeSentinel: meta.rfq_number is required');
  }
  return gate.writeSentinel(meta.rfq_number, {
    rfq_number: meta.rfq_number,
    chuboe_rfq_id: meta.chuboe_rfq_id,
    customer: meta.customer || null,
    rfq_type: meta.rfq_type || null,
    salesrep: meta.salesrep || null,
    line_mpns: meta.line_mpns,
    targets_summary: meta.targets_summary || null,
    sample_mpns: meta.sample_mpns || [],
    top_mfrs: meta.top_mfrs || [],
  });
}

/**
 * Pull additional RFQ context for the approval email — salesrep name,
 * sample MPNs, top MFRs, target-price summary.
 */
async function fetchRFQContext(pool, chuboeRfqId) {
  const ctx = {};

  const salesrep = await pool.query(
    `SELECT u.name
       FROM adempiere.chuboe_rfq r
       LEFT JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
      WHERE r.chuboe_rfq_id = $1`,
    [chuboeRfqId]
  );
  ctx.salesrep = salesrep.rows[0]?.name || null;

  const mpns = await pool.query(
    `SELECT rl.line,
            rlm.chuboe_mpn_clean AS mpn,
            rlm.chuboe_mfr_text AS mfr_text,
            rl.qty,
            rl.priceentered AS target_price
       FROM adempiere.chuboe_rfq_line rl
       JOIN adempiere.chuboe_rfq_line_mpn rlm
         ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
      WHERE rl.chuboe_rfq_id = $1 AND rl.isactive='Y'
      ORDER BY rl.line ASC, rlm.chuboe_rfq_line_mpn_id ASC
      LIMIT 20`,
    [chuboeRfqId]
  );
  ctx.sample_mpns = mpns.rows;

  const mfrs = await pool.query(
    `SELECT COALESCE(m.name, NULLIF(rlm.chuboe_mfr_text, ''), '(blank)') AS mfr,
            COUNT(*) AS line_count
       FROM adempiere.chuboe_rfq_line rl
       JOIN adempiere.chuboe_rfq_line_mpn rlm
         ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
       LEFT JOIN adempiere.chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
      WHERE rl.chuboe_rfq_id = $1 AND rl.isactive='Y'
      GROUP BY 1
      ORDER BY line_count DESC
      LIMIT 5`,
    [chuboeRfqId]
  );
  ctx.top_mfrs = mfrs.rows;

  const tgts = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE priceentered IS NOT NULL AND priceentered > 0) AS with_target,
            COUNT(*) AS total_lines,
            MIN(priceentered) FILTER (WHERE priceentered > 0) AS min_target,
            MAX(priceentered) AS max_target,
            AVG(priceentered) FILTER (WHERE priceentered > 0) AS avg_target
       FROM adempiere.chuboe_rfq_line
      WHERE chuboe_rfq_id = $1 AND isactive='Y'`,
    [chuboeRfqId]
  );
  ctx.targets_summary = tgts.rows[0] || {};

  return ctx;
}

// ─── CACHE COVERAGE SCAN ─────────────────────────────────────────────────────

/**
 * Walk the local envelope cache for every line in an RFQ. Pure local I/O —
 * no franchise API calls. Returns coverage stats + top-N high-value cached
 * lines so the operator can decide whether to approve the API spend, cap
 * lines, or run cache-only (skip live calls, just process what's already in
 * the cache).
 *
 * Tradeoff: this reads up to N cache files (one per RFQ MPN that hits the
 * index). On a 25k-line RFQ with ~30% cache hit rate ≈ 7,500 file reads;
 * sequential takes 30-60s. Done before the approval email goes out, so the
 * operator waits for the email — but that's still way cheaper than the live
 * API spend the gate is protecting against.
 *
 * @param {object} pool — pg pool
 * @param {number} chuboeRfqId
 * @param {object} opts
 * @param {number} [opts.maxAgeDays=30] — older cache entries are ignored
 * @returns {Promise<{totalLines, withCache, withStock, avgCacheAgeDays,
 *   estApiCallsIfApproved, digikeyQuotaMultiple, topValued: Array}>}
 */
async function scanCacheCoverage(pool, chuboeRfqId, opts = {}) {
  const maxAgeDays = opts.maxAgeDays || 30;
  const topN = opts.topN || 10;
  const { cacheKey, CACHE_DIR } = require('./api-result-writer');

  // Build cache index once: Map<normalized-MPN, {file, dateStr, ageDays}>.
  const cacheIndex = new Map();
  if (fs.existsSync(CACHE_DIR)) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const m = f.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const mpn = m[1];
      const dateStr = m[2];
      const ageDays = Math.floor((today.getTime() - new Date(dateStr).getTime()) / 86400000);
      if (ageDays > maxAgeDays) continue;
      const existing = cacheIndex.get(mpn);
      if (!existing || dateStr > existing.dateStr) {
        cacheIndex.set(mpn, { file: path.join(CACHE_DIR, f), dateStr, ageDays });
      }
    }
  }

  const { rows: lines } = await pool.query(
    `SELECT rl.line, rlm.chuboe_mpn_clean AS mpn, rl.qty
       FROM adempiere.chuboe_rfq_line rl
       JOIN adempiere.chuboe_rfq_line_mpn rlm
         ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
      WHERE rl.chuboe_rfq_id = $1 AND rl.isactive='Y'
        AND rlm.chuboe_mpn_clean IS NOT NULL AND rlm.chuboe_mpn_clean <> ''`,
    [chuboeRfqId]
  );

  let withCache = 0;
  let withStock = 0;
  let totalAgeDays = 0;
  const valuedHits = [];

  for (const row of lines) {
    const normalized = cacheKey(row.mpn);
    const hit = cacheIndex.get(normalized);
    if (!hit) continue;
    withCache++;
    totalAgeDays += hit.ageDays;
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(hit.file, 'utf-8')); }
    catch { continue; }
    const pricings = envelope.data?.Pricings || [];
    const stockEntries = pricings.filter(p => Number(p.CurrentStockQty || 0) > 0);
    if (stockEntries.length === 0) continue;
    withStock++;

    // Best price at this qty: for each stock-carrying distributor pick the
    // highest qty-break ≤ RFQ qty; take the min UnitPrice across distributors.
    const qty = Number(row.qty || 1);
    let bestPrice = Infinity;
    let bestSupplier = null;
    for (const p of stockEntries) {
      const breaks = (p.Pricings || []).filter(b => Number(b.QtyBreak) <= qty);
      if (breaks.length === 0) continue;
      breaks.sort((a, b) => Number(b.QtyBreak) - Number(a.QtyBreak));
      const candidate = Number(breaks[0].UnitPrice);
      if (Number.isFinite(candidate) && candidate > 0 && candidate < bestPrice) {
        bestPrice = candidate;
        bestSupplier = p.SupplierName || '?';
      }
    }
    if (!Number.isFinite(bestPrice)) continue;
    valuedHits.push({
      line: row.line,
      mpn: row.mpn,
      qty,
      bestPrice,
      bestSupplier,
      extended: bestPrice * qty,
      ageDays: hit.ageDays,
    });
  }

  valuedHits.sort((a, b) => b.extended - a.extended);
  const totalLines = lines.length;
  const linesWithoutCache = totalLines - withCache;
  const estApi = linesWithoutCache * 10;
  return {
    totalLines,
    withCache,
    withStock,
    avgCacheAgeDays: withCache > 0 ? totalAgeDays / withCache : 0,
    cacheHitPct: totalLines > 0 ? (withCache / totalLines) : 0,
    stockHitPct: totalLines > 0 ? (withStock / totalLines) : 0,
    estApiCallsIfApproved: estApi,
    digikeyCallsIfApproved: linesWithoutCache,
    digikeyQuotaMultiple: linesWithoutCache / 1000,
    topValued: valuedHits.slice(0, topN),
  };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-US');
const fmtUsd = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
};

function renderCacheCoverageSection(coverage) {
  if (!coverage || !coverage.totalLines) return '';
  const pctOf = (n, d) => d > 0 ? Math.round(100 * n / d) : 0;
  const hitPct = pctOf(coverage.withCache, coverage.totalLines);
  const stockPct = pctOf(coverage.withStock, coverage.totalLines);
  const linesWithoutCache = coverage.totalLines - coverage.withCache;
  const ageBlurb = coverage.withCache > 0
    ? `avg ${coverage.avgCacheAgeDays.toFixed(1)}d old`
    : '—';

  const topRows = (coverage.topValued || []).map(t => `
    <tr>
      <td style="padding:3px 14px 3px 0">${esc(t.line)}</td>
      <td style="padding:3px 14px 3px 0">${esc(t.mpn)}</td>
      <td style="padding:3px 14px 3px 0">${esc(t.bestSupplier || '?')}</td>
      <td style="text-align:right;padding:3px 14px 3px 0">${fmt(t.qty)}</td>
      <td style="text-align:right;padding:3px 14px 3px 0">${fmtUsd(t.bestPrice)}</td>
      <td style="text-align:right;padding:3px 14px 3px 0">${fmtUsd(t.extended)}</td>
      <td style="text-align:right">${t.ageDays}d</td>
    </tr>`).join('') || '<tr><td colspan="7" style="color:#888">No stock-carrying cached lines</td></tr>';

  return `
<h3 style="margin-bottom:6px;margin-top:18px">Cache Coverage (no APIs called)</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr><td style="color:#666;padding:3px 14px 3px 0">Lines with recent cache data</td><td><b>${fmt(coverage.withCache)}</b> / ${fmt(coverage.totalLines)} (${hitPct}%, ${ageBlurb})</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Lines showing franchise stock (cached)</td><td><b>${fmt(coverage.withStock)}</b> / ${fmt(coverage.totalLines)} (${stockPct}%)</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Lines with NO recent cache</td><td><b>${fmt(linesWithoutCache)}</b> — would need fresh API calls</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Cost if approved (full)</td><td>~${fmt(coverage.estApiCallsIfApproved)} distributor calls; ~${fmt(coverage.digikeyCallsIfApproved)} hit DigiKey (~${coverage.digikeyQuotaMultiple.toFixed(1)}× daily quota)</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Cost if cache-only</td><td><b>$0 API spend</b> — write VQs off the ${fmt(coverage.withCache)} cached envelopes only</td></tr>
</table>

<h4 style="margin-bottom:6px;margin-top:14px">Top ${coverage.topValued?.length || 0} cached lines by extended value (price × qty)</h4>
<table style="border-collapse:collapse;font-size:12px">
  <tr>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Line</th>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MPN</th>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Best supplier</th>
    <th style="text-align:right;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Qty</th>
    <th style="text-align:right;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Best price</th>
    <th style="text-align:right;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Extended</th>
    <th style="text-align:right;border-bottom:1px solid #ccc">Cache age</th>
  </tr>
  ${topRows}
</table>`;
}

function renderApprovalEmailHtml(meta, ctx, thresholdN, coverage = null) {
  const t = ctx.targets_summary || {};
  const withTarget = Number(t.with_target || 0);
  const totalLines = Number(t.total_lines || 0);
  const targetsRow = withTarget === 0
    ? `<tr><td style="color:#666;padding:3px 14px 3px 0">Target prices</td><td>No customer targets on file</td></tr>`
    : `<tr><td style="color:#666;padding:3px 14px 3px 0">Target prices</td><td>${fmt(withTarget)} / ${fmt(totalLines)} lines have targets — range ${fmtUsd(t.min_target)} – ${fmtUsd(t.max_target)} (avg ${fmtUsd(t.avg_target)})</td></tr>`;

  const mfrRows = (ctx.top_mfrs || []).map(m =>
    `<tr><td style="padding:3px 14px 3px 0">${esc(m.mfr)}</td><td style="text-align:right">${fmt(m.line_count)}</td></tr>`
  ).join('') || '<tr><td colspan="2" style="color:#888">—</td></tr>';

  const mpnRows = (ctx.sample_mpns || []).map(m =>
    `<tr>
       <td style="padding:3px 14px 3px 0">${esc(m.line)}</td>
       <td style="padding:3px 14px 3px 0">${esc(m.mpn)}</td>
       <td style="padding:3px 14px 3px 0">${esc(m.mfr_text || '—')}</td>
       <td style="text-align:right;padding:3px 14px 3px 0">${fmt(m.qty)}</td>
       <td style="text-align:right">${fmtUsd(m.target_price)}</td>
     </tr>`
  ).join('') || '<tr><td colspan="5" style="color:#888">—</td></tr>';

  // Each line hits ~10 distributor APIs (DigiKey, Mouser, TTI, Newark, Farnell,
  // Arrow, Future, Rutronik, Master, Waldom). DigiKey is the rate-limited one
  // (1000/day quota). Express the cost in DigiKey-quota terms since that's
  // what tends to fail first.
  const lineMpns = Number(meta.line_mpns || 0);
  const totalApiCalls = lineMpns * 10;
  const digikeyCalls = lineMpns;
  const digikeyQuotaMultiple = (digikeyCalls / 1000).toFixed(1);

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;max-width:840px">
<h2 style="color:#b58900;margin-bottom:6px">[APPROVAL NEEDED] Large RFQ ${esc(meta.rfq_number)}</h2>
<p style="margin-top:0;color:#666;font-size:12px">From the auto-enrichment gate — line count exceeds threshold (${fmt(thresholdN)})</p>

<p>RFQ <b>${esc(meta.rfq_number)}</b> from <b>${esc(meta.customer || '?')}</b> arrived with <b>${fmt(lineMpns)} line MPNs</b>.</p>

<p style="background:#fff3cd;padding:10px 14px;border-left:4px solid #b58900;margin:14px 0">
<b>Enrichment is paused for this RFQ until you approve.</b><br/>
Estimated cost if approved: <b>~${fmt(totalApiCalls)} total distributor API calls</b> (across 10 distys), of which <b>~${fmt(digikeyCalls)} hit DigiKey</b> — about <b>${digikeyQuotaMultiple}×</b> the daily DigiKey quota (1,000/day).
</p>

<h3 style="margin-bottom:6px">RFQ Context</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr><td style="color:#666;padding:3px 14px 3px 0">RFQ #</td><td>${esc(meta.rfq_number)}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Customer</td><td>${esc(meta.customer || '?')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">RFQ Type</td><td>${esc(meta.rfq_type || '?')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Salesperson</td><td>${esc(ctx.salesrep || '?')}</td></tr>
  <tr><td style="color:#666;padding:3px 14px 3px 0">Total line MPNs</td><td>${fmt(meta.line_mpns)}</td></tr>
  ${targetsRow}
</table>

<h3 style="margin-bottom:6px;margin-top:18px">Top MFRs (by line count)</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr><th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MFR</th><th style="text-align:right;border-bottom:1px solid #ccc">Lines</th></tr>
  ${mfrRows}
</table>

${renderCacheCoverageSection(coverage)}

<h3 style="margin-bottom:6px;margin-top:18px">Sample Lines (first 20)</h3>
<table style="border-collapse:collapse;font-size:12px">
  <tr>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Line</th>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MPN</th>
    <th style="text-align:left;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">MFR text</th>
    <th style="text-align:right;border-bottom:1px solid #ccc;padding:4px 14px 4px 0">Qty</th>
    <th style="text-align:right;border-bottom:1px solid #ccc">Target</th>
  </tr>
  ${mpnRows}
</table>

<h3 style="margin-top:24px">How to respond</h3>
<p><b>Reply by email</b> — the first non-quoted line is parsed by the rfq-loading agent (within ~5–10 min of this email arriving, then every 30m):</p>
<ul style="font-family:'Courier New',monospace;font-size:12px;background:#f5f5f5;padding:10px 24px;border-radius:4px">
  <li><b>YES</b> — enrich all lines (full API spend)</li>
  <li><b>YES --cache-only</b> — write VQs from the ${coverage ? fmt(coverage.withCache) : '<cache hits>'} cached envelopes only; <b>no API spend</b></li>
  <li><b>LIMIT 1000</b> — enrich the first 1,000 lines only (or any cap)</li>
  <li><b>NO</b> — reject permanently</li>
</ul>
<p style="color:#666;font-size:12px">Or from the workspace shell:</p>
<pre style="background:#f5f5f5;padding:10px 14px;border-radius:4px;font-size:12px;overflow-x:auto">
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js approve ${esc(meta.rfq_number)}
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js approve ${esc(meta.rfq_number)} --max-lines 1000
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js approve ${esc(meta.rfq_number)} --cache-only
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js reject  ${esc(meta.rfq_number)} --reason "duplicate of 1133xxx"</pre>

<p style="color:#888;font-size:11px;margin-top:18px">
Gate threshold: ${fmt(thresholdN)} line MPNs. Override per-run with <code>LARGE_RFQ_THRESHOLD=N</code>. Sentinel: <code>~/workspace/.large-rfq-pending/${esc(meta.rfq_number)}.json</code>
</p>
</body></html>`;
}

// ─── EMAIL SEND ──────────────────────────────────────────────────────────────

/**
 * Send the approval email from rfqloading@orangetsunami.com (the inbox
 * polled by the rfq-loading workflow agent). Replies land there and get
 * routed to approve_large_rfq / reject_large_rfq actions automatically.
 *
 * Falls back to excess@ on bounce — same pattern as enrich-poller's main
 * digest email path.
 *
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {function} opts.log
 * @param {string} [opts.to=jake.harris@Astutegroup.com]
 * @returns {Promise<{delivered: 'primary'|'fallback', bounceDetected: boolean}>}
 */
async function sendApprovalEmail({ subject, html, log, to }) {
  const { sendWithFallback } = require('./verified-send');
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    if (log) log('WARN: WORKMAIL_PASS not set — skipping approval email');
    return { delivered: 'none', bounceDetected: false };
  }
  return sendWithFallback({
    primary:  { from: process.env.LARGE_RFQ_GATE_FROM || 'rfqloading@orangetsunami.com', pass, displayName: 'RFQ Loading' },
    fallback: { from: process.env.LARGE_RFQ_GATE_FALLBACK || 'excess@orangetsunami.com',  pass, displayName: 'RFQ Loading' },
    mail: { to: to || 'jake.harris@Astutegroup.com', subject, html },
    log: log || (() => {}),
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else { out.flags[key] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return fallback; }
}

function cliList() {
  if (!fs.existsSync(PENDING_DIR)) { console.log('(no pending)'); return; }
  const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('(no pending)'); return; }
  for (const f of files) {
    const rfqNumber = f.slice(0, -'.json'.length);
    const sentinel = readJsonSafe(path.join(PENDING_DIR, f), {});
    const state = gate.isRejected(rfqNumber) ? 'REJECTED'
      : gate.isProcessed(rfqNumber) ? 'PROCESSED'
      : gate.isCleared(rfqNumber) ? 'APPROVED'
      : 'PENDING';
    console.log(`${rfqNumber.padEnd(10)} ${state.padEnd(10)} ${(sentinel.customer || '?').padEnd(28)} ${(sentinel.rfq_type || '?').padEnd(10)} ${fmt(sentinel.line_mpns)} lines  queued ${sentinel.queued_at || '?'}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`Usage:
  large-rfq-gate.js list
  large-rfq-gate.js approve <RFQ#> [--max-lines N] [--note "..."] [--cache-only]
  large-rfq-gate.js reject  <RFQ#> [--reason "..."]
  large-rfq-gate.js veto    <RFQ#> [--reason "..."]   # block enrichment regardless of size, no sentinel required
  large-rfq-gate.js status  <RFQ#>
  large-rfq-gate.js threshold     # print current threshold

Threshold env: LARGE_RFQ_THRESHOLD (default ${DEFAULT_THRESHOLD})
Pending dir:   ${PENDING_DIR}`);
    process.exit(0);
  }

  if (cmd === 'threshold') {
    console.log(gate.threshold());
    process.exit(0);
  }
  if (cmd === 'list') { cliList(); process.exit(0); }

  const rfqNumber = args._[1];
  if (!rfqNumber) { console.error('error: RFQ# required'); process.exit(2); }

  if (cmd === 'status') {
    const sentinel = readJsonSafe(gate.sentinelPath(rfqNumber));
    if (!sentinel) { console.log(`${rfqNumber}: no sentinel`); process.exit(0); }
    const state = gate.isRejected(rfqNumber) ? 'REJECTED'
      : gate.isProcessed(rfqNumber) ? 'PROCESSED'
      : gate.isCleared(rfqNumber) ? 'APPROVED'
      : 'PENDING';
    console.log(`${rfqNumber}: ${state}`);
    console.log(JSON.stringify(sentinel, null, 2));
    if (gate.isCleared(rfqNumber))  console.log('cleared:',  JSON.stringify(gate.isCleared(rfqNumber)));
    if (gate.isRejected(rfqNumber)) console.log('rejected:', JSON.stringify(gate.isRejected(rfqNumber)));
    process.exit(0);
  }

  if (cmd === 'approve') {
    if (!gate.hasSentinel(rfqNumber)) {
      console.error(`error: no pending sentinel for ${rfqNumber}. Approval ignored.`);
      process.exit(3);
    }
    if (gate.isRejected(rfqNumber)) {
      console.error(`error: ${rfqNumber} is rejected — remove ${gate.rejectedPath(rfqNumber)} first if you want to flip it.`);
      process.exit(3);
    }
    const maxLines = args.flags['max-lines'] ? Number(args.flags['max-lines']) : null;
    const cacheOnly = args.flags['cache-only'] === true || args.flags['cache-only'] === 'true';
    gate.markApproved(rfqNumber, {
      maxLines: Number.isFinite(maxLines) ? maxLines : null,
      cacheOnly,
      approvedBy: args.flags.by || process.env.USER || 'cli',
      note: args.flags.note || null,
    });
    const extras = [];
    if (maxLines) extras.push(`cap ${maxLines} lines`);
    if (cacheOnly) extras.push('cache-only');
    console.log(`approved ${rfqNumber}${extras.length ? ` (${extras.join(', ')})` : ''}`);
    process.exit(0);
  }

  if (cmd === 'reject') {
    if (!gate.hasSentinel(rfqNumber)) {
      console.error(`error: no pending sentinel for ${rfqNumber}.`);
      process.exit(3);
    }
    gate.markRejected(rfqNumber, {
      reason: args.flags.reason || null,
      rejectedBy: args.flags.by || process.env.USER || 'cli',
    });
    console.log(`rejected ${rfqNumber}`);
    process.exit(0);
  }

  if (cmd === 'veto') {
    // No sentinel required: this is for RFQs below the gate threshold that the
    // operator still wants to keep out of enrichment (test stubs, junk loads,
    // etc.). enrich-poller checks isRejected() unconditionally.
    gate.markRejected(rfqNumber, {
      reason: args.flags.reason || 'operator veto',
      rejectedBy: args.flags.by || process.env.USER || 'cli',
    });
    console.log(`vetoed ${rfqNumber} (will be skipped by enrich-poller)`);
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

if (require.main === module) main();

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
// Preserve the pre-refactor surface area exactly so enrich-poller and any
// other callers don't need to change. The state-machine methods come from the
// generic gate instance; writeSentinel is wrapped to keep its meta-only
// signature; the RFQ-specific helpers (fetch/scan/render/send) stay local.

module.exports = {
  PENDING_DIR,
  threshold: gate.threshold,
  sentinelPath: gate.sentinelPath,
  clearedPath: gate.clearedPath,
  rejectedPath: gate.rejectedPath,
  processedPath: gate.processedPath,
  hasSentinel: gate.hasSentinel,
  isPending: gate.isPending,
  isCleared: gate.isCleared,
  isRejected: gate.isRejected,
  isProcessed: gate.isProcessed,
  writeSentinel,
  markApproved: gate.markApproved,
  markRejected: gate.markRejected,
  markProcessed: gate.markProcessed,
  listClearedUnprocessed: gate.listClearedUnprocessed,
  fetchRFQContext,
  scanCacheCoverage,
  renderApprovalEmailHtml,
  sendApprovalEmail,
};
