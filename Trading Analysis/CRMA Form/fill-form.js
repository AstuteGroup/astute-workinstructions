#!/usr/bin/env node
/**
 * Fill a CRMA form from an OT sales-order #.
 *
 * Uses surgical zip-level cell patch (xlsx-patcher.js) — modifies ONLY the
 * target cell values in xl/worksheets/sheet1.xml. All other zip entries
 * (custom XML, drawings, printer settings, data validations, styles, theme)
 * are preserved byte-for-byte. Critical: dropdowns, branding, and print
 * layout must survive intact since the form goes straight to operations.
 *
 * Usage:
 *   node fill-form.js \
 *     --so SO506499 \
 *     --line 10 \
 *     --rma-qty 8 \
 *     --reason 'DMG - Damaged item(s)' \
 *     --root-cause Carrier \
 *     --disposition 'Credit and Replace' \
 *     --explanation 'Customer received 8 pcs broken in transit (UPS 1Z…). …' \
 *     --src   tmp/crma-<ts>/CRMA\ Request\ Form\ 2023.06.xlsx \
 *     --out   tmp/CRMA_<so>.xlsx
 *
 * If --line is omitted the first line on the SO is used. If --rma-qty is
 * omitted, the full ordered qty is used.
 *
 * The four Infor-only fields (Customer Code, Astute Invoice #, Infor Item #,
 * Lot Number) are always left blank for the buyer.
 */
const { Pool } = require('pg');
const { patchXlsx } = require('./xlsx-patcher');

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
  host: '/var/run/postgresql',                // Unix socket peer auth — no password needed
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
});

(async () => {
  // 1. Header lookup
  const hr = (await pool.query(`
    SELECT o.c_order_id, o.documentno, o.poreference, o.dateordered,
           bp.c_bpartner_id, bp.value AS bp_search_key, bp.name AS customer_name,
           bp.referenceno AS infor_c_code,
           u.name AS salesperson
      FROM adempiere.c_order o
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
      LEFT JOIN adempiere.ad_user u ON u.ad_user_id = o.salesrep_id
     WHERE o.documentno = $1 AND o.issotrx='Y' AND o.isactive='Y'`, [opts.so])).rows[0];
  if (!hr) { console.error(`SO not found: ${opts.so}`); process.exit(1); }

  // 2. Line lookup
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
  if (!lr) { console.error(`No line on ${opts.so}${opts.line ? ` line ${opts.line}` : ''}`); process.exit(1); }

  // 3. Winning VQ cost
  const vq = (await pool.query(`
    SELECT cost FROM adempiere.chuboe_vq_line
     WHERE chuboe_rfq_line_id = $1 AND ispurchased='Y' AND isactive='Y'
     LIMIT 1`, [lr.chuboe_rfq_line_id])).rows[0];
  const lotUnitCost = vq ? parseFloat(vq.cost) : null;

  // 4. Customer contact (first active user on the BP)
  const contact = (await pool.query(`
    SELECT name, email, phone FROM adempiere.ad_user
     WHERE c_bpartner_id = $1 AND isactive='Y'
     ORDER BY name LIMIT 1`, [hr.c_bpartner_id])).rows[0] || {};

  await pool.end();

  // 5. Build cell update map
  const rmaQty = opts.rmaQty ? parseInt(opts.rmaQty, 10) : parseFloat(lr.qtyentered);
  // Customer Code: prefer Infor C-format from referenceno; fall back to BP value (search key)
  const customerCode = hr.infor_c_code || hr.bp_search_key;
  // COV line numbering: Infor uses 1, 2, 3...; OT uses 10, 20, 30... — divide
  const otLine = parseInt(lr.line, 10);
  const covLine = otLine % 10 === 0 ? otLine / 10 : otLine;
  // RMA date: write as mm/dd/yyyy STRING (form has no custom date numFmt; raw serial would render as a number)
  const today = new Date();
  const rmaDate = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
  // Package details: default to a single box (form requires both fields per ops convention)
  const pkgType = arg('--pkg-type', 'Box');
  const pkgQty  = parseInt(arg('--pkg-qty', '1'), 10);

  const updates = {
    'C3':  hr.salesperson || null,
    'H3':  hr.customer_name || null,
    'C5':  lr.chuboe_co_string || null,           // Astute COV = Infor COV
    'H5':  customerCode,                          // Infor C-code OR BP search key
    'C6':  covLine,                               // Infor COV line numbering (not OT line)
    'C8':  rmaDate,                               // mm/dd/yyyy string
    // H8 Astute Invoice Number — buyer provides
    'C10': lr.chuboe_mpn || null,                 // Infor Item Number = MPN (part number from c_orderline)
    // C13 Lot Number(s) — buyer provides (Infor allocates at ship time)
    'E13': rmaQty,
    'F13': parseFloat(lr.priceentered),
    'G13': lotUnitCost,
    'C17': opts.reason,                           // dropdown
    'H17': opts.rootCause,                        // dropdown
    'C19': opts.disposition,                      // dropdown
    'H19': opts.returnVia || null,                // dropdown; blank if no return
    'C21': opts.explanation || null,
    'C28': contact.name || null,
    'C29': contact.email || null,
    'C30': contact.phone || null,
    'H28': pkgType,                               // Package Type dropdown (Box/Pallet/Other)
    'H29': pkgQty                                 // Package Quantity
  };

  // 6. Surgical patch
  const stats = patchXlsx(opts.src, opts.out, updates);

  console.log(`Wrote: ${opts.out}`);
  console.log(`SO ${opts.so} / COV ${lr.chuboe_co_string} / Line ${lr.line} / ${lr.chuboe_mpn} (${lr.mfr || '?'})`);
  console.log(`Customer: ${hr.customer_name} | RMA qty: ${rmaQty} | Selling: $${lr.priceentered} | Lot cost: ${lotUnitCost != null ? '$' + lotUnitCost : 'N/A'}`);
  console.log(`OT line ${otLine} → COV line ${covLine}`);
  console.log(`Cells updated: ${stats.updated.length} (${stats.updated.join(', ')})`);
  if (stats.inserted.length) console.log(`Cells inserted: ${stats.inserted.length} (${stats.inserted.join(', ')})`);
  console.log(`Left blank for buyer: Astute Invoice #, Lot Number(s)`);
})().catch(e => { console.error(e.message); process.exit(1); });
