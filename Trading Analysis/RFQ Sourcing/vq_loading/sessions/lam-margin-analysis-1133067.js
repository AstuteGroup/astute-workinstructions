// Margin analysis: every VQ on RFQ 1133067 vs LAM Kitting contract resale
//   Green: margin > 18%   Yellow: 0-18%   Red: < 0%
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const LAM_DB = path.join(__dirname, '../../../LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx');
const QUOTES_JSON = path.join(__dirname, '2026-04-29-LAM-reorders-1133067.json');

const TARGET_MPNS = new Set([
  'LTM8074EY#PBF','MAX16029TG+','LTM4632EV#PBF','AD9467BCPZ-250',
  'LT1491ACS#PBF','SN74LVC125ARGYR','ADS8688IDBTR','LMZ14202TZ-ADJ/NOPB'
]);

const LINE_OF = {
  'SN74LVC125ARGYR': 10, 'LTM8074EY#PBF': 60, 'MAX16029TG+': 70, 'LTM4632EV#PBF': 80,
  'ADS8688IDBTR': 110, 'LMZ14202TZ-ADJ/NOPB': 120, 'AD9467BCPZ-250': 130, 'LT1491ACS#PBF': 150,
};

function readResaleMap() {
  const wb = XLSX.readFile(LAM_DB);
  const ws = wb.Sheets['INVENTORY'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const resale = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cpc = String(r[0] || '').trim();
    const mpn = String(r[1] || '').trim();
    const basePrice = parseFloat(r[5]) || 0;
    const resalePrice = parseFloat(r[6]) || 0;
    const moq = parseInt(r[8], 10) || 0;
    if (TARGET_MPNS.has(mpn) && resalePrice > 0) {
      resale[mpn] = { cpc, basePrice, resalePrice, moq };
    }
  }
  return resale;
}

function colorFlag(pct) {
  if (pct < 0) return 'RED';
  if (pct < 18) return 'YELLOW';
  return 'GREEN';
}

function symbolize(flag) {
  return flag === 'GREEN' ? '🟢' : flag === 'YELLOW' ? '🟡' : '🔴';
}

