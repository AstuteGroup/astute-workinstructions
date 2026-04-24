#!/usr/bin/env node
/**
 * Fill a CRMA form from an OT sales-order #.
 *
 * Usage:
 *   node fill-form.js \
 *     --so SO506499 \
 *     --line 10 \
 *     --rma-qty 8 \
 *     --reason 'DMG - Damaged item(s)' \
 *     --root-cause Carrier \
 *     --disposition 'Credit and Replace' \
 *     --explanation 'Customer received 8 pcs broken in transit (UPS 1Z…). Customer authorized to scrap in place — no physical return required. Astute issuing 8 pc replacement at no charge.' \
 *     --src   tmp/crma-<ts>/CRMA\ Request\ Form\ 2023.06.xlsx \
 *     --out   tmp/CRMA_<so>.xlsx
 *
 * If --line is omitted the first line on the SO is used. If --rma-qty is omitted, the full ordered qty is used.
 *
 * The four Infor-only fields (Customer Code, Astute Invoice #, Infor Item #, Lot Number) are always left blank for the buyer.
 *
 * See ./crma-form.md for cell map, dropdown source ranges, and the disposition convention for "scrap + replace".
 */
const XLSX = require('xlsx');
const { Pool } = require('pg');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const opts = {
  so:          arg('--so'),
  line:        arg('--line'),
  rmaQty:      arg('--rma-qty'),
  reason:      arg('--reason'),
  rootCause:   arg('--root-cause'),
  disposition: arg('--disposition'),
  returnVia:   arg('--return-via', ''),
  explanation: arg('--explanation', ''),
  src:         arg('--src'),
  out:         arg('--out')
};

for (const k of ['so', 'reason', 'rootCause', 'disposition', 'src', 'out']) {
  if (!opts[k]) { console.error(`Missing required arg: --${k}`); process.exit(1); }
}

const pool = new Pool({
  database: 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
});

(async () => {
  // 1. Header + line lookup
  const headerSql = `
    SELECT o.c_order_id, o.documentno, o.poreference, o.dateordered,
           bp.c_bpartner_id, bp.value AS bp_search_key, bp.name AS customer_name,
           bp.referenceno AS infor_c_code,
           u.name AS salesperson
      FROM adempiere.c_order o
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
      LEFT JOIN adempiere.ad_user u ON u.ad_user_id = o.salesrep_id
     WHERE o.documentno = $1 AND o.issotrx='Y' AND o.isactive='Y'`;
  const hr = (await pool.query(headerSql, [opts.so])).rows[0];
  if (!hr) { console.error(`SO not found: ${opts.so}`); process.exit(1); }

  const lineSql = `
    SELECT ol.line, ol.qtyentered, ol.priceentered,
           ol.chuboe_co_string, ol.chuboe_mpn, mfr.name AS mfr,
           ol.chuboe_trackingnumbers, ol.chuboe_rfq_line_id
      FROM adempiere.c_orderline ol
      LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = ol.chuboe_mfr_id
     WHERE ol.c_order_id = $1 AND ol.isactive='Y'
       ${opts.line ? 'AND ol.line = $2' : ''}
     ORDER BY ol.line`;
  const lineParams = opts.line ? [hr.c_order_id, parseInt(opts.line, 10)] : [hr.c_order_id];
  const lr = (await pool.query(lineSql, lineParams)).rows[0];
  if (!lr) { console.error(`No line found on ${opts.so}${opts.line ? ` line ${opts.line}` : ''}`); process.exit(1); }

  // 2. Winning VQ cost
  const vqSql = `
    SELECT cost FROM adempiere.chuboe_vq_line
     WHERE chuboe_rfq_line_id = $1 AND ispurchased='Y' AND isactive='Y'
     LIMIT 1`;
  const vq = (await pool.query(vqSql, [lr.chuboe_rfq_line_id])).rows[0];
  const lotUnitCost = vq ? parseFloat(vq.cost) : null;

  // 3. Customer contact
  const contactSql = `
    SELECT name, email, phone FROM adempiere.ad_user
     WHERE c_bpartner_id = $1 AND isactive='Y'
     ORDER BY name LIMIT 1`;
  const contact = (await pool.query(contactSql, [hr.c_bpartner_id])).rows[0] || {};

  await pool.end();

  // 4. Fill the form
  const wb = XLSX.readFile(opts.src, { cellDates: true, cellStyles: true });
  const ws = wb.Sheets['Sheet1'];

  const setCell = (addr, value, z) => {
    const c = { ...(ws[addr] || {}) };
    c.v = value;
    c.t = (typeof value === 'number') ? 'n' : (value instanceof Date ? 'd' : 's');
    if (z) c.z = z;
    delete c.f; delete c.w;
    ws[addr] = c;
  };

  const rmaQty = opts.rmaQty ? parseInt(opts.rmaQty, 10) : parseFloat(lr.qtyentered);

  setCell('C3', hr.salesperson || '');
  setCell('H3', hr.customer_name || '');
  setCell('C5', lr.chuboe_co_string || '');                   // Astute COV = Infor COV
  // H5 Customer Code → leave blank if no Infor C-format on file
  if (hr.infor_c_code) setCell('H5', hr.infor_c_code);
  setCell('C6', parseInt(lr.line, 10), '0');
  setCell('C8', new Date(), 'mm/dd/yyyy');
  // H8 Invoice # — leave blank for buyer
  // C10 Infor Item # — leave blank for buyer

  // Lot detail row
  // C13 Lot Number — leave blank for buyer
  setCell('E13', rmaQty, '#,##0');
  setCell('F13', parseFloat(lr.priceentered), '$#,##0.00');
  if (lotUnitCost != null) setCell('G13', lotUnitCost, '$#,##0.00');

  setCell('C17', opts.reason);          // dropdown
  setCell('H17', opts.rootCause);       // dropdown
  setCell('C19', opts.disposition);     // dropdown
  if (opts.returnVia) setCell('H19', opts.returnVia);
  if (opts.explanation) setCell('C21', opts.explanation);

  if (contact.name)  setCell('C28', contact.name);
  if (contact.email) setCell('C29', contact.email);
  if (contact.phone) setCell('C30', contact.phone);

  XLSX.writeFile(wb, opts.out, { bookType: 'xlsx', cellStyles: true });
  console.log(`Wrote: ${opts.out}`);
  console.log(`SO ${opts.so} / COV ${lr.chuboe_co_string} / Line ${lr.line} / ${lr.chuboe_mpn} (${lr.mfr || '?'})`);
  console.log(`Customer: ${hr.customer_name} | RMA qty: ${rmaQty} | Selling: $${lr.priceentered} | Lot cost: ${lotUnitCost != null ? '$' + lotUnitCost : 'N/A'}`);
  console.log(`Left blank for buyer: Customer Code${hr.infor_c_code ? '' : ' (no Infor C-code in OT)'}, Astute Invoice #, Infor Item #, Lot Number(s)`);
})().catch(e => { console.error(e.message); process.exit(1); });
