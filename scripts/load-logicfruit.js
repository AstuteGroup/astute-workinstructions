#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { writeOffer } = require('../shared/offer-writeback');
const { createNotifier } = require('../shared/notifier');

const BPARTNER_ID = 1009965; // Logic Fruit Technologies
const OFFER_TYPE = 1000000;  // Customer Excess

(async () => {
  // Lines from email body
  const lines = [
    { mpn: '10M08SCU169I7G', mfr: 'Intel/Altera', qty: 480, description: 'FPGA' },
    { mpn: '10CL040YF484I7G', mfr: 'Intel/Altera', qty: 120, description: 'FPGA' },
    { mpn: '10M16SCU169I7G', mfr: 'Intel/Altera', qty: 222, description: 'FPGA' },
    { mpn: '10CL055YF484I7G', mfr: 'Intel/Altera', qty: 112, description: 'FPGA' },
    { mpn: 'ICZ0912D15', mfr: 'XP Power', qty: 500, description: 'DC-DC Converter' },
    { mpn: 'JCM3012D15', mfr: 'XP Power', qty: 80, description: 'DC-DC Converter' },
    { mpn: 'ICZ0912S05', mfr: 'XP Power', qty: 44, description: 'DC-DC Converter' },
  ];

  console.log(`Loading ${lines.length} lines for Logic Fruit Technologies`);
  lines.forEach(l => console.log(`  ${l.mpn} - ${l.mfr} - qty ${l.qty}`));

  // Write the offer
  const result = await writeOffer({
    bpartnerId: BPARTNER_ID,
    offerTypeId: OFFER_TYPE,
    description: 'Logic Fruit Technologies Excess — Jun 2026',
    writeMpnRecords: true,
    lines,
  });

  console.log('\nOffer created:');
  console.log(`  Offer ID: ${result.offerId}`);
  console.log(`  Search Key (MO#): ${result.searchKey}`);
  console.log(`  Lines written: ${result.linesWritten}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`    - ${e}`));
  }

  // Send confirmation email to INTERNAL Astute people only
  const notifier = createNotifier({
    fromEmail: 'excess@orangetsunami.com',
    fromName: 'Excess Offer System'
  });

  const confirmBody = `The following excess offer has been loaded into Orange Tsunami.

Partner: Logic Fruit Technologies
Market Offer #: ${result.searchKey}
Lines loaded: ${result.linesWritten}

This offer is now available for matching against open RFQs.

— Excess Offer System (automated)`;

  // Only send to internal Astute people
  const toEmail = 'nandhini@astutegroup.com';
  const ccEmails = ['lavanya.manohar@astutegroup.com', 'jake.harris@astutegroup.com'];

  await notifier.sendEmail(toEmail, 'Re: Excess parts available – Logic Fruit Technologies', confirmBody, {
    cc: ccEmails
  });

  console.log(`\nConfirmation sent to: ${toEmail}`);
  console.log(`CC: ${ccEmails.join(', ')}`);
})();