function main() {
  const resaleMap = readResaleMap();
  const quotes = JSON.parse(fs.readFileSync(QUOTES_JSON, 'utf8'));

  console.log('LAM Resale Map (from Lam_Kitting_DB_03132026.xlsx):');
  for (const [mpn, info] of Object.entries(resaleMap)) {
    console.log(`  ${mpn.padEnd(24)} CPC ${info.cpc.padEnd(18)} resale $${info.resalePrice.toFixed(4).padStart(9)}  base $${info.basePrice.toFixed(4).padStart(9)}  MOQ ${info.moq}`);
  }

  const enriched = quotes.map(q => {
    const info = resaleMap[q.mpn];
    if (!info) return null;
    const margin = (info.resalePrice - q.cost) / info.resalePrice * 100;
    const flag = colorFlag(margin);
    const isSuspended = q.vendorSearchKey === '1006247'; // Dragon
    return { ...q, line: LINE_OF[q.mpn], resale: info.resalePrice, basePrice: info.basePrice, moq: info.moq, margin, flag, isSuspended };
  }).filter(Boolean);

  enriched.sort((a, b) => a.line - b.line || a.cost - b.cost);

  console.log('\n');
  let lastLine = null;
  for (const r of enriched) {
    if (r.line !== lastLine) {
      const lineQuotes = enriched.filter(x => x.line === r.line);
      console.log(`\n── Line ${r.line} | ${r.mpn} | resale $${r.resale.toFixed(4)} | LAM MOQ ${r.moq} | ${lineQuotes.length} quotes ──`);
      lastLine = r.line;
    }
    const susp = r.isSuspended ? ' ⚠SUSPENDED' : '';
    const altMpn = r.vendorQuotedMpn && r.vendorQuotedMpn !== r.mpn ? ` [alt: ${r.vendorQuotedMpn}]` : '';
    console.log(`  ${symbolize(r.flag)} ${r.vendorName.slice(0,38).padEnd(38)} | $${r.cost.toFixed(4).padStart(9)} × ${String(r.qty).padStart(4)} | DC ${(r.dateCode||'-').padEnd(3)} | ${(r.coo||'?').slice(0,16).padEnd(16)} | ${r.leadTime.padEnd(10)} | margin ${r.margin.toFixed(1).padStart(5)}%${susp}${altMpn}`);
  }

  // Summary by line
  console.log('\n\n=== SUMMARY: BEST GREEN/YELLOW QUOTE PER LINE (excludes SUSPENDED) ===\n');
  const lineMpns = Array.from(new Set(enriched.map(r => r.mpn))).sort((a,b) => LINE_OF[a] - LINE_OF[b]);
  for (const mpn of lineMpns) {
    const lineQuotes = enriched.filter(r => r.mpn === mpn && !r.isSuspended);
    const viable = lineQuotes.filter(r => r.flag !== 'RED').sort((a,b) => b.margin - a.margin);
    const allReds = lineQuotes.filter(r => r.flag === 'RED');
    const lineNo = LINE_OF[mpn];
    if (viable.length > 0) {
      const best = viable[0];
      console.log(`  Line ${String(lineNo).padStart(3)} | ${mpn.padEnd(22)} | ${symbolize(best.flag)} ${best.vendorName.slice(0,28).padEnd(28)} | $${best.cost.toFixed(4).padStart(9)} | DC ${best.dateCode} | margin ${best.margin.toFixed(1)}% | ${viable.length}/${lineQuotes.length} viable (excl Dragon)`);
    } else if (allReds.length > 0) {
      const best = allReds.sort((a,b) => b.margin - a.margin)[0];
      console.log(`  Line ${String(lineNo).padStart(3)} | ${mpn.padEnd(22)} | 🔴 ALL RED — best is ${best.vendorName.slice(0,28).padEnd(28)} @ $${best.cost.toFixed(4)} (margin ${best.margin.toFixed(1)}%)`);
    } else {
      console.log(`  Line ${String(lineNo).padStart(3)} | ${mpn.padEnd(22)} | (no non-Dragon quotes)`);
    }
  }

  // GP value analysis (top opportunity per line)
  console.log('\n=== TOTAL GP IF BUYING BEST QUOTE PER LINE @ LAM REORDER QTY ===\n');
  // RFQ qtys from earlier query
  const RFQ_QTY = { 'SN74LVC125ARGYR': 25, 'LTM8074EY#PBF': 25, 'MAX16029TG+': 25, 'LTM4632EV#PBF': 25,
                    'ADS8688IDBTR': 15, 'LMZ14202TZ-ADJ/NOPB': 12, 'AD9467BCPZ-250': 14, 'LT1491ACS#PBF': 2 };
  // Note: Tracy quoted at 80/75/etc; LAM MOQ enforces minimum buy. RFQ Qty = system reorder qty.
  let totalGp = 0;
  for (const mpn of lineMpns) {
    const viable = enriched.filter(r => r.mpn === mpn && !r.isSuspended && r.flag !== 'RED').sort((a,b) => b.margin - a.margin);
    if (viable.length === 0) continue;
    const best = viable[0];
    const qty = RFQ_QTY[mpn] || best.qty;
    const lineGp = (best.resale - best.cost) * qty;
    totalGp += lineGp;
    console.log(`  ${mpn.padEnd(22)} qty ${String(qty).padStart(3)} × ($${best.resale.toFixed(4)} - $${best.cost.toFixed(4)}) = $${lineGp.toFixed(2).padStart(9)} GP @ ${best.margin.toFixed(1)}% (${best.vendorName.slice(0,25)})`);
  }
  console.log(`  ${'─'.repeat(80)}`);
  console.log(`  TOTAL GP @ system reorder qty:  $${totalGp.toFixed(2)}`);
}

main();
