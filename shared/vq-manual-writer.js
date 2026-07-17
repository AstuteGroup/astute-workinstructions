/**
 * VQ Manual Writer — enforced wrapper for ad-hoc/manual VQ creation.
 *
 * WHY IT EXISTS:
 *   `shared/vq-writer.js` is designed for franchise API results where ship-to
 *   fields (warehouse, shipper, incoterm) are unknown at load time. Manual VQ
 *   creation (operator adding a quote from a broker, one-off franchise order,
 *   etc.) should set ALL fields upfront except DatePromised (unknown until
 *   purchase is approved).
 *
 *   This module enforces program defaults at creation time, NOT tick time.
 *   The validator at tick time then has nothing to complain about except
 *   the promise date (which is legitimately set at approval).
 *
 * USAGE:
 *   const { createManualVQ } = require('../shared/vq-manual-writer');
 *
 *   const vq = await createManualVQ({
 *     program: 'LAM_KITTING',
 *     rfqValue: '1137922',
 *     rfqLineId: 3141430,
 *     mpn: 'DG406EUI+',
 *     mfrText: 'Maxim Integrated Products Inc',
 *     vendorBpId: 1000634,           // Amalfi Trading
 *     vendorLocationId: 1004101,
 *     qty: 70,
 *     cost: 19.95,
 *     dateCode: '24+',
 *     leadTime: 'STOCK',
 *     notes: 'buying from franchise. Redacted packing slip to be provided',
 *     isBrokerAsFranchise: true,     // broker treated as franchise for traceability
 *   });
 *
 * WHAT THIS ENFORCES AT CREATION:
 *   - COO defaults to PENDING (not USA!)
 *   - Warehouse, Warehouse Group, Shipper, Incoterm from program defaults
 *   - Packaging defaults to F-REEL if not specified
 *   - Traceability derived from vendor type (or overridden for broker-as-franchise)
 *   - Date Code and Lead Time required (no silent nulls)
 *
 * WHAT REMAINS FOR TICK TIME:
 *   - DatePromised (genuinely unknown until purchase approval)
 *   - IsPurchased (set by tickVQForPurchase)
 */

const { apiPost, apiGet } = require('./api-client');
const { lookupMfr } = require('./mfr-lookup');
const { PROGRAM_DEFAULTS } = require('./vq-purchase-validator');

// Default values
const DEFAULTS = {
  C_UOM_ID: 100,              // Each
  C_Currency_ID: 100,         // USD
  C_Country_ID: 1000001,      // PENDING (NOT USA - we don't know COO for most sources)
  Chuboe_RoHS: 'Y',
  Chuboe_Packaging_ID: 1000001,  // F-REEL (factory reel)
};

// Traceability IDs
const TRACEABILITY = {
  FRANCHISE: 1000001,         // Authorized Distribution Certs
  NON_TRACEABLE: 1000003,     // Non-Traceable (brokers)
};

// Vendor types that count as authorized/franchise
const AUTHORIZED_VENDOR_TYPES = new Set([
  1000001, // Manufacture Direct Component
  1000002, // Franchise
  1000007, // Manufacture Direct Assemblies
  1000008, // Catalog (DigiKey, Mouser, etc.)
  1000009, // Online Distributor (Avnet, etc.)
]);

/**
 * Get vendor type for a business partner.
 */
async function getVendorType(bpId) {
  const result = await apiGet('C_BPartner', { filter: `C_BPartner_ID eq ${bpId}`, top: 1 });
  return result.records?.[0]?.Chuboe_VendorType_ID?.id || result.records?.[0]?.Chuboe_VendorType_ID || null;
}

