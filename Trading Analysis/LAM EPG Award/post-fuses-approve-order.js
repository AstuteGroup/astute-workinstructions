/**
 * Post the Approve Order R_Request for the 4 Fuses VQs on RFQ 1132040.
 *
 * Approval text is verbatim from Jake's OT Copy Text paste (with the truncated
 * final "Jake Harri" restored to "Jake Harris"). All 4 lines show Traceability:
 * Authorized Distribution Certs after the 12:59 patch.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { apiPost } = require('../../shared/api-client');

const APPROVAL_TEXT = `RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost: 220.72
  Gross Profit:
  Profit Margin: 0%

RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost:
  Gross Profit:
  Profit Margin: 0%

RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost: 382.96
  Gross Profit:
  Profit Margin: 0%

RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost: 28.42
  Gross Profit:
  Profit Margin: 0%

RFQ
  Customer: Lam Research
  Total Revenue:
  Total Cost: 720.92
  Gross Profit:
  Profit Margin: 0%

RFQ Line
  RFQ Line #: 110
  Purchase Qty: 30
  Sold Qty:
  Total Revenue:
  Total Cost: 720.92
  Gross Profit:
  Profit Margin: 0%
  Sales Rep: Josh Syre
  Public Customer Notes:
  Private Customer Notes:

Vendor Quote
  Vendor: Fuses Unlimited
  Vendor Type: Catalog
  Traceability: Authorized Distribution Certs
  Contact:
  Contact Email:
  Contact Phone:
  MPN: LP-CC-30
  Ship-To Warehouse: BROWNSVILLE
  Inventory Group Identifier: W111: LAM KITTING
  Cost: 24.0308 USD
  Quantity: 30
  Date Code: within 2 years
  COO: PENDING
  Lead Time: stock
  Packaging: OTHER
  Shipper: FedEx Ground
  RoHS: Y
  Public Vendor Order Notes:
  Private Vendor Order Notes:
  Inco Term: The seller makes the goods available at its location, so the buyer can take over all the transportation costs and also bears the risks of bringing the goods to their final destination.
  MFR: Eaton
  Buyer: Jake Harris

RFQ Line
  RFQ Line #: 210
  Purchase Qty: 20
  Sold Qty:
  Total Revenue:
  Total Cost: 382.96
  Gross Profit:
  Profit Margin: 0%
  Sales Rep: Josh Syre
  Public Customer Notes:
  Private Customer Notes:

Vendor Quote
  Vendor: Fuses Unlimited
  Vendor Type: Catalog
  Traceability: Authorized Distribution Certs
  Contact:
  Contact Email:
  Contact Phone:
  MPN: KLKR007.T
  Ship-To Warehouse: BROWNSVILLE
  Inventory Group Identifier: W111: LAM KITTING
  Cost: 19.148 USD
  Quantity: 20
  Date Code: within 2 years
  COO: PENDING
  Lead Time: stock
  Packaging: OTHER
  Shipper: FedEx Ground
  RoHS: Y
  Public Vendor Order Notes:
  Private Vendor Order Notes:
  Inco Term: The seller makes the goods available at its location, so the buyer can take over all the transportation costs and also bears the risks of bringing the goods to their final destination.
  MFR: Littelfuse Inc
  Buyer: Jake Harris

RFQ Line
  RFQ Line #: 1540
  Purchase Qty: 105
  Sold Qty:
  Total Revenue:
  Total Cost: 28.42
  Gross Profit:
  Profit Margin: 0%
  Sales Rep: Josh Syre
  Public Customer Notes:
  Private Customer Notes:

Vendor Quote
  Vendor: Fuses Unlimited
  Vendor Type: Catalog
  Traceability: Authorized Distribution Certs
  Contact:
  Contact Email:
  Contact Phone:
  MPN: #ABC-12
  Ship-To Warehouse: BROWNSVILLE
  Inventory Group Identifier: W111: LAM KITTING
  Cost: 0.2707 USD
  Quantity: 105
  Date Code: within 2 years
  COO: PENDING
  Lead Time: stock
  Packaging: OTHER
  Shipper: FedEx Ground
  RoHS: Y
  Public Vendor Order Notes: BK/ABC-12-R part number accepted
  Private Vendor Order Notes:
  Inco Term: The seller makes the goods available at its location, so the buyer can take over all the transportation costs and also bears the risks of bringing the goods to their final destination.
  MFR: Eaton
  Buyer: Jake Harris

RFQ Line
  RFQ Line #: 2020
  Purchase Qty: 200
  Sold Qty:
  Total Revenue:
  Total Cost: 220.72
  Gross Profit:
  Profit Margin: 0%
  Sales Rep: Josh Syre
  Public Customer Notes:
  Private Customer Notes:

Vendor Quote
  Vendor: Fuses Unlimited
  Vendor Type: Catalog
  Traceability: Authorized Distribution Certs
  Contact:
  Contact Email:
  Contact Phone:
  MPN: S505H-500-R
  Ship-To Warehouse: BROWNSVILLE
  Inventory Group Identifier: W111: LAM KITTING
  Cost: 1.1036 USD
  Quantity: 200
  Date Code: within 2 years
  COO: PENDING
  Lead Time: stock
  Packaging: OTHER
  Shipper: FedEx Ground
  RoHS: Y
  Public Vendor Order Notes: BK1-S505H-500-R part number accepted
  Private Vendor Order Notes:
  Inco Term: The seller makes the goods available at its location, so the buyer can take over all the transportation costs and also bears the risks of bringing the goods to their final destination.
  MFR: Eaton
  Buyer: Jake Harris`;

const PAYLOAD = {
  R_RequestType_ID:    1000000,   // Approve Order
  R_Status_ID:         1000000,   // Submitted
  Priority:            '5',
  Chuboe_RFQ_ID:       1141455,   // RFQ 1132040 internal
  C_BPartner_ID:       1001105,   // Fuses Unlimited
  SalesRep_ID:         1000004,   // Jake Harris
  Summary:             'Please approve LAM Kitting orders',
  Chuboe_Approval_Text: APPROVAL_TEXT,
  AD_Table_ID:         1000002,       // Chuboe_RFQ — links to RFQ window
  Record_ID:           1141455,
};

(async () => {
  console.log('[approve-order] POST R_Request for Fuses Unlimited / RFQ 1132040');
  console.log(`  Summary: "${PAYLOAD.Summary}"`);
  console.log(`  Approval text length: ${APPROVAL_TEXT.length} chars`);
  const r = await apiPost('R_Request', PAYLOAD);
  console.log(`  ✓ R_Request_ID = ${r.id}  DocumentNo = ${r.DocumentNo || '(server-assigned)'}`);
})().catch(e => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
