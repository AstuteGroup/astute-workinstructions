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
  'UPS': 1000026,  // Default to UPS Ground
  'DHL': 1000036,
  'Courier/Local Delivery': 1000045,
};

// Vendor mapping (should be dynamic lookup in production)
const VENDOR_MAP = {
  'Avnet EM': { bpartnerId: 1000336, locationId: 1001693 },
  'Arrow Electronics International Inc (NY)': { bpartnerId: 1000386, locationId: 1001110 },
  'GE Aviation Systems': { bpartnerId: 1000062, locationId: 1004724 },  // TEST: GE Aerospace
};

// Check if running against TEST environment
function isTestEnvironment() {
  const baseUrl = process.env.IDEMPIERE_BASE_URL || '';
  return baseUrl.includes('172.31.28.106');  // TEST server IP
}

// MFR cache (populated dynamically via API lookup)
const MFR_CACHE = {};

async function lookupMfr(mfrName) {
  if (!mfrName) return null;

  // Skip MFR lookup in TEST - system records not allowed as FK
  // TODO: Test MFR population when moving to PROD
  if (isTestEnvironment()) {
    console.log(`    MFR skipped in TEST: "${mfrName}" (system records not allowed)`);
    return null;
  }

  // Check cache first
  if (MFR_CACHE[mfrName] !== undefined) {
    return MFR_CACHE[mfrName];
  }

  // Try exact match first
  try {
    const filter = encodeURIComponent(`Name eq '${mfrName.replace(/'/g, "''")}'`);
    const result = await apiGet(`chuboe_mfr?$filter=${filter}`);
    if (result.records && result.records.length > 0) {
      const mfr = result.records[0];
      MFR_CACHE[mfrName] = mfr.id;
      console.log(`    MFR lookup: "${mfrName}" -> ID ${mfr.id}`);
      return mfr.id;
    }
  } catch (err) {
    console.log(`    MFR lookup error: ${err.message}`);
  }

  // Try fuzzy match (contains)
  try {
    const filter = encodeURIComponent(`contains(Name,'${mfrName.split(' ')[0].replace(/'/g, "''")}')`);
    const result = await apiGet(`chuboe_mfr?$filter=${filter}&$top=5`);
    if (result.records && result.records.length > 0) {
      // Prefer exact match if available
      const exact = result.records.find(r => r.Name === mfrName);
      const mfr = exact || result.records[0];
      MFR_CACHE[mfrName] = mfr.id;
      console.log(`    MFR fuzzy lookup: "${mfrName}" -> "${mfr.Name}" (ID ${mfr.id})`);
      return mfr.id;
    }
  } catch (err) {
    // Ignore fuzzy match errors
  }

  MFR_CACHE[mfrName] = null;
  return null;
}

// Buyer cache (populated dynamically via API lookup)
const BUYER_CACHE = {};

// One email/name can match several ad_user rows: one employee record plus a
// contact row on each vendor/customer BP the person is attached to. The employee
// row is the one whose Business Partner is the person themselves
// (C_BPartner_ID.identifier === Name); contact rows carry a company BP.
// Falls back to the lowest id (oldest record) when nothing matches.
function pickEmployeeUser(records) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const employee = records.find(
    (u) => u.C_BPartner_ID && norm(u.C_BPartner_ID.identifier) === norm(u.Name)
  );
  if (employee) return employee;
  return records.reduce((lowest, u) => (u.id < lowest.id ? u : lowest), records[0]);
}

async function lookupBuyer(buyerName, buyerEmail) {
  // There is no default buyer: an unrecognised buyer leaves the PO's Buyer blank rather
  // than attributing the order to someone who did not raise it.
  if (!buyerName && !buyerEmail) {
    console.log('  Buyer: no name or email on the PDF - leaving Buyer blank');
    return null;
  }

  const cacheKey = buyerEmail || buyerName;
  if (BUYER_CACHE[cacheKey] !== undefined) {
    return BUYER_CACHE[cacheKey];
  }

  // Try email lookup first (more reliable)
  if (buyerEmail) {
    try {
      const filter = encodeURIComponent(`EMail eq '${buyerEmail.replace(/'/g, "''")}'`);
      const result = await apiGet(`ad_user?$filter=${filter}`);
      if (result.records && result.records.length > 0) {
        const user = pickEmployeeUser(result.records);
        const dupes = result.records.length > 1
          ? ` [${result.records.length} rows matched; picked BP "${user.C_BPartner_ID && user.C_BPartner_ID.identifier}"]`
          : '';
        BUYER_CACHE[cacheKey] = user.id;
        console.log(`  Buyer lookup: "${buyerEmail}" -> ${user.Name} (ID ${user.id})${dupes}`);
        return user.id;
      }
    } catch (err) {
      console.log(`  Buyer email lookup error: ${err.message}`);
    }
  }

  // Try name lookup as fallback
  if (buyerName) {
    try {
      const filter = encodeURIComponent(`Name eq '${buyerName.replace(/'/g, "''")}'`);
      const result = await apiGet(`ad_user?$filter=${filter}`);
      if (result.records && result.records.length > 0) {
        const user = pickEmployeeUser(result.records);
        const dupes = result.records.length > 1
          ? ` [${result.records.length} rows matched; picked BP "${user.C_BPartner_ID && user.C_BPartner_ID.identifier}"]`
          : '';
        BUYER_CACHE[cacheKey] = user.id;
        console.log(`  Buyer lookup: "${buyerName}" -> ID ${user.id}${dupes}`);
        return user.id;
      }
    } catch (err) {
      console.log(`  Buyer name lookup error: ${err.message}`);
    }
  }

  // No match — leave the Buyer blank for a human to fill in
  console.log(`  Buyer not found: "${buyerName}" <${buyerEmail}> - leaving Buyer blank`);
  BUYER_CACHE[cacheKey] = null;
  return null;
}

