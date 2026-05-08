'use strict';
/**
 * Clean up the 18 customer-excess offers written to wrong (employee) BPs
 * 5/04-5/06.
 *
 * Two-phase:
 *   Phase 1 — deactivate 11 offers
 *     - 9 Bucket A junk (sender-confirmation 'Upload MO_*' emails, no real data)
 *     - 2 Bucket B dups (1026093 dup of 1026092; 1026114 dup of 1026113)
 *
 *   Phase 2 — PATCH BP on 7 Bucket B unique offers
 *     - 1026070 → GE Healthcare (1000732)
 *     - 1026074 → Syrma SGS Technology (1003549)
 *     - 1026075 → Schneider Electric (1005030)
 *     - 1026089 → Future Electronics (1000328) + flip type to Broker Stock Offer (1000001)
 *     - 1026092 → GE Healthcare (1000732)
 *     - 1026113 → Matrix Comesec (1008058)
 *     - 1026115 → GE Healthcare (1000732)
 *
 * Run with --commit to actually patch; default is dry-run.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { patchRecord } = require('../../../shared/record-updater');

const COMMIT = process.argv.includes('--commit');

const DEACTIVATE = [
  // Bucket A — junk
  { offerId: 1026184, sk: '1026077', reason: 'Bucket A junk — Upload MO_Search Key 1008289 (sender notification, no offer data)' },
  { offerId: 1026185, sk: '1026078', reason: 'Bucket A junk — Upload MO_Search Key 1008289' },
  { offerId: 1026186, sk: '1026079', reason: 'Bucket A junk — Upload MO_Search Key 1008289' },
  { offerId: 1026187, sk: '1026080', reason: 'Bucket A junk — Upload MO_1002733' },
  { offerId: 1026188, sk: '1026081', reason: 'Bucket A junk — Upload MO_1002733' },
  { offerId: 1026189, sk: '1026082', reason: 'Bucket A junk — Upload MO_1002733' },
  { offerId: 1026190, sk: '1026083', reason: 'Bucket A junk — Upload MO_1002733' },
  { offerId: 1026191, sk: '1026084', reason: 'Bucket A junk — Upload MO_Search Key 1005525' },
  { offerId: 1026192, sk: '1026085', reason: 'Bucket A junk — Upload MO_Search Key 1005525' },
  // Bucket B — duplicate forwards
  { offerId: 1026200, sk: '1026093', reason: 'Bucket B dup — same email as 1026092 (FW: 5AGXMB5G4F40C5G), forwarded twice by Aaron' },
  { offerId: 1026221, sk: '1026114', reason: 'Bucket B dup — same email as 1026113 (FW: Matrix comsec - Search key#1009991)' },
];

const PATCH = [
  { offerId: 1026177, sk: '1026070', bp: 1000732, bpName: 'GE Healthcare',                 reason: 'FW: Excess from Naneesh@gehealthcare.com' },
  { offerId: 1026181, sk: '1026074', bp: 1003549, bpName: 'Syrma SGS Technology Limited',  reason: 'FW: Excess - Syrma' },
  { offerId: 1026182, sk: '1026075', bp: 1005030, bpName: 'Schneider Electric',            reason: 'FW: Excess inventory - Schneider Electric Pvt. Ltd.' },
  { offerId: 1026196, sk: '1026089', bp: 1000328, bpName: 'Future Electronics Corporation', reason: 'FW: Liquidation List from Mary.Papanastasoulis@FutureElectronics.com — broker liquidation, not customer excess', flipToBrokerType: true },
  { offerId: 1026199, sk: '1026092', bp: 1000732, bpName: 'GE Healthcare',                 reason: 'FW: 5AGXMB5G4F40C5G from Naneesh@gehealthcare.com' },
  { offerId: 1026220, sk: '1026113', bp: 1008058, bpName: 'Matrix Comesec Pvt Ltd',         reason: 'FW: Matrix comsec - Search key#1009991 — search key in subject explicit' },
  { offerId: 1026222, sk: '1026115', bp: 1000732, bpName: 'GE Healthcare',                 reason: 'FW: Altera Excess Inventory from Aguilar Zuñiga@gehealthcare.com' },
];

(async () => {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}\n`);

  console.log('═'.repeat(100));
  console.log(`PHASE 1 — Deactivate ${DEACTIVATE.length} offers`);
  console.log('═'.repeat(100));
  let okDeact = 0, errDeact = 0;
  for (const d of DEACTIVATE) {
    console.log(`  ${d.sk} (id ${d.offerId}): ${d.reason}`);
    if (!COMMIT) continue;
    try {
      const r = await patchRecord('chuboe_offer', d.offerId, { IsActive: 'N' }, { source: 'wrong-bp-cleanup-2026-05-07' });
      if (r.status === 'patched' || r.status === 'no-op') { console.log(`    → ${r.status}`); okDeact++; }
      else { console.log(`    → ${r.status} ${r.error || ''}`); errDeact++; }
    } catch (e) {
      console.log(`    → ERROR ${e.message}`);
      errDeact++;
    }
  }

  console.log('');
  console.log('═'.repeat(100));
  console.log(`PHASE 2 — PATCH BP on ${PATCH.length} Bucket B offers`);
  console.log('═'.repeat(100));
  let okPatch = 0, errPatch = 0;
  for (const p of PATCH) {
    const fieldsToPatch = { C_BPartner_ID: p.bp };
    if (p.flipToBrokerType) fieldsToPatch.chuboe_offer_type_id = 1000001;
    const fieldDesc = Object.entries(fieldsToPatch).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  ${p.sk} (id ${p.offerId}) → ${p.bpName} (${p.bp})  [${fieldDesc}]`);
    console.log(`    reason: ${p.reason}`);
    if (!COMMIT) continue;
    try {
      const r = await patchRecord('chuboe_offer', p.offerId, fieldsToPatch, { source: 'wrong-bp-cleanup-2026-05-07' });
      if (r.status === 'patched' || r.status === 'no-op') { console.log(`    → ${r.status}`); okPatch++; }
      else { console.log(`    → ${r.status} ${r.error || ''}`); errPatch++; }
    } catch (e) {
      console.log(`    → ERROR ${e.message}`);
      errPatch++;
    }
  }

  console.log('');
  console.log('═'.repeat(100));
  console.log(`SUMMARY${COMMIT ? '' : ' (dry-run, nothing changed)'}`);
  console.log('═'.repeat(100));
  console.log(`  Deactivate: ${COMMIT ? `${okDeact} ok / ${errDeact} err` : `${DEACTIVATE.length} planned`}`);
  console.log(`  PATCH BP  : ${COMMIT ? `${okPatch} ok / ${errPatch} err` : `${PATCH.length} planned`}`);
})().catch(e => { console.error(e); process.exit(1); });
