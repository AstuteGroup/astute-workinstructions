#!/usr/bin/env node
/**
 * Create a Purchase Order in OT from extracted PDF data
 *
 * Usage:
 *   node create-po-from-pdf.js <pdf_file>
 *   node create-po-from-pdf.js <json_file>  (if already extracted)
 */

const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });

const { login, apiPost, apiGet } = require('../../../shared/api-client');

// ─── LOOKUPS ────────────────────────────────────────────────────────────────
// These should be dynamic in production, hardcoded for now

const LOOKUPS = {
  // Document type for Purchase Order
  docTypeId: 1000016,
  // Currency USD
  currencyId: 100,
  // Payment term: Net 30 Days
  paymentTermId: 1000003,
  // Price list: Purchase USD
  priceListId: 1000005,
  // Default warehouse (Standard) - used for m_warehouse_id
  warehouseId: 1000000,
  // Unit of measure: Each
  uomId: 100,
  // Tax category (exempt)
  taxId: 1000000,
  // Product: Receiving Clearing Product
  productId: 1000033,
  // Jake Harris (default buyer)
  buyerId: 1000004,
};

// Incoterm mapping
const INCOTERM_MAP = {
  'Ex-Works': 1000000,
  'EXW': 1000000,
  'FOB': 1000003,
  'CIF': 1000005,
  'DAP': 1000010,
  'DDP': 1000007,
};

// Shipper mapping
const SHIPPER_MAP = {
  'FedEx Ground': 1000003,
  'FedEx Express': 1000010,
  'FedEx Priority Overnight': 1000006,
  'FedEx Standard Overnight': 1000007,
  'FedEx 2Day': 1000009,
  'UPS Ground': 1000026,
  'UPS': 100,
  'DHL': 1000036,
  'Courier/Local Delivery': 1000045,
};

// Vendor mapping (should be dynamic lookup in production)
const VENDOR_MAP = {
  'Avnet EM': { bpartnerId: 1000336, locationId: 1001693 },
  'Arrow Electronics International Inc (NY)': { bpartnerId: 1000386, locationId: 1001110 },
};

// Manufacturer mapping
const MFR_MAP = {
  'Vishay Intertechnology, Inc.': 1000019,
  'Vishay Intertechnology Inc': 1000019,
  'Vishay': 1000019,
};

// Warehouse mapping (chuboe_warehouse_id)
const WAREHOUSE_MAP = {
  'W111': 1000015,  // W111: LAM KITTING
  'W103': 1000005,  // W103: GE AEROSPACE EXCESS
  'W106': 1000004,  // W106: TAXAN EXCESS
  'W107': 1000009,  // W107: SPARTRONICS EXCESS
};

// Warehouse group mapping (chuboe_warehouse_group_id)
const WAREHOUSE_GROUP_MAP = {
  'BROWNSVILLE': 1000008,
  'AUSTIN': 1000000,
  'HONG KONG': 1000001,
  'STEVENAGE': 1000007,
  'PHILIPPINES': 1000006,
};

// ─── HELPER FUNCTIONS ───────────────────────────────────────────────────────

