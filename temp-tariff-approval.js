#!/usr/bin/env node
/**
 * Create approval request for tariff VQs
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { postApproveOrder } = require('./shared/r-request-writer');

const RFQ_ID = 1148927;
const RFQ_VALUE = '1139512';

const tariffVQs = [
  { vqId: 2228067, invoice: '89497435', amount: 99.65 },
  { vqId: 2228068, invoice: '89519101', amount: 94.41 },
  { vqId: 2228069, invoice: '89568193', amount: 778.90 },
  { vqId: 2228070, invoice: '89765460', amount: 7.28 },
  { vqId: 2228071, invoice: '90441161', amount: 0.31 },
];

const totalTariff = tariffVQs.reduce((sum, t) => sum + t.amount, 0);

async function main() {
  console.log('Creating approval request for tariff VQs...\n');

  const approvalText = `RFQ
  Customer: Lam Research
  Total Revenue: $0.00
  Total Cost: $${totalTariff.toFixed(2)}
  Gross Profit: N/A
  Profit Margin: N/A

TARIFF CHARGES - POV0075257 Reconciliation
Tariff charges from Mouser invoices for parts shipped March-May 2026.

Tariff Lines:
${tariffVQs.map(t => `  Invoice ${t.invoice}: $${t.amount.toFixed(2)}`).join('\n')}

Total Tariff: $${totalTariff.toFixed(2)}

Reference: Mouser Invoices 89497435, 89519101, 89568193, 89765460, 90441161

ACTION REQUIRED:
1. Add tariff charges to Infor POV0075257
2. Include in OT PO for Mouser
`.trim();

  try {
    const request = await postApproveOrder({
      vqIds: tariffVQs.map(t => t.vqId),
      program: 'LAM_KITTING',
      rfqId: RFQ_ID,
      summary: `approve order — Mouser POV0075257 tariff charges - $${totalTariff.toFixed(2)} for RFQ ${RFQ_VALUE}`,
      approvalText: approvalText,
      message: 'TARIFF: Charges from Mouser invoices for POV0075257 reconciliation items.',
    });
    console.log(`✓ Approval request created: ${request.documentNo}`);
    console.log(`  VQs validated: ${request.vqsValidated}`);
    console.log(`  Total tariff: $${totalTariff.toFixed(2)}`);
  } catch (err) {
    console.log(`✗ Approval request failed: ${err.message}`);
    if (err.violations) {
      for (const v of err.violations) {
        console.log(`    - ${v}`);
      }
    }
  }
}

main().catch(console.error);
