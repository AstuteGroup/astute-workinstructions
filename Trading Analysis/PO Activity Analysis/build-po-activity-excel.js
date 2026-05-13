#!/usr/bin/env node
// Build comprehensive January 2026 PO analysis workbook.
// Reads /home/analytics_user/workspace/January_2026_POs.csv (parts-only — services excluded).
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const CSV_PATH = '/home/analytics_user/workspace/January_2026_POs.csv';
const OUT_PATH = '/home/analytics_user/workspace/January_2026_POs_Analysis.xlsx';

// ---- CSV parser (handles quoted fields with embedded commas / newlines) ----
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
  return rows;
}

const raw = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(raw).filter(r => r.length > 1);
const header = rows.shift();
const idx = Object.fromEntries(header.map((h,i)=>[h,i]));

function num(v) { if (v===''||v===null||v===undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null ? '' : String(v); }
function dateOnly(v) { if (!v) return null; return v.slice(0,10); }

const data = rows.map(r => ({
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
  // Per-PO attribution (avoids multi-PO over-counting on the same RFQ line)
  so_revenue:           num(r[idx.attributed_so_revenue]),
  so_latest_date:       dateOnly(r[idx.so_latest_date]),
  otin_lot:             str(r[idx.otin_lot]),
  insp_validated:       str(r[idx.insp_validated]),
  insp_processed:       str(r[idx.insp_processed]),
  insp_opened_date:     dateOnly(r[idx.insp_opened_date]),
  insp_validated_date:  dateOnly(r[idx.insp_validated_date]),
  receipt_picked_date:  dateOnly(r[idx.receipt_picked_date]),
}));

// ---- Derived calcs ----
const TODAY = new Date('2026-05-13');
function daysBetween(a,b) { if(!a||!b) return null; return Math.round((new Date(b) - new Date(a))/86400000); }
data.forEach(r => {
  r.po_spend         = (r.po_qty && r.po_price) ? r.po_qty * r.po_price : null;
  r.gp_dollars       = (r.so_revenue && r.po_spend) ? r.so_revenue - r.po_spend : null;
  r.margin_pct       = (r.so_revenue && r.so_revenue > 0 && r.po_spend != null) ? (r.so_revenue - r.po_spend) / r.so_revenue : null;
  r.days_late        = (r.delivery_status === 'past_due' && r.promise_date) ? daysBetween(r.promise_date, TODAY.toISOString().slice(0,10)) : null;

  // 4-stage cycle
  r.stage1_po_to_recv     = daysBetween(r.po_date,             r.first_recv_date);
  r.stage2_recv_to_lot    = daysBetween(r.first_recv_date,     r.insp_opened_date);
  r.stage3_lot_to_valid   = daysBetween(r.insp_opened_date,    r.insp_validated_date);
  r.total_po_to_valid     = daysBetween(r.po_date,             r.insp_validated_date);

  // Backward-compat for old tab name
  r.po_to_receipt_d  = r.stage1_po_to_recv;
  r.receipt_to_valid = daysBetween(r.first_recv_date, r.insp_validated_date);
});

// ---- Percentile helper ----
function pctl(arr, p) {
  const xs = arr.filter(x => x != null && Number.isFinite(x) && x >= 0).sort((a,b)=>a-b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)));
  return xs[i];
}
function summarize(label, arr) {
  return {
    label,
    n: arr.filter(x => x != null && Number.isFinite(x) && x >= 0).length,
    median: pctl(arr, 0.5),
    p75: pctl(arr, 0.75),
    p90: pctl(arr, 0.90),
    max: (() => { const xs = arr.filter(x => x != null && Number.isFinite(x)); return xs.length ? Math.max(...xs) : null; })(),
  };
}

// Pre-compute cycle benchmarks (validated lines only, so each stage has data)
const validatedOnly = data.filter(r => r.insp_validated === 'Y' && r.first_recv_date && r.insp_validated_date);
const cycleBenchmarks = [
  summarize('1. PO placed → first receipt',      validatedOnly.map(r => r.stage1_po_to_recv)),
  summarize('2. Receipt → inspection opened',    validatedOnly.map(r => r.stage2_recv_to_lot)),
  summarize('3. Inspection opened → validated',  validatedOnly.map(r => r.stage3_lot_to_valid)),
  summarize('Total: PO placed → validated',      validatedOnly.map(r => r.total_po_to_valid)),
];

