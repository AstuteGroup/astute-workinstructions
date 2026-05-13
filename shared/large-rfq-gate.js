/**
 * Large-RFQ Approval Gate
 *
 * Pauses auto-enrichment for RFQs above a configured line-count threshold
 * until an operator explicitly approves. Prevents quota-burn on big
 * internal-shortage scrapes (e.g., RFQ 1134261 burned 7,974 API calls in
 * a single tick) and gives the operator a chance to review the demand
 * profile before the full ~10-API-calls-per-line spend kicks off.
 *
 * State directory: ~/workspace/.large-rfq-pending/
 *   {rfq_number}.json       ← sentinel: pending, contains full RFQ context
 *   {rfq_number}.cleared    ← approval flag (optional { maxLines } body)
 *   {rfq_number}.rejected   ← rejection flag (skip permanently)
 *   {rfq_number}.processed  ← internal: enrichment ran on the cleared sentinel
 *
 * Flow:
 *   1. enrich-poller detects RFQ with line_mpns > threshold()
 *   2. First sight → fetchRFQContext(), writeSentinel(), send approval email,
 *      exclude from this tick's processing.
 *   3. Subsequent ticks see the sentinel and skip until paired .cleared exists.
 *   4. Operator approves via CLI (`large-rfq-gate.js approve <RFQ#>`) or via
 *      a future reply-parser action — either writes {rfq_number}.cleared.
 *   5. Next tick scans for cleared+unprocessed sentinels, processes them, then
 *      writes {rfq_number}.processed.
 *
 * Threshold: 5000 line MPNs by default. Override with LARGE_RFQ_THRESHOLD env var.
 *
 * Single source of truth for the cleared-RFQ list: this directory. Don't add
 * a parallel approval registry elsewhere.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PENDING_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-rfq-pending'
);
const DEFAULT_THRESHOLD = 5000;

function threshold() {
  const env = parseInt(process.env.LARGE_RFQ_THRESHOLD, 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_THRESHOLD;
}

function ensurePendingDir() {
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function sentinelPath(rfqNumber)   { return path.join(PENDING_DIR, `${rfqNumber}.json`); }
function clearedPath(rfqNumber)    { return path.join(PENDING_DIR, `${rfqNumber}.cleared`); }
function rejectedPath(rfqNumber)   { return path.join(PENDING_DIR, `${rfqNumber}.rejected`); }
function processedPath(rfqNumber)  { return path.join(PENDING_DIR, `${rfqNumber}.processed`); }

function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return fallback; }
}

function hasSentinel(rfqNumber)  { return fs.existsSync(sentinelPath(rfqNumber)); }
function isPending(rfqNumber) {
  return hasSentinel(rfqNumber)
    && !fs.existsSync(clearedPath(rfqNumber))
    && !fs.existsSync(rejectedPath(rfqNumber));
}
function isCleared(rfqNumber) {
  const p = clearedPath(rfqNumber);
  if (!fs.existsSync(p)) return null;
  return readJsonSafe(p, { approved: true });
}
function isRejected(rfqNumber) {
  const p = rejectedPath(rfqNumber);
  if (!fs.existsSync(p)) return null;
  return readJsonSafe(p, { rejected: true });
}
function isProcessed(rfqNumber)  { return fs.existsSync(processedPath(rfqNumber)); }

function writeSentinel(meta) {
  ensurePendingDir();
  const payload = {
    rfq_number: meta.rfq_number,
    chuboe_rfq_id: meta.chuboe_rfq_id,
    customer: meta.customer || null,
    rfq_type: meta.rfq_type || null,
    salesrep: meta.salesrep || null,
    line_mpns: meta.line_mpns,
    targets_summary: meta.targets_summary || null,
    sample_mpns: meta.sample_mpns || [],
    top_mfrs: meta.top_mfrs || [],
    queued_at: new Date().toISOString(),
  };
  fs.writeFileSync(sentinelPath(meta.rfq_number), JSON.stringify(payload, null, 2));
  return payload;
}

function markApproved(rfqNumber, opts = {}) {
  ensurePendingDir();
  fs.writeFileSync(clearedPath(rfqNumber), JSON.stringify({
    approved: true,
    maxLines: opts.maxLines || null,
    approvedAt: new Date().toISOString(),
    approvedBy: opts.approvedBy || null,
    note: opts.note || null,
  }, null, 2));
}

function markRejected(rfqNumber, opts = {}) {
  ensurePendingDir();
  fs.writeFileSync(rejectedPath(rfqNumber), JSON.stringify({
    rejected: true,
    reason: opts.reason || null,
    rejectedAt: new Date().toISOString(),
    rejectedBy: opts.rejectedBy || null,
  }, null, 2));
}

function markProcessed(rfqNumber) {
  ensurePendingDir();
  fs.writeFileSync(processedPath(rfqNumber), JSON.stringify({
    processedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * Return cleared sentinels that haven't been processed yet — used by
 * enrich-poller to pick up approvals that arrived after the watermark
 * moved past the original detection tick.
 */
