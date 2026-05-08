/**
 * Pull AVL alternates for the 51 remaining lines on RFQ 1132040, run franchise
 * API on each MPN, and output two xlsx files:
 *
 *   File A: EPG_AVL_Alternates_Analysis_<date>.xlsx
 *     Multi-MPN CPCs only (26 lines). For each CPC, shows primary + each
 *     alternate side by side with best vendor / stock / cost / margin.
 *
 *   File B: EPG_SoleSourced_BestOption_<date>.xlsx
 *     Sole-sourced CPCs only (25 lines). Single MPN per row, best franchise
 *     vendor + price + margin + stock status.
 *
 * Both files emailed to Jake.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { searchAllDistributors, extractStockAndLtRows } = require('../../shared/franchise-api');
const { createNotifier } = require('../../shared/notifier');

const AVL_ANALYSIS = '/home/analytics_user/workspace/.tmp-attach/avl-analysis.json';
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT_ALTERNATES = path.join(__dirname, `EPG_AVL_Alternates_Analysis_${TODAY}.xlsx`);
const OUT_SOLE = path.join(__dirname, `EPG_SoleSourced_BestOption_${TODAY}.xlsx`);

const { multi, single } = JSON.parse(fs.readFileSync(AVL_ANALYSIS, 'utf8'));

console.log(`[avl-sweep] ${multi.length} multi-MPN CPCs, ${single.length} sole-sourced`);

// ── Query helper: best stock row + best LT row across all distributors ───
async function queryMpn(mpn, need, mfr) {
  let result;
  try {
    // mfr → enables MFR-veto in shared/mpn-match (rejects MISMATCH candidates
    // after resolving aliases + acquisitions). Opt-in; null/undefined = MPN-only match.
    result = await searchAllDistributors(mpn, need || 1, { includeNoResults: true, mfr });
  } catch (e) {
    return { error: e.message.slice(0, 150), quotes: [] };
  }
  const quotes = [];
  for (const d of (result.distributors || [])) {
    if (!d.found) continue;
    const rows = extractStockAndLtRows(d, mpn, need || 1) || [];
    for (const row of rows) {
      const cost = Number(row.cost);
      if (!cost || cost <= 0) continue;
      quotes.push({
        vendor: d.name,
        cost,
        qty: Number(row.qty || 0),
        isStock: !row.leadTime,
        leadTime: row.leadTime || '',
        moq: Number(row.moq || 0),
        hts: d.vqHts || null,
        eccn: d.vqEccn || null,
      });
    }
  }
  return { quotes };
}

function pickBestQuote(quotes, need) {
  // Stock first, then by cost. MOQ-violators only if no clean alt.
  const clean = quotes.filter(q => !(q.moq && q.moq > need && !q.isStock));
  const useQuotes = clean.length > 0 ? clean : quotes;
  const sorted = [...useQuotes].sort((a, b) => {
    if (a.isStock !== b.isStock) return a.isStock ? -1 : 1;
    return a.cost - b.cost;
  });
  return sorted[0] || null;
}

// Cache of MPN → quotes (avoid duplicate queries)
const mpnCache = new Map();
async function cachedQuery(mpn, need, mfr) {
  // Cache key includes mfr so an MFR-scoped query (with veto) doesn't serve
  // a prior MFR-blind result from the same key. Typical usage: one MFR per
  // MPN, so cache behavior is unchanged.
  const key = `${mpn.toUpperCase()}|${(mfr || '').toUpperCase()}`;
  if (mpnCache.has(key)) return mpnCache.get(key);
  const r = await queryMpn(mpn, need, mfr);
  mpnCache.set(key, r);
  return r;
}

// ── Sole-sourced sweep (25 lines, 1 MPN each) ─────────────────────────────
async function buildSoleSourced() {
  console.log(`\n[sole] Querying ${single.length} sole-sourced MPNs`);
  const rows = [];
  for (let i = 0; i < single.length; i++) {
    const r = single[i];
    const avlMpn = r.avlMpns[0];
    process.stdout.write(`  [${i+1}/${single.length}] ${avlMpn.mpn.padEnd(28)} need=${r.need} ... `);
    const { quotes, error } = await cachedQuery(avlMpn.mpn, r.need, avlMpn.mfr);
    if (error) { console.log('ERR ' + error); rows.push({ ...r, avlMpn, error }); continue; }
    const best = pickBestQuote(quotes, r.need);
    if (!best) { console.log('NO HITS'); rows.push({ ...r, avlMpn, noHits: true }); continue; }
    const margin = r.resale > 0 ? (r.resale - best.cost) / r.resale : 0;
    const gp = (r.resale - best.cost) * r.need;
    console.log(`✓ ${best.vendor} $${best.cost.toFixed(4)} ${best.isStock?'STOCK':'LT'}`);
    rows.push({ ...r, avlMpn, best, margin, gp, allQuotes: quotes });
  }
  return rows;
}

// ── Multi-MPN sweep (26 CPCs, ~2-6 MPNs each) ─────────────────────────────
async function buildMultiAlternates() {
  console.log(`\n[multi] Querying alternates for ${multi.length} multi-MPN CPCs`);
  const cpcRows = [];
  for (let i = 0; i < multi.length; i++) {
    const r = multi[i];
    process.stdout.write(`  [${i+1}/${multi.length}] line ${r.line} CPC ${r.cpc} (${r.avlMpns.length} MPNs)\n`);
    const mpnResults = [];
    for (const m of r.avlMpns) {
      process.stdout.write(`    ${m.mpn.padEnd(28)}${m.preferred?' ★':''} ... `);
      const { quotes, error } = await cachedQuery(m.mpn, r.need, m.mfr);
      if (error) { console.log('ERR'); mpnResults.push({ ...m, error }); continue; }
      const best = pickBestQuote(quotes, r.need);
      if (!best) { console.log('NO HITS'); mpnResults.push({ ...m, noHits: true }); continue; }
      const margin = r.resale > 0 ? (r.resale - best.cost) / r.resale : 0;
      const gp = (r.resale - best.cost) * r.need;
      console.log(`✓ ${best.vendor} $${best.cost.toFixed(4)} ${best.isStock?'STOCK':'LT'} margin=${(margin*100).toFixed(1)}%`);
      mpnResults.push({ ...m, best, margin, gp });
    }
    // Pick the WINNING alternate (highest GP or first available if all tied)
    const viable = mpnResults.filter(m => m.best);
    viable.sort((a, b) => (b.gp || 0) - (a.gp || 0));
    const winner = viable[0] || null;
    cpcRows.push({ ...r, mpnResults, winner });
  }
  return cpcRows;
}

(async () => {
  const soleRows = await buildSoleSourced();
  const multiRows = await buildMultiAlternates();

  // ── Build File A: Multi-MPN Alternates Analysis ────────────────────────
  console.log(`\n[xlsx] Writing ${OUT_ALTERNATES}`);
  const wbA = XLSX.utils.book_new();
  const headerA = [
    'RFQ Line', 'CPC', 'Need Qty', 'LAM Target', 'Resale',
    'AVL MPN', 'MFR', 'Preferred?', 'Best Vendor', 'Best Cost', 'Stock?', 'Avail Qty', 'MOQ',
    'Margin %', 'Line GP', 'WINNER?',
  ];
  const dataA = [headerA];
  for (const r of multiRows.sort((a, b) => a.line - b.line)) {
    for (const m of r.mpnResults) {
      const isWinner = r.winner && r.winner.mpn === m.mpn ? '★ WINNER' : '';
      if (m.error) {
        dataA.push([r.line, r.cpc, r.need, r.target, r.resale, m.mpn, m.mfr, m.preferred?'YES':'', 'ERR: '+m.error.slice(0,40), '', '', '', '', '', '', isWinner]);
      } else if (m.noHits) {
        dataA.push([r.line, r.cpc, r.need, r.target, r.resale, m.mpn, m.mfr, m.preferred?'YES':'', '(no franchise hits)', '', '', '', '', '', '', isWinner]);
      } else {
        dataA.push([r.line, r.cpc, r.need, r.target, r.resale, m.mpn, m.mfr, m.preferred?'YES':'', m.best.vendor, m.best.cost, m.best.isStock?'STOCK':'LT', m.best.qty, m.best.moq||'', m.margin, m.gp, isWinner]);
      }
    }
    // Blank row between CPCs for readability
    dataA.push([]);
  }
  const wsA = XLSX.utils.aoa_to_sheet(dataA);
  wsA['!cols'] = [{wch:8},{wch:18},{wch:9},{wch:11},{wch:11},{wch:30},{wch:24},{wch:10},{wch:18},{wch:11},{wch:8},{wch:11},{wch:8},{wch:9},{wch:11},{wch:14}];
  // Format columns: LAM Target (3), Resale (4), Best Cost (9), Margin (13), GP (14)
  for (let r = 1; r < dataA.length; r++) {
    const fmt = (c, z) => { const cell = wsA[XLSX.utils.encode_cell({r, c})]; if (cell && cell.t === 'n') cell.z = z; };
    fmt(3, '$#,##0.0000');
    fmt(4, '$#,##0.0000');
    fmt(9, '$#,##0.0000');
    fmt(13, '0.0%');
    fmt(14, '$#,##0.00');
  }
  XLSX.utils.book_append_sheet(wbA, wsA, 'Alternates Analysis');
  XLSX.writeFile(wbA, OUT_ALTERNATES);

  // ── Build File B: Sole-Sourced Best Option ─────────────────────────────
  console.log(`[xlsx] Writing ${OUT_SOLE}`);
  const wbB = XLSX.utils.book_new();
  const headerB = [
    'RFQ Line', 'CPC', 'AVL MPN', 'MFR', 'Need Qty', 'LAM Target', 'Resale',
    'Best Vendor', 'Best Cost', 'Stock?', 'Avail Qty', 'MOQ', 'Lead Time',
    'Margin %', 'Line GP', 'HTS', 'ECCN', 'Status',
  ];
  const dataB = [headerB];
  let solePosCount = 0, soleNegCount = 0, soleNoHits = 0;
  for (const r of soleRows.sort((a, b) => a.line - b.line)) {
    if (r.error) {
      dataB.push([r.line, r.cpc, r.avlMpn.mpn, r.avlMpn.mfr, r.need, r.target, r.resale, '', '', '', '', '', '', '', '', '', '', 'API ERROR']);
      soleNoHits++;
    } else if (r.noHits) {
      dataB.push([r.line, r.cpc, r.avlMpn.mpn, r.avlMpn.mfr, r.need, r.target, r.resale, '', '', '', '', '', '', '', '', '', '', 'NO FRANCHISE HITS']);
      soleNoHits++;
    } else {
      const status = r.gp >= 0 ? 'OK' : 'NEGATIVE MARGIN';
      if (r.gp >= 0) solePosCount++; else soleNegCount++;
      dataB.push([r.line, r.cpc, r.avlMpn.mpn, r.avlMpn.mfr, r.need, r.target, r.resale, r.best.vendor, r.best.cost, r.best.isStock?'STOCK':'LT', r.best.qty, r.best.moq||'', r.best.leadTime||'', r.margin, r.gp, r.best.hts||'', r.best.eccn||'', status]);
    }
  }
  const wsB = XLSX.utils.aoa_to_sheet(dataB);
  wsB['!cols'] = [{wch:8},{wch:18},{wch:30},{wch:24},{wch:9},{wch:11},{wch:11},{wch:18},{wch:11},{wch:8},{wch:11},{wch:8},{wch:13},{wch:9},{wch:11},{wch:14},{wch:11},{wch:18}];
  for (let r = 1; r < dataB.length; r++) {
    const fmt = (c, z) => { const cell = wsB[XLSX.utils.encode_cell({r, c})]; if (cell && cell.t === 'n') cell.z = z; };
    fmt(5, '$#,##0.0000');
    fmt(6, '$#,##0.0000');
    fmt(8, '$#,##0.0000');
    fmt(13, '0.0%');
    fmt(14, '$#,##0.00');
  }
  XLSX.utils.book_append_sheet(wbB, wsB, 'Sole-Sourced Best Option');
  XLSX.writeFile(wbB, OUT_SOLE);

  // ── Email both ──────────────────────────────────────────────────────────
  console.log(`\n[email] Sending both files`);
  const notifier = createNotifier({
    fromEmail: 'vortex@orangetsunami.com',
    fromName: 'Analytics Terminal',
    smtpPass: process.env.WORKMAIL_PASS,
  });
  const body = `Hi Jake,

Two reports from the LAM EPG AVL analysis on the 51 remaining lines of RFQ 1132040.

INPUT
  AVL: rfqloading@orangetsunami.com inbox, "LAM EPG AVL" email (3,268 rows / 1,626 unique CPCs)
  Remaining lines: 51 (after dropping 26 CPCs touched today)
  Split: 26 multi-MPN CPCs + 25 sole-sourced CPCs (every remaining CPC has a match in the AVL)

FILE A — Alternates Analysis (multi-MPN CPCs only)
  ${multiRows.length} CPCs with multiple approved MPNs. Each row shows:
    - The MPN (with ★ on the LAM-preferred one)
    - Best franchise vendor + cost + stock status + MOQ
    - Margin and line GP at LAM resale
    - "★ WINNER" flag on the alternate that gives the best GP per CPC

  Use this to spot lines where switching to an alternate gets better stock or pricing than the primary.

FILE B — Sole-Sourced Best Option
  ${soleRows.length} CPCs with only one approved MPN. Each row shows:
    - The single approved MPN
    - Best franchise vendor + cost + stock + lead time
    - Margin / GP / HTS / ECCN
    - Status: OK / NEGATIVE MARGIN / NO FRANCHISE HITS

  Sole-sourced summary:
    OK (positive margin):    ${solePosCount}
    NEGATIVE MARGIN:         ${soleNegCount}
    NO FRANCHISE HITS:       ${soleNoHits}

  The "no franchise hits" lines are the ones that need a broker channel — there's no AVL substitute available.

— Claude via Jake's analytics terminal
`;
  await notifier.sendWithAttachment(
    'jake.harris@Astutegroup.com',
    `LAM EPG RFQ 1132040 — AVL Alternates + Sole-Sourced (Apr 9)`,
    body,
    [
      { filename: path.basename(OUT_ALTERNATES), content: fs.readFileSync(OUT_ALTERNATES) },
      { filename: path.basename(OUT_SOLE), content: fs.readFileSync(OUT_SOLE) },
    ],
  );
  console.log('✓ sent');
})().catch(e => { console.error(e); process.exit(1); });