// ---- xlsx writers with proper formatting ----
function buildSheet(rows, colDefs) {
  const headers = colDefs.map(c=>c.header);
  const aoa = [headers];
  rows.forEach(r => aoa.push(colDefs.map(c => r[c.key])));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // apply z + width
  const range = XLSX.utils.decode_range(ws['!ref']);
  ws['!cols'] = colDefs.map(c => ({ wch: c.width || 14 }));
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

// ---- Build aggregations ----
const partsOnly = data; // CSV already excludes services
const notReceived = partsOnly.filter(r => r.otin_status === 'NOT_RECEIVED');
const pastDue = partsOnly.filter(r => r.delivery_status === 'past_due');
const validated = partsOnly.filter(r => r.otin_status === 'VALIDATED');
const inInspection = partsOnly.filter(r => r.otin_status === 'RECEIVED_NO_LOT' || r.otin_status === 'LOT_OPEN');

const totalSpend = partsOnly.reduce((s,r)=>s+(r.po_spend||0), 0);
const totalRevenue = partsOnly.reduce((s,r)=>s+(r.so_revenue||0), 0);
const openExposure = notReceived.reduce((s,r)=>s+(r.po_spend||0), 0);
const openCommitRevenue = notReceived.reduce((s,r)=>s+(r.so_revenue||0), 0);

// Group helper
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
  const spend = rs.reduce((s,r)=>s+(r.po_spend||0), 0);
  const revenue = rs.reduce((s,r)=>s+(r.so_revenue||0), 0);
  const recv = rs.filter(r=>r.otin_status!=='NOT_RECEIVED').length;
  const val = rs.filter(r=>r.otin_status==='VALIDATED').length;
  const past = rs.filter(r=>r.delivery_status==='past_due').length;
  const trk = rs.filter(r=>r.po_tracking && r.po_tracking.trim()).length;
  const openExp = rs.filter(r=>r.otin_status==='NOT_RECEIVED').reduce((s,r)=>s+(r.po_spend||0), 0);
  const avgLate = (() => {
    const xs = rs.filter(r=>r.delivery_status==='past_due' && r.days_late!=null).map(r=>r.days_late);
    return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
  })();
  return {
    lines, distinct_povs: distinctPovs, spend, revenue,
    recv_pct: pct(recv, lines), val_pct: pct(val, lines),
    past_due_pct: pct(past, lines), tracking_pct: pct(trk, lines),
    open_exposure: openExp, avg_days_late: avgLate
  };
}

// ===================== SHEET 1: Summary =====================
const summaryRows = [
  ['January 2026 PO Activity — Comprehensive Analysis', ''],
  ['As of', TODAY.toISOString().slice(0,10)],
  ['Scope', 'POVs generated Jan 1 – Jan 31, 2026 (parts only — services / testing / fees excluded)'],
  ['', ''],
  ['—— Volume ——', ''],
  ['Distinct POVs',                 new Set(partsOnly.map(r=>r.infor_pov)).size],
  ['PO lines (parts only)',         partsOnly.length],
  ['Excluded service/testing lines','30 (pre-Excel)'],
  ['Distinct buyers',               new Set(partsOnly.map(r=>r.buyer).filter(Boolean)).size],
  ['Distinct suppliers',            new Set(partsOnly.map(r=>r.supplier).filter(Boolean)).size],
  ['Distinct customers',            new Set(partsOnly.map(r=>r.customer).filter(Boolean)).size],
  ['', ''],
  ['—— $ Economics ——', ''],
  ['Total PO spend (cost)',         totalSpend],
  ['Total tied SO revenue',         totalRevenue],
  ['Booked GP',                     totalRevenue - totalSpend],
  ['Booked margin',                 totalRevenue > 0 ? (totalRevenue - totalSpend) / totalRevenue : null],
  ['Open exposure (NOT_RECEIVED)',  openExposure],
  ['Open revenue at risk (NOT_RECEIVED w/ SO)', openCommitRevenue],
  ['', ''],
  ['—— OTIN Lifecycle ——', ''],
  ['VALIDATED (inspection done)',   validated.length],
  ['LOT_OPEN / RECEIVED_NO_LOT (awaiting inspection)', inInspection.length],
  ['NOT_RECEIVED (vendor delay)',   notReceived.length],
  ['', ''],
  ['—— Delivery Performance ——', ''],
  ['On-time (received)',            partsOnly.filter(r=>r.delivery_status==='received').length],
  ['Past-due (not received)',       pastDue.length],
  ['Due within 7 days',             partsOnly.filter(r=>r.delivery_status==='due_within_7d').length],
  ['Future-promise (not yet due)',  partsOnly.filter(r=>r.delivery_status==='future').length],
  ['No promise date',               partsOnly.filter(r=>r.delivery_status==='no_promise_date').length],
  ['Worst days late',               Math.max(...pastDue.map(r=>r.days_late||0), 0)],
  ['Median days late',              (()=>{ const xs = pastDue.map(r=>r.days_late||0).sort((a,b)=>a-b); return xs[Math.floor(xs.length/2)]; })()],
  ['', ''],
  ['—— Cycle Benchmarks (days, validated lines only) ——', `n=${validatedOnly.length}`],
  ['Stage', 'Median  /  P75  /  P90  /  Max'],
  ...cycleBenchmarks.map(b => [b.label, `${b.median}  /  ${b.p75}  /  ${b.p90}  /  ${b.max}`]),
  ['', ''],
  ['Interpretation', 'Stage 1 = vendor lead time + transit + dock-in.'],
  ['',               'Stage 2 = goods received → routed to inspection bench (staging).'],
  ['',               'Stage 3 = pure inspection cycle (queue + test/validate work).'],
];

