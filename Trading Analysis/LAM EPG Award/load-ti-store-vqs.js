/**
 * Load 2 VQs from TI Store for LAM EPG RFQ 1132040:
 *   1. LM5069MMX-2/NOPB (alt to LM5069MM-2/NOPB) — $1.91 × 155
 *   2. UC2825AQDWREP — $8.604 × 35 (premium, seller to update pricing with customer)
 *
 * Steps per line:
 *   1. Look up RFQ line ID by CPC
 *   2. For alt MPN: POST chuboe_rfq_line_mpn
 *   3. POST chuboe_vq_line via writeVQFromAPI
 *   4. PATCH Tier 2 + IsPurchased=Y
 *   5. Update SIPOC
 *   6. Append to session-load-tracker.json
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { apiPost } = require('../../shared/api-client');
const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');

const RFQ_VALUE = '1132040';
const RFQ_INTERNAL_ID = 1141455;
const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const TRACKER = path.join(__dirname, 'session-load-tracker.json');
const BUYER_ID = 1000004;

const TI_STORE = {
  bpId: 1003257,
  sk: '1005256',
  loc: 1005677,
  type: 'Franchise',
  ship: 'US',
};

const SHIP_DEFAULTS = {
  Chuboe_Warehouse_Group_ID: 1000008,  // BROWNSVILLE
  Chuboe_Warehouse_ID:       1000015,  // W111: LAM KITTING
  M_Shipper_ID:              1000003,  // FedEx Ground
  Chuboe_Inco_Term_ID:       1000000,  // EXW
};

function bizDaysFromToday(n) {
  const d = new Date();
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function setSipocCell(ws, rowIdx, colIdx, value, format) {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  let cell = ws[addr];
  if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
  cell.v = value;
  cell.t = (typeof value === 'number') ? 'n' : 's';
  if (format) cell.z = format;
  delete cell.w;
}

function getRfqLineId(cpc) {
  const sql = `SELECT rl.line, rl.chuboe_rfq_line_id FROM adempiere.chuboe_rfq r JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id=r.chuboe_rfq_id WHERE r.value='${RFQ_VALUE}' AND rl.chuboe_cpc='${cpc}' AND rl.isactive='Y';`;
  const out = execFileSync('psql', ['-U', 'analytics_user', '-A', '-F|', '-t', '-c', sql], { encoding: 'utf8' });
  const [line, lineId] = out.trim().split('|');
  return { lineNo: Number(line), lineId: Number(lineId) };
}

const LINES = [
  {
    cpc: '630-232484-001',
    primaryMpn: 'LM5069MM-2/NOPB',
    loadMpn: 'LM5069MMX-2/NOPB',
    loadMfr: 'Texas Instruments',
    isAlt: true,  // different MPN — need rfq_line_mpn
    cost: 1.91,
    qty: 155,
    leadTime: 'stock',
    notes: 'TI Store stock; ordering LM5069MMX-2/NOPB — X = large reel (2500pc) variant, acceptable alternate per buyer',
    sipocRow: 65,
  },
  {
    cpc: '630-A21745-001',
    primaryMpn: 'UC2825AQDWREP',
    loadMpn: 'UC2825AQDWREP',
    loadMfr: 'Texas Instruments',
    isAlt: false,  // same MPN
    cost: 8.604,
    qty: 35,
    leadTime: 'stock',
    notes: 'TI Store stock; PREMIUM — cost $8.604 > base $7.27, seller to update pricing with customer',
    sipocRow: 182,
  },
];

(async () => {
  const promise = bizDaysFromToday(5);
  console.log('Promise date:', promise);

  for (const ln of LINES) {
    console.log(`\n=== ${ln.cpc} — ${ln.loadMpn} ===`);

    // 1. Get RFQ line
    const { lineNo, lineId } = getRfqLineId(ln.cpc);
    console.log(`  RFQ line ${lineNo} (id ${lineId})`);

    // 2. Alt MPN record if needed
    let altMpnId = null;
    if (ln.isAlt) {
      const rec = await apiPost('Chuboe_RFQ_Line_MPN', {
        Chuboe_RFQ_ID: RFQ_INTERNAL_ID,
        Chuboe_RFQ_Line_ID: lineId,
        Chuboe_MPN: ln.loadMpn,
        Chuboe_MFR_Text: ln.loadMfr,
        Qty: ln.qty,
        PriceEntered: ln.cost,
        Description: `Reel size variant of ${ln.primaryMpn} (MMX = 2500pc reel)`,
      });
      altMpnId = rec.id;
      console.log(`  ✓ rfq_line_mpn ${altMpnId} created`);
    }

    // 3. Write VQ
    const fr = {
      distributors: [{
        found: true,
        name: 'TI Store',
        bpValue: TI_STORE.sk,
        vqMpn: ln.loadMpn,
        vqManufacturer: ln.loadMfr,
        franchiseRfqPrice: ln.cost,
        vqPrice: ln.cost,
        franchiseQty: ln.qty,
        vqLeadTime: ln.leadTime,
        vqVendorNotes: ln.notes,
        vqEccn: 'EAR99',
        vqHts: null,
      }],
    };
    const r = await writeVQFromAPI(RFQ_VALUE, ln.cpc, fr, { searchedMpn: ln.loadMpn, buyerId: BUYER_ID, rfqQty: ln.qty });
    if (r.written.length === 0) {
      console.error('  ✗ VQ write failed:', JSON.stringify(r.flagged.concat(r.failed)).slice(0, 400));
      continue;
    }
    const w = r.written[0];
    console.log(`  ✓ vq ${w.vqLineId} written`);

    // 4. Tier 2 patch
    await patchRecord('Chuboe_VQ_Line', w.vqLineId, {
      C_BPartner_Location_ID: TI_STORE.loc,
      ...SHIP_DEFAULTS,
      Chuboe_Packaging_ID: 1000010, // OTHER
      DatePromised: promise,
      DueDate: promise,
      IsPurchased: 'Y',
      Chuboe_Traceability_ID: 1000001, // Authorized Distribution Certs
    });
    console.log(`  ✓ Tier 2 patched (IsPurchased=Y, promise=${promise})`);

    // 5. SIPOC update
    const wb = XLSX.readFile(SIPOC);
    const wsSipoc = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(wsSipoc, { header: 1, defval: '' });
    const si = ln.sipocRow;
    setSipocCell(wsSipoc, si, 13, ln.loadMpn);                          // MPN to Purchase
    setSipocCell(wsSipoc, si, 14, ln.loadMfr.toUpperCase());            // Manufacturer
    setSipocCell(wsSipoc, si, 15, 'TI Store');                          // Source
    setSipocCell(wsSipoc, si, 16, ln.cost, '$#,##0.0000');              // Purchase Price
    setSipocCell(wsSipoc, si, 17, ln.qty, '#,##0');                     // Qty
    setSipocCell(wsSipoc, si, 18, 0, '#,##0');                          // Qty Remaining
    setSipocCell(wsSipoc, si, 19, ln.leadTime);                         // Lead Time
    setSipocCell(wsSipoc, si, 20, 'Y');                                 // VQ in OT

    const resale = Number(aoa[si][8] || 0);
    const totalCost = ln.cost * ln.qty;
    const margin = resale > 0 ? (resale - ln.cost) / resale : 0;
    setSipocCell(wsSipoc, si, 21, totalCost, '$#,##0.00');              // Total Cost
    setSipocCell(wsSipoc, si, 22, Math.round((Number(aoa[si][6]||0) - ln.cost) * ln.qty * 100) / 100, '$#,##0.00'); // Savings
    setSipocCell(wsSipoc, si, 23, margin, '0.0%');                      // Margin

    const existing = String(aoa[si][33] || '').trim();
    const newNote = existing ? existing + '; ' + ln.notes : ln.notes;
    setSipocCell(wsSipoc, si, 33, newNote);

    const range = XLSX.utils.decode_range(wsSipoc['!ref']);
    if (range.e.c < 38) { range.e.c = 38; wsSipoc['!ref'] = XLSX.utils.encode_range(range); }
    XLSX.writeFile(wb, SIPOC);
    console.log(`  ✓ SIPOC row ${si} updated`);

    // 6. Tracker
    let tracker = [];
    if (fs.existsSync(TRACKER)) tracker = JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
    tracker.push({
      timestamp: new Date().toISOString(),
      rfq: RFQ_VALUE,
      line: lineNo,
      cpc: ln.cpc,
      primaryMpn: ln.primaryMpn,
      loadedMpn: ln.loadMpn,
      mfr: ln.loadMfr,
      vendor: 'TI Store',
      vendorBpId: TI_STORE.bpId,
      vendorType: TI_STORE.type,
      qty: ln.qty,
      cost: ln.cost,
      leadTime: ln.leadTime,
      datePromised: promise,
      shipDestination: 'BROWNSVILLE / W111 LAM KITTING',
      buyer: 'Jake Harris',
      vqLineId: w.vqLineId,
      altMpnId: altMpnId,
      isPurchased: 'Y',
      rRequest: null,
      status: 'PENDING_APPROVE_ORDER',
      note: ln.notes,
    });
    fs.writeFileSync(TRACKER, JSON.stringify(tracker, null, 2));
    console.log(`  ✓ tracker (${tracker.length} entries)`);
  }

  console.log('\n=== DONE — ready for Copy Text ===');
})().catch(e => { console.error(e); process.exit(1); });
