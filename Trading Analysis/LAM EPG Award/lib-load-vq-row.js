/**
 * Reusable VQ load helper for the LAM EPG batch sourcing workflow.
 *
 * For each remaining line:
 *   1. Query the named vendor live via franchise API
 *   2. Apply Jake's buy-qty rules:
 *        stock present + stock >= need:  buy = max(need, MOQ) rounded UP to SPQ multiple
 *        stock present + stock <  need:  PARTIAL — buy = stock (capped at MOQ floor + SPQ rounding)
 *        no stock + lead time present:   LT buy — buy = max(need, MOQ) rounded UP to SPQ
 *        explicit qtyOverride:           use the override (still rounded to SPQ if SPQ > 1)
 *   3. POST a new chuboe_rfq_line_mpn record for the alternate MPN (the LAM AVL alt)
 *   4. POST chuboe_vq_line via writeVQFromAPI (synthetic distributor stub)
 *   5. PATCH Tier 2 + IsPurchased=Y
 *   6. Update SIPOC row (col C/MPN preserved; col N/MPN-to-Purchase = alt; cost/qty/source/notes refreshed)
 *   7. Append to session-load-tracker.json with status PENDING_APPROVE_ORDER
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { apiPost } = require('../../shared/api-client');
const { writeVQFromAPI } = require('../../shared/vq-writer');
const { patchRecord } = require('../../shared/record-updater');
const { searchAllDistributors, extractStockAndLtRows } = require('../../shared/franchise-api');

const RFQ_VALUE = '1132040';
const RFQ_INTERNAL_ID = 1141455;
const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const TRACKER = path.join(__dirname, 'session-load-tracker.json');
const BUYER_ID = 1000004; // Jake Harris

// Vendor name → BP info (verified against c_bpartner 2026-04-09)
const VENDORS = {
  DigiKey:    { bpId: 1000327, sk: '1002331', loc: 1000240, type: 'Catalog',           ship: 'US' },
  Mouser:     { bpId: 1000334, sk: '1002338', loc: 1000683, type: 'Catalog',           ship: 'US' },
  Master:     { bpId: 1000405, sk: '1002409', loc: 1001349, type: 'Franchise',         ship: 'US' },
  Newark:     { bpId: 1000390, sk: '1002394', loc: 1000619, type: 'Catalog',           ship: 'US' },
  'Newark/Farnell': { bpId: 1000390, sk: '1002394', loc: 1000619, type: 'Catalog',     ship: 'US' },
  Future:     { bpId: 1000328, sk: '1002332', loc: 1000241, type: 'Franchise',         ship: 'US' },
  TTI:        { bpId: 1000326, sk: '1002330', loc: 1000239, type: 'Catalog',           ship: 'US' },
  Arrow:      { bpId: 1000386, sk: '1002390', loc: 1001110, type: 'Franchise',         ship: 'US' },
  Sager:      { bpId: 1000335, sk: '1002339', loc: 1006612, type: 'Franchise',         ship: 'US' },
  Waldom:     { bpId: 1000644, sk: '1002648', loc: 1002857, type: 'Catalog',           ship: 'US' },
  Rutronik:   { bpId: 1002668, sk: '1004668', loc: 1011556, type: 'Franchise',         ship: 'US' },
};

const SHIP_DEFAULTS = {
  US: {
    Chuboe_Warehouse_Group_ID: 1000008,  // BROWNSVILLE
    Chuboe_Warehouse_ID:       1000015,  // W111: LAM KITTING
    M_Shipper_ID:              1000003,  // FedEx Ground
    Chuboe_Inco_Term_ID:       1000000,  // EXW
  },
};

const TRACEABILITY_FOR_TYPE = {
  Catalog:   1000001, // Authorized Distribution Certs
  Franchise: 1000001,
  'Online Distributor': 1000001,
  Broker:    1000003, // Non-Traceable
};

function bizDaysFromToday(n) {
  const d = new Date();
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function calendarDaysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseLeadTimeToPromise(lt) {
  if (!lt || /stock/i.test(lt)) return bizDaysFromToday(5);
  let m;
  if ((m = lt.match(/(\d+)\s*week/i))) return calendarDaysFromToday(Number(m[1]) * 7);
  if ((m = lt.match(/(\d+)\s*day/i)))  return calendarDaysFromToday(Number(m[1]));
  if ((m = lt.match(/(\d+)\s*month/i))) return calendarDaysFromToday(Number(m[1]) * 30);
  return bizDaysFromToday(5); // unknown — default to stock cadence
}

function applyMoqSpq(qty, moq, spq) {
  let q = qty;
  if (moq && moq > q) q = moq;
  if (spq && spq > 1) q = Math.ceil(q / spq) * spq;
  return q;
}

async function getRfqLineId(cpc) {
  const sql = `SELECT rl.line, rl.chuboe_rfq_line_id FROM adempiere.chuboe_rfq r JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id=r.chuboe_rfq_id WHERE r.value='${RFQ_VALUE}' AND rl.chuboe_cpc='${cpc}' AND rl.isactive='Y';`;
  const out = execFileSync('psql', ['-A', '-F|', '-t', '-c', sql], { encoding: 'utf8' });
  const [line, lineId] = out.trim().split('|');
  return { lineNo: Number(line), lineId: Number(lineId) };
}

function getSipocInfo(cpc) {
  const wb = XLSX.readFile(SIPOC);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  for (let i = 2; i < aoa.length; i++) {
    if (String(aoa[i][0] || '').trim() === cpc) {
      return {
        rowIdx: i,
        primaryMpn: aoa[i][2],
        primaryMfr: aoa[i][3],
        base: Number(aoa[i][6] || 0),
        resale: Number(aoa[i][8] || 0),
      };
    }
  }
  return null;
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

/**
 * Load one VQ row.
 * @param {Object} opts
 * @param {string} opts.cpc - LAM CPC
 * @param {string} opts.altMpn - The AVL alternate MPN to load
 * @param {string} opts.altMfr - The alternate's manufacturer (AVL)
 * @param {string} opts.vendor - Vendor short name (DigiKey, Master, ...)
 * @param {number} opts.need - LAM need qty
 * @param {number} [opts.qtyOverride] - Manual buy qty override (still respects SPQ)
 * @param {number} [opts.costOverride] - Use this cost instead of the API price
 * @param {boolean} [opts.splitStockLt] - If true and vendor has stock < need + LT, write 2 VQs (stock + LT) to cover full need
 * @param {boolean} [opts.partialAllowed] - If true, allow stock-only partial when stock < need (default: true)
 */
