// Per-MPN audit of the active Eaton carryover offer (1026049) — joins
// carryover qty × this-week Infor (W117 + other) × open sales orders × shipped
// orders (chuboe_trackingnumbers populated). Writes XLSX and emails.

const { execSync } = require('child_process');
const { readCSVFile } = require('../../shared/csv-utils');
const XLSX = require('xlsx');

const SQL = `
WITH carryover AS (
  SELECT ol.chuboe_mpn AS mpn,
         MIN(ol.chuboe_mfr_text) AS carry_mfr,
         SUM(ol.qty) AS carry_qty,
         COUNT(*) AS dc_lines,
         MIN(ol.description) AS description,
         string_agg(DISTINCT COALESCE(ol.chuboe_date_code,'') , ';') FILTER (WHERE ol.chuboe_date_code IS NOT NULL AND ol.chuboe_date_code <> '') AS date_codes
  FROM adempiere.chuboe_offer o
  JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id
  WHERE o.value = '1026049' AND o.isactive='Y' AND ol.isactive='Y'
  GROUP BY ol.chuboe_mpn
),
orders_all AS (
  SELECT sv.chuboe_mpn AS mpn,
         SUM(sv.qtyentered) AS ord_qty,
         COUNT(DISTINCT sv.c_order_id) AS orders,
         MAX(sv.dateordered)::date AS last_order
  FROM adempiere.chuboe_adv_search_salesorderline_v sv
  WHERE sv.isactive='Y' AND sv.dateordered >= '2025-06-21'
  GROUP BY sv.chuboe_mpn
),
orders_shipped AS (
  SELECT sv.chuboe_mpn AS mpn,
         SUM(sv.qtyentered) AS shipped_qty,
         COUNT(DISTINCT sv.c_order_id) AS shipped_orders,
         MAX(sv.dateordered)::date AS last_shipped_order
  FROM adempiere.chuboe_adv_search_salesorderline_v sv
  WHERE sv.isactive='Y' AND sv.dateordered >= '2025-06-21'
    AND sv.chuboe_trackingnumbers IS NOT NULL AND sv.chuboe_trackingnumbers <> ''
  GROUP BY sv.chuboe_mpn
)
SELECT c.mpn, c.carry_mfr, c.carry_qty, c.dc_lines, c.date_codes, c.description,
       COALESCE(oa.ord_qty,0) AS ord_qty, COALESCE(oa.orders,0) AS orders, oa.last_order,
       COALESCE(os.shipped_qty,0) AS shipped_qty, COALESCE(os.shipped_orders,0) AS shipped_orders, os.last_shipped_order
FROM carryover c
LEFT JOIN orders_all oa ON oa.mpn = c.mpn
LEFT JOIN orders_shipped os ON os.mpn = c.mpn
ORDER BY c.carry_qty DESC;`;

const csvPath = '/tmp/eaton_audit_raw.csv';
const flatSQL = SQL.replace(/\n/g, ' ');
require('fs').writeFileSync('/tmp/eaton_audit.sql', `COPY (${flatSQL}) TO '${csvPath}' WITH (FORMAT CSV, HEADER true);`);
// COPY TO file path requires superuser; use \copy via -c with -o redirect instead
// Rbash blocks >, so use psql -o filename.
require('fs').writeFileSync('/tmp/eaton_audit_query.sql', flatSQL);
execSync(`psql -A -F',' -P footer=off -P format=csv -f /tmp/eaton_audit_query.sql -o ${csvPath}`, { stdio: 'inherit' });

const carryCSV = readCSVFile(csvPath);
console.log(`DB rows: ${carryCSV.rows.length}`);

// Infor signals from this week
const infor = readCSVFile('/tmp/Inventory 2026-04-20/inventory_cleaned_20260420110009..csv');
const iH = infor.headers;
const iItem = iH.indexOf('Item');
const iName = iH.indexOf('Name');
const iWh = iH.indexOf('Warehouse');
const iQty = iH.indexOf('Lot Quantity');
const iDC = iH.indexOf('Date Code');

const inforByMpn = new Map();
for (const row of infor.rows) {
    const mpn = (row[iItem] || '').trim();
    if (!mpn) continue;
    if (!inforByMpn.has(mpn)) inforByMpn.set(mpn, { w117Qty: 0, w117Mfrs: new Set(), w117DCs: new Set(), otherWhs: new Set(), otherQty: 0 });
    const agg = inforByMpn.get(mpn);
    const wh = (row[iWh] || '').trim();
    const qty = parseFloat((row[iQty] || '0').replace(/,/g, '')) || 0;
    if (wh === 'W117') {
        agg.w117Qty += qty;
        if (row[iName]) agg.w117Mfrs.add(row[iName].trim());
        if (row[iDC]) agg.w117DCs.add(row[iDC].trim());
    } else {
        agg.otherWhs.add(wh);
        agg.otherQty += qty;
    }
}

