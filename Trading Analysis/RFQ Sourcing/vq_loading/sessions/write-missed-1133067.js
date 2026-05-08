// One-off: write the 9 VQs that load-bulk-summary skipped/failed for RFQ 1133067
//   - 7 DRAGON quotes (BP 1006247, vendor type 1000004 Suspended) → written for record
//   - 2 ECI quotes (BP 1008351, vendor type NULL on BP) → override to 1000003

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { apiPost, apiGet, resolveBP, resolveMFR } = require(path.join(__dirname, '../../../../shared/api-client'));

const RFQ_SEARCH_KEY = '1133067';
const BUYER_ID = 1009477;          // Tracy Xie
const PENDING_COUNTRY_ID = 1000001;
const COUNTRY_MAP = {
  'malaysia': 238,
  'philippines': 278,
  'taiwan': 316,
  'united states': 100,
  'korea, republic of': 234,
  'korea': 234,
  'china': 153,
  'hong kong': 196,
};
function resolveCoo(coo) {
  if (!coo) return PENDING_COUNTRY_ID;
  const k = coo.toLowerCase().trim();
  return COUNTRY_MAP[k] || PENDING_COUNTRY_ID;
}

// 9 missed quotes — DRAGON × 7 + ECI × 2 — extracted from the master JSON
const MISSED = [
  // DRAGON × 7 (BP 1006247, vendor type 1000004 Suspended — write with that intact)
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'LTM8074EY#PBF',       mfr: 'Analog Devices', qty: 80,  cost: 10.04, leadTime: 'stock',     dateCode: '25+', coo: 'Korea, Republic of', vendorNotes: 'BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'MAX16029TG+',         mfr: 'Analog Devices', qty: 75,  cost: 6.49,  leadTime: 'stock',     dateCode: '24+', coo: 'United States',      vendorNotes: 'Quoted MPN: MAX16029TG+T | BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'LTM4632EV#PBF',       mfr: 'Analog Devices', qty: 80,  cost: 9.27,  leadTime: 'stock',     dateCode: '22+', coo: 'Malaysia',           vendorNotes: 'BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'AD9467BCPZ-250',      mfr: 'Analog Devices', qty: 100, cost: 123.53,leadTime: 'stock',     dateCode: '25+', coo: 'Philippines',        vendorNotes: 'BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'LT1491ACS#PBF',       mfr: 'Analog Devices', qty: 60,  cost: 13.13, leadTime: 'stock',     dateCode: '22+', coo: 'Malaysia',           vendorNotes: 'BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'ADS8688IDBTR',        mfr: 'Texas Instruments', qty: 60, cost: 5.56, leadTime: 'stock',    dateCode: '25+', coo: 'Malaysia',           vendorNotes: 'BP marked Suspended in OT — broker quote captured for record only' },
  { vendorSearchKey: '1006247', vendorTypeOverride: 1000004, mpn: 'LMZ14202TZ-ADJ/NOPB', mfr: 'Texas Instruments', qty: 250,cost: 6.95, leadTime: 'stock',    dateCode: '26+', coo: 'Malaysia',           vendorNotes: 'Quoted MPN: LMZ14202TZX-ADJ/NOPB | BP marked Suspended in OT — broker quote captured for record only' },
  // ECI rows already written successfully on the prior run as vq 2140966 + 2140967 — removed to avoid duplicates
];

async function getRFQLines(rfqSearchKey) {
  const rfq = await apiGet('Chuboe_RFQ', { filter: `Value eq '${rfqSearchKey}'`, top: 1 });
  if (!rfq.records?.[0]) throw new Error(`RFQ ${rfqSearchKey} not found`);
  const rfqId = rfq.records[0].id;

  const lines = await apiGet('Chuboe_RFQ_Line', { filter: `Chuboe_RFQ_ID eq ${rfqId} and IsActive eq true`, top: 100 });
  const out = {};
  for (const l of lines.records || []) {
    const mpns = await apiGet('Chuboe_RFQ_Line_MPN', { filter: `Chuboe_RFQ_Line_ID eq ${l.id} and IsActive eq true`, top: 50 });
    for (const m of mpns.records || []) {
      const mpn = (m.Chuboe_MPN || '').trim();
      if (mpn) out[mpn.toUpperCase()] = { lineId: l.id, lineNo: l.Line, qty: l.Qty };
    }
  }
  return out;
}

async function main() {
  const lineMap = await getRFQLines(RFQ_SEARCH_KEY);
  console.log(`RFQ ${RFQ_SEARCH_KEY} has ${Object.keys(lineMap).length} accepted MPNs`);

  const written = [];
  const failed = [];

  for (const q of MISSED) {
    try {
      const bp = await resolveBP(q.vendorSearchKey, null);
      if (!bp) throw new Error(`BP ${q.vendorSearchKey} not found`);

      const lineMatch = lineMap[q.mpn.toUpperCase()];
      if (!lineMatch) throw new Error(`MPN ${q.mpn} not on RFQ ${RFQ_SEARCH_KEY}`);

      const mfr = await resolveMFR(q.mfr);

      const payload = {
        Chuboe_RFQ_Line_ID: lineMatch.lineId,
        C_BPartner_ID: bp.id,
        Chuboe_MFR_Text: q.mfr,
        Chuboe_MPN: q.mpn,
        Cost: q.cost,
        Qty: q.qty,
        C_Currency_ID: 100,
        Chuboe_Lead_Time: q.leadTime || 'stock',
        Chuboe_Date_Code: q.dateCode,
        Chuboe_Note_User: q.vendorNotes,
        C_UOM_ID: 100,
        C_Country_ID: resolveCoo(q.coo),
        Chuboe_RoHS: 'Y',
        Chuboe_Traceability_ID: 1000003,        // Non-Traceable (force)
        Chuboe_VendorType_ID: q.vendorTypeOverride,
        Chuboe_Buyer_ID: BUYER_ID,
        IsPurchased: 'N',
      };
      if (mfr?.id && !mfr.isSystem) payload.Chuboe_MFR_ID = mfr.id;

      const result = await apiPost('Chuboe_VQ_Line', payload);
      written.push({ mpn: q.mpn, vendor: bp.name, vqId: result.id, cost: q.cost, qty: q.qty, line: lineMatch.lineNo });
      console.log(`  ✓ line ${lineMatch.lineNo} | ${q.mpn.padEnd(28)} | ${bp.name.slice(0,30).padEnd(30)} | $${String(q.cost).padStart(8)} × ${String(q.qty).padStart(5)} → vq ${result.id}`);
    } catch (err) {
      failed.push({ mpn: q.mpn, vendor: q.vendorSearchKey, error: err.message });
      console.log(`  ✗ ${q.mpn.padEnd(28)} | bp ${q.vendorSearchKey} | ${err.message}`);
    }
  }

  console.log(`\nDone: ${written.length} written, ${failed.length} failed`);
  const trackerPath = path.join(__dirname, `2026-04-29-missed-write-1133067.json`);
  fs.writeFileSync(trackerPath, JSON.stringify({ rfq: RFQ_SEARCH_KEY, written, failed }, null, 2));
  console.log(`Tracker: ${trackerPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
