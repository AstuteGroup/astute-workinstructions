#!/usr/bin/env node
/**
 * Create request to add tariff line to PO810397 (POV0075254)
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPost } = require('./shared/api-client');

const ORDER_ID = 1017645;  // PO810397
const SALES_REP_ID = 1000004;  // Jake Harris

const requestText = `REQUEST: Add Tariff Line to PO810397

Infor POV: POV0075254
OT PO: PO810397
Vendor: Arrow Electronics

Invoice 29802810 (23-Jun-2026) includes a customs tariff charge:

  Line Item: SHV24-1A85-78D3K
    Qty: 288 @ $8.45 = $2,433.60 (pricing verified ✓)
    Date Code: 2507M
    COO: China
    Tracking: 530217763711

  CUSTOMS TARIFF CHARGE: $640.08
    Tariff No: 8536.41.00.20

TOTAL INVOICE: $3,073.68

Please add 1 tariff line for $640.08 to match the invoice.

Reference: Arrow Invoice 29802810`;

async function main() {
  console.log('Creating tariff request for PO810397...');

  const request = await apiPost('r_request', {
    R_RequestType_ID: 1000006,  // Change Request
    Summary: `Add tariff line to PO810397 - POV0075254 - $640.08 (Arrow Invoice 29802810)`,
    Result: requestText,
    C_Order_ID: ORDER_ID,
    SalesRep_ID: SALES_REP_ID,
    AD_User_ID: SALES_REP_ID,
    Priority: '5',
  }, { context: 'r-request-writer' });

  console.log(`✓ Request created: ${request.DocumentNo || request.id}`);
  console.log(`  Tariff: $640.08`);
  console.log(`  Invoice: 29802810`);
}

main().catch(console.error);
