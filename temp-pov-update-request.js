#!/usr/bin/env node
/**
 * Create request to update POV price and add tariff line for PO810397
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPost } = require('./shared/api-client');

const ORDER_ID = 1017645;  // PO810397
const SALES_REP_ID = 1000004;  // Jake Harris

const requestText = `REQUEST: Update POV Price + Add Tariff Line

OT PO: PO810397
Infor POV: POV0075254
Vendor: Arrow Electronics
Invoice: 29802810 (23-Jun-2026)

═══════════════════════════════════════════════════════════════

1. UPDATE POV PRICE TO MATCH INVOICE

   MPN: SHV24-1A85-78D3K
   Qty: 288

   Invoice Price: $8.45 each
   OT Price: $8.45 each ✓

   >> Please update Infor POV0075254 price to $8.45 to match invoice

═══════════════════════════════════════════════════════════════

2. ADD TARIFF LINE

   CUSTOMS TARIFF CHARGE: $640.08
   Tariff No: 8536.41.00.20

   >> Please add tariff line for $640.08 to POV0075254

═══════════════════════════════════════════════════════════════

INVOICE SUMMARY:
  Parts: $2,433.60 (288 x $8.45)
  Tariff: $640.08
  TOTAL: $3,073.68

Tracking: 530217763711
Ship Date: 23-Jun-2026
Date Code: 2507M
COO: China`;

async function main() {
  console.log('Creating request for PO810397...');

  const request = await apiPost('r_request', {
    R_RequestType_ID: 1000006,  // Change Request
    Summary: `Update POV price + add tariff - PO810397 / POV0075254 - Arrow Invoice 29802810`,
    Result: requestText,
    C_Order_ID: ORDER_ID,
    SalesRep_ID: SALES_REP_ID,
    AD_User_ID: SALES_REP_ID,
    Priority: '5',
  }, { context: 'r-request-writer' });

  console.log(`✓ Request created: ${request.DocumentNo || request.id}`);
}

main().catch(console.error);
