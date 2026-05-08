/**
 * Load 4 Fuses Unlimited VQs against RFQ 1132040 (LAM EPG).
 *
 * Quote: Sales Quote #1633615 from Charles Robinson (CRobinson@fusesunlimited.com),
 *        dated 2026-03-27, forwarded by Jake Harris on 2026-04-01.
 *        Captured in vq inbox session 2026-04-06T20-22-17 (email #20),
 *        flagged needs-extraction / no-template-match — never auto-loaded.
 *
 * Skipping BK/1A1119-10-R per Jake (will source from Master next).
 * Loading the other 4 lines at the qty *remaining to source* per SIPOC,
 * not the full LAM qty (LP-CC-30 and KLKR007.T are already partially placed).
 *
 * MPNs are loaded under the LAM file's MPN form (matches chuboe_rfq_line_mpn).
 * Vendor notes carry "<catalog form> part number accepted" per Jake's instruction.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { writeVQFromAPI } = require('../../shared/vq-writer');

const RFQ = '1132040';
const BUYER_ID = 1000004;            // Jake Harris
const FUSES_BP_SEARCH_KEY = '1003109'; // Fuses Unlimited

// Lines to load — qty = remaining-to-source per SIPOC
const LINES = [
  {
    cpc:        '670-346211-025',
    rfqMpn:     'LP-CC-30',          // matches chuboe_rfq_line_mpn (#5185096)
    catalogMpn: 'LP-CC-30',
    mfr:        'Eaton',
    qty:        30,
    cost:       24.0308,
    catalogMpn: null,                // form matches RFQ MPN — no note
  },
  {
    cpc:        '670-332664-018',
    rfqMpn:     'KLKR007.T',         // matches chuboe_rfq_line_mpn (#5185106)
    mfr:        'Littelfuse Inc',
    qty:        20,
    cost:       19.1480,
    catalogMpn: null,                // form matches RFQ MPN — no note
  },
  {
    cpc:        '670-006780-038',
    rfqMpn:     '#ABC-12',           // matches chuboe_rfq_line_mpn (#5185239)
    catalogMpn: 'BK/ABC-12-R',
    mfr:        'Eaton',
    qty:        105,
    cost:       0.2707,
  },
  {
    cpc:        '670-338640-050',
    rfqMpn:     'S505H-500-R',       // matches chuboe_rfq_line_mpn (#5185302)
    catalogMpn: 'BK1-S505H-500-R',
    mfr:        'Eaton',
    qty:        200,
    cost:       1.1036,
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n[fuses-vq] Loading ${LINES.length} VQs to RFQ ${RFQ} (dry-run=${dryRun})`);
  console.log(`[fuses-vq] Quote ref: Fuses Unlimited #1633615 dated 2026-03-27\n`);

  const all = { written: [], flagged: [], failed: [] };

  for (const ln of LINES) {
    const note = ln.catalogMpn ? `${ln.catalogMpn} part number accepted` : null;

    // Synthesize a single-distributor "franchise result" so writeVQFromAPI handles
    // BP / MFR / vendor type / traceability / validation. Pass searchedMpn = vqMpn
    // (both = the rfq-line MPN form) so the cross-ref check doesn't fire.
    const franchiseResults = {
      distributors: [{
        found: true,
        name: 'Fuses Unlimited',
        bpValue: FUSES_BP_SEARCH_KEY,
        vqMpn: ln.rfqMpn,
        vqManufacturer: ln.mfr,
        franchiseRfqPrice: ln.cost,
        vqPrice: ln.cost,
        franchiseQty: ln.qty,
        vqLeadTime: 'stock',
        vqVendorNotes: note,
      }],
    };

    console.log(`[fuses-vq] ${ln.cpc} ${ln.rfqMpn} (${ln.mfr})  qty=${ln.qty}  cost=$${ln.cost}  note="${note}"`);

    if (dryRun) {
      console.log('  [dry-run] would post 1 VQ');
      continue;
    }

    const r = await writeVQFromAPI(RFQ, ln.cpc, franchiseResults, {
      searchedMpn: ln.rfqMpn,
      buyerId: BUYER_ID,
    });

    all.written.push(...r.written);
    all.flagged.push(...r.flagged);
    all.failed.push(...r.failed);

    for (const w of r.written)  console.log(`    ✓ vq_line_id=${w.vqLineId}  mfr_id=${w.mfrId || '(text-only)'}`);
    for (const f of r.flagged)  console.log(`    ⚠ FLAGGED: ${f.reason} — ${f.detail}`);
    for (const f of r.failed)   console.log(`    ✗ FAILED: ${f.reason} — ${f.detail}`);
  }

  console.log(`\n[fuses-vq] Done: ${all.written.length} written, ${all.flagged.length} flagged, ${all.failed.length} failed`);
  if (all.written.length) {
    console.log('\nVQ line IDs:');
    for (const w of all.written) console.log(`  ${w.vqLineId}  ${w.mpn}  qty=${w.qty}  cost=$${w.price}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
