/**
 * One-off: flip c_bpartner.ischuboestock from 'N' to 'Y' on
 *   Astute Electronics - LAM Consignment (c_bpartner_id 1011267)
 *
 * Operator confirmed 2026-05-15: this BP was misclassified. ischuboestock is
 * the canonical flag the chuboe_mpn Stock tab uses to decide whether a BP's
 * chuboe_offer rows count as visible stock. Eaton Consignment (same shape of
 * arrangement) is already 'Y'; LAM was 'N' by oversight. Flipping it makes
 * the LAM Consignment offers (e.g., SZ-KS16/12N 510 pcs in Philippines) appear
 * on the Stock tab alongside other market offer types.
 *
 * Usage: node oneoffs/patch-lam-consignment-ischuboestock.js [--commit]
 */

'use strict';
require('dotenv').config({ path: require('path').join(require('os').homedir(), 'workspace/.env') });

const { apiGet } = require('../shared/api-client');
const { patchRecord } = require('../shared/record-updater');

const COMMIT = process.argv.includes('--commit');
const BP_ID = 1011267;

(async () => {
  const before = await apiGet('c_bpartner', { id: BP_ID });
  console.log('BEFORE:');
  console.log('  Name:           ', before.Name);
  console.log('  IsChuboeStock:  ', before.IsChuboeStock);
  console.log('  IsActive:       ', before.IsActive);

  if (!COMMIT) {
    console.log('\nDRY-RUN. Pass --commit to apply.');
    return;
  }

  const result = await patchRecord('c_bpartner', BP_ID, { IsChuboeStock: true }, {
    source: 'one-off:lam-consignment-ischuboestock-2026-05-15',
  });
  console.log('\nPATCH RESULT:');
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
