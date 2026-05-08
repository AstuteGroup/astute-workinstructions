/**
 * Filter the OT Copy Text for RFQ 1132040 to just the 14 Tracy lines
 * (excluding the 4 Fuses lines already on R_Request 1157760), then post
 * a new Approve Order R_Request via REST.
 *
 * Reusable shape for future batches: pass --keep-lines and --copy-text-file.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { apiPost } = require('../../shared/api-client');

const COPY_TEXT_FILE = path.join(__dirname, '../../../.tmp-attach/copy-text-1132040-tracy.txt');
const KEEP_LINES = new Set([150, 430, 480, 660, 770, 920, 960, 1000, 1100, 1110, 1430, 1530, 1700, 1730]);

// R_Request payload meta
const RFQ_INTERNAL_ID = 1141455; // RFQ 1132040
const SUMMARY = 'Please approve LAM Kitting orders — Tracy / HK delivery';
// Tracy is the buyer for these lines, but the request is sent to Jake (1000004) per the standard flow.
const SALES_REP_ID = 1000004; // Jake Harris (request creator / recipient)
// Fuses Unlimited was used on the prior request; this batch is multi-vendor.
// Picking the dominant vendor (Smartel) for C_BPartner_ID since the field accepts only one.
const C_BPARTNER_ID = 1004861; // SMARTEL ELECTRONICS (ASIA) CO LTD

// ── Filter the Copy Text ────────────────────────────────────────────────────

function parseAndFilter(rawText, keepLines) {
  // Split into top-level blocks separated by blank lines
  const blocks = rawText.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);

  const rfqSummaries = [];        // top "RFQ" blocks
  const linePairs = [];           // [{lineNo, rfqLineBlock, vendorQuoteBlock, totalCost}]

  let i = 0;
  // First pass: collect top RFQ summary blocks (until we hit "RFQ Line")
  while (i < blocks.length && blocks[i].startsWith('RFQ\n')) {
    rfqSummaries.push(blocks[i]);
    i++;
  }
  // Second pass: pair RFQ Line blocks with following Vendor Quote blocks
  while (i < blocks.length) {
    if (blocks[i].startsWith('RFQ Line\n')) {
      const rfqLineBlock = blocks[i];
      const lineNoMatch = rfqLineBlock.match(/RFQ Line #:\s*(\d+)/);
      const totalCostMatch = rfqLineBlock.match(/Total Cost:\s*([0-9.]+)/);
      const lineNo = lineNoMatch ? parseInt(lineNoMatch[1], 10) : null;
      const totalCost = totalCostMatch ? totalCostMatch[1] : null;
      let vendorQuoteBlock = null;
      if (i + 1 < blocks.length && blocks[i + 1].startsWith('Vendor Quote\n')) {
        vendorQuoteBlock = blocks[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      linePairs.push({ lineNo, totalCost, rfqLineBlock, vendorQuoteBlock });
    } else {
      i++;
    }
  }

  // Filter to kept lines only
  const keptPairs = linePairs.filter(p => keepLines.has(p.lineNo));
  console.log(`[filter] Found ${linePairs.length} line+VQ pairs in Copy Text; keeping ${keptPairs.length} (${[...keepLines].sort((a,b)=>a-b).join(', ')})`);

  // For each kept pair, find its matching RFQ summary block (by Total Cost) and keep that
  const keptCosts = new Set(keptPairs.map(p => p.totalCost).filter(Boolean));
  const keptSummaries = rfqSummaries.filter(s => {
    const m = s.match(/Total Cost:\s*([0-9.]+)/);
    return m && keptCosts.has(m[1]);
  });

  // Rebuild the text in the original ordering: summaries first, then pairs
  const out = [];
  for (const s of keptSummaries) out.push(s);
  for (const p of keptPairs) {
    out.push(p.rfqLineBlock);
    if (p.vendorQuoteBlock) out.push(p.vendorQuoteBlock);
  }
  return out.join('\n\n') + '\n';
}

(async () => {
  const raw = fs.readFileSync(COPY_TEXT_FILE, 'utf8');
  const filtered = parseAndFilter(raw, KEEP_LINES);

  console.log(`\n[filter] Output: ${filtered.length} chars`);
  console.log(`[filter] Preview (first 600 chars):`);
  console.log('---');
  console.log(filtered.substring(0, 600));
  console.log('---\n');

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('[dry-run] Skipping POST.');
    fs.writeFileSync(path.join(__dirname, 'tracy-filtered-approval.txt'), filtered);
    console.log('Saved tracy-filtered-approval.txt for inspection.');
    return;
  }

  const payload = {
    R_RequestType_ID: 1000000,   // Approve Order
    R_Status_ID:      1000000,   // Submitted
    Priority:         '5',
    Chuboe_RFQ_ID:    RFQ_INTERNAL_ID,
    C_BPartner_ID:    C_BPARTNER_ID,
    SalesRep_ID:      SALES_REP_ID,
    Summary:          SUMMARY,
    Chuboe_Approval_Text: filtered,
    AD_Table_ID:      1000002,       // Chuboe_RFQ — links to RFQ window
    Record_ID:        RFQ_INTERNAL_ID,
  };

  console.log(`[approve-order] POST R_Request — Summary: "${SUMMARY}"`);
  const r = await apiPost('R_Request', payload);
  console.log(`  ✓ R_Request_ID = ${r.id}  DocumentNo = ${r.DocumentNo || '(server-assigned)'}`);
})().catch(e => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
