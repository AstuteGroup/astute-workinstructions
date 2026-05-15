/**
 * One-off: route UID 3182 (Edgar's CY7C1019DV33-10ZSXI quote, $2.20 / 6,155 pcs
 * STOCK) against the matched RFQ 1134656. Bounced 2026-05-15 on a missing-MFR
 * needs_review that the new OT-history MFR path now resolves. Run after the
 * cq-writer.MANDATORY_FIELDS + mfr-resolver.consultOTHistory changes shipped
 * the same session.
 *
 * Usage: node oneoffs/resolve-cq-uid-3182.js [--commit]
 *   default is dry-run; pass --commit to write.
 */

'use strict';

require('dotenv').config({ path: require('path').join(require('os').homedir(), 'workspace/.env') });

const { writeCQBatch } = require('../shared/cq-writer');

const COMMIT = process.argv.includes('--commit');

const RFQ_SEARCH_KEY = '1134656';
const LINES = [
  {
    mpn: 'CY7C1019DV33-10ZSXI',
    qty: 6155,
    resale: 2.20,
    leadTime: 'STOCK',
    // mfrText intentionally omitted — writer's consultOTHistory path will
    // resolve it to "Cypress Semiconductor Corp" from prior CQ/VQ history
    notePrivate: 'Routed manually after MFR-blank needs_review (UID 3182, 2026-05-15) — MFR auto-inferred from OT trading history via mfr-from-ot-history.js.',
  },
];

(async () => {
  if (!COMMIT) {
    console.log('DRY-RUN (pass --commit to actually write)');
    console.log('Would call: writeCQBatch(' + JSON.stringify(RFQ_SEARCH_KEY) + ', ' + JSON.stringify(LINES, null, 2) + ')');
    process.exit(0);
  }
  console.log('Writing CQ to RFQ ' + RFQ_SEARCH_KEY + '...');
  const r = await writeCQBatch(RFQ_SEARCH_KEY, LINES, {});
  console.log('Result:');
  console.log(JSON.stringify({
    written: r.written,
    flagged: r.flagged,
    failed: r.failed,
    skipped: r.skipped,
    summary: r.summary,
  }, null, 2));
})().catch(e => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
