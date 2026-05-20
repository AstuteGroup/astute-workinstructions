#!/usr/bin/env node
//
// Single-quote load for Troson / ACPL-217-56AE (the last missing quote from
// Betty's "upload VQ May 13th" reprocess). The agent extracted only "roson"
// (red-highlighted substring), missing the leading "T" which was not in red.
// Operator (Jake) confirmed the correct vendor as Shenzhen Troson Technology
// Co., Ltd (BP 1001653, searchKey 1003655, Global Sourcing).
//
// Source row from Betty's email:
//   Troson  ACPL-217-56AE   12000   0.145usd，SPQ：3K，25+，

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { loadBulkSummary } = require('../shared/load-bulk-summary');

const QUOTE = {
  vendorSearchKey: '1003655',
  vendorName: 'Shenzhen Troson Technology Co., Ltd',
  mpn: 'ACPL-217-56AE',
  mfr: 'BROADCOM',
  qty: 12000,
  cost: 0.145,
  leadTime: 'stock',
  dateCode: '25+',
  vendorNotes: 'SPQ: 3K. operator follow-up after agent extracted only red substring "roson" missing leading "T" in "Troson"',
};

const RFQ = '1134279';
const BUYER_ID = 1011159; // Betty Song

(async () => {
  const result = await loadBulkSummary({
    rfqSearchKey: RFQ,
    buyerId: BUYER_ID,
    quotes: [QUOTE],
    dryRun: false,
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