/**
 * Create a manual VQ with all program defaults applied.
 *
 * @param {object} opts
 * @param {string} opts.program           'LAM_KITTING' | 'LAM_EPG' | null (uses program defaults)
 * @param {string} opts.rfqValue          RFQ search key (e.g., '1137922')
 * @param {number} opts.rfqId             RFQ ID (optional if rfqValue provided)
 * @param {number} opts.rfqLineId         RFQ Line ID (required)
 * @param {string} opts.mpn               MPN (required)
 * @param {string} opts.mfrText           Manufacturer name (required)
 * @param {number} [opts.mfrId]           Manufacturer ID (optional - resolved from mfrText if not provided)
 * @param {number} opts.vendorBpId        Vendor business partner ID (required)
 * @param {number} opts.vendorLocationId  Vendor location ID (required)
 * @param {number} opts.qty               Quantity (required)
 * @param {number} opts.cost              Unit cost (required)
 * @param {string} opts.dateCode          Date code (required - e.g., '24+', '26+')
 * @param {string} opts.leadTime          Lead time (required - e.g., 'STOCK', '31 WEEKS')
 * @param {string} [opts.notes]           Public notes (vendor-facing)
 * @param {string} [opts.internalNotes]   Internal notes (buyer-only)
 * @param {number} [opts.packagingId]     Packaging ID (defaults to F-REEL)
 * @param {number} [opts.cooCountryId]    COO country ID (defaults to PENDING)
 * @param {boolean} [opts.isBrokerAsFranchise=false]  Treat broker as franchise for traceability
 * @returns {object} { id, vqLineId, mpn, vendor, cost, qty, ... }
 */