function listClearedUnprocessed() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  const files = fs.readdirSync(PENDING_DIR);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.cleared')) continue;
    const rfqNumber = f.slice(0, -'.cleared'.length);
    if (isProcessed(rfqNumber)) continue;
    const sentinel = readJsonSafe(sentinelPath(rfqNumber));
    const cleared = readJsonSafe(clearedPath(rfqNumber), { approved: true });
    if (!sentinel) continue;  // sentinel was deleted, nothing to do
    out.push({ ...sentinel, _approval: cleared });
  }
  return out;
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

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-US');
const fmtUsd = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
};

function renderApprovalEmailHtml(meta, ctx, thresholdN) {
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
<p>From the workspace shell, run one of:</p>
<pre style="background:#f5f5f5;padding:10px 14px;border-radius:4px;font-size:12px;overflow-x:auto">
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js approve ${esc(meta.rfq_number)}
node ~/workspace/astute-workinstructions/shared/large-rfq-gate.js approve ${esc(meta.rfq_number)} --max-lines 1000
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

function cliList() {
  if (!fs.existsSync(PENDING_DIR)) { console.log('(no pending)'); return; }
  const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('(no pending)'); return; }
  for (const f of files) {
    const rfqNumber = f.slice(0, -'.json'.length);
    const sentinel = readJsonSafe(path.join(PENDING_DIR, f), {});
    const state = isRejected(rfqNumber) ? 'REJECTED'
      : isProcessed(rfqNumber) ? 'PROCESSED'
      : isCleared(rfqNumber) ? 'APPROVED'
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
  large-rfq-gate.js approve <RFQ#> [--max-lines N] [--note "..."]
  large-rfq-gate.js reject  <RFQ#> [--reason "..."]
  large-rfq-gate.js status  <RFQ#>
  large-rfq-gate.js threshold     # print current threshold

Threshold env: LARGE_RFQ_THRESHOLD (default ${DEFAULT_THRESHOLD})
Pending dir:   ${PENDING_DIR}`);
    process.exit(0);
  }

  if (cmd === 'threshold') {
    console.log(threshold());
    process.exit(0);
  }
  if (cmd === 'list') { cliList(); process.exit(0); }

  const rfqNumber = args._[1];
  if (!rfqNumber) { console.error('error: RFQ# required'); process.exit(2); }

  if (cmd === 'status') {
    const sentinel = readJsonSafe(sentinelPath(rfqNumber));
    if (!sentinel) { console.log(`${rfqNumber}: no sentinel`); process.exit(0); }
    const state = isRejected(rfqNumber) ? 'REJECTED'
      : isProcessed(rfqNumber) ? 'PROCESSED'
      : isCleared(rfqNumber) ? 'APPROVED'
      : 'PENDING';
    console.log(`${rfqNumber}: ${state}`);
    console.log(JSON.stringify(sentinel, null, 2));
    if (isCleared(rfqNumber))  console.log('cleared:',  JSON.stringify(isCleared(rfqNumber)));
    if (isRejected(rfqNumber)) console.log('rejected:', JSON.stringify(isRejected(rfqNumber)));
    process.exit(0);
  }

  if (cmd === 'approve') {
    if (!hasSentinel(rfqNumber)) {
      console.error(`error: no pending sentinel for ${rfqNumber}. Approval ignored.`);
      process.exit(3);
    }
    if (isRejected(rfqNumber)) {
      console.error(`error: ${rfqNumber} is rejected — remove ${rejectedPath(rfqNumber)} first if you want to flip it.`);
      process.exit(3);
    }
    const maxLines = args.flags['max-lines'] ? Number(args.flags['max-lines']) : null;
    markApproved(rfqNumber, {
      maxLines: Number.isFinite(maxLines) ? maxLines : null,
      approvedBy: args.flags.by || process.env.USER || 'cli',
      note: args.flags.note || null,
    });
    console.log(`approved ${rfqNumber}${maxLines ? ` (cap ${maxLines} lines)` : ''}`);
    process.exit(0);
  }

  if (cmd === 'reject') {
    if (!hasSentinel(rfqNumber)) {
      console.error(`error: no pending sentinel for ${rfqNumber}.`);
      process.exit(3);
    }
    markRejected(rfqNumber, {
      reason: args.flags.reason || null,
      rejectedBy: args.flags.by || process.env.USER || 'cli',
    });
    console.log(`rejected ${rfqNumber}`);
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  PENDING_DIR,
  threshold,
  sentinelPath,
  clearedPath,
  rejectedPath,
  processedPath,
  hasSentinel,
  isPending,
  isCleared,
  isRejected,
  isProcessed,
  writeSentinel,
  markApproved,
  markRejected,
  markProcessed,
  listClearedUnprocessed,
  fetchRFQContext,
  renderApprovalEmailHtml,
  sendApprovalEmail,
};
