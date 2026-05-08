/**
 * Live API sweep on the 58 SIPOC-remaining lines for RFQ 1132040.
 *
 * Source: Lam_EPG_SIPOC.xlsx (Source col blank or "(pending)") minus the 17
 * CPCs we already touched today via Fuses + Tracy + Zynq hold.
 *
 * Output: EPG_Remaining_ByVendor_<date>.xlsx with one tab per distributor,
 * a Summary tab, and a "No Source" tab for MPNs with zero franchise hits.
 *
 * Format mirrors EPG_LiveAPI_ByVendor_20260402.xlsx:
 *   Line, CPC, MPN, MFR, Need Qty, Resale, Cost, Avail Qty, Full Qty?,
 *   Margin %, Line GP, API Hits, LT Alt Vendor, LT Alt Cost, LT Lead Time, LT Margin %
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { execFileSync } = require('child_process');

const { searchAllDistributors, extractStockAndLtRows } = require('../../shared/franchise-api');

const RFQ_VALUE = '1132040';
const REMAINING_FILE = path.join(__dirname, 'remaining-58.json');
const OUT_FILE = path.join(__dirname, `EPG_Remaining_BestOnly_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`);

// CPCs already loaded today as IsPurchased=Y (Fuses + Tracy + Amatom + DigiKey).
// These still appear on the report under their best vendor's tab, but are
// flagged so the buyer doesn't pick them again.
const ALREADY_LOADED = new Set([
  // Fuses
  '670-346211-025','670-332664-018','670-006780-038','670-338640-050',
  // Tracy/HK (incl Zynq held)
  '630-337692-003','631-123367-001','630-047972-001','630-052043-001',
  '630-048308-001','630-337161-001','630-B70151-001','630-311294-001',
  '630-198438-001','630-017794-002','630-900073-001','630-099973-001',
  '630-341691-001','630-343681-001','630-204173-001',
  // Amatom
  '723-097621-068','723-097621-043',
  // DigiKey
  '630-114967-001','668-A01540-026','668-277308-002','668-A51618-026',
]);

async function getRfqQty(cpcs) {
  // Use psql directly (peer auth via Unix socket — Pool's TCP path needs a password)
  const cpcList = cpcs.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const sql = `SELECT rl.line, rl.chuboe_cpc, lm.qty
       FROM adempiere.chuboe_rfq r
       JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id=r.chuboe_rfq_id
       JOIN adempiere.chuboe_rfq_line_mpn lm ON lm.chuboe_rfq_line_id=rl.chuboe_rfq_line_id
      WHERE r.value='${RFQ_VALUE}' AND rl.isactive='Y' AND lm.isactive='Y'
        AND rl.chuboe_cpc IN (${cpcList});`;
  const out = execFileSync('psql', ['-A', '-F|', '-t', '-c', sql], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.trim().split('\n')) {
    if (!line.trim()) continue;
    const [lineNo, cpc, qty] = line.split('|');
    map.set(cpc, { line: Number(lineNo), qty: Number(qty) });
  }
  return map;
}

(async () => {
  const lines = JSON.parse(fs.readFileSync(REMAINING_FILE, 'utf8'));
  console.log(`[sweep] ${lines.length} lines to query`);

  // Pull qty from DB
  const qtyMap = await getRfqQty(lines.map(l => l.cpc));
  console.log(`[sweep] Got qty for ${qtyMap.size}/${lines.length} CPCs from RFQ ${RFQ_VALUE}`);

  // Bucket: per-MPN quote map (we'll resolve best-vendor-per-line at the end)
  // No-source bucket: lines with 0 API hits
  const byMpn = new Map();
  const noSource = [];

  let idx = 0;
  for (const ln of lines) {
    idx++;
    const meta = qtyMap.get(ln.cpc);
    const need = meta?.qty || 0;
    const lineNo = meta?.line || '';
    process.stdout.write(`[${String(idx).padStart(2)}/${lines.length}] ${ln.mpn.padEnd(28)} need=${need} ... `);

    let result;
    try {
      // CORRECTED 2026-04-09: signature is (mpn, qty, options) — qty is positional, not in options.
      // Prior call passed an object as qty → distributor modules fell back to qty=1 pricing on every line.
      // Pass mfr for MFR-veto — shared/mpn-match rejects candidates whose MFR is MISMATCH
      // per shared/mfr-equivalence (handles aliases + acquisitions). Catches wrong-match
      // hits like Newark returning "COMPUTER COMPONENTS,INC" for a Yageo MPN.
      result = await searchAllDistributors(ln.mpn, need || 1, { includeNoResults: true, mfr: ln.mfr });
    } catch (e) {
      console.log(`ERR ${e.message.slice(0,80)}`);
      noSource.push({ line: lineNo, cpc: ln.cpc, mpn: ln.mpn, mfr: ln.mfr, need, target: ln.target, resale: ln.resale, reason: 'API_ERROR' });
      continue;
    }

    const dists = (result.distributors || []).filter(d => d.found);
    const apiHits = dists.length;

    if (apiHits === 0) {
      console.log('NO HITS');
      noSource.push({ line: lineNo, cpc: ln.cpc, mpn: ln.mpn, mfr: ln.mfr, need, target: ln.target, resale: ln.resale, reason: 'NO_HITS' });
      continue;
    }

    // Use the centralized extractor instead of rolling our own field access.
    // Stash all per-MPN quotes for best-vendor-per-line resolution after loop.
    let placed = 0;
    if (!byMpn.has(ln.mpn)) {
      byMpn.set(ln.mpn, { line: lineNo, cpc: ln.cpc, mpn: ln.mpn, mfr: ln.mfr, need, resale: ln.resale, target: ln.target, quotes: [] });
    }
    for (const d of dists) {
      const name = d.name || 'Unknown';
      const rows = extractStockAndLtRows(d, ln.mpn, need || 1) || [];
      for (const row of rows) {
        const unitCost = Number(row.cost);
        if (!unitCost || unitCost <= 0) continue;
        const isStock = !row.leadTime;
        const availQty = isStock ? Number(row.qty || 0) : 0;
        const leadTime = isStock ? '' : String(row.leadTime || '');
        const moq = Number(row.moq || 0);

        // Effective buy qty:
        //   Stock rows: min(need, availQty)  — partial if stock can't cover full need
        //   LT rows:    max(need, moq)       — bumped to MOQ if vendor MOQ exceeds need
        let effBuyQty;
        let moqViolation = false;
        if (isStock) {
          effBuyQty = Math.min(need, availQty);
        } else {
          effBuyQty = need;
          if (moq && moq > need) {
            effBuyQty = moq;
            moqViolation = true;
          }
        }

        // Margin/GP based on what we'd actually pay vs what LAM pays us:
        //   Revenue = ln.resale × need (LAM pays for need only, not the MOQ overhang)
        //   Cost    = unitCost × effBuyQty (we commit to buy qty)
        const revenue = ln.resale * need;
        const totalCost = unitCost * effBuyQty;
        const gp = revenue - totalCost;
        const margin = revenue > 0 ? gp / revenue : 0;

        const fullQty = isStock
          ? (availQty >= need ? 'YES' : (availQty > 0 ? 'PARTIAL' : 'NO'))
          : (moqViolation ? `MOQ ${moq}` : 'LT');

        byMpn.get(ln.mpn).quotes.push({
          vendor: name,
          unitCost,
          effBuyQty,
          totalCost,
          availQty,
          isStock,
          leadTime,
          moq,
          moqViolation,
          fullQty,
          margin,
          gp,
        });
        placed++;
      }
    }
    console.log(`${apiHits} hits, ${placed} placed`);
  }

  console.log(`\n[sweep] Lines with quotes: ${byMpn.size}`);
  console.log(`[sweep] No-source lines: ${noSource.length}`);

  // ── Build xlsx ─────────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // ── Resolve best vendor per MPN ───────────────────────────────────────────
  // Picking rule:
  //   1. Exclude MOQ-violation quotes unless they're the only option.
  //   2. Stock preferred over LT when costs are tied.
  //   3. Within stock or LT bucket: lowest unit cost wins.
  // CPCs already loaded today are DROPPED entirely — not shown anywhere on
  // the report — so the buyer never has to mentally filter them out.
  const winnerByVendor = new Map();
  for (const [mpn, data] of byMpn) {
    if (data.quotes.length === 0) continue;
    if (ALREADY_LOADED.has(data.cpc)) continue; // hard-drop, no clutter
    // Stock first, then LT-without-MOQ-violation, then everything else
    const cleanQuotes = data.quotes.filter(q => !q.moqViolation);
    const useQuotes = cleanQuotes.length > 0 ? cleanQuotes : data.quotes;
    const sorted = [...useQuotes].sort((a, b) => {
      if (a.isStock !== b.isStock) return a.isStock ? -1 : 1;
      return a.unitCost - b.unitCost;
    });
    const best = sorted[0];
    const runnerUp = sorted[1] || null;
    const alreadyLoaded = ALREADY_LOADED.has(data.cpc);
    const winnerRow = {
      line: data.line, cpc: data.cpc, mpn, mfr: data.mfr, need: data.need, resale: data.resale,
      vendor: best.vendor,
      unitCost: best.unitCost,
      effBuyQty: best.effBuyQty,
      totalCost: best.totalCost,
      availQty: best.availQty,
      isStock: best.isStock,
      leadTime: best.leadTime,
      moq: best.moq,
      moqViolation: best.moqViolation,
      fullQty: best.fullQty,
      margin: best.margin,
      gp: best.gp,
      altVendor: runnerUp ? runnerUp.vendor : '',
      altCost: runnerUp ? runnerUp.unitCost : '',
      altDelta: runnerUp ? (runnerUp.unitCost - best.unitCost) : '',
      quoteCount: data.quotes.length,
      alreadyLoaded,
    };
    if (!winnerByVendor.has(best.vendor)) winnerByVendor.set(best.vendor, []);
    winnerByVendor.get(best.vendor).push(winnerRow);
  }

  // Summary
  const summaryRows = [
    [`LAM EPG RFQ ${RFQ_VALUE} — Remaining-Lines Sourcing Report (BEST VENDOR PER LINE)`],
    ['Generated', new Date().toISOString().slice(0,10)],
    ['Source', 'SIPOC remaining (Source blank/pending) minus CPCs touched today; each line on exactly ONE tab'],
    ['Picking rule', 'cheapest with stock preferred; MOQ-violation quotes excluded unless only option'],
    ['Lines surveyed', lines.length],
    [''],
    ['Vendor', 'Lines', 'Total Cost (effBuy×cost)', 'Total Resale (need×resale)', 'Gross Profit', 'Avg Margin %'],
  ];
  let totLines = 0, totCost = 0, totResale = 0, totGp = 0;
  const sortedVendors = [...winnerByVendor.entries()].sort((a,b) => b[1].length - a[1].length);
  for (const [name, rows] of sortedVendors) {
    const lns = rows.length;
    const cost = rows.reduce((s, r) => s + r.totalCost, 0);
    const res = rows.reduce((s, r) => s + r.resale * r.need, 0);
    const gp = res - cost;
    const m = res > 0 ? gp / res : 0;
    summaryRows.push([name, lns, cost, res, gp, m]);
    totLines += lns; totCost += cost; totResale += res; totGp += gp;
  }
  summaryRows.push([]);
  summaryRows.push(['TOTAL', totLines, totCost, totResale, totGp, totResale > 0 ? totGp / totResale : 0]);
  summaryRows.push([]);
  summaryRows.push(['No-Source Lines', noSource.length]);

  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs['!cols'] = [{wch:18},{wch:8},{wch:22},{wch:22},{wch:14},{wch:14}];
  for (let r = 7; r < 7 + sortedVendors.length; r++) {
    for (const c of [2,3,4]) { const cell = summaryWs[XLSX.utils.encode_cell({r, c})]; if (cell) cell.z = '$#,##0.00'; }
    const mc = summaryWs[XLSX.utils.encode_cell({r, c:5})]; if (mc) mc.z = '0.0%';
  }
  const totalRowIdx = 8 + sortedVendors.length;
  for (const c of [2,3,4]) if (summaryWs[XLSX.utils.encode_cell({r:totalRowIdx, c})]) summaryWs[XLSX.utils.encode_cell({r:totalRowIdx, c})].z = '$#,##0.00';
  if (summaryWs[XLSX.utils.encode_cell({r:totalRowIdx, c:5})]) summaryWs[XLSX.utils.encode_cell({r:totalRowIdx, c:5})].z = '0.0%';
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  // Per-vendor tabs (best-of only — already-loaded CPCs dropped entirely)
  const headerCols = [
    'Line','CPC','MPN','MFR','Need Qty','Resale','Unit Cost','Eff Buy Qty','Total Cost',
    'Stock?','Avail Qty','MOQ','Full Qty?','Lead Time',
    'Margin %','Line GP',
    'Next Best Alt Vendor','Next Best Alt Cost','Δ vs Best',
    'Quote Count',
  ];
  for (const [name, rows] of sortedVendors) {
    const data = [headerCols];
    const sortedRows = [...rows].sort((a, b) => (b.gp || 0) - (a.gp || 0));
    for (const r of sortedRows) {
      data.push([
        r.line, r.cpc, r.mpn, r.mfr, r.need, r.resale, r.unitCost, r.effBuyQty, r.totalCost,
        r.isStock ? 'STOCK' : 'LT', r.availQty || '', r.moq || '', r.fullQty, r.leadTime || '',
        r.margin, r.gp,
        r.altVendor, r.altCost, r.altDelta,
        r.quoteCount,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      {wch:6},{wch:18},{wch:24},{wch:22},{wch:9},{wch:11},{wch:11},{wch:11},{wch:12},
      {wch:8},{wch:10},{wch:8},{wch:11},{wch:13},
      {wch:9},{wch:11},
      {wch:18},{wch:13},{wch:13},
      {wch:11},
    ];
    for (let r = 1; r <= sortedRows.length; r++) {
      const fmtCol = (c, z) => { const cell = ws[XLSX.utils.encode_cell({r, c})]; if (cell) cell.z = z; };
      fmtCol(5, '$#,##0.0000');  // Resale
      fmtCol(6, '$#,##0.0000');  // Unit Cost
      fmtCol(8, '$#,##0.00');    // Total Cost
      fmtCol(14, '0.0%');         // Margin
      fmtCol(15, '$#,##0.00');    // Line GP
      fmtCol(17, '$#,##0.0000');  // Alt Cost
      fmtCol(18, '$#,##0.0000');  // Δ
    }
    const safe = name.replace(/[\/\\\?\*\[\]:]/g, '').substring(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safe);
  }

  // No Source tab
  const nsHeader = ['Line','CPC','MPN','MFR','Need Qty','LAM Target','Resale','Reason'];
  const nsData = [nsHeader, ...noSource.sort((a,b)=>(a.line||0)-(b.line||0)).map(n=>[n.line, n.cpc, n.mpn, n.mfr, n.need, n.target, n.resale, n.reason])];
  const nsWs = XLSX.utils.aoa_to_sheet(nsData);
  nsWs['!cols'] = [{wch:6},{wch:18},{wch:28},{wch:30},{wch:9},{wch:12},{wch:12},{wch:12}];
  for (let r = 1; r <= noSource.length; r++) {
    const fmtCol = (c, z) => { const cell = nsWs[XLSX.utils.encode_cell({r, c})]; if (cell) cell.z = z; };
    fmtCol(5, '$#,##0.0000');
    fmtCol(6, '$#,##0.0000');
  }
  XLSX.utils.book_append_sheet(wb, nsWs, 'No Source');

  XLSX.writeFile(wb, OUT_FILE);
  console.log(`\n[sweep] Wrote ${OUT_FILE}`);
})().catch(e => { console.error(e); process.exit(1); });
