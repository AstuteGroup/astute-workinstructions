#!/usr/bin/env node
/**
 * Price Intelligence Dashboard generator
 *
 * Standardized version of the MT40A1G16TB-062E IT:F dashboard (Mar 2026),
 * with the customer-target overlay added from the IT:E iteration. Supports
 * one or many MPNs in a single page — when multiple are provided, the
 * dashboard adds an MPN dropdown that switches the active dataset.
 *
 * Pulls VQ + Market Offer + Customer-target history for each MPN and
 * renders an interactive HTML chart matching the IT:F look.
 *
 * Usage (single MPN):
 *   node price-intel.js --mpn "MT40A1G16TB-062E IT:F"
 *
 * Usage (multi MPN — dropdown):
 *   node price-intel.js --mpn "MT41K64M16TW-107 IT:J" --mpn "MT25QL01GBBB8E120AAT" ...
 *   node price-intel.js --mpns "A,B,C"
 *   node price-intel.js --mpn-file mpns.txt          # newline-separated
 *
 * Other flags:
 *   --from YYYY-MM-DD   Earliest date to include (default all-time)
 *   --to YYYY-MM-DD     Latest date (default today)
 *   --loose             Prefix-match chuboe_mpn_clean (catches family/TR variants)
 *   --email             Email the dashboard via shared/notifier.js
 *   --to-email <addr>   Override recipient (default OPERATOR_EMAIL or jake.harris@)
 *   --out <path>        Override output filename
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'output');

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argAll(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith('--')) {
      out.push(args[i + 1]);
    }
  }
  return out;
}
function argOne(flag, fallback = null) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

// Collect MPNs from --mpn (repeatable), --mpns (csv), --mpn-file (newline)
const mpnList = [];
mpnList.push(...argAll('--mpn'));
const csv = argOne('--mpns');
if (csv && csv !== true) mpnList.push(...csv.split(',').map(s => s.trim()).filter(Boolean));
const mpnFile = argOne('--mpn-file');
if (mpnFile && mpnFile !== true) {
  mpnList.push(...fs.readFileSync(mpnFile, 'utf-8')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean));
}

// Dedupe by clean form (preserving first occurrence's display string)
const cleanOf = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const seen = new Map();
for (const raw of mpnList) {
  const c = cleanOf(raw);
  if (c.length < 5) continue;
  if (!seen.has(c)) seen.set(c, raw);
}
const MPNS = [...seen.entries()].map(([clean, raw]) => ({ raw, clean }));

if (MPNS.length === 0) {
  console.error('Usage: node price-intel.js --mpn "<MPN>" [--mpn "<MPN2>" ...] [--from] [--to] [--loose] [--email]');
  process.exit(1);
}

const FROM   = argOne('--from', null);
const TO     = argOne('--to', null);
const LOOSE  = !!argOne('--loose', false);
const EMAIL  = !!argOne('--email', false);
const TO_EMAIL = argOne('--to-email', process.env.OPERATOR_EMAIL || 'jake.harris@Astutegroup.com');
const OUT_OVERRIDE = argOne('--out', null);

// Customer-facing variant — shows scatter of indicative-price points
// (each VQ/MO observation × (1 + markup)) plus the customer's own historical
// targets when anchored, with MFR equivalence enforced. The markup shifts
// absolute values off the supplier-cost level so the chart shows where
// Astute might quote, not where suppliers are charging.
const CUSTOMER_VIEW = !!argOne('--customer-view', false);
const CUSTOMER_BP   = argOne('--customer-bp', null);
const MFR_OVERRIDE  = argOne('--mfr', null);
const MARKUP        = (() => {
  const raw = argOne('--markup', '0.35');
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 5) {
    console.error(`Error: --markup must be a positive decimal (e.g. 0.35 for 35%); got "${raw}"`);
    process.exit(2);
  }
  return n;
})();

// --customer-bp is optional — when omitted, customer-view renders an
// anonymous market-band variant (no banner watermark, no target overlay,
// no per-customer canonical-MFR inference). --mfr is recommended in that
// mode to anchor the band; otherwise it falls back to MFR-agnostic.

// ── psql ─────────────────────────────────────────────────────────────────────
function psql(sql) {
  const cmd = `psql -U analytics_user -t -A -F $'\\x1f' -c "${sql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 600000, maxBuffer: 1024 * 1024 * 128, shell: '/bin/bash' });
  return out.split('\n').filter(Boolean).map(line => line.split('\x1f'));
}

// ── Match clauses ────────────────────────────────────────────────────────────
const cleanList = MPNS.map(m => `'${m.clean}'`).join(', ');
const matchClause = (col) => LOOSE
  ? '(' + MPNS.map(m => `${col} LIKE '${m.clean}%'`).join(' OR ') + ')'
  : `${col} IN (${cleanList})`;

// Each row carries its match key so we can group by user-input MPN.
// For LOOSE we use a CASE expression to derive the matched MPN.
function matchKey(col) {
  if (!LOOSE) return col;
  const branches = MPNS.map(m => `WHEN ${col} LIKE '${m.clean}%' THEN '${m.clean}'`).join(' ');
  return `(CASE ${branches} ELSE '' END)`;
}

function dateRange(col) {
  const parts = [];
  if (FROM) parts.push(`${col} >= '${FROM}'::date`);
  if (TO)   parts.push(`${col} <= '${TO}'::date`);
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

// ── Queries (batched: one query per source covers all MPNs) ──────────────────
console.log(`Pulling data for ${MPNS.length} MPN${MPNS.length > 1 ? 's' : ''}: ${MPNS.map(m => m.raw).join(' | ')}`);
console.log(`Mode: ${LOOSE ? 'LOOSE prefix' : 'EXACT clean'}`);

const vqDateCol = `COALESCE(vq.chuboe_datequotetrx, vq.created)`;
const vqRows = psql(`
  SELECT
    ${matchKey('vq.chuboe_mpn_clean')},
    TO_CHAR(${vqDateCol}, 'YYYY-MM-DD'),
    COALESCE(NULLIF(TRIM(vq.bpname),''), bp.name, ''),
    COALESCE(vq.qty, 0),
    vq.cost,
    COALESCE(NULLIF(TRIM(vq.chuboe_date_code),''), ''),
    COALESCE(rfq.value, ''),
    COALESCE(cust.name, ''),
    COALESCE(NULLIF(TRIM(vq.chuboe_mfr_text),''), mfr.name, '')
  FROM adempiere.chuboe_vq_line vq
  LEFT JOIN adempiere.c_bpartner bp   ON bp.c_bpartner_id   = vq.c_bpartner_id
  LEFT JOIN adempiere.chuboe_rfq rfq  ON rfq.chuboe_rfq_id  = vq.chuboe_rfq_id
  LEFT JOIN adempiere.c_bpartner cust ON cust.c_bpartner_id = rfq.c_bpartner_id
  LEFT JOIN adempiere.chuboe_mfr mfr  ON mfr.chuboe_mfr_id  = vq.chuboe_mfr_id
  WHERE vq.isactive = 'Y'
    AND vq.cost > 0
    AND ${matchClause('vq.chuboe_mpn_clean')}
    ${dateRange(vqDateCol)}
  ORDER BY 1, 2
`);

const offerDateCol = `COALESCE(o.datetrx, o.created)`;
const moRows = psql(`
  SELECT
    ${matchKey('ol.chuboe_mpn_clean')},
    TO_CHAR(${offerDateCol}, 'YYYY-MM-DD'),
    COALESCE(bp.name, ''),
    COALESCE(ol.qty, 0),
    ol.priceentered,
    COALESCE(NULLIF(TRIM(ol.chuboe_date_code),''), ''),
    COALESCE(ot.name, ''),
    COALESCE(NULLIF(TRIM(ol.chuboe_mfr_text),''), mfr.name, '')
  FROM adempiere.chuboe_offer_line ol
  JOIN adempiere.chuboe_offer o     ON o.chuboe_offer_id = ol.chuboe_offer_id
  LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id  = o.c_bpartner_id
  LEFT JOIN adempiere.chuboe_offer_type ot ON ot.chuboe_offer_type_id = o.chuboe_offer_type_id
  LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = ol.chuboe_mfr_id
  WHERE ol.isactive = 'Y'
    AND o.isactive  = 'Y'
    AND o.chuboe_offer_type_id <> 1000025 /* exclude LAM Kitting Inventory (LAM consigned, not ours) */
    AND ol.priceentered > 0
    AND ${matchClause('ol.chuboe_mpn_clean')}
    ${dateRange(offerDateCol)}
  ORDER BY 1, 2
