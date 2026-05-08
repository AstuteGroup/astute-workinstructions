/**
 * Load 2 Amatom VQs against RFQ 1132040 (LAM EPG).
 *
 * Source: vq inbox email #8331 — Amatom quote from Earlene Watrous, 03/31/26
 *   18130B-S-0632-28  105 @ $10.07 EA  (stock; 3800 in stock)
 *   18126B-S-0632-28   85 @ $12.19 EA  (9-10 weeks lead time)
 *
 * 9724-SS-0256-7 NOT included (no qty in SIPOC; user said "two parts").
 *
 * Buyer: Jake Harris (1000004)
 * Ship: BROWNSVILLE / W111: LAM KITTING / FedEx Ground / EXW (US-domestic)
 * Promise: 2026-04-16 (stock line) / 2026-06-18 (10-week line)
 * HTS/ECCN: ECCN=EAR99 (commodity mechanical hardware), HTS blank
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');

const RFQ = '1132040';
const BUYER_ID = 1000004;
const AMATOM_BP_SEARCH_KEY = '1004734';

const COMMON_TIER2 = {
  C_BPartner_Location_ID:    1003360,  // Amatom Cromwell, CT
  Chuboe_Warehouse_Group_ID: 1000008,  // BROWNSVILLE
  Chuboe_Warehouse_ID:       1000015,  // W111: LAM KITTING
  M_Shipper_ID:              1000003,  // FedEx Ground
  Chuboe_Inco_Term_ID:       1000000,  // EXW
  Chuboe_Packaging_ID:       1000010,  // OTHER
  IsPurchased:               'Y',
};

const LINES = [
  {
    cpc:  '723-097621-068',
    mpn:  '18130B-S-0632-28',
    mfr:  'Amatom',
    qty:  105,
    cost: 10.07,
    leadTime: 'stock',
    notes: 'STOCK (3800 on hand at Amatom; LAM target $17.50)',
    promise: '2026-04-16',
  },
  {
    cpc:  '723-097621-043',
    mpn:  '18126B-S-0632-28',
    mfr:  'Amatom',
    qty:  85,
    cost: 12.19,
    leadTime: '9-10 weeks',
    notes: '9-10 week lead time; LAM target $19.75; NCNR per quote',
    promise: '2026-06-18', // 10 weeks from today
  },
];

const written = [];

(async () => {
  console.log(`[amatom-vq] Loading ${LINES.length} VQs to RFQ ${RFQ}\n`);

  for (const ln of LINES) {
    const franchiseResults = {
      distributors: [{
        found: true,
        name: 'Amatom',
        bpValue: AMATOM_BP_SEARCH_KEY,
        vqMpn: ln.mpn,
        vqManufacturer: ln.mfr,
        franchiseRfqPrice: ln.cost,
        vqPrice: ln.cost,
        franchiseQty: ln.qty,
        vqLeadTime: ln.leadTime,
        vqVendorNotes: ln.notes,
        vqEccn: 'EAR99',
        vqHts: null,
      }],
    };
    process.stdout.write(`  ${ln.mpn.padEnd(20)} qty=${String(ln.qty).padStart(3)} cost=$${String(ln.cost).padStart(7)} lt=${ln.leadTime.padEnd(11)} `);
    try {
      const r = await writeVQFromAPI(RFQ, ln.cpc, franchiseResults, {
        searchedMpn: ln.mpn,
        buyerId: BUYER_ID,
        // Force date code default since vendor type 1000013 (New/Ungraded) isn't in MFR_DIRECT_OR_FRANCHISE
        dateCode: 'within 2 years',
      });
      if (r.written.length) {
        const w = r.written[0];
        written.push({ ...ln, vqLineId: w.vqLineId });
        console.log(`✓ vq=${w.vqLineId}`);
      } else if (r.flagged.length) {
        console.log(`⚠ FLAGGED ${r.flagged[0].reason} ${r.flagged[0].detail.slice(0,80)}`);
      } else if (r.failed.length) {
        console.log(`✗ FAILED ${r.failed[0].reason} ${r.failed[0].detail.slice(0,80)}`);
      }
    } catch (e) {
      console.log(`✗ EXCEPTION ${e.message.slice(0,160)}`);
    }
  }

  console.log(`\n[amatom-vq] Pass 1: ${written.length}/${LINES.length} written`);
  console.log(`[amatom-vq] Pass 2: Tier 2 patch + IsPurchased=Y`);
  for (const w of written) {
    const patch = { ...COMMON_TIER2, DatePromised: w.promise, DueDate: w.promise };
    try {
      await patchRecord('Chuboe_VQ_Line', w.vqLineId, patch);
      console.log(`  ${w.mpn.padEnd(20)} vq=${w.vqLineId} ✓ Tier 2 (promise=${w.promise})`);
    } catch (e) {
      console.log(`  ${w.mpn.padEnd(20)} vq=${w.vqLineId} ✗ ${e.message.slice(0,160)}`);
    }
  }

  console.log('\n[amatom-vq] Done.');
})().catch(e => { console.error(e); process.exit(1); });
