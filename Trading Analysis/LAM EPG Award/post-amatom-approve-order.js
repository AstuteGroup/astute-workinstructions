/**
 * Post the Amatom Approve Order R_Request — RFQ lines 240 + 270.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { apiPost } = require('../../shared/api-client');

const COPY_TEXT_FILE = path.join(__dirname, '../../../.tmp-attach/copy-text-1132040-amatom.txt');
const KEEP_LINES = new Set([240, 270]);

const PAYLOAD_META = {
  R_RequestType_ID: 1000000,   // Approve Order
  R_Status_ID:      1000000,   // Submitted
  Priority:         '5',
  Chuboe_RFQ_ID:    1141455,   // RFQ 1132040
  C_BPartner_ID:    1002734,   // Amatom
  SalesRep_ID:      1000004,   // Jake Harris
  Summary:          'Please approve LAM Kitting orders — Amatom',
  AD_Table_ID:      1000002,       // Chuboe_RFQ — links to RFQ window
  Record_ID:        1141455,
};

function parseAndFilter(rawText, keepLines) {
  const blocks = rawText.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const rfqSummaries = [];
  const linePairs = [];
  let i = 0;
  while (i < blocks.length && blocks[i].startsWith('RFQ\n')) { rfqSummaries.push(blocks[i]); i++; }
  while (i < blocks.length) {
    if (blocks[i].startsWith('RFQ Line\n')) {
      const rfqLineBlock = blocks[i];
      const m = rfqLineBlock.match(/RFQ Line #:\s*(\d+)/);
      const tc = rfqLineBlock.match(/Total Cost:\s*([0-9.]+)/);
      const lineNo = m ? parseInt(m[1], 10) : null;
      const totalCost = tc ? tc[1] : null;
      let vq = null;
      if (i + 1 < blocks.length && blocks[i + 1].startsWith('Vendor Quote\n')) { vq = blocks[i + 1]; i += 2; }
      else { i++; }
      linePairs.push({ lineNo, totalCost, rfqLineBlock, vendorQuoteBlock: vq });
    } else { i++; }
  }
  const kept = linePairs.filter(p => keepLines.has(p.lineNo));
  console.log(`[filter] ${linePairs.length} pairs in input → keeping ${kept.length} (${[...keepLines].sort((a,b)=>a-b).join(', ')})`);
  const keptCosts = new Set(kept.map(k => k.totalCost).filter(Boolean));
  const keptSums = rfqSummaries.filter(s => {
    const m = s.match(/Total Cost:\s*([0-9.]+)/);
    return m && keptCosts.has(m[1]);
  });
  const out = [];
  for (const s of keptSums) out.push(s);
  for (const p of kept) { out.push(p.rfqLineBlock); if (p.vendorQuoteBlock) out.push(p.vendorQuoteBlock); }
  return out.join('\n\n') + '\n';
}

(async () => {
  const raw = fs.readFileSync(COPY_TEXT_FILE, 'utf8');
  const filtered = parseAndFilter(raw, KEEP_LINES);
  console.log(`[filter] ${filtered.length} chars`);

  const payload = { ...PAYLOAD_META, Chuboe_Approval_Text: filtered };
  console.log(`[approve-order] POST — Summary: "${PAYLOAD_META.Summary}"`);
  const r = await apiPost('R_Request', payload);
  console.log(`  ✓ R_Request_ID = ${r.id}  DocumentNo = ${r.DocumentNo || '(server)'}`);
})().catch(e => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
