#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const XLSX = require('xlsx');
const { writeOffer } = require('../shared/offer-writeback');
const { createNotifier } = require('../shared/notifier');

const BPARTNER_ID = 1000463; // USI Electronics
const OFFER_TYPE = 1000000;  // Customer Excess

(async () => {
  // Parse the xlsx
  const wb = XLSX.readFile('/tmp/USI MX List of Sale - WK22.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  // Map columns: Plant, Material, MPN, Manufacturer, ' QTY ', ' UP USD ', ' Total Value '
  const lines = data.map(r => ({
    mpn: String(r['MPN'] || '').trim(),
    mfr: String(r['Manufacturer'] || '').trim(),
    qty: Number(r[' QTY ']) || 0,
    description: String(r['Material'] || '').trim()
  })).filter(l => l.mpn && l.qty > 0);

  console.log(`Parsed ${lines.length} lines from xlsx`);
  console.log('Sample lines:');
  lines.slice(0, 5).forEach(l => console.log(`  ${l.mpn} - ${l.mfr} - qty ${l.qty}`));

  // Write the offer
  console.log('\nWriting offer to OT...');
  const result = await writeOffer({
    bpartnerId: BPARTNER_ID,
    offerTypeId: OFFER_TYPE,
    description: 'USI Mexico Excess - Week 22 Jun 2026',
    writeMpnRecords: true,
    lines,
  });

  console.log('\nOffer created:');
  console.log(`  Offer ID: ${result.offerId}`);
  console.log(`  Search Key (MO#): ${result.searchKey}`);
  console.log(`  Lines written: ${result.linesWritten}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    result.errors.slice(0, 5).forEach(e => console.log(`    - ${e}`));
  }

  // Skip confirmation emails during manual backlog processing
  console.log('\n(Confirmation email skipped - batch processing mode)');
})();
