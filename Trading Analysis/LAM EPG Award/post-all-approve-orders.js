/**
 * Parse the full Copy Text and post one R_Request per vendor for approval.
 * LAM EPG RFQ 1132040 — all loaded VQs.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { apiPost } = require('../../shared/api-client');

const RFQ_INTERNAL_ID = 1141455;
const RFQ_AD_TABLE_ID = 1000002; // AD_Table_ID for Chuboe_RFQ — links R_Request to RFQ window
const SALES_REP_ID = 1000004;

const COPY_TEXT = fs.readFileSync(path.join(__dirname, 'copy-text-all-vendors.txt'), 'utf8');

// Vendor name → BP ID mapping
const VENDOR_BP = {
  'Master Electronics':                          1000405,
  'Fuses Unlimited':                              1001960,
  'Waldom Electronics':                           1000644,
  'SMARTEL ELECTRONICS (ASIA) CO LTD':           1004861,
  'Amatom':                                       1001955,
  'Digi-Key Electronics':                         1000327,
  'CHIP ENERGY INTERNATIONAL CO.,LIMITED':        1010640,
  'Texas Instruments':                            1003257,
  'Sager - v3004':                                1000335,
  'Dragon Core Electronics (HK) Co., Limited':   1004251,
  'HK Firsttop Technology Ltd':                   1003256,
  'TTI Inc':                                      1000326,
};

// Parse Copy Text into RFQ Line blocks with their VQ blocks
function parseCopyText(raw) {
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const rfqSummaries = [];
  const pairs = [];
  let current = null;

  for (const b of blocks) {
    if (b.startsWith('RFQ\n') || b.startsWith('RFQ\r\n')) {
      rfqSummaries.push(b);
    } else if (b.startsWith('RFQ Line\n') || b.startsWith('RFQ Line\r\n')) {
      if (current) pairs.push(current);
      const m = b.match(/RFQ Line #:\s*(\d+)/);
      current = { lineNo: m ? Number(m[1]) : null, rfqLineBlock: b, vqBlocks: [] };
    } else if ((b.startsWith('Vendor Quote\n') || b.startsWith('Vendor Quote\r\n')) && current) {
      current.vqBlocks.push(b);
    }
  }
  if (current) pairs.push(current);
  return { rfqSummaries, pairs };
}

// Extract vendor name from VQ block
function getVendor(vqBlock) {
  const m = vqBlock.match(/Vendor:\s*(.+)/);
  return m ? m[1].trim() : 'UNKNOWN';
}

// Build approval text for a vendor batch
function buildApprovalText(rfqSummaries, vendorPairs) {
  const out = [];
  // One RFQ summary per pair
  for (let i = 0; i < vendorPairs.length; i++) {
    if (i < rfqSummaries.length) {
      out.push(rfqSummaries[i]);
    }
  }
  for (const p of vendorPairs) {
    out.push(p.rfqLineBlock);
    for (const vq of p.vqBlocks) out.push(vq);
  }
  return out.join('\n\n') + '\n';
}

(async () => {
  const { rfqSummaries, pairs } = parseCopyText(COPY_TEXT);
  console.log(`Parsed ${pairs.length} RFQ Line blocks, ${rfqSummaries.length} RFQ summaries`);

  // Group pairs by vendor
  const vendorGroups = new Map();
  for (const p of pairs) {
    if (p.vqBlocks.length === 0) continue;
    const vendor = getVendor(p.vqBlocks[0]);
    if (!vendorGroups.has(vendor)) vendorGroups.set(vendor, []);
    vendorGroups.get(vendor).push(p);
  }

  console.log(`\n${vendorGroups.size} vendors:`);
  for (const [v, ps] of vendorGroups) {
    console.log(`  ${v}: lines ${ps.map(p => p.lineNo).join(', ')}`);
  }

  // Post one R_Request per vendor
  const results = [];
  let summaryIdx = 0;
  for (const [vendor, vendorPairs] of vendorGroups) {
    const bpId = VENDOR_BP[vendor];
    if (!bpId) {
      console.log(`\n  ✗ ${vendor}: NO BP ID MAPPED — skipping`);
      continue;
    }

    // Grab enough RFQ summaries for this vendor's pairs
    const batchSummaries = rfqSummaries.slice(summaryIdx, summaryIdx + vendorPairs.length);
    summaryIdx += vendorPairs.length;

    const text = buildApprovalText(batchSummaries, vendorPairs);
    const linesStr = vendorPairs.map(p => p.lineNo).join(', ');
    const subject = `Please approve LAM Kitting orders — ${vendor.split(' ')[0]} (${vendorPairs.length} lines)`;

    console.log(`\n[${vendor}] ${vendorPairs.length} lines: ${linesStr} (${text.length} chars)`);

    const payload = {
      R_RequestType_ID: 1000000,
      R_Status_ID:      1000000,
      Priority:         '5',
      Chuboe_RFQ_ID:    RFQ_INTERNAL_ID,
      C_BPartner_ID:    bpId,
      SalesRep_ID:      SALES_REP_ID,
      Summary:          subject,
      Chuboe_Approval_Text: text,
      AD_Table_ID:      RFQ_AD_TABLE_ID,
      Record_ID:        RFQ_INTERNAL_ID,
    };

    const r = await apiPost('R_Request', payload);
    console.log(`  ✓ R_Request_ID = ${r.id}  DocumentNo = ${r.DocumentNo}`);
    results.push({ vendor, rRequestId: r.id, documentNo: r.DocumentNo, lines: vendorPairs.map(p => p.lineNo) });
  }

  console.log('\n=== POSTED ===');
  for (const r of results) {
    console.log(`  ${r.vendor.padEnd(45)} R_Request ${r.rRequestId} (DocNo ${r.documentNo}) lines: ${r.lines.join(', ')}`);
  }
  console.log(`\n✓ ${results.length} R_Requests posted`);
})().catch(e => { console.error(e); process.exit(1); });
