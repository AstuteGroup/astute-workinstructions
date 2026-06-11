#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const XLSX = require('xlsx');
const { writeOffer } = require('../shared/offer-writeback');
const { createNotifier } = require('../shared/notifier');

const BPARTNER_ID = 1005860; // CHARGEPOINT
const OFFER_TYPE = 1000000;  // Customer Excess

(async () => {
  // Parse the xlsx
  const wb = XLSX.readFile('/tmp/Surplus Wire Inventory.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  const lines = data.map(r => ({
    mpn: String(r['Part Number'] || '').trim().replace(/^\t|\r|\n/g, ''),
    mfr: String(r['Manufacturer or Additional Description'] || '').split(/[\r\n]/)[0].trim(),
    qty: Number(r[' Inventory qty  ']) || 0,
    description: String(r['Description'] || '').trim()
  })).filter(l => l.mpn && l.qty > 0);

  console.log(`Parsed ${lines.length} lines from xlsx`);
  lines.slice(0, 3).forEach(l => console.log(`  ${l.mpn} - ${l.mfr} - qty ${l.qty}`));

  // Write the offer
  const result = await writeOffer({
    bpartnerId: BPARTNER_ID,
    offerTypeId: OFFER_TYPE,
    description: 'ChargePoint Surplus Wire Inventory — Jun 2026',
    writeMpnRecords: true,
    lines,
  });

  console.log('\nOffer created:');
  console.log(`  Offer ID: ${result.offerId}`);
  console.log(`  Search Key (MO#): ${result.searchKey}`);
  console.log(`  Lines written: ${result.linesWritten}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
  }

  // Send confirmation email
  const notifier = createNotifier({
    fromEmail: 'excess@orangetsunami.com',
    fromName: 'Excess Offer System'
  });

  const confirmBody = `Thank you for submitting the excess offer.

Partner: CHARGEPOINT
Market Offer #: ${result.searchKey}
Lines loaded: ${result.linesWritten}

This offer has been loaded into Orange Tsunami and is now available for matching against open RFQs.

— Excess Offer System (automated)`;

  // TO: original external sender, CC: internal forwarders + Jake
  const toEmail = 'erika.estrada@chargepoint.com';
  const ccEmails = ['alex.partida@astutegroup.com', 'joel.marquez@astutegroup.com', 'jake.harris@astutegroup.com'];

  await notifier.sendEmail(toEmail, 'Re: Surplus Wire and Components Available – Bulk Lot', confirmBody, {
    cc: ccEmails
  });

  console.log(`\nConfirmation sent to: ${toEmail}`);
  console.log(`CC: ${ccEmails.join(', ')}`);
})();