const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
wsSummary['!cols'] = [{wch:46},{wch:24}];
// Format $ rows
const dollarRows = ['Total PO spend (cost)','Total tied SO revenue','Booked GP','Open exposure (NOT_RECEIVED)','Open revenue at risk (NOT_RECEIVED w/ SO)'];
const pctRows = ['Booked margin'];
summaryRows.forEach((r, i) => {
  if (dollarRows.includes(r[0])) {
    const cell = wsSummary[XLSX.utils.encode_cell({r:i, c:1})];
    if (cell) cell.z = '$#,##0.00';
  }
  if (pctRows.includes(r[0])) {
    const cell = wsSummary[XLSX.utils.encode_cell({r:i, c:1})];
    if (cell) cell.z = '0.0%';
  }
});

// ===================== SHEET 2: All POVs =====================
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
const wsAll = buildSheet(partsOnly, allCols);

// ===================== SHEET 3: Open / Past-Due =====================
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

// ===================== SHEET 4: By Buyer =====================
const buyerGroups = groupBy(partsOnly, r => r.buyer || '(no buyer)');
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

// ===================== SHEET 5: By Supplier =====================
const suppGroups = groupBy(partsOnly, r => r.supplier || '(no supplier)');
const bySupplier = [...suppGroups.entries()].map(([supplier, rs]) => ({ supplier, ...bucketStats(rs) }))
  .sort((a,b) => b.lines - a.lines);
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

// ===================== SHEET 6: By Customer =====================
const custGroups = groupBy(partsOnly.filter(r=>r.customer), r => r.customer);
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

// ===================== SHEET 7: Cycle Times — 4-stage =====================
const cycleRows = partsOnly.filter(r => r.total_po_to_valid != null && r.total_po_to_valid >= 0)
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

// ===================== SHEET 7b: Cycle Benchmarks tab =====================
const benchRows = [
  ['Cycle Stage','n','Median (d)','P75 (d)','P90 (d)','Max (d)'],
  ...cycleBenchmarks.map(b => [b.label, b.n, b.median, b.p75, b.p90, b.max]),
];
const wsBench = XLSX.utils.aoa_to_sheet(benchRows);
wsBench['!cols'] = [{wch:40},{wch:8},{wch:10},{wch:10},{wch:10},{wch:10}];

// ===================== SHEET 8: Status x Buyer matrix =====================
// Rows = buyer, Cols = OTIN status counts
const allStatuses = ['VALIDATED','LOT_OPEN','RECEIVED_NO_LOT','NOT_RECEIVED'];
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

// ---- Assemble workbook ----
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
XLSX.utils.book_append_sheet(wb, wsOpen, 'Open Past-Due');
XLSX.utils.book_append_sheet(wb, wsMatrix, 'Buyer Status Matrix');
XLSX.utils.book_append_sheet(wb, wsBuyer, 'By Buyer');
XLSX.utils.book_append_sheet(wb, wsSupplier, 'By Supplier');
XLSX.utils.book_append_sheet(wb, wsCust, 'By Customer');
XLSX.utils.book_append_sheet(wb, wsBench, 'Cycle Benchmarks');
XLSX.utils.book_append_sheet(wb, wsCycle, 'Cycle Times');
XLSX.utils.book_append_sheet(wb, wsAll, 'All Lines');
XLSX.writeFile(wb, OUT_PATH);

console.log(`Wrote ${OUT_PATH}`);
console.log(`Total parts-only lines: ${partsOnly.length}`);
console.log(`Distinct POVs: ${new Set(partsOnly.map(r=>r.infor_pov)).size}`);
console.log(`Past-due open lines: ${pastDue.length}, $ exposure: $${openExposure.toFixed(2)}`);
console.log(`Validated: ${validated.length}, In-inspection: ${inInspection.length}, Not received: ${notReceived.length}`);