// Warehouse mapping: Infor warehouse code -> chuboe_warehouse_id.
// Sourced from adempiere.chuboe_warehouse (name + description) — several chuboe
// warehouses cover a set of Infor codes, and their description spells the set out
// verbatim ("FOR INFOR: Austin-MAIN, HK-W105, PH-W109, STEVENAGE-W102").
// IDs verified identical on TEST and PROD for every row present in both.
const WAREHOUSE_MAP = {
  'W101': 1000002,  // W101: OFF SITE TESTING
  'W103': 1000005,  // W103: GE AEROSPACE EXCESS
  'W106': 1000004,  // W106: TAXAN EXCESS
  'W107': 1000009,  // W107: SPARTRONICS EXCESS
  'W111': 1000015,  // W111: LAM KITTING
  'W117': 1000018,  // W117: Eaton Consignment (PROD only — absent from TEST)
  'W118': 1000019,  // W118: LAM Consignment (PROD only — absent from TEST)
  // ALLOCATED/PRESOLD
  'MAIN': 1000000,
  'W102': 1000000,
  'W105': 1000000,
  'W109': 1000000,
  // UNALLOCATED/STRANDED
  'W104': 1000006,
  'W108': 1000006,
  // SPEC BUY: TRADING TEAM MANAGEMENT
  'W112': 1000017,
  'W113': 1000017,
  'W114': 1000017,
};

// Warehouse group mapping (chuboe_warehouse_group_id)
const WAREHOUSE_GROUP_MAP = {
  'BROWNSVILLE': 1000008,
  'AUSTIN': 1000000,
  'HONG KONG': 1000001,
  'STEVENAGE': 1000007,
  'PHILIPPINES': 1000006,
  'GERMANY': 1000005,
  'DROP-SHIP': 1000009,
};

// The warehouse group is the receiving *region*, independent of the warehouse:
// c_orderline pairs W111 with BROWNSVILLE (1241 lines), HONG KONG (65), AUSTIN (35)
// and STEVENAGE (25), so it must come from the delivery address, not the warehouse.
// Ordered — Brownsville is checked before Austin, since both are Astute US sites.
const WAREHOUSE_GROUP_HINTS = [
  ['BROWNSVILLE', ['brownsville']],
  ['HONG KONG', ['hong kong', 'kowloon', 'kwun tong']],
  ['PHILIPPINES', ['philippines', 'manila', 'laguna']],
  ['STEVENAGE', ['stevenage', 'united kingdom']],
  ['GERMANY', ['germany', 'holzkirchen']],
  ['AUSTIN', ['austin']],
];