async function loadVqRow(opts) {
  const { cpc, altMpn, altMfr, vendor, need, qtyOverride, costOverride, splitStockLt } = opts;
  const partialAllowed = opts.partialAllowed !== false;

  console.log(`\n[load] CPC ${cpc} alt ${altMpn} from ${vendor} (need ${need})`);

  const vendorInfo = VENDORS[vendor];
  if (!vendorInfo) throw new Error(`Unknown vendor: ${vendor}`);

  // 1. Query API. Pass altMfr for the MFR-veto layer (rejects candidates
  // whose MFR is MISMATCH via shared/mpn-match + mfr-equivalence).
  const all = await searchAllDistributors(altMpn, need, { includeNoResults: true, mfr: altMfr });
  const dist = (all.distributors || []).find(d => d.found && (d.name === vendor || d.name.includes(vendor)));
  if (!dist) throw new Error(`No ${vendor} hit for ${altMpn}`);
  const rows = extractStockAndLtRows(dist, altMpn, need) || [];
  if (rows.length === 0) throw new Error(`${vendor} returned no usable rows for ${altMpn}`);

  // Pick best row: stock first
  rows.sort((a, b) => (a.leadTime ? 1 : 0) - (b.leadTime ? 1 : 0));
  const best = rows[0];
  const ltRow = rows.find(r => r.leadTime); // for splitStockLt mode
  const isStock = !best.leadTime;
  const stockQty = isStock ? Number(best.qty || 0) : 0;
  const moq = Number(best.moq || 0);
  const spq = Number(best.spq || 1);
  let cost = Number(best.cost);
  if (costOverride != null) cost = Number(costOverride);

  // 2. Apply qty rules
  let buyQty;
  let partial = false;
  let qtyRemaining = 0;
  if (qtyOverride != null) {
    buyQty = applyMoqSpq(qtyOverride, moq, spq);
    if (buyQty < need) { partial = true; qtyRemaining = need - buyQty; }
  } else if (isStock) {
    if (stockQty >= need) {
      buyQty = applyMoqSpq(need, moq, spq);
    } else {
      // PARTIAL — buy stock qty (with MOQ/SPQ rounding within stock)
      buyQty = applyMoqSpq(stockQty, moq, spq);
      if (buyQty > stockQty) buyQty = stockQty; // can't exceed stock on stock-only buy
      partial = true;
      qtyRemaining = need - buyQty;
    }
  } else {
    // LT buy
    buyQty = applyMoqSpq(need, moq, spq);
  }

  const leadTime = isStock ? 'stock' : best.leadTime;
  const promise = isStock ? bizDaysFromToday(5) : parseLeadTimeToPromise(leadTime);

  // 3. Get RFQ line + SIPOC info
  const { lineNo, lineId } = await getRfqLineId(cpc);
  const sipoc = getSipocInfo(cpc);
  if (!sipoc) throw new Error(`SIPOC row not found for CPC ${cpc}`);

  console.log(`  vendor=${vendor} cost=$${cost} stock=${stockQty} moq=${moq} spq=${spq} buy=${buyQty}${partial?' PARTIAL '+qtyRemaining+' rem':''} ltime=${leadTime} promise=${promise}`);

  // 4. Add new chuboe_rfq_line_mpn for the alternate
  const altMpnRecord = await apiPost('Chuboe_RFQ_Line_MPN', {
    Chuboe_RFQ_ID: RFQ_INTERNAL_ID,
    Chuboe_RFQ_Line_ID: lineId,
    Chuboe_MPN: altMpn,
    Chuboe_MFR_Text: altMfr,
    Qty: need,
    PriceEntered: sipoc.base,
    Description: `AVL alternate to ${sipoc.primaryMpn}`,
  });
  console.log(`  ✓ rfq_line_mpn ${altMpnRecord.id} created`);

  // 5. Write VQ
  const fr = {
    distributors: [{
      found: true,
      name: vendor,
      bpValue: vendorInfo.sk,
      vqMpn: altMpn,
      vqManufacturer: altMfr,
      franchiseRfqPrice: cost,
      vqPrice: cost,
      franchiseQty: buyQty,
      vqLeadTime: isStock ? 'stock' : leadTime,
      vqVendorNotes: `AVL alt to ${sipoc.primaryMpn}; ${vendor} ${isStock ? 'stock' : leadTime}; MOQ ${moq||1} SPQ ${spq}${partial?'; PARTIAL '+buyQty+'/'+need+', '+qtyRemaining+' rem':''}`,
      vqEccn: dist.vqEccn || 'EAR99',
      vqHts: dist.vqHts || null,
    }],
  };
  const r = await writeVQFromAPI(RFQ_VALUE, cpc, fr, { searchedMpn: altMpn, buyerId: BUYER_ID, rfqQty: need });
  if (r.written.length === 0) {
    throw new Error('VQ write failed: ' + JSON.stringify(r.flagged.concat(r.failed)).slice(0, 400));
  }
  const w = r.written[0];
  console.log(`  ✓ vq ${w.vqLineId} written`);

  // 6. Tier 2 patch
  const tier2 = {
    C_BPartner_Location_ID:    vendorInfo.loc,
    ...SHIP_DEFAULTS[vendorInfo.ship],
    Chuboe_Packaging_ID:       1000010, // OTHER
    DatePromised:              promise,
    DueDate:                   promise,
    IsPurchased:               'Y',
    Chuboe_Traceability_ID:    TRACEABILITY_FOR_TYPE[vendorInfo.type] || 1000003,
  };
  await patchRecord('Chuboe_VQ_Line', w.vqLineId, tier2);
  console.log(`  ✓ Tier 2 patched`);

  // 7. SIPOC update
  const wb = XLSX.readFile(SIPOC);
  const ws = wb.Sheets[wb.SheetNames[0]];
  setSipocCell(ws, sipoc.rowIdx, 13, altMpn);                                      // MPN to Purchase
  setSipocCell(ws, sipoc.rowIdx, 14, altMfr.toUpperCase());                        // Manufacturer
  setSipocCell(ws, sipoc.rowIdx, 15, vendor);                                      // Source
  setSipocCell(ws, sipoc.rowIdx, 16, cost, '$#,##0.0000');                          // Purchase Price
  setSipocCell(ws, sipoc.rowIdx, 17, buyQty, '#,##0');                              // Qty
  setSipocCell(ws, sipoc.rowIdx, 18, qtyRemaining, '#,##0');                        // Qty Remaining
  setSipocCell(ws, sipoc.rowIdx, 19, isStock ? 'stock' : leadTime);                // Lead Time wks
  setSipocCell(ws, sipoc.rowIdx, 20, 'Y');                                          // VQ in OT
  const savings = Math.round((sipoc.base - cost) * buyQty * 100) / 100;
  setSipocCell(ws, sipoc.rowIdx, 22, savings, '$#,##0.00');                         // Savings
  setSipocCell(ws, sipoc.rowIdx, 33, `Request pending (batched); AVL alt ${altMpn} from ${vendor}${partial?' PARTIAL '+buyQty+'/'+need+', '+qtyRemaining+' rem':''}`);
  // DO NOT touch col 2 (MPN) — preserve LAM-preferred primary
  XLSX.writeFile(wb, SIPOC);
  console.log(`  ✓ SIPOC row ${sipoc.rowIdx} updated`);

  // 8. Append to tracker
  let tracker = [];
  if (fs.existsSync(TRACKER)) tracker = JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
  tracker.push({
    timestamp: new Date().toISOString(),
    rfq: RFQ_VALUE,
    line: lineNo,
    cpc,
    primaryMpn: sipoc.primaryMpn,
    loadedMpn: altMpn,
    mfr: altMfr,
    vendor,
    vendorBpId: vendorInfo.bpId,
    vendorType: vendorInfo.type,
    qty: buyQty,
    need,
    qtyRemaining,
    partial,
    cost,
    base: sipoc.base,
    resale: sipoc.resale,
    leadTime: isStock ? 'stock' : leadTime,
    datePromised: promise,
    shipDestination: vendorInfo.ship === 'US' ? 'BROWNSVILLE / W111 LAM KITTING' : 'HONG KONG / ALLOCATED-PRESOLD',
    buyer: 'Jake Harris',
    vqLineId: w.vqLineId,
    altMpnId: altMpnRecord.id,
    eccn: dist.vqEccn || 'EAR99',
    hts: dist.vqHts || null,
    isPurchased: 'Y',
    rRequest: null,
    status: 'PENDING_APPROVE_ORDER',
    note: `AVL alt to ${sipoc.primaryMpn}${partial?' PARTIAL '+buyQty+'/'+need+', '+qtyRemaining+' rem':''}`,
  });
  fs.writeFileSync(TRACKER, JSON.stringify(tracker, null, 2));
  console.log(`  ✓ tracker (${tracker.length} entries)`);

  return { vqLineId: w.vqLineId, altMpnId: altMpnRecord.id, buyQty, partial, qtyRemaining, cost, leadTime, promise };
}

module.exports = { loadVqRow };