`);

const tgtDateCol = `COALESCE(rfq.chuboe_co_orderdate, rfq.created)`;
const tgtRows = psql(`
  SELECT
    ${matchKey('rlm.chuboe_mpn_clean')},
    TO_CHAR(${tgtDateCol}, 'YYYY-MM-DD'),
    COALESCE(cust.name, ''),
    COALESCE(rl.qty, 0),
    rl.priceentered,
    COALESCE(rfq.value, ''),
    COALESCE(rfq.c_bpartner_id::text, ''),
    COALESCE(NULLIF(TRIM(rlm.chuboe_mfr_text),''), mfr.name, '')
  FROM adempiere.chuboe_rfq_line rl
  JOIN adempiere.chuboe_rfq rfq      ON rfq.chuboe_rfq_id  = rl.chuboe_rfq_id
  JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
  LEFT JOIN adempiere.c_bpartner cust ON cust.c_bpartner_id = rfq.c_bpartner_id
  LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = rlm.chuboe_mfr_id
  WHERE rl.isactive = 'Y'
    AND rfq.isactive = 'Y'
    AND rl.priceentered > 0
    AND ${matchClause('rlm.chuboe_mpn_clean')}
    ${dateRange(tgtDateCol)}
  ORDER BY 1, 2
`);

// ── Group by MPN ─────────────────────────────────────────────────────────────
const byMpn = new Map();
MPNS.forEach(m => byMpn.set(m.clean, { raw: m.raw, clean: m.clean, vq: [], mo: [], tgt: [] }));

vqRows.forEach(r => {
  const e = byMpn.get(r[0]); if (!e) return;
  e.vq.push({ date: r[1], vendor: r[2], qty: parseFloat(r[3]) || 0, cost: parseFloat(r[4]) || 0,
              dc: r[5], rfq: r[6], customer: r[7], mfr: r[8] });
});
moRows.forEach(r => {
  const e = byMpn.get(r[0]); if (!e) return;
  e.mo.push({ date: r[1], vendor: r[2], qty: parseFloat(r[3]) || 0, cost: parseFloat(r[4]) || 0,
              dc: r[5], offerType: r[6], mfr: r[7] });
});
tgtRows.forEach(r => {
  const e = byMpn.get(r[0]); if (!e) return;
  e.tgt.push({ date: r[1], customer: r[2], qty: parseFloat(r[3]) || 0, price: parseFloat(r[4]) || 0,
               rfq: r[5], bpId: r[6], mfr: r[7] });
});

// Print per-MPN summary to stderr
console.log('\nPer-MPN counts:');
for (const m of MPNS) {
  const e = byMpn.get(m.clean);
  console.log(`  ${m.raw.padEnd(30)} VQ=${String(e.vq.length).padStart(4)}  MO=${String(e.mo.length).padStart(4)}  TGT=${String(e.tgt.length).padStart(4)}`);
}

const totalRows = MPNS.reduce((s, m) => {
  const e = byMpn.get(m.clean);
  return s + e.vq.length + e.mo.length + e.tgt.length;
}, 0);
if (totalRows === 0) {
  console.error('\nNo data found for any MPN. Try --loose for prefix match, or check MPN spelling.');
  process.exit(3);
}

// Drop MPNs with zero data so they don't clutter the dropdown
const liveMpns = MPNS.filter(m => {
  const e = byMpn.get(m.clean);
  return e.vq.length + e.mo.length + e.tgt.length > 0;
});
const deadMpns = MPNS.filter(m => !liveMpns.includes(m));
if (deadMpns.length) {
  console.log(`\nNote: ${deadMpns.length} MPN${deadMpns.length > 1 ? 's have' : ' has'} no data and won't appear in dropdown:`);
  deadMpns.forEach(m => console.log(`  - ${m.raw}`));
}

// ── Customer-View branch ─────────────────────────────────────────────────────
// When --customer-view is set, render an external/customer-safe variant
// (aggregated market band, no individual quotes, no other-customer targets,
// MFR-equivalence filtered) and exit. Internal rendering below is untouched.
if (CUSTOMER_VIEW) {
  const emailPromise = renderCustomerView();
  // If --email was set, renderCustomerView returns a Promise; ensure exit
  // code propagates after it settles. Internal-render path is skipped via
  // the `else` branch wrapping the rest of the file (search "INTERNAL_BEGIN").
  if (emailPromise && typeof emailPromise.then === 'function') {
    emailPromise.finally(() => process.exit(process.exitCode || 0));
  }
}

