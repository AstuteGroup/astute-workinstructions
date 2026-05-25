#!/usr/bin/env node
/**
 * PO Activity Analysis — end-to-end driver.
 *
 * Substitutes the SQL template, runs psql, builds the Excel workbook
 * and the management-meeting PowerPoint deck in one shot.
 *
 * Usage:
 *   node build-po-activity.js --start 2026-01-01 --end 2026-05-01 --label 2026-Jan-Apr
 *   node build-po-activity.js --start 2026-01-01 --end 2026-02-01 --label 2026-Jan
 *
 * end-date is EXCLUSIVE (first day of the month AFTER the last month you want).
 *
 * Outputs (under <out-dir>/, default ./output/<label>/):
 *   <label>_POs.csv                — line-level fact table
 *   <label>_MFR_breakdown.csv      — cumulative top-50 MFR aggregation
 *   <label>_CPC_conversion.csv     — per-CPC VQ→PO+SO conversion detail
 *   <label>_POs_Analysis.xlsx      — 11-tab Excel workbook
 *   <label>_POs_Slides.pptx        — 3-slide management deck
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const PptxGenJS = require('pptxgenjs');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.start || !args.end || !args.label) {
  console.error('Usage: node build-po-activity.js --start YYYY-MM-DD --end YYYY-MM-DD --label <label> [--out-dir <dir>]');
  console.error('  end-date is EXCLUSIVE — use 2026-05-01 to include April 2026.');
  process.exit(2);
}
const START = args.start;
const END   = args.end;
const LABEL = args.label;
const SCRIPT_DIR = __dirname;
const OUT_DIR = path.resolve(args['out-dir'] || path.join(SCRIPT_DIR, 'output', LABEL));
const TEMPLATE_SQL = path.join(SCRIPT_DIR, 'po-activity-by-range.sql');

fs.mkdirSync(OUT_DIR, { recursive: true });

const OUT_CSV       = path.join(OUT_DIR, `${LABEL}_POs.csv`);
const OUT_MFR_CSV   = path.join(OUT_DIR, `${LABEL}_MFR_breakdown.csv`);
const OUT_CONV_CSV  = path.join(OUT_DIR, `${LABEL}_CPC_conversion.csv`);
const OUT_XLSX      = path.join(OUT_DIR, `${LABEL}_POs_Analysis.xlsx`);
const OUT_PPTX      = path.join(OUT_DIR, `${LABEL}_POs_Slides.pptx`);

console.log(`PO Activity Analysis — ${START} → ${END}  (label: ${LABEL})`);
console.log(`Outputs in: ${OUT_DIR}`);

// ---------------------------------------------------------------------------
// Phase 1: substitute SQL template + run psql
// ---------------------------------------------------------------------------
const template = fs.readFileSync(TEMPLATE_SQL, 'utf8');
const filledSql = template
  .replace(/@START_DATE@/g, START)
  .replace(/@END_DATE@/g, END)
  .replace(/@OUT_CSV@/g, OUT_CSV)
  .replace(/@OUT_MFR_CSV@/g, OUT_MFR_CSV)
  .replace(/@OUT_CONV_CSV@/g, OUT_CONV_CSV);
const tmpSql = path.join(OUT_DIR, `_${LABEL}_run.sql`);
fs.writeFileSync(tmpSql, filledSql);

console.log('\n[1/3] Running psql…');
let psqlOut;
try {
  psqlOut = execFileSync('psql', ['-f', tmpSql], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
} catch (e) {
  console.error('psql failed:', e.stderr || e.message);
  process.exit(1);
}
// Echo summary tail so the operator sees the conversion % + status breakdown live
const tail = psqlOut.split('\n').slice(-40).join('\n');
console.log(tail);
fs.unlinkSync(tmpSql);

// ---------------------------------------------------------------------------
// Phase 2: read the three CSVs
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}
function num(v)  { if (v===''||v==null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v)  { return v == null ? '' : String(v); }
function bool(v) { return String(v).toLowerCase() === 't' || String(v).toLowerCase() === 'true' || v === 'Y'; }
function dateOnly(v) { return v ? String(v).slice(0,10) : null; }

function loadCsv(file, mapper) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = parseCSV(raw);
  const header = rows.shift();
  const idx = Object.fromEntries(header.map((h,i)=>[h,i]));
  return { rows: rows.map(r => mapper(r, idx)), header };
}

console.log('\n[2/3] Reading CSVs + building Excel + PPTX…');

const fact = loadCsv(OUT_CSV, (r, idx) => ({
  ot_po:                str(r[idx.ot_po]),
  po_docstatus:         str(r[idx.po_docstatus]),
  infor_pov:            str(r[idx.infor_pov]),
  po_date:              dateOnly(r[idx.po_date]),
  promise_date:         dateOnly(r[idx.promise_date]),
  po_line_no:           num(r[idx.po_line_no]),
  supplier:             str(r[idx.supplier]),
  buyer:                str(r[idx.buyer]),
  mpn:                  str(r[idx.mpn]),
  mfr:                  str(r[idx.mfr]),
  po_qty:               num(r[idx.po_qty]),
  po_price:             num(r[idx.po_price]),
  po_tracking:          str(r[idx.po_tracking]),
  recv_qty:             num(r[idx.recv_qty]),
  first_recv_date:      dateOnly(r[idx.first_recv_date]),
  last_recv_date:       dateOnly(r[idx.last_recv_date]),
  recv_docs:            str(r[idx.recv_docs]),
  otin_status:          str(r[idx.otin_status]),
  delivery_status:      str(r[idx.delivery_status]),
  rfq_search_key:       str(r[idx.rfq_search_key]),
  rfq_type:             str(r[idx.rfq_type]),
  customer:             str(r[idx.customer]),
  seller:               str(r[idx.seller]),
  so_docs:              str(r[idx.so_docs]),
  so_docstatuses:       str(r[idx.so_docstatuses]),
  cov:                  str(r[idx.cov]),
  so_line_count:        num(r[idx.so_line_count]),
  so_qty_total:         num(r[idx.so_qty_total]),
  so_price_wavg:        num(r[idx.so_price_wavg]),
  so_revenue_full:      num(r[idx.so_revenue_full_rfq]),
  so_revenue:           num(r[idx.attributed_so_revenue]),
  so_latest_date:       dateOnly(r[idx.so_latest_date]),
  otin_lot:             str(r[idx.otin_lot]),
  insp_validated:       str(r[idx.insp_validated]),
  insp_processed:       str(r[idx.insp_processed]),
  insp_opened_date:     dateOnly(r[idx.insp_opened_date]),
  insp_validated_date:  dateOnly(r[idx.insp_validated_date]),
  receipt_picked_date:  dateOnly(r[idx.receipt_picked_date]),
})).rows;

const mfrRows = loadCsv(OUT_MFR_CSV, (r, idx) => ({
  mfr:                str(r[idx.mfr]),
  po_lines:           num(r[idx.po_lines]),
  supplier_count:     num(r[idx.supplier_count]),
  customer_count:     num(r[idx.customer_count]),
  spend:              num(r[idx.spend]),
  revenue:            num(r[idx.revenue]),
  booked_gp:          num(r[idx.booked_gp]),
  booked_margin_pct:  num(r[idx.booked_margin_pct]),
  validation_rate:    num(r[idx.validation_rate]),
  past_due_rate:      num(r[idx.past_due_rate]),
})).rows;

const convRows = loadCsv(OUT_CONV_CSV, (r, idx) => ({
  cpc:        str(r[idx.cpc]),
  customers:  str(r[idx.customers]),
  had_po:     bool(r[idx.had_po]),
  had_soldcq: bool(r[idx.had_soldcq]),
  converted:  bool(r[idx.converted]),
})).rows;

// ---------------------------------------------------------------------------
// Phase 3: derived calculations
// ---------------------------------------------------------------------------
// Reference date: today (when this script runs). Used for "days late" against promise dates.
const TODAY = new Date().toISOString().slice(0,10);
function daysBetween(a,b) { if(!a||!b) return null; return Math.round((new Date(b) - new Date(a))/86400000); }

fact.forEach(r => {
  r.po_spend         = (r.po_qty && r.po_price) ? r.po_qty * r.po_price : null;
  r.gp_dollars       = (r.so_revenue && r.po_spend) ? r.so_revenue - r.po_spend : null;
  r.margin_pct       = (r.so_revenue && r.so_revenue > 0 && r.po_spend != null) ? (r.so_revenue - r.po_spend) / r.so_revenue : null;
  r.days_late        = (r.delivery_status === 'past_due' && r.promise_date) ? daysBetween(r.promise_date, TODAY) : null;
  r.stage1_po_to_recv     = daysBetween(r.po_date,             r.first_recv_date);
  r.stage2_recv_to_lot    = daysBetween(r.first_recv_date,     r.insp_opened_date);
  r.stage3_lot_to_valid   = daysBetween(r.insp_opened_date,    r.insp_validated_date);
  r.total_po_to_valid     = daysBetween(r.po_date,             r.insp_validated_date);
});

function pctl(arr, p) {
  const xs = arr.filter(x => x != null && Number.isFinite(x) && x >= 0).sort((a,b)=>a-b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
}
function summarize(label, arr) {
  const xs = arr.filter(x => x != null && Number.isFinite(x) && x >= 0);
  return {
    label,
    n: xs.length,
    median: pctl(arr, 0.5),
    p75: pctl(arr, 0.75),
    p90: pctl(arr, 0.90),
    max: xs.length ? Math.max(...xs) : null,
  };
}
const validatedOnly = fact.filter(r => r.insp_validated === 'Y' && r.first_recv_date && r.insp_validated_date);
const cycleBenchmarks = [
  summarize('1. PO placed → first receipt',     validatedOnly.map(r => r.stage1_po_to_recv)),
  summarize('2. Receipt → inspection opened',   validatedOnly.map(r => r.stage2_recv_to_lot)),
  summarize('3. Inspection opened → validated', validatedOnly.map(r => r.stage3_lot_to_valid)),
  summarize('Total: PO placed → validated',     validatedOnly.map(r => r.total_po_to_valid)),
];

// ---------------------------------------------------------------------------
// Excel — 11 tabs
// ---------------------------------------------------------------------------
function buildSheet(rows, colDefs) {
  const headers = colDefs.map(c=>c.header);
  const aoa = [headers];
  rows.forEach(r => aoa.push(colDefs.map(c => r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = colDefs.map(c => ({ wch: c.width || 14 }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) {
    colDefs.forEach((c, C) => {
      const cell = ws[XLSX.utils.encode_cell({r:R, c:C})];
      if (!cell) return;
      if (c.z) cell.z = c.z;
      if (c.t) cell.t = c.t;
    });
  }
  return ws;
}
function groupBy(arr, keyFn) {
  const m = new Map();
  arr.forEach(r => {
    const k = keyFn(r) || '(blank)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  return m;
}
function pct(n, d) { return d>0 ? n/d : null; }
function bucketStats(rs) {
  const lines = rs.length;
  const distinctPovs = new Set(rs.map(r=>r.infor_pov)).size;
  const spend   = rs.reduce((s,r)=>s+(r.po_spend||0),  0);
  const revenue = rs.reduce((s,r)=>s+(r.so_revenue||0), 0);
  const recv = rs.filter(r=>r.otin_status!=='NOT_RECEIVED').length;
  const val  = rs.filter(r=>r.otin_status==='VALIDATED').length;
  const past = rs.filter(r=>r.delivery_status==='past_due').length;
  const trk  = rs.filter(r=>r.po_tracking && r.po_tracking.trim()).length;
  const openExp = rs.filter(r=>r.otin_status==='NOT_RECEIVED').reduce((s,r)=>s+(r.po_spend||0), 0);
  const lateXs = rs.filter(r=>r.delivery_status==='past_due' && r.days_late!=null).map(r=>r.days_late);
  const avgLate = lateXs.length ? lateXs.reduce((a,b)=>a+b,0)/lateXs.length : null;
  return {
    lines, distinct_povs: distinctPovs, spend, revenue,
    recv_pct: pct(recv, lines), val_pct: pct(val, lines),
    past_due_pct: pct(past, lines), tracking_pct: pct(trk, lines),
    open_exposure: openExp, avg_days_late: avgLate
  };
}

const notReceived  = fact.filter(r => r.otin_status === 'NOT_RECEIVED');
const pastDue      = fact.filter(r => r.delivery_status === 'past_due');
const validated    = fact.filter(r => r.otin_status === 'VALIDATED' || r.otin_status === 'PROCESSED');
const inInspection = fact.filter(r => r.otin_status === 'RECEIVED_NO_LOT' || r.otin_status === 'LOT_OPEN');
const totalSpend   = fact.reduce((s,r)=>s+(r.po_spend||0), 0);
const totalRevenue = fact.reduce((s,r)=>s+(r.so_revenue||0), 0);
const openExposure = notReceived.reduce((s,r)=>s+(r.po_spend||0), 0);
const openCommitRevenue = notReceived.reduce((s,r)=>s+(r.so_revenue||0), 0);
const distinctPovs = new Set(fact.map(r=>r.infor_pov)).size;
const distinctBuyers = new Set(fact.map(r=>r.buyer).filter(Boolean)).size;
const distinctSuppliers = new Set(fact.map(r=>r.supplier).filter(Boolean)).size;
const distinctCustomers = new Set(fact.map(r=>r.customer).filter(Boolean)).size;

// Conversion headline numbers
const cpcsWithVq = convRows.length;
const cpcsToPo   = convRows.filter(r=>r.had_po).length;
const cpcsToSoldcq = convRows.filter(r=>r.had_soldcq).length;
const cpcsConverted = convRows.filter(r=>r.converted).length;
const conversionPct = cpcsWithVq>0 ? cpcsConverted / cpcsWithVq : null;

// Friendly period label (e.g. "January through April 2026")
function formatPeriod(start, endExcl) {
  const MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const s = new Date(start), e = new Date(endExcl);
  const eIncl = new Date(e); eIncl.setUTCDate(eIncl.getUTCDate() - 1);
  const sM = MO[s.getUTCMonth()], eM = MO[eIncl.getUTCMonth()];
  const sY = s.getUTCFullYear(), eY = eIncl.getUTCFullYear();
  if (sM === eM && sY === eY) return `${sM} ${sY}`;
  if (sY === eY)               return `${sM} through ${eM} ${sY}`;
  return `${sM} ${sY} through ${eM} ${eY}`;
}
const PERIOD = formatPeriod(START, END);

// ---------- Summary tab ----------
const summaryRows = [
  [`PO Activity — ${PERIOD}`, ''],
  ['Date range', `${START} (incl) → ${END} (excl)`],
  ['As of', TODAY],
  ['Scope', `POVs placed in period, parts only — services / testing / fees / freight excluded`],
  ['', ''],
  ['—— Volume ——', ''],
  ['Distinct POVs',                 distinctPovs],
  ['PO lines (parts only)',         fact.length],
  ['Distinct buyers',               distinctBuyers],
  ['Distinct suppliers',            distinctSuppliers],
  ['Distinct customers',            distinctCustomers],
  ['', ''],
  ['—— $ Economics ——', ''],
  ['Total PO spend (cost)',         totalSpend],
  ['Total attributed SO revenue',   totalRevenue],
  ['Booked GP',                     totalRevenue - totalSpend],
  ['Booked margin',                 totalRevenue > 0 ? (totalRevenue - totalSpend) / totalRevenue : null],
  ['Open exposure (NOT_RECEIVED)',  openExposure],
  ['Open revenue at risk',          openCommitRevenue],
  ['', ''],
  ['—— Conversion (VQ → PO + sold CQ, per CPC) ——', ''],
  ['CPCs with VQ in period',                cpcsWithVq],
  ['... also with PO in period',            cpcsToPo],
  ['... also with sold CQ in period',       cpcsToSoldcq],
  ['... with BOTH (converted)',             cpcsConverted],
  ['Conversion %',                          conversionPct],
  ['', ''],
  ['—— OTIN Lifecycle ——', ''],
  ['VALIDATED (inspection done)',           validated.length],
  ['LOT_OPEN / RECEIVED_NO_LOT (in insp.)', inInspection.length],
  ['NOT_RECEIVED (vendor delay)',           notReceived.length],
  ['', ''],
  ['—— Delivery Performance ——', ''],
  ['Received',                              fact.filter(r=>r.delivery_status==='received').length],
  ['Past-due (not received)',               pastDue.length],
  ['Due within 7 days',                     fact.filter(r=>r.delivery_status==='due_within_7d').length],
  ['Future-promise (not yet due)',          fact.filter(r=>r.delivery_status==='future').length],
  ['No promise date',                       fact.filter(r=>r.delivery_status==='no_promise_date').length],
  ['Worst days late',                       Math.max(...pastDue.map(r=>r.days_late||0), 0)],
  ['Median days late',                      (()=>{ const xs = pastDue.map(r=>r.days_late||0).sort((a,b)=>a-b); return xs.length ? xs[Math.floor(xs.length/2)] : null; })()],
  ['', ''],
  ['—— Cycle Benchmarks (days, validated lines only) ——', `n=${validatedOnly.length}`],
  ['Stage', 'Median  /  P75  /  P90  /  Max'],
  ...cycleBenchmarks.map(b => [b.label, `${b.median}  /  ${b.p75}  /  ${b.p90}  /  ${b.max}`]),
  ['', ''],
  ['Interpretation', 'Stage 1 = vendor lead time + transit + dock-in.'],
  ['',               'Stage 2 = goods received → routed to inspection bench.'],
  ['',               'Stage 3 = pure inspection cycle (queue + test/validate).'],
];
const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
wsSummary['!cols'] = [{wch:50},{wch:28}];
const dollarLabels = new Set(['Total PO spend (cost)','Total attributed SO revenue','Booked GP','Open exposure (NOT_RECEIVED)','Open revenue at risk']);
const pctLabels = new Set(['Booked margin','Conversion %']);
summaryRows.forEach((r, i) => {
  if (dollarLabels.has(r[0])) { const cell = wsSummary[XLSX.utils.encode_cell({r:i, c:1})]; if (cell) cell.z = '$#,##0.00'; }
  if (pctLabels.has(r[0]))    { const cell = wsSummary[XLSX.utils.encode_cell({r:i, c:1})]; if (cell) cell.z = '0.0%'; }
});

// ---------- All Lines (full fact) ----------
const allCols = [
  {key:'ot_po', header:'OT PO#', width:11},
  {key:'po_docstatus', header:'PO Status', width:9},
  {key:'infor_pov', header:'Infor POV', width:13},
  {key:'po_date', header:'PO Date', width:11},
  {key:'promise_date', header:'Promise Date', width:12},
  {key:'po_line_no', header:'Line', width:6, z:'#,##0'},
  {key:'supplier', header:'Supplier', width:32},
  {key:'buyer', header:'Buyer', width:18},
  {key:'mpn', header:'MPN', width:28},
  {key:'mfr', header:'MFR', width:18},
  {key:'po_qty', header:'PO Qty', width:9, z:'#,##0'},
  {key:'po_price', header:'PO Price', width:12, z:'$#,##0.00'},
  {key:'po_spend', header:'PO Spend', width:14, z:'$#,##0.00'},
  {key:'po_tracking', header:'Tracking #', width:24},
  {key:'recv_qty', header:'Recv Qty', width:9, z:'#,##0'},
  {key:'first_recv_date', header:'First Recv', width:11},
  {key:'last_recv_date', header:'Last Recv', width:11},
  {key:'otin_status', header:'OTIN Status', width:16},
  {key:'delivery_status', header:'Delivery Status', width:15},
  {key:'days_late', header:'Days Late', width:9, z:'#,##0'},
  {key:'otin_lot', header:'OTIN Lot', width:11},
  {key:'insp_validated', header:'Insp Valid', width:9},
  {key:'insp_opened_date', header:'Insp Opened', width:11},
  {key:'insp_validated_date', header:'Insp Validated', width:13},
  {key:'stage1_po_to_recv', header:'Stage 1 PO→Recv (d)', width:16, z:'#,##0'},
  {key:'stage2_recv_to_lot', header:'Stage 2 Recv→Lot (d)', width:16, z:'#,##0'},
  {key:'stage3_lot_to_valid', header:'Stage 3 Lot→Valid (d)', width:16, z:'#,##0'},
  {key:'total_po_to_valid', header:'Total PO→Valid (d)', width:14, z:'#,##0'},
  {key:'rfq_search_key', header:'RFQ#', width:10},
  {key:'rfq_type', header:'RFQ Type', width:12},
  {key:'customer', header:'Customer', width:30},
  {key:'seller', header:'Seller', width:18},
  {key:'so_docs', header:'SO#(s)', width:18},
  {key:'so_docstatuses', header:'SO Status', width:10},
  {key:'cov', header:'COV (Cust PO)', width:20},
  {key:'so_qty_total', header:'SO Qty (full RFQ line)', width:14, z:'#,##0'},
  {key:'so_price_wavg', header:'SO Price (wavg)', width:14, z:'$#,##0.00'},
  {key:'so_revenue', header:'SO Rev (this PO)', width:14, z:'$#,##0.00'},
  {key:'so_revenue_full', header:'SO Rev (full RFQ)', width:16, z:'$#,##0.00'},
  {key:'gp_dollars', header:'GP $ (this PO)', width:14, z:'$#,##0.00'},
  {key:'margin_pct', header:'Margin', width:9, z:'0.0%'},
];
const wsAll = buildSheet(fact, allCols);

// ---------- Open Past-Due ----------
const openRows = notReceived.slice().sort((a,b) => (b.days_late||-1) - (a.days_late||-1));
const openCols = [
  {key:'days_late', header:'Days Late', width:9, z:'#,##0'},
  {key:'promise_date', header:'Promise Date', width:12},
  {key:'ot_po', header:'OT PO#', width:11},
  {key:'infor_pov', header:'Infor POV', width:13},
  {key:'po_date', header:'PO Date', width:11},
  {key:'supplier', header:'Supplier', width:32},
  {key:'buyer', header:'Buyer', width:18},
  {key:'mpn', header:'MPN', width:28},
  {key:'mfr', header:'MFR', width:18},
  {key:'po_qty', header:'PO Qty', width:9, z:'#,##0'},
  {key:'po_price', header:'PO Price', width:12, z:'$#,##0.00'},
  {key:'po_spend', header:'PO Spend', width:14, z:'$#,##0.00'},
  {key:'po_tracking', header:'Tracking #', width:24},
  {key:'customer', header:'Customer', width:30},
  {key:'so_docs', header:'SO#(s)', width:18},
  {key:'so_revenue', header:'SO Rev at Risk', width:14, z:'$#,##0.00'},
];
const wsOpen = buildSheet(openRows, openCols);

// ---------- Buyer Status Matrix ----------
const buyerGroups = groupBy(fact, r => r.buyer || '(no buyer)');
const allStatuses = ['VALIDATED','LOT_OPEN','RECEIVED_NO_LOT','NOT_RECEIVED','PROCESSED'];
const matrix = [...buyerGroups.entries()].map(([buyer, rs]) => {
  const out = { buyer, lines: rs.length };
  allStatuses.forEach(s => out[s] = rs.filter(r=>r.otin_status===s).length);
  out.past_due = rs.filter(r=>r.delivery_status==='past_due').length;
  return out;
}).sort((a,b)=>b.lines-a.lines);
const matrixCols = [
  {key:'buyer', header:'Buyer', width:22},
  {key:'lines', header:'Total Lines', width:11, z:'#,##0'},
  ...allStatuses.map(s => ({key:s, header:s, width:14, z:'#,##0'})),
  {key:'past_due', header:'Past-Due', width:10, z:'#,##0'},
];
const wsMatrix = buildSheet(matrix, matrixCols);

// ---------- By Buyer ----------
const byBuyer = [...buyerGroups.entries()].map(([buyer, rs]) => ({ buyer, ...bucketStats(rs) }))
  .sort((a,b) => b.spend - a.spend);
const buyerCols = [
  {key:'buyer', header:'Buyer', width:22},
  {key:'lines', header:'Lines', width:7, z:'#,##0'},
  {key:'distinct_povs', header:'POVs', width:7, z:'#,##0'},
  {key:'spend', header:'PO Spend', width:14, z:'$#,##0.00'},
  {key:'revenue', header:'SO Revenue', width:14, z:'$#,##0.00'},
  {key:'open_exposure', header:'Open $', width:14, z:'$#,##0.00'},
  {key:'recv_pct', header:'Received %', width:11, z:'0.0%'},
  {key:'val_pct', header:'Validated %', width:11, z:'0.0%'},
  {key:'past_due_pct', header:'Past Due %', width:11, z:'0.0%'},
  {key:'tracking_pct', header:'Tracking %', width:11, z:'0.0%'},
  {key:'avg_days_late', header:'Avg Days Late', width:13, z:'#,##0'},
];
const wsBuyer = buildSheet(byBuyer, buyerCols);

// ---------- By Supplier ----------
const suppGroups = groupBy(fact, r => r.supplier || '(no supplier)');
const bySupplier = [...suppGroups.entries()].map(([supplier, rs]) => ({ supplier, ...bucketStats(rs) }))
  .sort((a,b) => b.spend - a.spend);
const suppCols = [
  {key:'supplier', header:'Supplier', width:36},
  {key:'lines', header:'Lines', width:7, z:'#,##0'},
  {key:'distinct_povs', header:'POVs', width:7, z:'#,##0'},
  {key:'spend', header:'PO Spend', width:14, z:'$#,##0.00'},
  {key:'recv_pct', header:'Received %', width:11, z:'0.0%'},
  {key:'val_pct', header:'Validated %', width:11, z:'0.0%'},
  {key:'past_due_pct', header:'Past Due %', width:11, z:'0.0%'},
  {key:'open_exposure', header:'Open $', width:14, z:'$#,##0.00'},
  {key:'avg_days_late', header:'Avg Days Late', width:13, z:'#,##0'},
];
const wsSupplier = buildSheet(bySupplier, suppCols);

// ---------- By Customer ----------
const custGroups = groupBy(fact.filter(r=>r.customer), r => r.customer);
const byCustomer = [...custGroups.entries()].map(([customer, rs]) => ({
  customer, lines: rs.length,
  distinct_povs: new Set(rs.map(r=>r.infor_pov)).size,
  spend: rs.reduce((s,r)=>s+(r.po_spend||0), 0),
  revenue: rs.reduce((s,r)=>s+(r.so_revenue||0), 0),
  gp: rs.reduce((s,r)=>s+(r.so_revenue||0), 0) - rs.reduce((s,r)=>s+(r.po_spend||0), 0),
  open_exposure: rs.filter(r=>r.otin_status==='NOT_RECEIVED').reduce((s,r)=>s+(r.po_spend||0), 0),
  open_revenue_at_risk: rs.filter(r=>r.otin_status==='NOT_RECEIVED').reduce((s,r)=>s+(r.so_revenue||0), 0),
  past_due_lines: rs.filter(r=>r.delivery_status==='past_due').length,
})).sort((a,b)=>b.revenue - a.revenue);
const custCols = [
  {key:'customer', header:'Customer', width:36},
  {key:'lines', header:'Lines', width:7, z:'#,##0'},
  {key:'distinct_povs', header:'POVs', width:7, z:'#,##0'},
  {key:'spend', header:'PO Spend', width:14, z:'$#,##0.00'},
  {key:'revenue', header:'SO Revenue', width:14, z:'$#,##0.00'},
  {key:'gp', header:'GP $', width:14, z:'$#,##0.00'},
  {key:'open_exposure', header:'Open PO $', width:14, z:'$#,##0.00'},
  {key:'open_revenue_at_risk', header:'Open SO $ Risk', width:14, z:'$#,##0.00'},
  {key:'past_due_lines', header:'Past-Due Lines', width:13, z:'#,##0'},
];
const wsCust = buildSheet(byCustomer, custCols);

// ---------- Cycle Benchmarks ----------
const benchRows = [
  ['Cycle Stage','n','Median (d)','P75 (d)','P90 (d)','Max (d)'],
  ...cycleBenchmarks.map(b => [b.label, b.n, b.median, b.p75, b.p90, b.max]),
];
const wsBench = XLSX.utils.aoa_to_sheet(benchRows);
wsBench['!cols'] = [{wch:40},{wch:8},{wch:10},{wch:10},{wch:10},{wch:10}];

// ---------- Cycle Times (per-line) ----------
const cycleRows = fact.filter(r => r.total_po_to_valid != null && r.total_po_to_valid >= 0)
  .map(r => ({
    ot_po: r.ot_po, infor_pov: r.infor_pov, supplier: r.supplier, buyer: r.buyer, mpn: r.mpn,
    po_date: r.po_date,
    first_recv_date: r.first_recv_date,
    insp_opened_date: r.insp_opened_date,
    insp_validated_date: r.insp_validated_date,
    s1_po_to_recv: r.stage1_po_to_recv,
    s2_recv_to_lot: r.stage2_recv_to_lot,
    s3_lot_to_valid: r.stage3_lot_to_valid,
    total_po_to_valid: r.total_po_to_valid,
    otin_status: r.otin_status,
  })).sort((a,b) => (b.total_po_to_valid||0) - (a.total_po_to_valid||0));
const cycleCols = [
  {key:'ot_po', header:'OT PO#', width:11},
  {key:'infor_pov', header:'Infor POV', width:13},
  {key:'supplier', header:'Supplier', width:32},
  {key:'buyer', header:'Buyer', width:18},
  {key:'mpn', header:'MPN', width:28},
  {key:'po_date', header:'PO Date', width:11},
  {key:'first_recv_date', header:'First Recv', width:11},
  {key:'insp_opened_date', header:'Insp Opened', width:11},
  {key:'insp_validated_date', header:'Insp Validated', width:13},
  {key:'s1_po_to_recv', header:'Stage 1 (PO→Recv)', width:16, z:'#,##0'},
  {key:'s2_recv_to_lot', header:'Stage 2 (Recv→Lot)', width:16, z:'#,##0'},
  {key:'s3_lot_to_valid', header:'Stage 3 (Lot→Valid)', width:16, z:'#,##0'},
  {key:'total_po_to_valid', header:'Total (PO→Valid)', width:15, z:'#,##0'},
  {key:'otin_status', header:'OTIN Status', width:16},
];
const wsCycle = buildSheet(cycleRows, cycleCols);

// ---------- MFR Breakdown (cumulative, top 50) ----------
const mfrCols = [
  {key:'mfr', header:'Manufacturer', width:30},
  {key:'po_lines', header:'PO Lines', width:9, z:'#,##0'},
  {key:'supplier_count', header:'Suppliers', width:10, z:'#,##0'},
  {key:'customer_count', header:'Customers', width:10, z:'#,##0'},
  {key:'spend', header:'PO Spend', width:15, z:'$#,##0.00'},
  {key:'revenue', header:'Attrib Revenue', width:15, z:'$#,##0.00'},
  {key:'booked_gp', header:'Booked GP', width:15, z:'$#,##0.00'},
  {key:'booked_margin_pct', header:'Booked Margin', width:13, z:'0.0%'},
  {key:'validation_rate', header:'Validated %', width:11, z:'0.0%'},
  {key:'past_due_rate', header:'Past-Due %', width:11, z:'0.0%'},
];
const wsMfr = buildSheet(mfrRows, mfrCols);

// ---------- Conversion (per-CPC detail) ----------
// Sort so the converted CPCs lead, then partial conversions, then no conversion.
const convSorted = convRows.slice().sort((a,b) =>
  (b.converted - a.converted) || (b.had_po - a.had_po) || (b.had_soldcq - a.had_soldcq) || a.cpc.localeCompare(b.cpc)
);
const convCols = [
  {key:'cpc', header:'CPC', width:24},
  {key:'customers', header:'Customer(s)', width:36},
  {key:'had_po', header:'PO Placed', width:10},
  {key:'had_soldcq', header:'Sold CQ', width:10},
  {key:'converted', header:'Converted (both)', width:16},
];
const wsConv = buildSheet(convSorted, convCols);

// ---------- Assemble workbook ----------
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, wsSummary,  'Summary');
XLSX.utils.book_append_sheet(wb, wsOpen,     'Open Past-Due');
XLSX.utils.book_append_sheet(wb, wsMatrix,   'Buyer Status Matrix');
XLSX.utils.book_append_sheet(wb, wsBuyer,    'By Buyer');
XLSX.utils.book_append_sheet(wb, wsSupplier, 'By Supplier');
XLSX.utils.book_append_sheet(wb, wsCust,     'By Customer');
XLSX.utils.book_append_sheet(wb, wsMfr,      'MFR Breakdown');
XLSX.utils.book_append_sheet(wb, wsConv,     'Conversion');
XLSX.utils.book_append_sheet(wb, wsBench,    'Cycle Benchmarks');
XLSX.utils.book_append_sheet(wb, wsCycle,    'Cycle Times');
XLSX.utils.book_append_sheet(wb, wsAll,      'All Lines');
XLSX.writeFile(wb, OUT_XLSX);
console.log(`  ✓ ${OUT_XLSX}`);

// ---------------------------------------------------------------------------
// PowerPoint deck — 3 slides
// ---------------------------------------------------------------------------
const pptx = new PptxGenJS();
pptx.title = `PO Activity — ${PERIOD}`;
pptx.author = 'Astute Analytics';
pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5"

const ACCENT  = '1F4E79'; // dark blue
const ACCENT2 = '2E75B6'; // mid blue
const NEUTRAL = '595959';
const RED     = 'C00000';
const GREEN   = '548235';

function fmtMoney(v)   { return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtMoney2(v)  { return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(v)     { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function fmtNum(v)     { return v == null ? '—' : Number(v).toLocaleString('en-US'); }

// ---------- Slide 1: Headline ----------
{
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('PO Activity — Headline Metrics', { x:0.4, y:0.3, w:12.5, h:0.6, fontSize:28, bold:true, color:ACCENT });
  s.addText(PERIOD, { x:0.4, y:0.9, w:12.5, h:0.4, fontSize:16, color:NEUTRAL, italic:true });

  // KPI grid — 4 cols × 2 rows
  const kpis = [
    { label:'Distinct POVs',          value:fmtNum(distinctPovs) },
    { label:'PO Lines (parts)',       value:fmtNum(fact.length) },
    { label:'Suppliers',              value:fmtNum(distinctSuppliers) },
    { label:'Customers',              value:fmtNum(distinctCustomers) },
    { label:'PO Spend',               value:fmtMoney(totalSpend) },
    { label:'Attributed Revenue',     value:fmtMoney(totalRevenue) },
    { label:'Booked Margin',          value:fmtPct(totalRevenue>0 ? (totalRevenue-totalSpend)/totalRevenue : null) },
    { label:'VQ → PO+SO Conversion',  value:fmtPct(conversionPct) },
  ];
  const startX = 0.4, startY = 1.6, kpW = 3.05, kpH = 1.6, gap = 0.15;
  kpis.forEach((k, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = startX + col * (kpW + gap);
    const y = startY + row * (kpH + 0.25);
    s.addShape(pptx.ShapeType.rect, { x, y, w:kpW, h:kpH, fill:{color:'F2F2F2'}, line:{color:ACCENT2, width:1} });
    s.addText(k.value, { x, y:y+0.15, w:kpW, h:0.8, fontSize:30, bold:true, color:ACCENT, align:'center' });
    s.addText(k.label, { x, y:y+1.05, w:kpW, h:0.45, fontSize:13, color:NEUTRAL, align:'center' });
  });

  // Conversion narrative
  s.addText(
    `Of ${fmtNum(cpcsWithVq)} CPCs we sourced VQs for during ${PERIOD}, ${fmtNum(cpcsConverted)} (${fmtPct(conversionPct)}) ` +
    `converted to both a placed PO and a sold customer quote. ` +
    `${fmtNum(cpcsToPo)} CPCs received a PO; ${fmtNum(cpcsToSoldcq)} reached a sold CQ.`,
    { x:0.4, y:5.5, w:12.5, h:0.9, fontSize:13, color:NEUTRAL, italic:true }
  );
  s.addText(`Source: iDempiere replica, parts-only filter. As of ${TODAY}.`,
    { x:0.4, y:7.0, w:12.5, h:0.3, fontSize:10, color:'A0A0A0', align:'right' });
}

// ---------- Slide 2: Operational health ----------
{
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('Operational Health', { x:0.4, y:0.3, w:12.5, h:0.6, fontSize:28, bold:true, color:ACCENT });
  s.addText(`${PERIOD}  •  validation, delivery performance, cycle benchmarks`,
    { x:0.4, y:0.9, w:12.5, h:0.4, fontSize:14, color:NEUTRAL, italic:true });

  // Left: status / past-due tiles
  const validatedPct = fact.length>0 ? validated.length / fact.length : null;
  const pastDuePct   = fact.length>0 ? pastDue.length    / fact.length : null;
  const notRecvPct   = fact.length>0 ? notReceived.length / fact.length : null;

  const tiles = [
    { label:'Lines Validated', value:fmtPct(validatedPct), sub:`${fmtNum(validated.length)} of ${fmtNum(fact.length)}`, color:GREEN },
    { label:'Past Due',        value:fmtPct(pastDuePct),   sub:`${fmtNum(pastDue.length)} lines  •  ${fmtMoney(pastDue.reduce((s,r)=>s+(r.po_spend||0),0))} exposure`, color:RED },
    { label:'Not Received',    value:fmtPct(notRecvPct),   sub:`${fmtNum(notReceived.length)} lines  •  ${fmtMoney(openExposure)} open PO $`, color:ACCENT },
    { label:'Open SO at Risk', value:fmtMoney(openCommitRevenue), sub:'attributed SO revenue tied to NOT_RECEIVED lines', color:ACCENT },
  ];
  const tileX = 0.4, tileY = 1.6, tileW = 5.8, tileH = 1.2, gap = 0.18;
  tiles.forEach((t, i) => {
    const y = tileY + i * (tileH + gap);
    s.addShape(pptx.ShapeType.rect, { x:tileX, y, w:tileW, h:tileH, fill:{color:'F8F8F8'}, line:{color:t.color, width:2} });
    s.addText(t.value, { x:tileX+0.2, y:y+0.1, w:2.5, h:0.9, fontSize:30, bold:true, color:t.color });
    s.addText(t.label, { x:tileX+2.9, y:y+0.1, w:2.8, h:0.5, fontSize:14, bold:true, color:ACCENT });
    s.addText(t.sub,   { x:tileX+2.9, y:y+0.55, w:2.8, h:0.6, fontSize:11, color:NEUTRAL });
  });

  // Right: cycle benchmark table
  const cycleTbl = [
    [
      { text:'Cycle Stage (days)', options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}} },
      { text:'Median',  options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
      { text:'P75',     options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
      { text:'P90',     options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
      { text:'Max',     options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
    ],
    ...cycleBenchmarks.map(b => [
      { text:b.label, options:{} },
      { text:String(b.median ?? '—'), options:{align:'center'} },
      { text:String(b.p75 ?? '—'),    options:{align:'center'} },
      { text:String(b.p90 ?? '—'),    options:{align:'center'} },
      { text:String(b.max ?? '—'),    options:{align:'center'} },
    ]),
  ];
  s.addText('Cycle Benchmarks (validated lines only)', { x:6.5, y:1.6, w:6.5, h:0.4, fontSize:14, bold:true, color:ACCENT });
  s.addTable(cycleTbl, { x:6.5, y:2.05, w:6.5, fontSize:11, border:{type:'solid', color:'D0D0D0', pt:0.5}, colW:[3.1, 0.85, 0.85, 0.85, 0.85] });
  s.addText(`n = ${validatedOnly.length} validated lines.  Stage 1 = vendor lead + transit. Stage 2 = receipt → inspection bench. Stage 3 = inspection work.`,
    { x:6.5, y:5.6, w:6.5, h:0.9, fontSize:10, color:NEUTRAL, italic:true });

  s.addText(`Source: iDempiere replica. As of ${TODAY}.`,
    { x:0.4, y:7.0, w:12.5, h:0.3, fontSize:10, color:'A0A0A0', align:'right' });
}

// ---------- Slide 3: Concentration ----------
{
  const s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('Spend Concentration', { x:0.4, y:0.3, w:12.5, h:0.6, fontSize:28, bold:true, color:ACCENT });
  s.addText(`${PERIOD}  •  Top 10 manufacturers and suppliers by PO spend`,
    { x:0.4, y:0.9, w:12.5, h:0.4, fontSize:14, color:NEUTRAL, italic:true });

  // Top 10 MFRs
  const top10Mfr = mfrRows.slice(0, 10);
  const top10Supp = bySupplier.slice(0, 10);
  const grand = totalSpend;

  function makeTbl(title, rows, keyName, x, y, w) {
    s.addText(title, { x, y, w, h:0.4, fontSize:14, bold:true, color:ACCENT });
    const aoa = [
      [
        { text:'#',                              options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
        { text:keyName,                          options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}} },
        { text:'PO Lines',                       options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'center'} },
        { text:'PO Spend',                       options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'right'} },
        { text:'% of total',                     options:{bold:true, color:'FFFFFF', fill:{color:ACCENT}, align:'right'} },
      ],
      ...rows.map((r, i) => [
        { text:String(i+1),                                                          options:{align:'center'} },
        { text:r[keyName.toLowerCase().includes('manuf') ? 'mfr' : 'supplier'] || '(blank)', options:{} },
        { text:fmtNum(r[keyName.toLowerCase().includes('manuf') ? 'po_lines' : 'lines']),    options:{align:'center'} },
        { text:fmtMoney(r.spend),                                                    options:{align:'right'} },
        { text:fmtPct(grand>0 ? (r.spend||0)/grand : null),                          options:{align:'right'} },
      ]),
    ];
    s.addTable(aoa, { x, y:y+0.4, w, fontSize:10.5, border:{type:'solid', color:'D0D0D0', pt:0.5}, colW:[0.35, 2.65, 0.85, 1.4, 0.95] });
  }
  makeTbl('Top 10 Manufacturers', top10Mfr,  'Manufacturer', 0.4, 1.4, 6.2);
  makeTbl('Top 10 Suppliers',     top10Supp, 'Supplier',     6.8, 1.4, 6.2);

  // Concentration narrative
  const top10MfrSpend = top10Mfr.reduce((a,b)=>a+(b.spend||0), 0);
  const top10SuppSpend = top10Supp.reduce((a,b)=>a+(b.spend||0), 0);
  s.addText(
    `Top 10 MFRs = ${fmtPct(grand>0 ? top10MfrSpend/grand : null)} of spend.  ` +
    `Top 10 suppliers = ${fmtPct(grand>0 ? top10SuppSpend/grand : null)} of spend.  ` +
    `Long tail in raw workbook (MFR Breakdown + By Supplier tabs).`,
    { x:0.4, y:6.6, w:12.5, h:0.4, fontSize:11, color:NEUTRAL, italic:true }
  );
  s.addText(`Source: iDempiere replica. As of ${TODAY}.`,
    { x:0.4, y:7.0, w:12.5, h:0.3, fontSize:10, color:'A0A0A0', align:'right' });
}

pptx.writeFile({ fileName: OUT_PPTX }).then(() => {
  console.log(`  ✓ ${OUT_PPTX}`);

  // ---------------------------------------------------------------------------
  // Phase 3 summary
  // ---------------------------------------------------------------------------
  console.log(`\n[3/3] Done.`);
  console.log(`  Period:                 ${PERIOD}`);
  console.log(`  PO lines (parts):       ${fmtNum(fact.length)}`);
  console.log(`  Distinct POVs:          ${fmtNum(distinctPovs)}`);
  console.log(`  PO spend:               ${fmtMoney2(totalSpend)}`);
  console.log(`  Attributed revenue:     ${fmtMoney2(totalRevenue)}`);
  console.log(`  Booked margin:          ${fmtPct(totalRevenue>0 ? (totalRevenue-totalSpend)/totalRevenue : null)}`);
  console.log(`  Validation rate:        ${fmtPct(fact.length>0 ? validated.length/fact.length : null)}`);
  console.log(`  Past-due lines:         ${fmtNum(pastDue.length)}  (${fmtMoney(pastDue.reduce((s,r)=>s+(r.po_spend||0),0))} exposure)`);
  console.log(`  CPCs with VQ:           ${fmtNum(cpcsWithVq)}`);
  console.log(`  VQ→PO+SO converted:     ${fmtNum(cpcsConverted)} (${fmtPct(conversionPct)})`);
});