async function createManualVQ(opts) {
  const {
    program,
    rfqValue,
    rfqId: providedRfqId,
    rfqLineId,
    mpn,
    mfrText,
    mfrId: providedMfrId,
    vendorBpId,
    vendorLocationId,
    qty,
    cost,
    dateCode,
    leadTime,
    notes,
    internalNotes,
    packagingId,
    cooCountryId,
    isBrokerAsFranchise = false,
  } = opts;

  // Validate required fields
  const missing = [];
  if (!rfqLineId) missing.push('rfqLineId');
  if (!mpn) missing.push('mpn');
  if (!mfrText) missing.push('mfrText');
  if (!vendorBpId) missing.push('vendorBpId');
  if (!vendorLocationId) missing.push('vendorLocationId');
  if (qty == null || qty <= 0) missing.push('qty (must be > 0)');
  if (cost == null || cost <= 0) missing.push('cost (must be > 0)');
  if (!dateCode) missing.push('dateCode');
  if (!leadTime) missing.push('leadTime');

  if (missing.length > 0) {
    throw new Error(`createManualVQ: missing required fields: ${missing.join(', ')}`);
  }

  // Resolve RFQ ID if not provided
  let rfqId = providedRfqId;
  if (!rfqId && rfqValue) {
    const rfqResult = await apiGet('Chuboe_RFQ', { filter: `Value eq '${rfqValue}'`, top: 1 });
    if (!rfqResult.records || rfqResult.records.length === 0) {
      throw new Error(`createManualVQ: RFQ '${rfqValue}' not found`);
    }
    rfqId = rfqResult.records[0].id;
  }
  if (!rfqId) {
    throw new Error('createManualVQ: rfqId or rfqValue is required');
  }

  // GUARDRAIL: Validate RFQ is not too old (max 90 days)
  // Added 2026-07-17 after VQ was mistakenly written to a 2024 RFQ
  const { psqlQuery } = require('./db-helpers');
  const rfqAgeCheck = psqlQuery(`
    SELECT value, created::date,
           EXTRACT(DAY FROM NOW() - created) as age_days
    FROM adempiere.chuboe_rfq
    WHERE chuboe_rfq_id = ${rfqId}
  `);
  if (rfqAgeCheck) {
    const [rfqVal, rfqCreated, ageDays] = rfqAgeCheck.trim().split('|');
    const age = parseInt(ageDays, 10);
    if (age > 90) {
      throw new Error(
        `createManualVQ: RFQ ${rfqVal} is ${age} days old (created ${rfqCreated}). ` +
        `Cannot write VQs to RFQs older than 90 days. Use a recent reorder RFQ instead.`
      );
    }
  }

  // Resolve MFR ID if not provided
  // NOTE: System MFRs (AD_Client_ID=0) work fine in VQs — verified 2026-07-17
  // with Crystek (M01400, ID 1001625). Previous assumption that they were
  // blocked was incorrect.
  let mfrId = providedMfrId;
  if (!mfrId) {
    const mfrLookup = lookupMfr(mfrText);
    if (mfrLookup.id) {
      mfrId = mfrLookup.id;
    }
    // If no match, we'll use mfrText and let server resolve
  }

  // Get vendor type for traceability
  const vendorTypeId = await getVendorType(vendorBpId);

  // Determine traceability
  let traceabilityId;
  if (isBrokerAsFranchise) {
    // Broker being used as franchise pass-through
    traceabilityId = TRACEABILITY.FRANCHISE;
  } else if (AUTHORIZED_VENDOR_TYPES.has(vendorTypeId)) {
    traceabilityId = TRACEABILITY.FRANCHISE;
  } else {
    traceabilityId = TRACEABILITY.NON_TRACEABLE;
  }

  // Get program defaults
  const programDefaults = program && PROGRAM_DEFAULTS[program] ? PROGRAM_DEFAULTS[program] : {};

  // Build payload with all defaults applied
  const payload = {
    AD_Org_ID: 1000000,
    Chuboe_RFQ_ID: rfqId,
    Chuboe_RFQ_Line_ID: rfqLineId,
    C_BPartner_ID: vendorBpId,
    C_BPartner_Location_ID: vendorLocationId,
    Chuboe_MPN: mpn,
    Chuboe_MFR_Text: mfrText,
    ...(mfrId ? { Chuboe_MFR_ID: mfrId } : {}),
    Qty: qty,
    Cost: cost,

    // Required fields with defaults
    C_Currency_ID: DEFAULTS.C_Currency_ID,
    C_UOM_ID: DEFAULTS.C_UOM_ID,
    Chuboe_RoHS: DEFAULTS.Chuboe_RoHS,

    // COO - default to PENDING, not USA
    C_Country_ID: cooCountryId || DEFAULTS.C_Country_ID,

    // Date/time fields - required at creation
    Chuboe_Date_Code: dateCode,
    Chuboe_Lead_Time: leadTime,

    // Packaging - default to F-REEL
    Chuboe_Packaging_ID: packagingId || DEFAULTS.Chuboe_Packaging_ID,

    // Traceability - derived from vendor type
    Chuboe_Traceability_ID: traceabilityId,
    Chuboe_VendorType_ID: vendorTypeId,

    // Program defaults (warehouse, shipper, incoterm)
    ...(programDefaults.chuboe_warehouse_id ? { Chuboe_Warehouse_ID: programDefaults.chuboe_warehouse_id.value } : {}),
    ...(programDefaults.chuboe_warehouse_group_id ? { Chuboe_Warehouse_Group_ID: programDefaults.chuboe_warehouse_group_id.value } : {}),
    ...(programDefaults.m_shipper_id ? { M_Shipper_ID: programDefaults.m_shipper_id.value } : {}),
    ...(programDefaults.chuboe_inco_term_id ? { Chuboe_Inco_Term_ID: programDefaults.chuboe_inco_term_id.value } : {}),

    // Notes
    ...(notes ? { Chuboe_Note_Public: notes } : {}),
    ...(internalNotes ? { Chuboe_Note_User: internalNotes } : {}),

    // Not purchased yet
    IsActive: true,
    IsPurchased: false,
  };

  // Write the VQ
  const result = await apiPost('chuboe_vq_line', payload, {
    context: 'manual-vq-creation',
  });

  console.log(`[vq-manual-writer] Created VQ ${result.id}: ${mpn} @ $${cost} x ${qty} from BP ${vendorBpId}`);

  return {
    id: result.id,
    vqLineId: result.id,
    mpn,
    mfrText,
    mfrId,
    vendorBpId,
    cost,
    qty,
    dateCode,
    leadTime,
    warehouseId: programDefaults.chuboe_warehouse_id?.value,
    traceabilityId,
    cooCountryId: payload.C_Country_ID,
  };
}

module.exports = {
  createManualVQ,
  DEFAULTS,
  TRACEABILITY,
  AUTHORIZED_VENDOR_TYPES,
};
