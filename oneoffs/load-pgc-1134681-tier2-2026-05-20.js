#!/usr/bin/env node
//
// Load the missing PGC tier-2 quote on ESDLIN1524BJ (RFQ 1134681). Email body
// had three PGC tiers (10500/$0.305, 30000/$0.305, 45000/$0.444); the agent
// loaded tiers 1 and 3 but skipped tier 2 because that line had no explicit
// vendor name (continuation of preceding PGC block).
//
// Source row: "ESDLIN1524BJ 30000 ST 25+ $0.305 3-4d COO CN" (unnamed
// continuation of "pgc ESDLIN1524BJ ST 10500 25+ $0.305 3-4d COO CN").

'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { loadBulkSummary } = require('../shared/load-bulk-summary');

(async () => {
  const result = await loadBulkSummary({
    rfqSearchKey: '1134681',
    buyerId: 1006326, // Elaine Liang
    quotes: [{
      vendorSearchKey: null,
      vendorName: 'PGC-IC Ltd',
      mpn: 'ESDLIN1524BJ',
      mfr: 'STMicroelectronics',
      qty: 30000,
      cost: 0.305,
      leadTime: '3-4d',
      dateCode: '25+',
      coo: 'China',
      vendorNotes: 'PGC tier-2 — unnamed continuation row in operator email recovered manually 2026-05-20',
    }],
    dryRun: false,
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
