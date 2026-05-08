/**
 * Load Tracy's 15 broker VQs against RFQ 1132040 (LAM EPG).
 *
 * Source: vq inbox email #8341 "tracy to buy", attachment "tracy to buy.csv"
 * Buyer: Tracy Xie (1009477)
 * Ship: Hong Kong / ALLOCATED-PRESOLD / FedEx International Economy / EXW
 * Promise/Due: 2026-04-16 (today + 5 business days, all stock)
 *
 * Rebalance shifted from XCZU4CG (originally) to XC6SLX100-3FGG484C:
 *   EPM240T100C4N    booked at LAM target $22.39   (Smartel real $27.00)
 *   LTC4231HMS-1#PBF booked at LAM target $7.3282  (Smartel real $8.25)
 *   XC6SLX100-3FGG484C booked at $53.4463          (Smartel real $41.00, absorbs $124.46)
 *   XCZU4CG-1SFVC784E booked at $342.00            (Smartel real, no rebalance)
 * Smartel total unchanged at $2,948.75 across the 4 lines.
 *
 * Restricted (5A002.A.4): XCZU4CG-1SFVC784E loaded as VQ but NOT marked
 * IsPurchased=Y; held in OT pending compliance review.
 *
 * HTS/ECCN populated from earlier sweep (tracy-hts-eccn.json).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');

const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');

const RFQ = '1132040';
const BUYER_ID = 1009477; // Tracy Xie

// Country IDs (from c_country)
const COO = { Taiwan: 316, Malaysia: 238, Philippines: 278 };

// HTS/ECCN sweep results from tracy-hts-eccn.json
const sweepRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracy-hts-eccn.json'), 'utf8'));
const sweep = {};
for (const r of sweepRaw) sweep[r.mpn] = { hts: r.hts?.[0] || null, eccn: r.eccn?.[0] || null };

// Tier 2 / common patch defaults for HK-bound, ALLOCATED-PRESOLD shipments
const TIER2 = {
  Chuboe_Warehouse_Group_ID: 1000001,  // HONG KONG
  Chuboe_Warehouse_ID:       1000000,  // ALLOCATED/PRESOLD
  M_Shipper_ID:              1000049,  // FedEx International Economy
  Chuboe_Inco_Term_ID:       1000000,  // EXW
  DatePromised:              '2026-04-16',
  DueDate:                   '2026-04-16',
  Chuboe_Packaging_ID:       1000010,  // OTHER
  IsPurchased:               'Y',
};

// Per-supplier BP location overrides (for the Tier 2 patch)
const BP_LOCATION = {
  '1006857': 1005757,  // Smartel (V013009 HK)
  '1005255': 1003929,  // HK Firsttop
  '1006247': 1004978,  // Dragon Core
  '1012507': 1014881,  // Chip Energy
};

// The 15 lines, in CSV order
const LINES = [
  { cpc:'630-047972-001', mpn:'EPM1270T144C4N',     mfr:'Altera',  bpSK:'1006857', qty:10,  cost:74.50,    dc:'25+',          notes:'Listed as INTEL manufacturer; STOCK' },
  { cpc:'630-048308-001', mpn:'EPM240T100C4N',      mfr:'Altera',  bpSK:'1006857', qty:20,  cost:22.39,    dc:'19+',          notes:'STOCK (booked at LAM target; rebalanced from $27)' },
  { cpc:'630-337161-001', mpn:'5M1270ZT144C5N',     mfr:'Altera',  bpSK:'1006247', qty:10,  cost:6.18,     dc:'22+',          notes:'STOCK' },
  // RESTRICTED — load VQ but DO NOT patch Tier 2 / IsPurchased (compliance hold)
  { cpc:'630-337692-003', mpn:'XCZU4CG-1SFVC784E',  mfr:'Xilinx',  bpSK:'1006857', qty:5,   cost:342.00,   dc:'22+', coo:COO.Taiwan, notes:'Stock; ECCN 5A002.A.4 — compliance review pending', restricted:true },
  { cpc:'631-123367-001', mpn:'XC6SLX100-3FGG484C', mfr:'Xilinx',  bpSK:'1006857', qty:10,  cost:53.4463,  dc:'22+',          notes:'STOCK (absorbs rebalance from EPM240+LTC4231; real Smartel $41.00)' },
  { cpc:'630-052043-001', mpn:'LT1499CS#PBF',       mfr:'ADI',     bpSK:'1012507', qty:50,  cost:12.062,   dc:'23+', coo:COO.Malaysia,   notes:'' },
  { cpc:'630-B70151-001', mpn:'ADA4891-2ARZ',       mfr:'ADI',     bpSK:'1005255', qty:120, cost:1.04,     dc:'21+', coo:COO.Philippines, notes:'Quoted MPN: ADA4891-2ARZ-R7' },
  { cpc:'630-311294-001', mpn:'LT8645SEV#PBF',      mfr:'ADI',     bpSK:'1006247', qty:25,  cost:4.63,     dc:'22+',          notes:'STOCK' },
  { cpc:'630-198438-001', mpn:'AD5696RBRUZ',        mfr:'ADI',     bpSK:'1006857', qty:15,  cost:15.25,    dc:'22+',          notes:'Quoted MPN: AD5696RBRUZ-RL7; COO exclusion: not China' },
  { cpc:'630-017794-002', mpn:'LT1376HVIS#PBF',     mfr:'ADI',     bpSK:'1006857', qty:20,  cost:9.60,     dc:'22+',          notes:'STOCK' },
  { cpc:'630-900073-001', mpn:'AD586KRZ',           mfr:'ADI',     bpSK:'1006857', qty:25,  cost:8.31,     dc:'25+',          notes:'Quoted MPN: AD586KRZ-REEL7; STOCK' },
  { cpc:'630-099973-001', mpn:'ADG431BRZ',          mfr:'ADI',     bpSK:'1006247', qty:35,  cost:6.18,     dc:'22+',          notes:'Quoted MPN: ADG431BRZ-REEL7; STOCK' },
  { cpc:'630-341691-001', mpn:'LTC4231HMS-1#PBF',   mfr:'ADI',     bpSK:'1006857', qty:35,  cost:7.3282,   dc:'21+',          notes:'STOCK (booked at LAM target; rebalanced from $8.25)' },
  { cpc:'630-343681-001', mpn:'AD5292BRUZ-20',      mfr:'ADI',     bpSK:'1012507', qty:40,  cost:5.778,    dc:'23+', coo:COO.Malaysia,   notes:'Quoted MPN: AD5292BRUZ-20-RL7; OWN STK' },
  { cpc:'630-204173-001', mpn:'524MILF',            mfr:'IDT',     bpSK:'1006857', qty:80,  cost:2.45,     dc:'22+',          notes:'Quoted MPN: 524MILFT; STOCK' },
];

const written = [];

(async () => {
  console.log(`[tracy-vq] Loading ${LINES.length} VQs to RFQ ${RFQ}\n`);

  // PASS 1: write VQs via vq-writer
  for (const ln of LINES) {
    const sw = sweep[ln.mpn] || {};
    const franchiseResults = {
      distributors: [{
        found: true,
        name: '',          // BP resolution by search key
        bpValue: ln.bpSK,
        vqMpn: ln.mpn,
        vqManufacturer: ln.mfr,
        franchiseRfqPrice: ln.cost,
        vqPrice: ln.cost,
        franchiseQty: ln.qty,
        vqLeadTime: 'stock',
        vqDateCode: ln.dc,
        vqCooCountryId: ln.coo || null,
        vqHts: sw.hts || null,
        vqEccn: sw.eccn || null,
        vqVendorNotes: ln.notes || null,
      }],
    };
    process.stdout.write(`  ${ln.mpn.padEnd(22)} qty=${String(ln.qty).padStart(3)} cost=$${String(ln.cost).padStart(9)} `);
    try {
      const r = await writeVQFromAPI(RFQ, ln.cpc, franchiseResults, {
        searchedMpn: ln.mpn,
        buyerId: BUYER_ID,
      });
      if (r.written.length) {
        const w = r.written[0];
        written.push({ ...ln, vqLineId: w.vqLineId });
        console.log(`✓ vq=${w.vqLineId}`);
      } else if (r.flagged.length) {
        console.log(`⚠ FLAGGED ${r.flagged[0].reason} ${r.flagged[0].detail.slice(0,80)}`);
      } else if (r.failed.length) {
        console.log(`✗ FAILED ${r.failed[0].reason} ${r.failed[0].detail.slice(0,80)}`);
      } else {
        console.log('? no result');
      }
    } catch (e) {
      console.log(`✗ EXCEPTION ${e.message.slice(0,120)}`);
    }
  }

  console.log(`\n[tracy-vq] Pass 1 complete: ${written.length}/${LINES.length} written\n`);

  // PASS 2: Tier 2 patch on the 14 PO-ready lines (skip restricted)
  console.log('[tracy-vq] Pass 2: Tier 2 patch + IsPurchased=Y on non-restricted lines');
  for (const w of written) {
    if (w.restricted) {
      console.log(`  ${w.mpn.padEnd(22)} vq=${w.vqLineId} — SKIP (restricted, no PO)`);
      continue;
    }
    const patch = { ...TIER2, C_BPartner_Location_ID: BP_LOCATION[w.bpSK] };
    try {
      await patchRecord('Chuboe_VQ_Line', w.vqLineId, patch);
      console.log(`  ${w.mpn.padEnd(22)} vq=${w.vqLineId} ✓ Tier 2 + IsPurchased=Y`);
    } catch (e) {
      console.log(`  ${w.mpn.padEnd(22)} vq=${w.vqLineId} ✗ patch failed: ${e.message.slice(0,160)}`);
    }
  }

  console.log('\n[tracy-vq] Done.');

  // Persist the written list for the email + approve order step
  fs.writeFileSync(path.join(__dirname, 'tracy-loaded.json'), JSON.stringify(written, null, 2));
  console.log('Saved tracy-loaded.json');
})().catch(e => { console.error(e); process.exit(1); });