function renderCustomerView() {
  const { computeMfrMatch } = require(path.join(ROOT, 'shared', 'mfr-equivalence'));

  const HAS_BP = !!(CUSTOMER_BP && CUSTOMER_BP !== true);

  // 1. Look up customer name (only when BP is provided)
  let customerName = null;
  if (HAS_BP) {
    const bpRows = psql(`
      SELECT name FROM adempiere.c_bpartner
      WHERE c_bpartner_id = ${parseInt(CUSTOMER_BP, 10)} AND isactive = 'Y'
    `);
    if (!bpRows.length) {
      console.error(`Error: c_bpartner_id=${CUSTOMER_BP} not found or inactive.`);
      process.exit(2);
    }
    customerName = bpRows[0][0];
    console.log(`\nCustomer view for: ${customerName} (BP ${CUSTOMER_BP})`);
  } else {
    console.log(`\nAnonymous market-band view (no customer anchor)`);
  }

  // 2. Per-MPN: resolve canonical MFR, filter VQ+MO, build band, slice targets
  const cvDatasets = [];
  const mpnNotes = [];
  for (const m of liveMpns) {
    const e = byMpn.get(m.clean);

    // Resolve canonical MFR — explicit override beats most-recent-target
    // inference, which only runs when a customer BP is anchored.
    const customerTargets = HAS_BP ? e.tgt.filter(t => t.bpId === String(CUSTOMER_BP)) : [];
    let canonicalMfr = (typeof MFR_OVERRIDE === 'string' && MFR_OVERRIDE) ? MFR_OVERRIDE : null;
    let mfrSource = canonicalMfr ? 'override' : null;
    if (!canonicalMfr && HAS_BP && customerTargets.length) {
      const sortedTgt = customerTargets.slice().sort((a, b) => b.date.localeCompare(a.date));
      const recent = sortedTgt.find(t => t.mfr && t.mfr.trim());
      if (recent) { canonicalMfr = recent.mfr; mfrSource = 'most-recent target'; }
    }

    // Filter VQ + MO by MFR equivalence (drop MISMATCH; keep '' [equivalent] and '?' [one-blank])
    const mfrFilter = (row) => {
      if (!canonicalMfr) return true;
      return computeMfrMatch(canonicalMfr, row.mfr || '') !== 'MISMATCH';
    };
    const vqKeep = e.vq.filter(mfrFilter);
    const moKeep = e.mo.filter(mfrFilter);
    const vqDropped = e.vq.length - vqKeep.length;
    const moDropped = e.mo.length - moKeep.length;

    // Build bi-weekly median line of indicative-quote prices. Every VQ + MO
    // observation × (1 + markup) gets bucketed; bucket median becomes one
    // point on the line. Buckets with <MIN_BUCKET observations are dropped
    // so a single quote can't drive a point.
    const MIN_BUCKET_OBS = 3;
    const allPoints = [
      ...vqKeep.map(x => ({ date: x.date, raw: x.cost })),
      ...moKeep.map(x => ({ date: x.date, raw: x.cost })),
    ].filter(p => p.raw > 0);
    const buckets = {};
    allPoints.forEach(p => {
      const bw = biweekStart(p.date);
      (buckets[bw] = buckets[bw] || []).push(p.raw * (1 + MARKUP));
    });
    const medianOf = (arr) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };
    const line = Object.entries(buckets)
      .filter(([, vals]) => vals.length >= MIN_BUCKET_OBS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ x: date, y: round2(medianOf(vals)) }));

    // Stats: latest line point as the "current" anchor; window median across
    // every bucket as a secondary callout.
    const lineYs = line.map(p => p.y);

    // Customer's own targets (their own data — safe to show back)
    const targetSeries = customerTargets
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(t => ({ x: t.date, y: round2(t.price) }));

    cvDatasets.push({
      raw: m.raw,
      clean: m.clean,
      canonicalMfr: canonicalMfr || '(no canonical MFR)',
      mfrSource,
      line,
      targets: targetSeries,
      stats: {
        bucketCount: line.length,
        observationCount: allPoints.length,
        targetCount: customerTargets.length,
        windowMedian: lineYs.length ? round2(medianOf(lineYs)) : null,
        currentMedian: line.length ? line[line.length - 1].y : null,
        currentBucket: line.length ? line[line.length - 1].x : null,
      },
      _diag: { vqKept: vqKeep.length, moKept: moKeep.length, vqDropped, moDropped },
    });

    mpnNotes.push(`  ${m.raw.padEnd(30)} canonical-MFR=${canonicalMfr || '(none)'}  bi-weekly-pts=${line.length}  obs=${allPoints.length}  targets=${customerTargets.length}  (VQ kept=${vqKeep.length}/${e.vq.length}, MO kept=${moKeep.length}/${e.mo.length})`);
  }

  console.log('\nPer-MPN summary:');
  mpnNotes.forEach(n => console.log(n));

  // 3. Drop MPNs whose bi-weekly median line has no points (every bucket
  //    fell below the 3-obs floor). Refusing is better than rendering empty.
  const renderable = cvDatasets.filter(d => d.line.length > 0);
  const suppressed = cvDatasets.filter(d => d.line.length === 0);
  if (suppressed.length) {
    console.log(`\nSuppressed ${suppressed.length} MPN(s) — no bi-weekly bucket meets the ≥3-obs floor:`);
    suppressed.forEach(d => console.log(`  - ${d.raw}`));
  }
  if (renderable.length === 0) {
    console.error(`\nNo data for customer view. Expand the date range or relax the canonical MFR.`);
    process.exit(5);
  }

  // 4. Render. Strip internal diagnostics (_diag, mfrSource) from the
  // payload before embedding — they only matter to the operator's stdout.
  const today = new Date().toISOString().slice(0, 10);
  const safeForEmbed = renderable.map(d => ({
    raw: d.raw,
    clean: d.clean,
    canonicalMfr: d.canonicalMfr,
    line: d.line,
    targets: d.targets,
    stats: d.stats,
  }));
  const html = buildCustomerHtml({
    customerName,
    customerBp: HAS_BP ? CUSTOMER_BP : null,
    hasBp: HAS_BP,
    datasets: safeForEmbed,
    suppressed: suppressed.map(d => d.raw),
    dateMin: FROM || (allDatesAcross(renderable)[0] || '2024-01-01'),
    dateMax: TO   || (allDatesAcross(renderable).slice(-1)[0] || today),
    markup: MARKUP,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  });

  // 5. Write file. Filename prefix differs so a seller scanning the output
  // dir can tell at a glance whether the file is anchored to a customer
  // (`customer_*_BP<id>_*`) or a generic anonymized band (`band_*_*`).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prefix = HAS_BP ? `customer_` : `indicative_`;
  const bpSeg = HAS_BP ? `_BP${String(CUSTOMER_BP).replace(/[^0-9]/g, '')}` : '';
  const outName = OUT_OVERRIDE || (renderable.length === 1
    ? `${prefix}${renderable[0].raw.replace(/[^A-Za-z0-9-]+/g, '_')}${bpSeg}_${today}.html`
    : `${prefix}multi_${renderable.length}_MPNs${bpSeg}_${today}.html`);
  const outPath = path.isAbsolute(outName) ? outName : path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, html);

  console.log(`\nCustomer dashboard written: ${outPath}`);
  console.log(`File size: ${(html.length / 1024).toFixed(1)} KB`);
  console.log(`MPNs rendered: ${renderable.length}${suppressed.length ? ` (${suppressed.length} suppressed — insufficient data)` : ''}`);

  // 6. Optional email
  if (EMAIL) {
    const { createNotifier } = require(path.join(ROOT, 'shared', 'notifier'));
    const notifier = createNotifier({
      fromEmail: 'stockRFQ@orangetsunami.com',
      fromName: 'Price Intelligence',
    });
    const subjectLabel = renderable.length === 1 ? renderable[0].raw : renderable.length + ' MPNs';
    const subject = HAS_BP
      ? `Indicative Pricing — ${subjectLabel} — ${customerName} (${today})`
      : `Indicative Pricing — ${subjectLabel} (${today})`;
    const markupPct = (MARKUP * 100).toFixed(0);
    const body = HAS_BP
      ? `<p>Customer-facing pricing dashboard for <b>${escapeHtml(customerName)}</b> (BP ${escapeHtml(String(CUSTOMER_BP))}).</p>
         <p><b>External-safe</b> — bi-weekly median line of indicative quote prices (underlying supplier observations × ${markupPct}% markup, aggregated to ≥3 obs/bucket), customer's own historical targets overlaid, no vendor/qty/DC/RFQ identifiers, MFR-equivalence enforced.</p>
         <p>Open the attached HTML in a browser${renderable.length > 1 ? ' and use the MPN dropdown to switch between parts' : ''}.</p>`
      : `<p>Anonymized indicative-quote trend for <b>${escapeHtml(subjectLabel)}</b> — no customer anchor.</p>
         <p><b>External-safe</b> — bi-weekly median line of indicative quote prices (underlying supplier observations × ${markupPct}% markup, aggregated to ≥3 obs/bucket), no identifiers, no customer-specific data.</p>
         <p>Open the attached HTML in a browser${renderable.length > 1 ? ' and use the MPN dropdown to switch between parts' : ''}.</p>`;
    return notifier.sendWithAttachment(
      TO_EMAIL, subject, body,
      [{ filename: path.basename(outPath), path: outPath }]
    ).then(ok => {
      console.log(ok ? `Emailed to ${TO_EMAIL}` : 'Email send failed');
      if (!ok) process.exitCode = 4;
    }).catch(err => { console.error('Email failed:', err.message); process.exitCode = 4; });
  }
  return null;
}

function biweekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const start = new Date('2024-01-01T00:00:00Z');
  const days = Math.floor((d - start) / 86400000);
  const period = Math.floor(days / 14);
  return new Date(start.getTime() + period * 14 * 86400000).toISOString().slice(0, 10);
}
function round2(v) { return Math.round((+v || 0) * 100) / 100; }
function allDatesAcross(datasets) {
  const out = [];
  datasets.forEach(d => {
    d.line.forEach(p => out.push(p.x));
    d.targets.forEach(t => out.push(t.x));
  });
  return out.sort();
}

function buildCustomerHtml(ctx) {
  const { customerName, customerBp, hasBp, datasets, suppressed, dateMin, dateMax, markup, generatedAt } = ctx;
  const titleLabel = datasets.length === 1 ? datasets[0].raw : `${datasets.length} MPNs`;
  const markupPct = ((markup || 0) * 100).toFixed(0);
  const bannerText = hasBp
    ? `External — Indicative Pricing · Prepared for ${customerName}`
    : `External-Safe — Indicative Pricing Scatter`;
  const titleHeader = hasBp ? 'Indicative Pricing' : 'Indicative Pricing';
  const customerLine = hasBp
    ? `<div class="customer-name">Prepared for ${escapeHtml(customerName)} (BP ${escapeHtml(String(customerBp))})</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Market Context — ${escapeHtml(titleLabel)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f5f6fa; color: #333; }
  .banner { background: #b71c1c; color: white; padding: 6px 30px; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-align: center; text-transform: uppercase; }
  .header { background: linear-gradient(135deg, #1a237e, #283593); color: white; padding: 22px 30px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header h1 .mpn-name { color: #fff176; }
  .header .subtitle { font-size: 13px; opacity: 0.9; margin-top: 4px; }
  .header .customer-name { font-size: 13px; opacity: 0.85; margin-top: 2px; font-style: italic; }
  .mpn-bar { padding: 14px 30px; background: #283593; border-bottom: 2px solid #1a237e; display: flex; align-items: center; gap: 12px; }
  .mpn-bar label { color: white; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; }
  .mpn-bar select { padding: 8px 14px; border: none; border-radius: 4px; font-size: 14px; font-weight: 600; min-width: 320px; cursor: pointer; }
  .stats-bar { display: flex; gap: 16px; padding: 18px 30px; background: white; border-bottom: 1px solid #e0e0e0; flex-wrap: wrap; }
  .stat-card { flex: 1; min-width: 160px; padding: 14px 18px; border-radius: 8px; background: #f8f9ff; border: 1px solid #e8eaf6; }
  .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-card .value { font-size: 22px; font-weight: 700; margin-top: 4px; color: #1565c0; }
  .stat-card .sub { font-size: 11px; color: #888; margin-top: 2px; }
  .stat-card.target .value { color: #2e7d32; }
  .chart-container { padding: 24px 30px; }
  canvas { background: white; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .footnote { padding: 16px 30px 30px; font-size: 11px; color: #777; line-height: 1.6; }
  .footnote b { color: #555; }
</style>
</head>
<body>

<div class="banner">${escapeHtml(bannerText)}</div>

<div class="header">
  <h1>${escapeHtml(titleHeader)} <span style="font-weight:300;opacity:0.85;">— </span><span class="mpn-name" id="activeMpnName">${escapeHtml(datasets[0].raw)}</span></h1>
  <div class="subtitle" id="subtitle">Loading…</div>
  ${customerLine}
</div>

${datasets.length > 1 ? `
<div class="mpn-bar">
  <label for="mpnSelect">MPN:</label>
  <select id="mpnSelect">
    ${datasets.map((d, i) => `<option value="${i}">${escapeHtml(d.raw)}</option>`).join('\n    ')}
  </select>
</div>
` : ''}

<div class="stats-bar" id="statsBar"></div>

<div class="chart-container">
  <canvas id="mainChart" height="500"></canvas>
</div>

<div class="footnote">
  <b>About this view:</b> each point on the line is the median indicative quote price for a two-week window, drawn from at least three underlying observations. Vendor identities, quantities, and other supplier-side details are not shown.${hasBp ? ' Your historical target line is overlaid for reference.' : ''}
  ${suppressed.length ? `<br><b>No data available:</b> ${suppressed.map(escapeHtml).join(', ')}.` : ''}
  <br>Date range: ${escapeHtml(dateMin)} → ${escapeHtml(dateMax)}. Generated ${escapeHtml(generatedAt)}.
</div>

<script>
const ALL_DATA = ${JSON.stringify(datasets)};
const HAS_BP   = ${JSON.stringify(!!hasBp)};
let activeIdx = 0;
let mainChart = null;

const fmt$ = v => v == null ? '—' : '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function escapeText(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function activeData() { return ALL_DATA[activeIdx]; }

function refreshStats() {
  const d = activeData();
  const s = d.stats;
  const mkCard = (cls, label, value, sub) => '<div class="stat-card ' + cls + '"><div class="label">' + label + '</div><div class="value">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  const cards = [
    mkCard('', 'Latest Indicative', fmt$(s.currentMedian), s.currentBucket ? 'bi-weekly bucket starting ' + s.currentBucket : ''),
    mkCard('', 'Window Median', fmt$(s.windowMedian), 'across ' + s.bucketCount + ' bi-weekly buckets'),
    mkCard('', 'Underlying Observations', s.observationCount, 'aggregated into the line'),
  ];
  if (HAS_BP) {
    cards.push(mkCard('target', 'Your Target History', s.targetCount, s.targetCount ? 'across your prior RFQs' : 'no prior RFQs found'));
  } else {
    cards.push(mkCard('', 'Bi-weekly Buckets', s.bucketCount, '≥ 3 obs each'));
  }
  document.getElementById('statsBar').innerHTML = cards.join('');
  document.getElementById('subtitle').textContent = d.canonicalMfr === '(no canonical MFR)'
    ? 'Bi-weekly indicative trend · MFR-agnostic'
    : 'Bi-weekly indicative trend · MFR: ' + escapeText(d.canonicalMfr);
  document.getElementById('activeMpnName').textContent = d.raw;
}

function updateChart() {
  const d = activeData();
  const canvas = document.getElementById('mainChart');
  // Defensive cleanup — use Chart.getChart() so we catch any chart attached
  // to the canvas, not just the one our local variable knows about. This
  // also avoids the v4 "Canvas is already in use" error when destroy()
  // ordering is off.
  const existing = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(canvas) : null;
  if (existing) { try { existing.destroy(); } catch (e) { /* ignore */ } }
  if (mainChart) { try { mainChart.destroy(); } catch (e) { /* ignore */ } }
  mainChart = null;
  const ctx = canvas.getContext('2d');

  // Single line: bi-weekly median of indicative-quote prices (each
  // underlying observation × markup, then bucketed and median-aggregated).
  // Point markers are hidden by default — the customer reads the trend
  // shape, not where individual buckets sit. Hover still surfaces the
  // value via pointHoverRadius. Customer-target overlay when anchored.
  const datasets = [
    {
      label: 'Indicative Trend',
      data: d.line,
      borderColor: 'rgba(26,35,126,1)',
      backgroundColor: 'rgba(68,114,196,0.12)',
      borderWidth: 2.5,
      pointRadius: 0,        // hide dots — don't highlight data density
      pointHoverRadius: 5,   // appear on hover so tooltip still works
      tension: 0.3, fill: false,
    },
  ];
  if (HAS_BP) {
    datasets.push({
      label: 'Your Targets',
      data: d.targets,
      borderColor: 'rgba(46,125,50,1)',
      backgroundColor: 'rgba(46,125,50,1)',
      borderDash: [6, 4], borderWidth: 2.5, pointRadius: 5, pointStyle: 'triangle',
      pointHoverRadius: 9, tension: 0.2, fill: false, spanGaps: true,
    });
  }

  try {
  mainChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        title: { display: true,
          text: d.raw + ' — Indicative Quote Trend',
          font: { size: 16, weight: 'bold' } },
        legend: {
          position: 'bottom', labels: { font: { size: 13 }, usePointStyle: true, padding: 20 },
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', titleFont: { size: 13 }, bodyFont: { size: 12 },
          padding: 12, cornerRadius: 6,
          callbacks: {
            title: items => items[0].raw.x,
            label: function(c) {
              if (c.dataset.label === 'Your Targets') return 'Your Target: ' + fmt$(c.raw.y);
              return 'Indicative Median: ' + fmt$(c.raw.y);
            },
          },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
             title: { display: true, text: 'Date', font: { size: 13 } }, grid: { color: '#f0f0f0' } },
        y: { title: { display: true, text: 'Unit Price ($)', font: { size: 13 } },
             ticks: { callback: v => '$' + v }, grid: { color: '#f0f0f0' }, beginAtZero: true },
      },
    },
  });
  } catch (err) {
    console.error('Chart render failed for MPN', d.raw, err);
    // Surface visibly without destroying the canvas (so a subsequent switch
    // can recover). Reset mainChart so the next destroy() is a no-op.
    mainChart = null;
    let banner = document.getElementById('chartErrorBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'chartErrorBanner';
      banner.style.cssText = 'margin:12px 30px;padding:12px;background:#ffebee;border:1px solid #c62828;color:#b71c1c;border-radius:6px;font-size:13px;';
      canvas.parentNode.insertBefore(banner, canvas);
    }
    banner.textContent = 'Chart render failed for ' + d.raw + ': ' + (err && err.message || String(err)) + ' (see browser console)';
  }
  // Clear any previous error banner if this render succeeded
  if (mainChart) {
    const banner = document.getElementById('chartErrorBanner');
    if (banner) banner.remove();
  }
}

function switchMpn(idx) {
  activeIdx = idx;
  refreshStats();
  updateChart();
}
const sel = document.getElementById('mpnSelect');
if (sel) sel.addEventListener('change', e => switchMpn(parseInt(e.target.value, 10)));

refreshStats();
updateChart();
</script>
</body>
</html>`;
}

