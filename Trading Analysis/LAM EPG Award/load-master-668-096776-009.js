/**
 * Single-line VQ load: Master Electronics for CPC 668-096776-009.
 * Per Jake's paste:
 *   CPC 668-096776-009  qty 2000  base $3.5450  resale $4.3232  alt MPN DLS1XS4AA35X (Conec)  Master
 *
 * Steps:
 *   1. POST new chuboe_rfq_line_mpn record for DLS1XS4AA35X on line 3068770 (line 50)
 *   2. POST chuboe_vq_line via writeVQFromAPI
 *   3. PATCH Tier 2 + IsPurchased=Y
 *   4. Update SIPOC row (col 13 MPN to Purchase = alt; col 2 MPN preserved)
 *   5. Append to session-load-tracker.json (status: PENDING_APPROVE_ORDER)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { apiPost } = require('../../shared/api-client');
const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');

const RFQ_VALUE = '1132040';
const RFQ_INTERNAL_ID = 1141455;
const LINE_ID = 3068770;
const CPC = '668-096776-009';
const PRIMARY_MPN = 'K85X-ED-9S-CBR';
const ALT_MPN = 'DLS1XS4AA35X';
const ALT_MFR_TEXT = 'Conec Elektronische Bauelemente GmbH';
const NEED_QTY = 2000;
const COST = 3.545;
const BASE_PRICE = 3.545;
const RESALE = 4.3232;

const MASTER_BP_SK = '1002409';
const MASTER_BP_LOCATION = 1001349; // V002991 - Phoenix, AZ
const BUYER_ID = 1000004; // Jake Harris

const TIER2 = {
  C_BPartner_Location_ID:    MASTER_BP_LOCATION,
  Chuboe_Warehouse_Group_ID: 1000008,  // BROWNSVILLE
  Chuboe_Warehouse_ID:       1000015,  // W111: LAM KITTING
  M_Shipper_ID:              1000003,  // FedEx Ground
  Chuboe_Inco_Term_ID:       1000000,  // EXW
  Chuboe_Packaging_ID:       1000010,  // OTHER
  DatePromised:              '2026-04-16',
  DueDate:                   '2026-04-16',
  IsPurchased:               'Y',
  Chuboe_Traceability_ID:    1000001,  // Authorized Distribution Certs (Franchise)
};

const TRACKER_FILE = path.join(__dirname, 'session-load-tracker.json');
const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');

(async () => {
  console.log(`[load] CPC ${CPC} line 50 — alt MPN ${ALT_MPN} from Master`);

  // ── 1. Add new chuboe_rfq_line_mpn for the alternate MPN ─────────────────
  const altMpnPayload = {
    Chuboe_RFQ_ID:        RFQ_INTERNAL_ID,
    Chuboe_RFQ_Line_ID:   LINE_ID,
    Chuboe_MPN:           ALT_MPN,
    Chuboe_MFR_Text:      ALT_MFR_TEXT,
    Qty:                  NEED_QTY,
    PriceEntered:         BASE_PRICE,
    Description:          'AVL alternate to ' + PRIMARY_MPN + ' (per LAM EPG AVL)',
  };
  let altMpnId;
  try {
    const r = await apiPost('Chuboe_RFQ_Line_MPN', altMpnPayload);
    altMpnId = r.id;
    console.log(`  ✓ chuboe_rfq_line_mpn ${altMpnId} created (${ALT_MPN})`);
  } catch (e) {
    console.error('  ✗ rfq_line_mpn POST failed:', e.message.slice(0, 400));
    process.exit(1);
  }

  // ── 2. Write VQ via vq-writer (synthetic Master distributor stub) ────────
  const franchiseResults = {
    distributors: [{
      found: true,
      name: 'Master Electronics',
      bpValue: MASTER_BP_SK,
      vqMpn: ALT_MPN,
      vqManufacturer: ALT_MFR_TEXT,
      franchiseRfqPrice: COST,
      vqPrice: COST,
      franchiseQty: NEED_QTY,
      vqLeadTime: 'stock',
      vqVendorNotes: `AVL alternate to ${PRIMARY_MPN}; Master at LAM target $${COST}`,
      vqEccn: 'EAR99',
      vqHts: null,
    }],
  };
  const r = await writeVQFromAPI(RFQ_VALUE, CPC, franchiseResults, {
    searchedMpn: ALT_MPN,
    buyerId: BUYER_ID,
    rfqQty: NEED_QTY,
  });
  if (r.written.length === 0) {
    console.error('  ✗ VQ write failed:', JSON.stringify(r.flagged.concat(r.failed)).slice(0, 400));
    process.exit(1);
  }
  const w = r.written[0];
  console.log(`  ✓ vq ${w.vqLineId} written`);

  // ── 3. PATCH Tier 2 ──────────────────────────────────────────────────────
  await patchRecord('Chuboe_VQ_Line', w.vqLineId, TIER2);
  console.log(`  ✓ Tier 2 patched`);

  // ── 4. Update SIPOC ──────────────────────────────────────────────────────
  // Row 6 (we found earlier). Don't touch col 2 (MPN — the original LAM preferred).
  // Update col 13 (MPN to Purchase) with the alt, plus the source/cost fields.
  const wb = XLSX.readFile(SIPOC);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let sipocRow = -1;
  for (let i = 2; i < aoa.length; i++) {
    if (String(aoa[i][0] || '').trim() === CPC) { sipocRow = i; break; }
  }
  if (sipocRow < 0) {
    console.error('  ✗ SIPOC row not found for CPC');
  } else {
    function setCell(rowIdx, colIdx, value, format) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
      let cell = ws[addr];
      if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
      cell.v = value;
      cell.t = (typeof value === 'number') ? 'n' : 's';
      if (format) cell.z = format;
      delete cell.w;
    }
    // col 13: MPN to Purchase (alt)
    setCell(sipocRow, 13, ALT_MPN);
    // col 14: Manufacturer (the alt's mfr)
    setCell(sipocRow, 14, 'CONEC ELEKTRONISCHE BAUELEMENTE GMBH');
    // col 15: Source
    setCell(sipocRow, 15, 'Master Electronics');
    // col 16: Purchase Price
    setCell(sipocRow, 16, COST, '$#,##0.0000');
    // col 17: Qty
    setCell(sipocRow, 17, NEED_QTY, '#,##0');
    // col 18: Qty Remaining to Source
    setCell(sipocRow, 18, 0, '#,##0');
    // col 19: Lead Time (wks)
    setCell(sipocRow, 19, 'stock');
    // col 20: VQ in OT
    setCell(sipocRow, 20, 'Y');
    // col 22: Savings (at-target = 0)
    setCell(sipocRow, 22, 0, '$#,##0.00');
    // col 33: Notes (Request pending — batch)
    setCell(sipocRow, 33, `Request pending (batched); AVL alt MPN ${ALT_MPN} ` + `from Master at LAM target`);
    // DO NOT touch col 2 (MPN) per Jake's instruction
    XLSX.writeFile(wb, SIPOC);
    console.log(`  ✓ SIPOC row ${sipocRow} updated (col C/MPN preserved as ${PRIMARY_MPN})`);
  }

  // ── 5. Append to session-load-tracker.json ───────────────────────────────
  let tracker = [];
  if (fs.existsSync(TRACKER_FILE)) {
    try { tracker = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8')); } catch (_) { tracker = []; }
  }
  tracker.push({
    timestamp: new Date().toISOString(),
    rfq: RFQ_VALUE,
    line: 50,
    cpc: CPC,
    primaryMpn: PRIMARY_MPN,
    loadedMpn: ALT_MPN,
    mfr: 'CONEC',
    vendor: 'Master Electronics',
    vendorBpId: 1000405,
    vendorType: 'Franchise',
    qty: NEED_QTY,
    cost: COST,
    leadTime: 'stock',
    shipDestination: 'BROWNSVILLE / W111 LAM KITTING',
    buyer: 'Jake Harris',
    vqLineId: w.vqLineId,
    altMpnId,
    eccn: 'EAR99',
    hts: null,
    isPurchased: 'Y',
    rRequest: null,
    status: 'PENDING_APPROVE_ORDER',
    note: `AVL alternate to ${PRIMARY_MPN} per LAM EPG AVL; Master at LAM target $${COST}`,
  });
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
  console.log(`  ✓ tracker updated (${tracker.length} entries total)`);

  console.log(`\n[done] vq=${w.vqLineId} altMpnId=${altMpnId} status=PENDING_APPROVE_ORDER`);
})().catch(e => { console.error(e); process.exit(1); });