function detectWarehouseGroup(deliverTo) {
  const haystack = `${deliverTo?.company || ''} ${deliverTo?.address || ''}`.toLowerCase();
  for (const [group, hints] of WAREHOUSE_GROUP_HINTS) {
    if (hints.some(h => haystack.includes(h))) return group;
  }
  return null;
}

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

  // Determine warehouse group from delivery address. Like the warehouse below, a null
  // group fails every c_orderline POST, so an unrecognised address stops the run before
  // the header is created.
  const warehouseGroup = poData.warehouse_group || detectWarehouseGroup(poData.deliver_to);
  const warehouseGroupId = WAREHOUSE_GROUP_MAP[warehouseGroup] || null;
  if (!warehouseGroupId) {
    if (poData.warehouse_group) {
      throw new Error(
        `Unknown warehouse group "${poData.warehouse_group}" — ` +
        `valid: ${Object.keys(WAREHOUSE_GROUP_MAP).join(', ')}.`
      );
    }
    throw new Error(
      `Could not determine warehouse group for ${poData.order_number} from delivery address ` +
      `"${`${poData.deliver_to?.company || ''} ${poData.deliver_to?.address || ''}`.trim()}" — ` +
      `re-run with --warehouse-group <${Object.keys(WAREHOUSE_GROUP_MAP).join('|')}>.`
    );
  }
  console.log(`Warehouse Group: ${warehouseGroup} -> ID ${warehouseGroupId}`);

  // Determine warehouse from warehouse code.
  // Every c_orderline POST sets Chuboe_Warehouse_ID, and the API rejects null with
  // "Could not convert value null for Chuboe_Warehouse" — so an unresolved code must
  // stop the run HERE, before the header is created. Otherwise the header lands, every
  // line fails, and an empty PO is left behind.
  const warehouseCode = poData.warehouse_code;
  if (!warehouseCode) {
    throw new Error(
      `No warehouse code on ${poData.order_number} — the PDF header carries none. ` +
      `Re-run with --warehouse <code> (e.g. --warehouse W111) to supply it.`
    );
  }
  const warehouseId = WAREHOUSE_MAP[warehouseCode] || null;
  if (!warehouseId) {
    throw new Error(
      `Unmapped warehouse code "${warehouseCode}" on ${poData.order_number}. ` +
      `Add it to WAREHOUSE_MAP (known: ${Object.keys(WAREHOUSE_MAP).join(', ')}) ` +
      `or re-run with --warehouse <code>.`
    );
  }
  console.log(`Warehouse: ${warehouseCode} -> ID ${warehouseId}`);

  // Check domestic shipping
  const isDomestic = isDomesticShipment(poData.vendor.address, poData.deliver_to.address);
  console.log(`Domestic Shipping: ${isDomestic ? 'Yes' : 'No'}`);

  // Look up buyer from PDF data
  const buyerId = await lookupBuyer(poData.buyer?.name, poData.buyer?.email);

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
    // Buyer (looked up from PDF; omitted entirely when unrecognised)
    ...(buyerId ? { SalesRep_ID: buyerId } : {}),
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

    // Look up manufacturer ID via API
    const mfrId = await lookupMfr(item.manufacturer);

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
      // Manufacturer (client-level record required)
      ...(mfrId && { Chuboe_MFR_ID: mfrId }),
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
    console.log(`    MFR: ${item.manufacturer} (ID ${mfrId || 'NOT MAPPED'})`);
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
  console.log(
    buyerId
      ? `Buyer: ${poData.buyer?.name} (ad_user ${buyerId})`
      : `Buyer: BLANK - "${poData.buyer?.name || 'none on PDF'}" did not match an ad_user`
  );
  console.log(`Total: $${poData.total}`);

  return createdPO;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Create Purchase Order in OT from PDF');
    console.log('');
    console.log('Usage:');
    console.log('  node create-po-from-pdf.js <pdf_file> [--warehouse <code>]');
    console.log('  node create-po-from-pdf.js <json_file> [--warehouse <code>]');
    console.log('');
    console.log('  --warehouse <code>        Warehouse code to use when the PDF header');
    console.log('                            carries none (or to override it).');
    console.log('  --warehouse-group <name>  Receiving region when it cannot be read from');
    console.log('                            the delivery address (e.g. BROWNSVILLE).');
    console.log('');
    console.log('Examples:');
    console.log('  node create-po-from-pdf.js POV0077469.pdf');
    console.log('  node create-po-from-pdf.js POV0060812.pdf --warehouse W111');
    console.log('  node create-po-from-pdf.js extracted.json');
    process.exit(1);
  }

  function flagValue(flag, example) {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`ERROR: ${flag} requires a value (e.g. ${flag} ${example})`);
      process.exit(1);
    }
    return value;
  }

  const warehouseOverride = flagValue('--warehouse', 'W111');
  const warehouseGroupOverride = flagValue('--warehouse-group', 'BROWNSVILLE');
  const flagValues = new Set([warehouseOverride, warehouseGroupOverride].filter(Boolean));
  const inputPath = args.find(a => !a.startsWith('--') && !flagValues.has(a));
  if (!inputPath) {
    console.error('ERROR: no PDF or JSON file given');
    process.exit(1);
  }
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

  if (warehouseOverride) {
    console.log(
      `\nWarehouse override: ${poData.warehouse_code || '(none on PDF)'} -> ${warehouseOverride}`
    );
    poData.warehouse_code = warehouseOverride;
  }
  if (warehouseGroupOverride) {
    console.log(`Warehouse group override: -> ${warehouseGroupOverride.toUpperCase()}`);
    poData.warehouse_group = warehouseGroupOverride.toUpperCase();
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
