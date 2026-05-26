/**
 * Offline proof for the load-bulk-summary no-bid fix — no OT/API needed.
 * Confirms: the no-bid stub (qty 0 / cost 0) now produces a row out of
 * extractStockAndLtRows (previously returned null -> WRITE_FAILED), AND that
 * vq-writer's no-bid filter predicate accepts it.
 */
'use strict';
const { extractStockAndLtRows } = require('../shared/franchise-api');

// The stub load-bulk-summary.js now builds for a no-bid quote.
const stub = {
  found: true, name: 'HAOXIN', bpValue: '1006032',
  vqMpn: 'ADUM4402CRWZ', vqManufacturer: 'Analog Devices',
  franchiseRfqPrice: 0, vqPrice: 0, franchiseQty: 0,
  vqLeadTime: '', vqVendorNotes: 'No-bid - NO STK',
  vqLines: [{
    vendorBP: '1006032', vendorName: 'HAOXIN', channel: 'HAOXIN',
    mpn: 'ADUM4402CRWZ', manufacturer: 'Analog Devices',
    qty: 0, cost: 0, leadTime: null, dateCode: null,
    moq: null, spq: null, vendorNotes: 'No-bid - NO STK', currencyId: null,
  }],
};

const rows = extractStockAndLtRows(stub, 'ADUM4402CRWZ', 3000);
console.log('extractStockAndLtRows returned:', rows ? `${rows.length} row(s)` : 'null (BUG — dropped)');

// vq-writer's no-bid filter (shared/vq-writer.js:529-530)
const accepted = (rows || []).filter(sub => sub.cost != null && sub.qty != null &&
  ((sub.cost > 0 && sub.qty > 0) || (sub.cost === 0 && sub.qty === 0)));
console.log('no-bid filter accepted:', accepted.length, 'row(s)');

// Counter-check: an old-style stub WITHOUT vqLines (relying on synthesize) still drops.
const oldStub = { ...stub }; delete oldStub.vqLines;
const oldRows = extractStockAndLtRows(oldStub, 'ADUM4402CRWZ', 3000);
console.log('pre-fix path (no vqLines) returns:', oldRows ? `${oldRows.length} row(s)` : 'null (confirms the original drop)');

const ok = rows && rows.length === 1 && accepted.length === 1 && oldRows === null;
console.log(ok ? '\nPASS — no-bid now survives extraction; old path confirmed dropping.' : '\nFAIL');
process.exit(ok ? 0 : 1);
