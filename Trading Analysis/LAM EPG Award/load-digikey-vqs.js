/**
 * Load 4 DigiKey VQs against RFQ 1132040 (LAM EPG).
 * Source: live API query, picked by Jake from the corrected sourcing report.
 *
 * Per Jake's "stock qty only" rule on partials: LCMXO2280C-3FTN256C buys
 * 30 of the 40 needed (DigiKey only has 30 stock); the remaining 10 stays
 * uncovered for next batch.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');
const { searchAllDistributors, extractStockAndLtRows } = require('../../shared/franchise-api');

const RFQ = '1132040';
const BUYER_ID = 1000004; // Jake Harris
const DIGIKEY_BP_SEARCH_KEY = '1002331';
const DIGIKEY_BP_LOCATION = 1000240;

const TIER2 = {
  C_BPartner_Location_ID:    DIGIKEY_BP_LOCATION,
  Chuboe_Warehouse_Group_ID: 1000008,  // BROWNSVILLE
  Chuboe_Warehouse_ID:       1000015,  // W111: LAM KITTING
  M_Shipper_ID:              1000003,  // FedEx Ground
  Chuboe_Inco_Term_ID:       1000000,  // EXW
  Chuboe_Packaging_ID:       1000010,  // OTHER
  DatePromised:              '2026-04-16',
  DueDate:                   '2026-04-16',
  IsPurchased:               'Y',
  Chuboe_Traceability_ID:    1000001,  // Authorized Distribution Certs (catalog)
};

// Lines: cpc and need from prior RFQ query; cap qty at min(need, stock)
const LINES = [
  { cpc: '668-A01540-026', mpn: '163A16959X',         need: 25 },
  { cpc: '630-114967-001', mpn: 'LCMXO2280C-3FTN256C', need: 40 },
  { cpc: '668-277308-002', mpn: '163A16159X',         need: 35 },
  { cpc: '668-A51618-026', mpn: '163A17059X',         need: 25 },
];

const written = [];

(async () => {
  console.log(`[digikey-vq] Loading ${LINES.length} DigiKey VQs to RFQ ${RFQ}\n`);

  // Pull live API data for each MPN, then call writeVQFromAPI with the
  // single-distributor result filtered to just DigiKey.
  for (const ln of LINES) {
    process.stdout.write(`  ${ln.mpn.padEnd(22)} need=${String(ln.need).padStart(3)} ... `);
    const all = await searchAllDistributors(ln.mpn, ln.need, { includeNoResults: true });
    const dk = (all.distributors || []).find(d => d.name === 'DigiKey' && d.found);
    if (!dk) { console.log('✗ no DigiKey hit'); continue; }

    // Inspect what extractStockAndLtRows would yield, and cap stock buy qty
    // at min(need, stock) per Jake's rule. We override the row qty by mutating
    // the distributor result's vqLines (which extractStockAndLtRows returns
    // directly when present).
    const rawRows = extractStockAndLtRows(dk, ln.mpn, ln.need) || [];
    if (rawRows.length === 0) { console.log('✗ no stock/LT rows'); continue; }

    // Pick the STOCK row only — partial means we buy only stock qty, NOT the LT row
    const stockRow = rawRows.find(r => !r.leadTime);
    if (!stockRow) { console.log('✗ no stock row'); continue; }

    const buyQty = Math.min(ln.need, Number(stockRow.qty));
    const partial = buyQty < ln.need;

    // Replace dk.vqLines with just the (potentially capped) stock row.
    // The wrapper returns vqLines as-is when present, so this gets the qty cap
    // through the writer cleanly.
    dk.vqLines = [{
      ...stockRow,
      qty: buyQty,
    }];

    const fr = { distributors: [dk] };
    const r = await writeVQFromAPI(RFQ, ln.cpc, fr, {
      searchedMpn: ln.mpn,
      buyerId: BUYER_ID,
      rfqQty: ln.need,
    });

    if (r.written.length) {
      const w = r.written[0];
      written.push({ ...ln, vqLineId: w.vqLineId, buyQty, partial, cost: stockRow.cost, eccn: dk.vqEccn, hts: dk.vqHts });
      console.log(`✓ vq=${w.vqLineId} ${partial?'PARTIAL':'full'} ${buyQty}/${ln.need} @ $${stockRow.cost}`);
    } else if (r.flagged.length) {
      console.log(`⚠ FLAGGED ${r.flagged[0].reason} ${r.flagged[0].detail.slice(0,80)}`);
    } else if (r.failed.length) {
      console.log(`✗ FAILED ${r.failed[0].reason} ${r.failed[0].detail.slice(0,80)}`);
    }
  }

  console.log(`\n[digikey-vq] Pass 1: ${written.length}/${LINES.length} written`);
  console.log(`[digikey-vq] Pass 2: Tier 2 patch`);
  for (const w of written) {
    try {
      await patchRecord('Chuboe_VQ_Line', w.vqLineId, TIER2);
      console.log(`  ${w.mpn.padEnd(22)} vq=${w.vqLineId} ✓ Tier 2`);
    } catch (e) {
      console.log(`  ${w.mpn.padEnd(22)} vq=${w.vqLineId} ✗ ${e.message.slice(0,160)}`);
    }
  }

  // Patch the malformed 3A991D ECCN on LCMXO2280C-3FTN256C if any
  console.log(`\n[digikey-vq] Pass 3: ECCN format fixes`);
  for (const w of written) {
    if (w.eccn && /^3A991D$/i.test(String(w.eccn).trim())) {
      try {
        await patchRecord('Chuboe_VQ_Line', w.vqLineId, { Chuboe_ECCN: '3A991.d' });
        console.log(`  ${w.mpn.padEnd(22)} ECCN ${w.eccn} → 3A991.d ✓`);
      } catch (e) {
        console.log(`  ${w.mpn.padEnd(22)} ECCN patch failed: ${e.message.slice(0,160)}`);
      }
    }
  }

  console.log(`\n[digikey-vq] Done. Written:`);
  for (const w of written) console.log(`  vq=${w.vqLineId}  line=?  ${w.mpn}  ${w.buyQty}/${w.need}${w.partial?' (PARTIAL)':''}  $${w.cost}`);
})().catch(e => { console.error(e); process.exit(1); });
