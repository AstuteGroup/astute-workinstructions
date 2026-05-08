/**
 * Post approve-order R_Request for Masline PO 304068.
 * Copy text synthesized from precedent (r_request 1155134, RFQ 1131454 — same
 * customer/part/source/split 6 weeks ago) per operator direction.
 */
require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });

const { postApproveOrder } = require('../../../shared/r-request-writer');

const RFQ_ID = 1142404;          // chuboe_rfq_id for RFQ search key 1132989
const VQ_ID  = 2135330;          // Taxan VQ, already ticked IsPurchased=Y

const QTY     = 100;
const RESALE  = 9.00;
const COST    = 4.95;
const REVENUE = QTY * RESALE;    // 900.00
const TOTAL_COST = QTY * COST;   // 495.00
const GP      = REVENUE - TOTAL_COST; // 405.00

const approvalText = `RFQ
  Customer: Masline Electronics Inc
  Total Revenue: ${REVENUE.toFixed(2)}
  Total Cost: ${TOTAL_COST.toFixed(2)}
  Gross Profit: ${GP.toFixed(2)}
  Profit Margin: 45%

RFQ Line
  RFQ Line #: 10
  Purchase Qty: ${QTY}
  Sold Qty: ${QTY}
  Total Revenue: ${REVENUE.toFixed(2)}
  Total Cost: ${TOTAL_COST.toFixed(2)}
  Gross Profit: ${GP.toFixed(2)}
  Profit Margin: 45%
  Sales Rep: Jake Harris
  Public Customer Notes:
  Private Customer Notes:

Customer Quote
  MPN: B20NJ50RE-B
  Customer PO#: 304068
  Customer Part Code: B20NJ50RE-B
  Quantity: ${QTY}
  Sale Price: ${RESALE.toFixed(2)} USD
  Customer Due Date: 05 Jun 2026
  Customer Request Date:
  Promise Date: 27 Apr 2026
  Customer Ship To Location: V002701, C006269 - Masline Electronics Inc - Rochester, NY - 511 South Clinton Ave.,Rochester, NY 14620
  Date Code: 2013
  Packaging: BULK
  Shipper: UPS Ground
  Inco Term: EXW - Ex Works
 Ship-From Warehouse: AUSTIN
  Lead Time: STOCK
  Public Customer Order Line Notes:
  Private Customer Order Line Notes:

Customer Quote Reference
  COO: PENDING
  UOM: Each
  Product Code: PA - Passives
  MFR: Ohmite
  RoHS: Y
  Hazardous: N

Vendor Quote
  Vendor: Astute Electronics - Taxan Excess
  Vendor Type: New/Ungraded Vendor
  Traceability: Non-Traceable
  Contact:
  Contact Email:
  Contact Phone:
  MPN: B20NJ50RE-B
  Ship-To Warehouse: AUSTIN
  Inventory Group Identifier: W106: TAXAN EXCESS
  Cost: ${COST.toFixed(2)} USD
  Quantity: ${QTY}
  Date Code: 2013
  COO: PENDING
  Lead Time: STOCK
  Packaging: BULK
  Shipper: Stock
  RoHS: Y
  Public Vendor Order Notes:
  Private Vendor Order Notes:
  Inco Term: The seller makes the goods available at its location, so the buyer can take over all the transportation costs and also bears the risks of bringing the goods to their final destination.
  MFR: Ohmite
  Buyer: Unassigned
`;

const message =
  'Masline PO 304068 received 2026-04-22 with $9.00 agreed on your 4/22 email. ' +
  'Taxan consignment buy-back 55/45: cost $4.95 = 55% × $9.00 resale (matches March precedent RFQ 1131454). ' +
  'Note: Masline PO lists MPN as "B20NJ50RE" (no suffix) — loaded as "B20NJ50RE-B" to match inventory; you indicated you would request Masline update the PO.';

(async () => {
  const { id, documentNo } = await postApproveOrder({
    vqId:         VQ_ID,
    program:      null,
    rfqId:        RFQ_ID,
    summary:      'approve order — Taxan Consignment B20NJ50RE-B (Masline PO 304068)',
    approvalText,
    message,
    priority:     '5',
  });
  console.log(`R_Request created: id=${id}, documentNo=${documentNo}`);
})().catch(e => {
  console.error('FATAL:', e.message);
  if (e.violations) console.error('Violations:', e.violations);
  process.exit(1);
});