function parseDate(dateStr) {
  // Parse format: "28 Jul 2026"
  const dateParts = dateStr.split(' ');
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${dateParts[2]}-${months[dateParts[1]]}-${dateParts[0].padStart(2, '0')}`;
}

function isDomesticShipment(vendorAddress, deliveryAddress) {
  // Check if both addresses are in the same country (US)
  const vendorUS = vendorAddress && vendorAddress.toLowerCase().includes('united states');
  const deliveryUS = deliveryAddress && deliveryAddress.toLowerCase().includes('united states');
  return vendorUS && deliveryUS;
}

// Note: The extractor now properly separates description from line_notes.
// These helper functions are kept for backwards compatibility but simplified.

function extractDescription(lineNotes, manufacturer) {
  // Fallback: if description was not extracted, use line_notes
  // Strip manufacturer prefix if present (legacy behavior)
  if (!lineNotes) return null;
  if (manufacturer && lineNotes.startsWith(manufacturer)) {
    return lineNotes.substring(manufacturer.length).trim();
  }
  return lineNotes;
}

function extractInternalNotes(lineNotes, manufacturer) {
  // Return line_notes as internal notes (already clean from extractor)
  // Strip manufacturer prefix if present (legacy behavior)
  if (!lineNotes) return null;
  if (manufacturer && lineNotes.startsWith(manufacturer)) {
    return lineNotes.substring(manufacturer.length).trim();
  }
  return lineNotes;
}

async function extractPdfData(pdfPath) {
  const { execSync } = require('child_process');
  const result = execSync(`node "${path.join(__dirname, 'extractor.js')}" "${pdfPath}"`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result)[0];
}

// ─── MAIN FUNCTION ──────────────────────────────────────────────────────────

async function createPurchaseOrder(poData) {
  console.log('\n=== Creating Purchase Order in OT TEST ===\n');

  // Login to API
  console.log('Logging in to iDempiere API...');
  const auth = await login();
  console.log(`  Logged in as user ID: ${auth.userId}`);
  console.log(`  Base URL: ${process.env.IDEMPIERE_BASE_URL}`);

  // Resolve vendor
  const vendorKey = poData.vendor.company;
  const vendor = VENDOR_MAP[vendorKey];
  if (!vendor) {
    throw new Error(`Unknown vendor: ${vendorKey}. Add to VENDOR_MAP.`);
  }
  console.log(`\nVendor: ${vendorKey}`);
  console.log(`  BP ID: ${vendor.bpartnerId}`);
  console.log(`  Location ID: ${vendor.locationId}`);

  // Parse dates
  const orderDate = parseDate(poData.date);
  const dueDate = poData.line_items[0]?.due_date ? parseDate(poData.line_items[0].due_date) : orderDate;
  console.log(`\nOrder Date: ${poData.date} -> ${orderDate}`);
  console.log(`Due Date: ${dueDate}`);

  // Resolve incoterm
  const incotermId = INCOTERM_MAP[poData.delivery_terms] || INCOTERM_MAP['Ex-Works'];
  console.log(`Incoterm: ${poData.delivery_terms} -> ID ${incotermId}`);

  // Resolve shipper
  const shipperId = SHIPPER_MAP[poData.ship_via] || SHIPPER_MAP['FedEx Ground'];
  console.log(`Shipper: ${poData.ship_via} -> ID ${shipperId}`);

  // Determine warehouse group from delivery address
  let warehouseGroupId = null;
  if (poData.deliver_to.company && poData.deliver_to.company.includes('Brownsville')) {
    warehouseGroupId = WAREHOUSE_GROUP_MAP['BROWNSVILLE'];
  }
  console.log(`Warehouse Group: BROWNSVILLE -> ID ${warehouseGroupId}`);

  // Determine warehouse from warehouse code
  const warehouseId = WAREHOUSE_MAP[poData.warehouse_code] || null;
  console.log(`Warehouse: ${poData.warehouse_code} -> ID ${warehouseId}`);

  // Check domestic shipping
  const isDomestic = isDomesticShipment(poData.vendor.address, poData.deliver_to.address);
  console.log(`Domestic Shipping: ${isDomestic ? 'Yes' : 'No'}`);

  // Build PO header payload
  const poHeader = {
    IsSOTrx: 'N',  // Purchase Order
    C_DocType_ID: LOOKUPS.docTypeId,
    C_DocTypeTarget_ID: LOOKUPS.docTypeId,
    DateOrdered: orderDate,
    DateAcct: orderDate,
    DatePromised: dueDate,
    C_BPartner_ID: vendor.bpartnerId,
    C_BPartner_Location_ID: vendor.locationId,
    C_Currency_ID: LOOKUPS.currencyId,
    M_Warehouse_ID: LOOKUPS.warehouseId,
    M_PriceList_ID: LOOKUPS.priceListId,
    // Buyer
    SalesRep_ID: LOOKUPS.buyerId,
    // Incoterm (Ex-Works, etc.)
    Chuboe_Inco_Term_ID: incotermId,
    // Delivery via Shipper (always 'S')
    DeliveryViaRule: 'S',
    // Shipper (FedEx Ground, etc.)
    M_Shipper_ID: shipperId,
    // Description
    Description: `Created from PDF: ${poData.source_file}`,
  };

  console.log('\nCreating PO header...');
  console.log('  Payload:', JSON.stringify(poHeader, null, 2));

  const createdPO = await apiPost('c_order', poHeader);
  console.log(`\n  SUCCESS! Created PO:`);
  console.log(`    Internal ID: ${createdPO.id}`);
  console.log(`    Document No: ${createdPO.DocumentNo}`);

  // Create order lines
  console.log('\nCreating order lines...');
  for (const item of poData.line_items) {
    // Parse due date for this line
    const lineDueDate = item.due_date ? parseDate(item.due_date) : dueDate;

    // Extract description and internal notes from line_notes
    const description = item.description || extractDescription(item.line_notes, item.manufacturer);
    const internalNotes = extractInternalNotes(item.line_notes, item.manufacturer);

    const linePayload = {
      C_Order_ID: createdPO.id,
      Line: item.line_number * 10,
      DateOrdered: orderDate,
      DatePromised: lineDueDate,
      M_Warehouse_ID: LOOKUPS.warehouseId,
      C_UOM_ID: LOOKUPS.uomId,
      QtyEntered: item.quantity_ordered,
      QtyOrdered: item.quantity_ordered,
      PriceEntered: item.unit_price,
      PriceActual: item.unit_price,
      PriceList: item.unit_price,
      C_Currency_ID: LOOKUPS.currencyId,
      C_Tax_ID: LOOKUPS.taxId,
      // Product: Receiving Clearing Product
      M_Product_ID: LOOKUPS.productId,
      // MPN
      Chuboe_MPN: item.item_number,
      // Note: Chuboe_MFR_ID can't be set for system MFR records (ad_client_id=0)
      // and c_orderline has no Chuboe_MFR_Text fallback, so MFR is omitted
      // Description (from PDF description or line notes)
      Description: description,
      // Internal notes
      Chuboe_Note_Private: internalNotes,
      // Infor PO number
      Chuboe_PO_String: poData.order_number,
      // Warehouse (W111, etc.)
      Chuboe_Warehouse_ID: warehouseId,
      // Warehouse group (Brownsville, etc.)
      Chuboe_Warehouse_Group_ID: warehouseGroupId,
      // Domestic shipping flag
      IsChuboeDomesticShipping: isDomestic ? 'Y' : 'N',
    };

    console.log(`  Line ${item.line_number}: ${item.item_number}`);
    console.log(`    Qty: ${item.quantity_ordered}, Price: $${item.unit_price}`);
    console.log(`    MFR: ${item.manufacturer}`);
    console.log(`    Description: ${description}`);
    console.log(`    Internal Notes: ${internalNotes}`);
    console.log(`    Warehouse: ${poData.warehouse_code} (ID ${warehouseId})`);
    console.log(`    Domestic: ${isDomestic ? 'Y' : 'N'}`);

    const createdLine = await apiPost('c_orderline', linePayload);
    console.log(`    Created line ID: ${createdLine.id}`);
  }

  console.log('\n=== Purchase Order Created Successfully ===');
  console.log(`Document: ${createdPO.DocumentNo}`);
  console.log(`Infor PO: ${poData.order_number}`);
  console.log(`Buyer: Jake Harris`);
  console.log(`Total: $${poData.total}`);

  return createdPO;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Create Purchase Order in OT from PDF');
    console.log('');
    console.log('Usage:');
    console.log('  node create-po-from-pdf.js <pdf_file>');
    console.log('  node create-po-from-pdf.js <json_file>');
    console.log('');
    console.log('Examples:');
    console.log('  node create-po-from-pdf.js POV0077469.pdf');
    console.log('  node create-po-from-pdf.js extracted.json');
    process.exit(1);
  }

  const inputPath = args[0];
  let poData;

  if (inputPath.endsWith('.json')) {
    // Read pre-extracted JSON
    poData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    if (Array.isArray(poData)) poData = poData[0];
  } else {
    // Extract from PDF
    console.log(`Extracting data from PDF: ${inputPath}`);
    poData = await extractPdfData(inputPath);
  }

  console.log('\nExtracted PO data:');
  console.log(`  Order: ${poData.order_number}`);
  console.log(`  Vendor: ${poData.vendor.company}`);
  console.log(`  Date: ${poData.date}`);
  console.log(`  Delivery Terms: ${poData.delivery_terms}`);
  console.log(`  Ship Via: ${poData.ship_via}`);
  console.log(`  Warehouse: ${poData.warehouse_code}`);
  console.log(`  Lines: ${poData.line_items.length}`);
  console.log(`  Total: $${poData.total}`);

  // Confirm before creating
  console.log('\n--- CONFIRM: Create this PO in OT TEST? ---');
  console.log('Press Ctrl+C to cancel, or wait 3 seconds to proceed...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  await createPurchaseOrder(poData);
}

main().catch(err => {
  console.error('\nERROR:', err.message);
  if (err.response) {
    console.error('API Response:', err.response.data);
  }
  process.exit(1);
});
