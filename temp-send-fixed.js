#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('./shared/notifier');

async function main() {
  const notifier = createNotifier({
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Kitting'
  });

  await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com',
    'Mouser Invoice Details - FIXED (tracking only on shipped lines)',
    `Fixed version - tracking and ship date only appear on lines that actually shipped.

12 invoices, 4 POVs, $15,478.22 total.

Sheets:
1. All Invoice Lines - every line with tracking only where qty shipped > 0
2. Invoice Summary - per-invoice totals`,
    [{
      filename: 'Mouser_Invoice_Details_All_POVs.xlsx',
      path: '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Invoice_Details_All_POVs.xlsx'
    }]
  );

  console.log('Email sent!');
}

main().catch(console.error);
