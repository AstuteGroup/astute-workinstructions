#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('./shared/notifier');

async function main() {
  const notifier = createNotifier({
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Kitting'
  });

  const outputPath = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/Mouser_Invoice_Details_All_POVs.xlsx';

  await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com',
    'Mouser Invoice Details - All POVs (12 Invoices)',
    `Mouser Invoice Details attached.

12 invoices across 4 POVs:

POV0075257: 5 invoices, $12,218.70
  - 89497435: $3,452.80 (Mar 26)
  - 89519101: $1,953.01 (Mar 27)
  - 89568193: $6,710.73 (Mar 30)
  - 89765460: $98.03 (Apr 13)
  - 90441161: $4.13 (May 20)

POV0075563: 5 invoices, $2,581.14
  - 89821186: $938.00 (Apr 14)
  - 90172966: $187.82 (May 05)
  - 90302299: $280.95 (May 13)
  - 90893594: $425.17 (Jun 16)
  - 90945447: $749.20 (Jun 18)

POV0075856: 1 invoice, $265.20
  - 90969889: $265.20 (Jun 18)

POV0076829: 1 invoice, $413.18
  - 91087894: $413.18 (Jun 25)

GRAND TOTAL: $15,478.22

Sheets included:
1. Invoice Lines - Full line-by-line detail
2. Invoice Summary - Per-invoice totals with POV subtotals
3. For Receiving - Shipped items only with tracking
4. For Accounts Payable - Payment summary`,
    [{ filename: 'Mouser_Invoice_Details_All_POVs.xlsx', path: outputPath }]
  );

  console.log('Email sent!');
}

main().catch(console.error);
