/**
 * Build a clean "what's left to buy" list from SIPOC, excluding everything
 * we've already loaded today, and email it to Jake.
 *
 * Columns: Line, CPC, MPN, MFR, Description, Need Qty, Base Unit Price (LAM target), Resale Price
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { execFileSync } = require('child_process');
const { createNotifier } = require('../../shared/notifier');

const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const OUT = path.join(__dirname, `EPG_Remaining_List_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`);

// Every CPC touched today across all batches (Fuses + Tracy + Amatom + DigiKey + TTI)
const TOUCHED_TODAY = new Set([
  // Fuses (4)
  '670-346211-025','670-332664-018','670-006780-038','670-338640-050',
  // Tracy/HK (14 + 1 Zynq held = 15)
  '630-337692-003','631-123367-001','630-047972-001','630-052043-001',
  '630-048308-001','630-337161-001','630-B70151-001','630-311294-001',
  '630-198438-001','630-017794-002','630-900073-001','630-099973-001',
  '630-341691-001','630-343681-001','630-204173-001',
  // Amatom (2)
  '723-097621-068','723-097621-043',
  // DigiKey (4)
  '630-114967-001','668-A01540-026','668-277308-002','668-A51618-026',
  // TTI X-1569 (1)
  '639-A21747-001',
]);

// ── Read SIPOC ────────────────────────────────────────────────────────────
const wb = XLSX.readFile(SIPOC);
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// SIPOC columns (from earlier inspection):
//   0 CPC | 1 Description | 2 MPN | 3 MFR | 4 Lead time | 5 SPQ/MOQ
//   6 Base Unit Price | 7 Total Cost | 8 Resale Price
//   ... 15 Source | 17 Qty | 18 Qty Remaining to Source

const remaining = [];
for (let i = 2; i < aoa.length; i++) {
  const r = aoa[i];
  const cpc = String(r[0] || '').trim();
  if (!cpc) continue;
  const source = String(r[15] || '').trim();
  // Skip rows already sourced (Source filled and not "pending")
  if (source && !source.toLowerCase().includes('pending')) continue;
  // Skip rows we touched today
  if (TOUCHED_TODAY.has(cpc)) continue;
  remaining.push({
    cpc,
    description: r[1] || '',
    mpn: r[2] || '',
    mfr: r[3] || '',
    qty: r[17] || '',  // SIPOC qty col may be blank — fall back to RFQ
    base: Number(r[6] || 0),
    resale: Number(r[8] || 0),
  });
}

console.log(`SIPOC remaining (after dropping ${TOUCHED_TODAY.size} touched-today CPCs): ${remaining.length}`);

// ── Get RFQ line + need qty for each CPC from the DB ──────────────────────
const cpcList = remaining.map(r => `'${r.cpc.replace(/'/g, "''")}'`).join(',');
const sql = `SELECT rl.line, rl.chuboe_cpc, lm.qty
  FROM adempiere.chuboe_rfq r
  JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id=r.chuboe_rfq_id
  JOIN adempiere.chuboe_rfq_line_mpn lm ON lm.chuboe_rfq_line_id=rl.chuboe_rfq_line_id
 WHERE r.value='1132040' AND rl.isactive='Y' AND lm.isactive='Y'
   AND rl.chuboe_cpc IN (${cpcList});`;
const out = execFileSync('psql', ['-A', '-F|', '-t', '-c', sql], { encoding: 'utf8' });
const rfqMap = new Map();
for (const ln of out.trim().split('\n')) {
  if (!ln.trim()) continue;
  const [line, cpc, qty] = ln.split('|');
  rfqMap.set(cpc, { line: Number(line), qty: Number(qty) });
}

// Merge in line# + need qty
for (const r of remaining) {
  const m = rfqMap.get(r.cpc);
  r.line = m?.line || '';
  r.need = m?.qty || r.qty || '';
}

// Sort by RFQ line #
remaining.sort((a, b) => (a.line || 0) - (b.line || 0));

// ── Build xlsx ────────────────────────────────────────────────────────────
const wbOut = XLSX.utils.book_new();
const headers = ['RFQ Line', 'CPC', 'MPN', 'MFR', 'Description', 'Need Qty', 'Base Unit Price (LAM Target)', 'Resale Price', 'Total Need Value (need × resale)'];
const data = [headers];
let totRev = 0;
for (const r of remaining) {
  const totalRev = r.need * r.resale;
  totRev += totalRev;
  data.push([r.line, r.cpc, r.mpn, r.mfr, r.description, r.need, r.base, r.resale, totalRev]);
}
data.push([]);
data.push(['', '', '', '', '', `Lines: ${remaining.length}`, '', 'Total Resale Value:', totRev]);

const wsOut = XLSX.utils.aoa_to_sheet(data);
wsOut['!cols'] = [
  {wch:8},{wch:18},{wch:26},{wch:28},{wch:42},{wch:9},{wch:18},{wch:13},{wch:20},
];
for (let i = 1; i <= remaining.length; i++) {
  const fmt = (c, z) => { const cell = wsOut[XLSX.utils.encode_cell({r: i, c})]; if (cell) cell.z = z; };
  fmt(5, '#,##0');         // need qty
  fmt(6, '$#,##0.0000');   // base
  fmt(7, '$#,##0.0000');   // resale
  fmt(8, '$#,##0.00');     // total
}
const totRowIdx = remaining.length + 2;
const totCell = wsOut[XLSX.utils.encode_cell({r: totRowIdx, c: 8})];
if (totCell) totCell.z = '$#,##0.00';

XLSX.utils.book_append_sheet(wbOut, wsOut, 'Remaining');
XLSX.writeFile(wbOut, OUT);
console.log(`Wrote ${OUT}`);

// ── Email ─────────────────────────────────────────────────────────────────
const body = `Hi Jake,

Remaining lines on LAM EPG RFQ 1132040 — what's left to buy.

Source: SIPOC (rows where Source is blank or pending) minus everything we have loaded as IsPurchased=Y today (Fuses + Tracy + Amatom + DigiKey + TTI X-1569 = 25 CPCs touched).

  Lines remaining: ${remaining.length}
  Total LAM resale value (need × resale): $${totRev.toFixed(2)}

Columns in attachment:
  RFQ Line | CPC | MPN | MFR | Description | Need Qty | Base Unit Price (LAM Target) | Resale Price | Total Need Value

Notes:
  - LCMXO2280C-3FTN256C (line 300) was a PARTIAL buy from DigiKey today — bought 30 of 40. The 10 ea gap is NOT in this list (we excluded the whole CPC). If you want to source the gap separately, ask and I will surface it.
  - Xilinx Zynq XCZU4CG-1SFVC784E (line 60) is on COMPLIANCE HOLD (5A002.A.4) — also excluded.
  - BK/1A1119-10-R (line 168, Eaton fuse) is held for Master quote — also excluded.

— Claude via Jake's analytics terminal
`;

const notifier = createNotifier({
  fromEmail: 'vortex@orangetsunami.com',
  fromName: 'Analytics Terminal',
  smtpPass: process.env.WORKMAIL_PASS,
});
notifier.sendWithAttachment(
  'jake.harris@Astutegroup.com',
  `LAM EPG RFQ 1132040 — Remaining Lines List (${remaining.length} lines, Apr 9)`,
  body,
  [{ filename: path.basename(OUT), content: fs.readFileSync(OUT) }],
).then(ok => console.log(ok ? '✓ sent' : '✗ failed')).catch(e => { console.error(e); process.exit(1); });