// ── HTML (internal view) ─────────────────────────────────────────────────────
// INTERNAL_BEGIN — everything below this point is the existing internal-only
// rendering path. Skipped when --customer-view is set (the customer-view
// branch above handled file write + email).
if (!CUSTOMER_VIEW) {
const allDates = [];
for (const m of liveMpns) {
  const e = byMpn.get(m.clean);
  e.vq.forEach(d => allDates.push(d.date));
  e.mo.forEach(d => allDates.push(d.date));
  e.tgt.forEach(d => allDates.push(d.date));
}
allDates.sort();
const dateMin = FROM || (allDates[0] || '2024-01-01');
const dateMax = TO   || (allDates[allDates.length - 1] || new Date().toISOString().slice(0, 10));

// Compact dataset for embedding: keep only fields the chart/table use
const datasets = liveMpns.map(m => {
  const e = byMpn.get(m.clean);
  return {
    raw: m.raw, clean: m.clean,
    vq: e.vq, mo: e.mo, tgt: e.tgt,
  };
});

const titleParts = liveMpns.length === 1
  ? liveMpns[0].raw
  : `${liveMpns.length} MPNs`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(titleParts)} — Price Intelligence Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f5f6fa; color: #333; }
  .header { background: linear-gradient(135deg, #1a237e, #283593); color: white; padding: 20px 30px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header h1 .mpn-name { color: #fff176; }
  .header .subtitle { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  .mpn-bar { padding: 14px 30px; background: #283593; border-bottom: 2px solid #1a237e; display: flex; align-items: center; gap: 12px; }
  .mpn-bar label { color: white; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; }
  .mpn-bar select { padding: 8px 14px; border: none; border-radius: 4px; font-size: 14px; font-weight: 600; min-width: 320px; cursor: pointer; }
  .mpn-bar .summary { color: #c5cae9; font-size: 12px; margin-left: auto; }
  .stats-bar { display: flex; gap: 16px; padding: 16px 30px; background: white; border-bottom: 1px solid #e0e0e0; flex-wrap: wrap; }
  .stat-card { flex: 1; min-width: 140px; padding: 12px 16px; border-radius: 8px; background: #f8f9ff; border: 1px solid #e8eaf6; }
  .stat-card.mo { background: #fff8f0; border-color: #ffe0b2; }
  .stat-card.tgt { background: #e8f5e9; border-color: #a5d6a7; }
  .stat-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-card .value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .stat-card.vq .value { color: #1565c0; }
  .stat-card.mo .value { color: #e65100; }
  .stat-card.tgt .value { color: #2e7d32; }
  .controls { padding: 12px 30px; background: white; border-bottom: 1px solid #e0e0e0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .controls label { font-size: 13px; font-weight: 600; }
  .controls select, .controls input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
  .controls button { padding: 6px 14px; border: 1px solid #1565c0; background: #1565c0; color: white; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .controls button:hover { background: #0d47a1; }
  .controls button.secondary { background: white; color: #1565c0; }
  .controls button.secondary:hover { background: #e8eaf6; }
  .chart-container { padding: 20px 30px; }
  canvas { background: white; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .table-section { padding: 0 30px 30px; }
  .table-section h3 { font-size: 15px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  th { background: #1a237e; color: white; padding: 8px 10px; text-align: left; position: sticky; top: 0; }
  td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; }
  tr:hover td { background: #f5f5f5; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .tag-vq { background: #e3f2fd; color: #1565c0; }
  .tag-mo { background: #fff3e0; color: #e65100; }
  .tag-tgt { background: #e8f5e9; color: #2e7d32; }
  .zoom-hint { font-size: 12px; color: #999; padding: 4px 30px 0; }
  .customer-filter { max-width: 220px; }
  .footnote { padding: 0 30px 30px; font-size: 11px; color: #888; }
  .empty-state { padding: 40px 30px; text-align: center; color: #999; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <h1>Price Intelligence Dashboard <span style="font-weight:300;opacity:0.85;">— </span><span class="mpn-name" id="activeMpnName">${escapeHtml(liveMpns[0].raw)}</span></h1>
  <div class="subtitle" id="subtitle">Loading…</div>
</div>

${liveMpns.length > 1 ? `
<div class="mpn-bar">
  <label for="mpnSelect">MPN:</label>
  <select id="mpnSelect">
    ${liveMpns.map((m, i) => `<option value="${i}">${escapeHtml(m.raw)}</option>`).join('\n    ')}
  </select>
  <div class="summary" id="mpnGlobalSummary">${liveMpns.length} MPNs loaded · ${dateMin} → ${dateMax}</div>
</div>
` : ''}

<div class="stats-bar" id="statsBar"></div>

<div class="controls">
  <label>Chart Type:</label>
  <select id="chartType">
    <option value="scatter">Scatter</option>
    <option value="line" selected>Line (Bi-weekly Avg)</option>
  </select>
  <label>Customer:</label>
  <select id="customerFilter" class="customer-filter">
    <option value="">All Customers</option>
  </select>
  <label>Date From:</label>
  <input type="date" id="dateFrom" value="${dateMin}">
  <label>To:</label>
  <input type="date" id="dateTo" value="${dateMax}">
  <button onclick="updateChart()">Apply</button>
  <button class="secondary" onclick="resetZoom()">Reset Zoom</button>
</div>
<div class="zoom-hint">Scroll to zoom, click+drag to pan. Hover over points for details.</div>

<div class="chart-container">
  <canvas id="mainChart" height="500"></canvas>
</div>

<div class="table-section">
  <h3 id="tableTitle">Recent Data</h3>
  <div style="max-height:400px; overflow-y:auto;">
    <table id="dataTable">
      <thead><tr>
        <th>Type</th><th>Date</th><th>Vendor / Customer</th><th>Cost / Target</th><th>Qty</th><th>DC</th><th>Context</th>
      </tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
</div>

<div class="footnote">
  Match: ${LOOSE ? '<b>LOOSE</b> (chuboe_mpn_clean prefix)' : '<b>EXACT</b> on chuboe_mpn_clean'}.
  ${deadMpns.length ? `<b>${deadMpns.length} MPN(s) had no data and were dropped:</b> ${deadMpns.map(m => escapeHtml(m.raw)).join(', ')}.` : ''}
  Generated ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC.
</div>

<script>
const ALL_DATA  = ${JSON.stringify(datasets)};
const DATE_MIN  = ${JSON.stringify(dateMin)};
const DATE_MAX  = ${JSON.stringify(dateMax)};

let activeIdx = 0;
let mainChart = null;

const fmt$ = v => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const avg  = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

function activeData() { return ALL_DATA[activeIdx]; }

function uniqueCustomers(d) {
  const set = new Set();
  d.vq.forEach(x => x.customer && set.add(x.customer));
  d.tgt.forEach(x => x.customer && set.add(x.customer));
  return [...set].sort();
}

function refreshStats() {
  const d = activeData();
  const vqCosts = d.vq.map(x => x.cost);
  const moCosts = d.mo.map(x => x.cost);
  const tgtPrices = d.tgt.map(x => x.price);
  const customers = uniqueCustomers(d);

  const mkCard = (cls, label, value) => '<div class="stat-card ' + cls + '"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
  document.getElementById('statsBar').innerHTML = [
    mkCard('vq',  'VQ Quotes',         d.vq.length),
    mkCard('vq',  'VQ Avg',            fmt$(avg(vqCosts))),
    mkCard('vq',  'VQ Range',          vqCosts.length ? fmt$(Math.min(...vqCosts)) + ' – ' + fmt$(Math.max(...vqCosts)) : '—'),
    mkCard('mo',  'MO Offers',         d.mo.length),
    mkCard('mo',  'MO Avg',            fmt$(avg(moCosts))),
    mkCard('mo',  'MO Range',          moCosts.length ? fmt$(Math.min(...moCosts)) + ' – ' + fmt$(Math.max(...moCosts)) : '—'),
    mkCard('tgt', 'Customer Targets',  d.tgt.length),
    mkCard('tgt', 'Target Avg',        fmt$(avg(tgtPrices))),
    mkCard('',    'Unique Customers',  customers.length),
  ].join('');

  const sub = d.vq.length + ' VQs + ' + d.mo.length + ' MOs + ' + d.tgt.length + ' customer targets | ' + DATE_MIN + ' → ' + DATE_MAX;
  document.getElementById('subtitle').textContent = sub;
  document.getElementById('activeMpnName').textContent = d.raw;

  // Refill customer dropdown
  const sel = document.getElementById('customerFilter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All Customers</option>' + customers.map(c => '<option value="' + escapeAttr(c) + '">' + escapeText(c) + '</option>').join('');
  if (customers.includes(prev)) sel.value = prev;
}

function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s) { return String(s ?? '').replace(/"/g, '&quot;'); }

function getBiweek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const start = new Date('2024-01-01T00:00:00');
  const days = Math.floor((d - start) / 86400000);
  const period = Math.floor(days / 14);
  return new Date(start.getTime() + period * 14 * 86400000).toISOString().slice(0, 10);
}

function groupForLine(data, priceField) {
  const groups = {};
  data.forEach(d => {
    const v = d[priceField]; if (!v) return;
    const p = getBiweek(d.date);
    if (!groups[p]) groups[p] = [];
    groups[p].push(v);
  });
  return Object.entries(groups).sort(([a],[b]) => a.localeCompare(b)).map(([date, vals]) => ({
    x: date, y: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
    count: vals.length, low: Math.min(...vals), high: Math.max(...vals),
  }));
}

function filterByCustomer(raw, dateFrom, dateTo, customer) {
  return raw.filter(d => {
    if (d.date < dateFrom || d.date > dateTo) return false;
    if (customer && d.customer !== customer) return false;
    return true;
  });
}

function updateChart() {
  const d = activeData();
  const chartType = document.getElementById('chartType').value;
  const customer  = document.getElementById('customerFilter').value;
  const dateFrom  = document.getElementById('dateFrom').value;
  const dateTo    = document.getElementById('dateTo').value;

  const vqFiltered  = filterByCustomer(d.vq, dateFrom, dateTo, customer);
  const tgtFiltered = filterByCustomer(d.tgt, dateFrom, dateTo, customer);
  const moFiltered  = d.mo.filter(x => x.date >= dateFrom && x.date <= dateTo);

  if (mainChart) mainChart.destroy();
  const ctx = document.getElementById('mainChart').getContext('2d');

  let datasets;
  if (chartType === 'scatter') {
    datasets = [
      { label: 'VQ Quotes',
        data: vqFiltered.map(x => ({ x: x.date, y: x.cost, vendor: x.vendor, qty: x.qty, dc: x.dc, rfq: x.rfq, customer: x.customer, mfr: x.mfr })),
        backgroundColor: 'rgba(68,114,196,0.65)', borderColor: 'rgba(68,114,196,1)',
        pointRadius: 5, pointHoverRadius: 8, pointStyle: 'circle', showLine: false },
      { label: 'Market Offers',
        data: moFiltered.map(x => ({ x: x.date, y: x.cost, vendor: x.vendor, qty: x.qty, dc: x.dc, offerType: x.offerType, mfr: x.mfr })),
        backgroundColor: 'rgba(237,125,49,0.55)', borderColor: 'rgba(237,125,49,1)',
        pointRadius: 4, pointHoverRadius: 7, pointStyle: 'rectRot', showLine: false },
      { label: 'Customer Targets',
        data: tgtFiltered.map(x => ({ x: x.date, y: x.price, customer: x.customer, qty: x.qty, rfq: x.rfq })),
        backgroundColor: 'rgba(46,125,50,0.6)', borderColor: 'rgba(46,125,50,1)',
        pointRadius: 6, pointHoverRadius: 9, pointStyle: 'triangle', showLine: false },
    ];
  } else {
    datasets = [
      { label: 'VQ Avg',
        data: groupForLine(vqFiltered, 'cost'),
        borderColor: 'rgba(68,114,196,1)', backgroundColor: 'rgba(68,114,196,0.1)',
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 8, tension: 0.2, fill: false, spanGaps: true },
      { label: 'MO Avg',
        data: groupForLine(moFiltered, 'cost'),
        borderColor: 'rgba(237,125,49,1)', backgroundColor: 'rgba(237,125,49,0.1)',
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 8, tension: 0.2, fill: false, spanGaps: true },
      { label: 'Customer Target Avg',
        data: groupForLine(tgtFiltered, 'price'),
        borderColor: 'rgba(46,125,50,1)', backgroundColor: 'rgba(46,125,50,0.1)',
        borderWidth: 2.5, borderDash: [6, 4], pointRadius: 5, pointStyle: 'triangle',
        pointHoverRadius: 9, tension: 0.2, fill: false, spanGaps: true },
    ];
  }

  mainChart = new Chart(ctx, {
    type: chartType === 'scatter' ? 'scatter' : 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        title: { display: true,
          text: d.raw + ' — ' + (chartType === 'scatter' ? 'All Data Points' : 'Bi-weekly Average') + (customer ? ' [' + customer + ']' : ''),
          font: { size: 16, weight: 'bold' } },
        legend: { position: 'bottom', labels: { font: { size: 13 }, usePointStyle: true, padding: 20 } },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)', titleFont: { size: 13 }, bodyFont: { size: 12 },
          padding: 12, cornerRadius: 6,
          callbacks: {
            title: items => items[0].dataset.label + ' — ' + items[0].raw.x,
            label: function(ctx) {
              const d = ctx.raw;
              const lines = ['Price: $' + d.y.toFixed(2)];
              if (d.vendor)    lines.push('Vendor: ' + d.vendor);
              if (d.qty)       lines.push('Qty: ' + d.qty.toLocaleString());
              if (d.dc)        lines.push('DC: ' + d.dc);
              if (d.mfr)       lines.push('MFR: ' + d.mfr);
              if (d.customer)  lines.push('Customer: ' + d.customer);
              if (d.rfq)       lines.push('RFQ: ' + d.rfq);
              if (d.offerType) lines.push('Type: ' + d.offerType);
              if (d.count)     lines.push('Points: ' + d.count + ' | Low: $' + d.low.toFixed(2) + ' | High: $' + d.high.toFixed(2));
              return lines;
            }
          }
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy' },
          pan:  { enabled: true, mode: 'xy' },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
             title: { display: true, text: 'Date', font: { size: 13 } }, grid: { color: '#f0f0f0' } },
        y: { title: { display: true, text: 'Unit Price ($)', font: { size: 13 } },
             ticks: { callback: v => '$' + v }, grid: { color: '#f0f0f0' }, beginAtZero: true },
      },
    },
  });

  // Recent table — interleaved
  const recent = [
    ...vqFiltered.map(x => ({ ...x, _kind: 'VQ',  _price: x.cost })),
    ...moFiltered.map(x => ({ ...x, _kind: 'MO',  _price: x.cost })),
    ...tgtFiltered.map(x => ({ ...x, _kind: 'TGT', _price: x.price })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);

  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = recent.map(d => {
    const tag = d._kind === 'VQ'  ? '<span class="tag tag-vq">VQ</span>'
              : d._kind === 'MO'  ? '<span class="tag tag-mo">MO</span>'
              :                     '<span class="tag tag-tgt">TGT</span>';
    const counterparty = d._kind === 'TGT' ? d.customer : d.vendor;
    const ctxCol = d._kind === 'VQ'  ? (d.customer ? d.customer + (d.rfq ? ' (RFQ ' + d.rfq + ')' : '') : '—')
                  : d._kind === 'MO'  ? (d.offerType || '—')
                  :                     (d.rfq ? 'RFQ ' + d.rfq : '—');
    return '<tr><td>' + tag + '</td><td>' + d.date + '</td><td>' + escapeText(counterparty || '—') + '</td><td>$' + d._price.toFixed(2) + '</td><td>' + (d.qty ? d.qty.toLocaleString() : '—') + '</td><td>' + escapeText(d.dc || '—') + '</td><td>' + escapeText(ctxCol) + '</td></tr>';
  }).join('');

  document.getElementById('tableTitle').textContent = 'Recent Data (' + recent.length + ' of ' + (vqFiltered.length + moFiltered.length + tgtFiltered.length) + ' total)';
}

function resetZoom() { if (mainChart) mainChart.resetZoom(); }

function switchMpn(idx) {
  activeIdx = idx;
  // Reset filters when switching MPN
  document.getElementById('customerFilter').value = '';
  refreshStats();
  updateChart();
}

const sel = document.getElementById('mpnSelect');
if (sel) sel.addEventListener('change', e => switchMpn(parseInt(e.target.value, 10)));

// Initial
refreshStats();
updateChart();
</script>
</body>
</html>`;

// ── Write file ───────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outName = OUT_OVERRIDE || (liveMpns.length === 1
  ? `${liveMpns[0].raw.replace(/[^A-Za-z0-9-]+/g, '_')}_${today}.html`
  : `multi_${liveMpns.length}_MPNs_${today}.html`);
const outPath = path.isAbsolute(outName) ? outName : path.join(OUT_DIR, outName);
fs.writeFileSync(outPath, html);

console.log(`\nDashboard written: ${outPath}`);
console.log(`File size: ${(html.length / 1024).toFixed(1)} KB`);
console.log(`MPNs in dropdown: ${liveMpns.length}${deadMpns.length ? ` (${deadMpns.length} dropped — no data)` : ''}`);

// ── Optional email ───────────────────────────────────────────────────────────
if (EMAIL) {
  const { createNotifier } = require(path.join(ROOT, 'shared', 'notifier'));
  const notifier = createNotifier({
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Price Intelligence',
  });

  const subject = `Price Intelligence Dashboard — ${liveMpns.length === 1 ? liveMpns[0].raw : liveMpns.length + ' MPNs'} (${today})`;
  const summaryRows = liveMpns.map(m => {
    const e = byMpn.get(m.clean);
    return `<tr><td>${escapeHtml(m.raw)}</td><td style="text-align:right">${e.vq.length}</td><td style="text-align:right">${e.mo.length}</td><td style="text-align:right">${e.tgt.length}</td></tr>`;
  }).join('');
  const body = `<p>Price intelligence dashboard for ${liveMpns.length === 1 ? '<b>' + escapeHtml(liveMpns[0].raw) + '</b>' : '<b>' + liveMpns.length + ' MPNs</b>'}:</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Segoe UI,sans-serif;font-size:13px">
      <thead style="background:#1a237e;color:white"><tr><th>MPN</th><th>VQ</th><th>MO</th><th>Targets</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    ${deadMpns.length ? `<p style="color:#999;font-size:12px;margin-top:12px">No data found for: ${deadMpns.map(m => escapeHtml(m.raw)).join(', ')}</p>` : ''}
    <p style="margin-top:16px">Open the attached HTML in a browser. ${liveMpns.length > 1 ? 'Use the MPN dropdown at the top to switch between parts.' : ''}</p>`;

  notifier.sendWithAttachment(
    TO_EMAIL, subject, body,
    [{ filename: path.basename(outPath), path: outPath }]
  ).then(ok => {
    console.log(ok ? `Emailed to ${TO_EMAIL}` : 'Email send failed');
    if (!ok) process.exitCode = 4;
  }).catch(err => { console.error('Email failed:', err.message); process.exitCode = 4; });
}
} // INTERNAL_END — close the !CUSTOMER_VIEW guard

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
