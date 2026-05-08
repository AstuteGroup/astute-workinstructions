/**
 * Post 4 Approve Order R_Requests, one per vendor, for the 11 new VQs
 * loaded today (lines 50, 130, 280, 690, 720, 830, 1280, 1610, 1640, 2040).
 *
 * Source: copy-text-1132040-batch-vendor.txt (the 11 lines from Jake's OT paste)
 *
 * Vendor → R_Request:
 *   Master:  lines 50, 690         BP 1000405
 *   DigiKey: 280, 1280, 1610, 1640 BP 1000327
 *   Sager:   720                   BP 1000335
 *   Waldom:  130, 830, 2040        BP 1000644
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { apiPost } = require('../../shared/api-client');

const SRC = path.join(__dirname, '../../../.tmp-attach/copy-text-1132040-batch-vendor.txt');
const TRACKER = path.join(__dirname, 'session-load-tracker.json');

const RFQ_INTERNAL_ID = 1141455;
const SALES_REP_ID = 1000004;

const BATCHES = [
  { vendor: 'Master',  bpId: 1000405, lines: new Set([50, 690]),       subject: 'Please approve LAM Kitting orders — Master' },
  { vendor: 'DigiKey', bpId: 1000327, lines: new Set([280, 1280, 1610, 1640]), subject: 'Please approve LAM Kitting orders — DigiKey (batch 2)' },
  { vendor: 'Sager',   bpId: 1000335, lines: new Set([720]),           subject: 'Please approve LAM Kitting orders — Sager' },
  { vendor: 'Waldom',  bpId: 1000644, lines: new Set([130, 830, 2040]), subject: 'Please approve LAM Kitting orders — Waldom' },
];

// Parse Copy Text into [{lineNo, rfqLineBlock, vqBlocks: [...]}]
function parseCopyText(raw) {
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const out = [];
  let current = null;
  for (const b of blocks) {
    if (b.startsWith('RFQ Line\n')) {
      if (current) out.push(current);
      const m = b.match(/RFQ Line #:\s*(\d+)/);
      const lineNo = m ? Number(m[1]) : null;
      current = { lineNo, rfqLineBlock: b, vqBlocks: [] };
    } else if (b.startsWith('Vendor Quote\n') && current) {
      current.vqBlocks.push(b);
    }
    // Top RFQ summary blocks ignored — we'll regenerate them per filter
  }
  if (current) out.push(current);
  return out;
}

function buildApprovalText(pairs) {
  // Generate RFQ summary blocks from each kept pair (one per pair)
  const out = [];
  for (const p of pairs) {
    const m = p.rfqLineBlock.match(/Total Cost:\s*([0-9.]+)/);
    const totalCost = m ? m[1] : '';
    out.push(`RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost: ${totalCost}
  Gross Profit:
  Profit Margin: 0%`);
  }
  for (const p of pairs) {
    out.push(p.rfqLineBlock);
    for (const vq of p.vqBlocks) out.push(vq);
  }
  return out.join('\n\n') + '\n';
}

(async () => {
  const raw = fs.readFileSync(SRC, 'utf8');
  const allPairs = parseCopyText(raw);
  console.log(`Parsed ${allPairs.length} RFQ Line blocks from Copy Text`);

  const tracker = JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
  const results = [];

  for (const batch of BATCHES) {
    const pairs = allPairs.filter(p => batch.lines.has(p.lineNo));
    if (pairs.length === 0) {
      console.log(`  ✗ ${batch.vendor}: no matching lines in Copy Text`);
      continue;
    }
    const text = buildApprovalText(pairs);
    const linesStr = [...batch.lines].sort((a,b)=>a-b).join(', ');
    console.log(`\n[${batch.vendor}] lines: ${linesStr} (${pairs.length} RFQ Line blocks, ${pairs.reduce((s,p)=>s+p.vqBlocks.length,0)} VQ blocks, ${text.length} chars)`);

    const payload = {
      R_RequestType_ID: 1000000,
      R_Status_ID:      1000000,
      Priority:         '5',
      Chuboe_RFQ_ID:    RFQ_INTERNAL_ID,
      C_BPartner_ID:    batch.bpId,
      SalesRep_ID:      SALES_REP_ID,
      Summary:          batch.subject,
      Chuboe_Approval_Text: text,
      AD_Table_ID:      1000002,       // Chuboe_RFQ — links to RFQ window
      Record_ID:        RFQ_INTERNAL_ID,
    };
    const r = await apiPost('R_Request', payload);
    console.log(`  ✓ R_Request_ID = ${r.id}  DocumentNo = ${r.DocumentNo}`);
    results.push({ vendor: batch.vendor, rRequestId: r.id, documentNo: r.DocumentNo, lines: [...batch.lines] });

    // Update tracker entries with this R_Request
    for (const t of tracker) {
      if (t.vendor && t.vendor.toLowerCase().includes(batch.vendor.toLowerCase())) {
        if (batch.lines.has(t.line)) {
          t.rRequest = r.id;
          t.status = 'SUBMITTED_FOR_APPROVAL';
        }
      }
    }
  }

  fs.writeFileSync(TRACKER, JSON.stringify(tracker, null, 2));
  console.log('\n=== POSTED ===');
  for (const r of results) console.log(`  ${r.vendor.padEnd(10)} R_Request ${r.rRequestId} (DocNo ${r.documentNo}) lines: ${r.lines.join(', ')}`);
  console.log('\n✓ tracker updated with R_Request IDs');
})().catch(e => { console.error(e); process.exit(1); });
