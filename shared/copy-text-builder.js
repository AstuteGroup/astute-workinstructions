/**
 * Copy Text Builder
 *
 * Builds properly formatted OT Copy Text blocks for approval requests.
 * Matches the exact format produced by OT's Copy Text button.
 *
 * Usage:
 *   const { buildCopyTextVQOnly, buildCopyTextWithCQ } = require('./copy-text-builder');
 *
 *   // For VQ-only approvals (no CQ exists):
 *   const text = buildCopyTextVQOnly({
 *     customer: 'Lam Research',
 *     totalCost: 1729.22,
 *     rfqLineNo: 890,
 *     purchaseQty: 50,
 *     mpn: 'SCT3022ALGC11',
 *     mfr: 'Rohm Co Ltd',
 *     salesRep: 'Jake Harris',
 *     vendor: 'Arrow Electronics',
 *     vendorType: 'Franchise',
 *     traceability: 'Authorized Distribution Certs',
 *     contact: 'Arrow Sales',
 *     cost: 34.58,
 *     dateCode: '24+',
 *     coo: 'PENDING',
 *     leadTime: 'STOCK',
 *   });
 *
 * See vq-purchase-workflow.md for format specification.
 */

/**
 * Format currency as $X,XXX.XX
 */
function formatCurrency(amount) {
  if (amount == null) return 'n/a';
  const num = Number(amount);
  if (isNaN(num)) return 'n/a';
  return '$' + num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
}

/**
 * Format percentage as X.X%
 */
function formatPercent(value) {
  if (value == null) return 'n/a';
  const num = Number(value);
  if (isNaN(num)) return 'n/a';
  return num.toFixed(1) + '%';
}

/**
 * Build Copy Text for VQ-Only approval (no Customer Quote).
 * Format B from vq-purchase-workflow.md.
 *
 * @param {object} opts - VQ data
 * @returns {string} Formatted copy text block
 */
function buildCopyTextVQOnly(opts) {
  const {
    customer,
    totalCost,
    rfqLineNo,
    purchaseQty,
    soldQty = 0,
    mpn,
    mfr,
    salesRep = 'Jake Harris',
    publicNotes = '',
    privateNotes = '',
    vendor,
    vendorType,
    traceability,
    contact = '',
    qty,
    cost,
    dateCode,
    coo = 'PENDING',
    leadTime,
  } = opts;

  const vqQty = qty || purchaseQty;

  return `RFQ
  Customer: ${customer || 'Unknown'}
  Total Revenue: n/a
  Total Cost: ${formatCurrency(totalCost)}
  Gross Profit: n/a
  Profit Margin: n/a

RFQ Line
  RFQ Line #: ${rfqLineNo}
  Purchase Qty: ${purchaseQty}
  Sold Qty: ${soldQty}
  MPN: ${mpn}
  MFR: ${mfr || ''}
  Sales Rep: ${salesRep}
  Public Customer Notes: ${publicNotes}
  Private Customer Notes: ${privateNotes}

Vendor Quote
  Vendor: ${vendor}
  Vendor Type: ${vendorType || ''}
  Traceability: ${traceability || ''}
  Contact: ${contact}
  MPN: ${mpn}
  MFR: ${mfr || ''}
  Quantity: ${vqQty}
  Cost: ${formatCurrency(cost)} USD
  Date Code: ${dateCode || ''}
  COO: ${coo}
  Lead Time: ${leadTime || ''}`;
}

/**
 * Build Copy Text for multiple VQs (batch approval).
 * Combines one RFQ header with multiple RFQ Line + Vendor Quote sections.
 *
 * @param {object} header - RFQ-level data (customer, totalCost)
 * @param {object[]} lines - Array of line data (each with rfqLineNo, mpn, etc.)
 * @returns {string} Formatted copy text block
 */