// Merge + classify
const dbH = carryCSV.headers;
const col = n => dbH.indexOf(n);
const out = [];
for (const r of carryCSV.rows) {
    const mpn = r[col('mpn')];
    const carry = parseFloat(r[col('carry_qty')]) || 0;
    const inf = inforByMpn.get(mpn) || { w117Qty: 0, w117Mfrs: new Set(), w117DCs: new Set(), otherWhs: new Set(), otherQty: 0 };
    const w117 = inf.w117Qty;
    const ordered = parseFloat(r[col('ord_qty')]) || 0;
    const shipped = parseFloat(r[col('shipped_qty')]) || 0;

    // Expected remaining after shipments: carry - shipped
    const expectedRemaining = carry - shipped;
    const w117VsExpected = expectedRemaining > 0 ? w117 / expectedRemaining : null;

    let state;
    if (w117 === 0 && inf.otherWhs.size === 0) {
        state = shipped > 0 ? 'not-in-infor-shipped' : (ordered > 0 ? 'not-in-infor-open-order' : 'not-in-infor-no-activity');
    } else if (w117 > 0) {
        if (w117VsExpected !== null && w117VsExpected >= 0.95 && w117VsExpected <= 1.05) state = 'match-after-ships';
        else if (w117 >= 0.95 * carry) state = 'match-raw';
        else if (w117 < 0.95 * carry && shipped > 0) state = 'w117-low-w-ships';    // low but we have shipment evidence
        else if (w117 < 0.95 * carry) state = 'w117-low-unexplained';               // low, nothing shipped per DB
        else state = 'w117-high';
    } else if (inf.otherWhs.size > 0) {
        state = 'in-other-wh-only';
    } else {
        state = 'other';
    }

    out.push({
        state,
        mpn,
        carry_mfr: r[col('carry_mfr')] || '',
        carry_qty: carry,
        dc_lines: parseInt(r[col('dc_lines')], 10) || 1,
        w117_qty: w117,
        w117_mfr: [...inf.w117Mfrs].join(';'),
        w117_dc: [...inf.w117DCs].join(';'),
        other_wh: [...inf.otherWhs].join(';'),
        other_qty: inf.otherQty,
        ordered_10mo: ordered,
        orders_count: parseInt(r[col('orders')], 10) || 0,
        last_order: r[col('last_order')] || '',
        shipped_10mo: shipped,
        shipped_orders: parseInt(r[col('shipped_orders')], 10) || 0,
        last_shipped_order: r[col('last_shipped_order')] || '',
        expected_remaining: expectedRemaining,
        w117_vs_expected_pct: w117VsExpected !== null ? Math.round(w117VsExpected * 100) : '',
        date_codes: r[col('date_codes')] || '',
        description: (r[col('description')] || '').slice(0, 50),
    });
}

const stateOrder = {
    'w117-low-w-ships': 1,
    'w117-low-unexplained': 2,
    'w117-high': 3,
    'match-raw': 4,
    'match-after-ships': 5,
    'not-in-infor-shipped': 6,
    'not-in-infor-open-order': 7,
    'in-other-wh-only': 8,
    'not-in-infor-no-activity': 9,
    'other': 99,
};
out.sort((a, b) => (stateOrder[a.state] || 99) - (stateOrder[b.state] || 99) || b.carry_qty - a.carry_qty);

// XLSX
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(out);
ws['!cols'] = [
    { wch: 26 }, { wch: 24 }, { wch: 24 }, { wch: 10 }, { wch: 5 },
    { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 9 },
    { wch: 11 }, { wch: 6 }, { wch: 11 }, { wch: 11 }, { wch: 6 }, { wch: 12 },
    { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 40 },
];
const numericCols = ['carry_qty', 'w117_qty', 'other_qty', 'ordered_10mo', 'shipped_10mo', 'expected_remaining'];
for (let r = 1; r <= out.length; r++) {
    for (const colName of numericCols) {
        const c = Object.keys(out[0]).indexOf(colName);
        const cell = ws[XLSX.utils.encode_cell({ c, r })];
        if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    }
}
XLSX.utils.book_append_sheet(wb, ws, 'Audit');

const stateCounts = {};
for (const row of out) stateCounts[row.state] = (stateCounts[row.state] || 0) + 1;
const legend = [
    { state: 'w117-low-w-ships',        meaning: 'W117 qty below carryover, BUT shipments exist — likely explainable' },
    { state: 'w117-low-unexplained',    meaning: 'W117 qty below carryover, NO shipment evidence — investigate (stale carryover? missing ship records?)' },
    { state: 'w117-high',               meaning: 'W117 qty higher than carryover — extra consignment received beyond original' },
    { state: 'match-raw',               meaning: 'W117 ≈ carryover ±5% — clean full receipt, safe to retire' },
    { state: 'match-after-ships',       meaning: 'W117 ≈ (carryover − shipped) ±5% — reconciles with shipment history' },
    { state: 'not-in-infor-shipped',    meaning: 'Not in Infor anywhere, but shipments recorded — sold through' },
    { state: 'not-in-infor-open-order', meaning: 'Not in Infor, sales order exists but no tracking — awaiting receipt/dispatch' },
    { state: 'in-other-wh-only',        meaning: 'Appears in Infor in a non-W117 warehouse — worth investigating' },
    { state: 'not-in-infor-no-activity',meaning: 'No signal anywhere — still at Eaton presumably, carryover qty unverified' },
];
const summary = [
    { metric: 'Total carryover MPNs', value: out.length },
    { metric: 'Total carryover qty',  value: out.reduce((s, r) => s + r.carry_qty, 0) },
    { metric: '', value: '' },
    ...legend.map(l => ({ metric: l.state, value: stateCounts[l.state] || 0, meaning: l.meaning })),
];
const wsSum = XLSX.utils.json_to_sheet(summary);
wsSum['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 80 }];
XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

const outPath = '/tmp/eaton_carryover_audit_2026-04-21.xlsx';
XLSX.writeFile(wb, outPath);
console.log(`Wrote ${outPath}`);
console.log('State breakdown:');
for (const [s, n] of Object.entries(stateCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(30)} ${n}`);
}
