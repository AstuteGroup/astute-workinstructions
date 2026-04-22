/**
 * Bootstrap loader for LAM Consignment static carryover.
 *
 * Reads `/tmp/lam_static/LAM CONSIGNMENT.xlsx` (104 MPNs, POV0071878, $2.14M)
 * and writes a single chuboe_offer + lines to OT with the description prefix
 * `[Carryover] LAM Consignment` so the weekly inventory_cleanup cron can find
 * it via `refreshStaticCarryoverOffers` lookup.
 *
 * BP + offer type mirror the existing LAM_Consignment weekly writer:
 *   - C_BPartner_ID = 1011267 (Astute - LAM Consignment)
 *   - Chuboe_Offer_Type_ID = 1000014
 *
 * After this runs, add LAM Consignment to STATIC_CARRYOVER_OFFERS with
 *   pairedWarehouses: ['W118'] so next Monday's cron reconciles it.
 *
 * File format (xlsx): Source | POV | MPN | MFR | Cost | Quantity | DateCode*
 *   *the "Date Code" column actually contains Cost × Quantity extended value,
 *    not date codes. We ignore that column.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const XLSX = require('xlsx');
const { writeOffer } = require('../../shared/offer-writeback');

const FILE = '/tmp/lam_static/LAM CONSIGNMENT.xlsx';
const BP_ID = 1011267;
const OFFER_TYPE_ID = 1000014;

(async () => {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets['Lam Consignment'];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const lines = rows.map(r => ({
    mpn: String(r.MPN || '').trim(),
    mfrText: String(r.MFR || '').trim(),
    qty: Number(r.Quantity) || 0,
    price: Number(r.Cost) || 0,
    description: String(r.POV || 'POV0071878').trim(),
  })).filter(l => l.mpn && l.qty > 0);

  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const totalValue = lines.reduce((s, l) => s + l.qty * l.price, 0);
  console.log(`Loaded ${lines.length} lines from ${FILE}`);
  console.log(`  Total qty: ${totalQty.toLocaleString()}`);
  console.log(`  Total value: $${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

  const today = new Date().toISOString().slice(0, 10);
  const description = `[Carryover] LAM Consignment — refreshed ${today}`;

  console.log(`\nWriting offer header + ${lines.length} lines...`);
  console.log(`  C_BPartner_ID:       ${BP_ID} (Astute - LAM Consignment)`);
  console.log(`  Chuboe_Offer_Type_ID:${OFFER_TYPE_ID}`);
  console.log(`  Description:         ${description}`);
  console.log('');

  const result = await writeOffer({
    bpartnerId: BP_ID,
    offerTypeId: OFFER_TYPE_ID,
    description,
    lines,
  });

  console.log(`\nResult:`);
  console.log(`  chuboe_offer_id: ${result.offerId}`);
  console.log(`  search_key:      ${result.searchKey}`);
  console.log(`  lines written:   ${result.linesWritten} / ${lines.length}`);
  if (result.errors && result.errors.length) {
    console.log(`  errors:          ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) console.log(`    ${e}`);
  }

  if (result.offerId) {
    console.log(`\nNext step: add to STATIC_CARRYOVER_OFFERS in inventory_cleanup.js:`);
    console.log(`  {`);
    console.log(`    label: 'LAM Consignment',`);
    console.log(`    bootstrapId: ${result.offerId},`);
    console.log(`    portalWarehouseName: 'Astute Electronics Inc. - LAM (Carryover)',`);
    console.log(`    pairedWarehouses: ['W118'],`);
    console.log(`  },`);
  }
})();