function buildCopyTextBatchVQOnly(header, lines) {
  const { customer, totalCost } = header;

  let text = `RFQ
  Customer: ${customer || 'Unknown'}
  Total Revenue: n/a
  Total Cost: ${formatCurrency(totalCost)}
  Gross Profit: n/a
  Profit Margin: n/a`;

  for (const line of lines) {
    const {
      rfqLineNo,
      purchaseQty,
      soldQty = 0,
      mpn,
      mfr,
      salesRep = 'Jake Harris',
      publicNotes = '',
      privateNotes = '',
      vendor,
      vendorType,
      traceability,
      contact = '',
      qty,
      cost,
      dateCode,
      coo = 'PENDING',
      leadTime,
    } = line;

    const vqQty = qty || purchaseQty;

    text += `

RFQ Line
  RFQ Line #: ${rfqLineNo}
  Purchase Qty: ${purchaseQty}
  Sold Qty: ${soldQty}
  MPN: ${mpn}
  MFR: ${mfr || ''}
  Sales Rep: ${salesRep}
  Public Customer Notes: ${publicNotes}
  Private Customer Notes: ${privateNotes}

Vendor Quote
  Vendor: ${vendor}
  Vendor Type: ${vendorType || ''}
  Traceability: ${traceability || ''}
  Contact: ${contact}
  MPN: ${mpn}
  MFR: ${mfr || ''}
  Quantity: ${vqQty}
  Cost: ${formatCurrency(cost)} USD
  Date Code: ${dateCode || ''}
  COO: ${coo}
  Lead Time: ${leadTime || ''}`;
  }

  return text;
}

/**
 * Build Copy Text with Customer Quote (Format A).
 * Use when CQ exists for the VQ being approved.
 *
 * @param {object} opts - Full RFQ/CQ/VQ data
 * @returns {string} Formatted copy text block
 */
function buildCopyTextWithCQ(opts) {
  const {
    // RFQ
    customer,
    totalRevenue,
    totalCost,
    grossProfit,
    profitMargin,
    // RFQ Line
    rfqLineNo,
    purchaseQty,
    soldQty,
    mpn,
    mfr,
    salesRep = 'Jake Harris',
    publicNotes = '',
    privateNotes = '',
    // Customer Quote
    cqMpn,
    customerPO,
    customerPartCode = '',
    cqQty,
    salePrice,
    cqDateCode,
    cqPackaging,
    shipper,
    incoTerm,
    shipFromWarehouse,
    cqLeadTime,
    // Customer Quote Reference
    cqCOO,
    uom = 'Each',
    productCode = '',
    cqMfr,
    rohs = 'Y',
    hazardous = 'N',
    // Vendor Quote
    vendor,
    vendorType,
    traceability,
    contact = '',
    vqMpn,
    vqMfr,
    vqQty,
    cost,
    vqDateCode,
    vqCOO,
    vqLeadTime,
  } = opts;

  return `RFQ
  Customer: ${customer || 'Unknown'}
  Total Revenue: ${formatCurrency(totalRevenue)}
  Total Cost: ${formatCurrency(totalCost)}
  Gross Profit: ${formatCurrency(grossProfit)}
  Profit Margin: ${formatPercent(profitMargin)}

RFQ Line
  RFQ Line #: ${rfqLineNo}
  Purchase Qty: ${purchaseQty}
  Sold Qty: ${soldQty}
  MPN: ${mpn}
  MFR: ${mfr || ''}
  Sales Rep: ${salesRep}
  Public Customer Notes: ${publicNotes}
  Private Customer Notes: ${privateNotes}

Customer Quote
  MPN: ${cqMpn || mpn}
  Customer PO#: ${customerPO || ''}
  Customer Part Code: ${customerPartCode}
  Quantity: ${cqQty || soldQty}
  Sale Price: ${formatCurrency(salePrice)} USD
  Date Code: ${cqDateCode || ''}
  Packaging: ${cqPackaging || ''}
  Shipper: ${shipper || ''}
  Inco Term: ${incoTerm || ''}
  Ship-From Warehouse: ${shipFromWarehouse || ''}
  Lead Time: ${cqLeadTime || ''}

Customer Quote Reference
  COO: ${cqCOO || 'PENDING'}
  UOM: ${uom}
  Product Code: ${productCode}
  MFR: ${cqMfr || mfr || ''}
  RoHS: ${rohs}
  Hazardous: ${hazardous}

Vendor Quote
  Vendor: ${vendor}
  Vendor Type: ${vendorType || ''}
  Traceability: ${traceability || ''}
  Contact: ${contact}
  MPN: ${vqMpn || mpn}
  MFR: ${vqMfr || mfr || ''}
  Quantity: ${vqQty || purchaseQty}
  Cost: ${formatCurrency(cost)} USD
  Date Code: ${vqDateCode || ''}
  COO: ${vqCOO || 'PENDING'}
  Lead Time: ${vqLeadTime || ''}`;
}

module.exports = {
  buildCopyTextVQOnly,
  buildCopyTextBatchVQOnly,
  buildCopyTextWithCQ,
  formatCurrency,
  formatPercent,
};
