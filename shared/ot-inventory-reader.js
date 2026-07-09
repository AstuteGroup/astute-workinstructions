/**
 * OT Inventory Reader
 *
 * Query current inventory state from OT (chuboe_offer + chuboe_offer_line)
 * instead of reading from disk CSVs.
 *
 * This decouples inventory consumers (like LAM 3PL) from the inventory
 * cleanup workflow timing.
 *
 * Usage:
 *   const { getLAMInventory, getInventoryByGroups } = require('./ot-inventory-reader');
 *
 *   // Get LAM inventory (W111 + W115 + W118 equivalent)
 *   const lam = await getLAMInventory();
 *
 *   // Get specific warehouse groups
 *   const freeStock = await getInventoryByGroups(['Free_Stock_Austin', 'Free_Stock_HK']);
 */

const { Pool } = require('pg');

// Use Unix socket connection (same as other shared modules)
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

/**
 * Warehouse group to OT offer mapping
 * Mirrors WAREHOUSE_WRITEBACK from inventory_cleanup.js
 */
const WAREHOUSE_GROUP_MAPPING = {
  'Free_Stock_Austin':       { bpartnerId: 1000332, offerTypeId: 1000008, warehouseCodes: ['W104', 'W112'] },
  'Free_Stock_Stevenage':    { bpartnerId: 1000332, offerTypeId: 1000006, warehouseCodes: ['W102'] },
  'Free_Stock_Hong_Kong':    { bpartnerId: 1000332, offerTypeId: 1000009, warehouseCodes: ['W108', 'W113'] },
  'Free_Stock_Philippines':  { bpartnerId: 1000332, offerTypeId: 1000014, warehouseCodes: ['W109', 'W114'] },
  'Franchise_Stock':         { bpartnerId: 1000325, offerTypeId: 1000008, warehouseCodes: ['W104'] },
  'GE_Consignment':          { bpartnerId: 1003236, offerTypeId: 1000008, warehouseCodes: ['W103'] },
  'Taxan_Consignment':       { bpartnerId: 1003621, offerTypeId: 1000008, warehouseCodes: ['W106'] },
  'Spartronics_Consignment': { bpartnerId: 1005225, offerTypeId: 1000008, warehouseCodes: ['W107'] },
  'Eaton_Consignment':       { bpartnerId: 1010966, offerTypeId: 1000014, warehouseCodes: ['W117'] },
  'LAM_Consignment':         { bpartnerId: 1011267, offerTypeId: 1000014, warehouseCodes: ['W118'] },
  'LAM_Dead_Inventory':      { bpartnerId: 1000332, offerTypeId: 1000008, warehouseCodes: ['W115'] },
};

/**
 * LAM-specific mapping for the 3PL workflow
 * W111 (LAM_3PL) is internal-only — no OT offer exists
 * W115 (LAM_Dead_Inventory) and W118 (LAM_Consignment) have OT offers
 */
const LAM_GROUPS = {
  'LAM_Dead_Inventory': WAREHOUSE_GROUP_MAPPING['LAM_Dead_Inventory'],
  'LAM_Consignment':    WAREHOUSE_GROUP_MAPPING['LAM_Consignment'],
};

// LAM customer-facing offer (for threshold check against kitting roster)
const LAM_KITTING_OFFER_TYPE = 1000025;
const LAM_BP_ID = 1000730;

/**
 * Query inventory from OT offers
 *
 * @param {Object} options
 * @param {number} options.bpartnerId - Business partner ID
 * @param {number} options.offerTypeId - Offer type ID
 * @returns {Promise<Array>} Inventory rows with mpn, mfr, qty, etc.
 */
async function getOfferInventory({ bpartnerId, offerTypeId }) {
  const query = `
    SELECT
      ol.chuboe_mpn as mpn,
      ol.chuboe_mfr_text as mfr,
      COALESCE(mfr.name, ol.chuboe_mfr_text) as mfr_resolved,
      ol.qty,
      ol.priceentered as unit_cost,
      ol.chuboe_date_code as date_code,
      ol.chuboe_lead_time as lead_time,
      ol.chuboe_package_desc as package_desc,
      ol.chuboe_cpc as cpc,
      ol.description,
      o.value as offer_key,
      o.description as offer_description,
      o.created as offer_created
    FROM adempiere.chuboe_offer o
    JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON ol.chuboe_mfr_id = mfr.chuboe_mfr_id
    WHERE o.isactive = 'Y'
      AND ol.isactive = 'Y'
      AND o.c_bpartner_id = $1
      AND o.chuboe_offer_type_id = $2
    ORDER BY o.created DESC, ol.chuboe_mpn
  `;

  const result = await pool.query(query, [bpartnerId, offerTypeId]);
  return result.rows;
}

/**
 * Get inventory for specific warehouse groups
 *
 * @param {string[]} groupNames - Array of group names (e.g., ['Free_Stock_Austin', 'LAM_Dead_Inventory'])
 * @returns {Promise<Object>} { groupName: [rows], ... }
 */
async function getInventoryByGroups(groupNames) {
  const result = {};

  for (const groupName of groupNames) {
    const mapping = WAREHOUSE_GROUP_MAPPING[groupName];
    if (!mapping) {
      console.warn(`Unknown warehouse group: ${groupName}`);
      result[groupName] = [];
      continue;
    }

    const rows = await getOfferInventory({
      bpartnerId: mapping.bpartnerId,
      offerTypeId: mapping.offerTypeId,
    });

    result[groupName] = rows;
  }

  return result;
}

/**
 * Get LAM inventory for threshold comparison
 *
 * Returns inventory from the LAM Kitting Inventory offer (type 1000025)
 * which contains the full roster with current stock levels.
 *
 * This is the decoupled replacement for reading W111/W115 CSVs.
 *
 * @returns {Promise<Object>} { rows: [...], metadata: { offerKey, created, lineCount } }
 */
async function getLAMInventory() {
  const query = `
    SELECT
      ol.chuboe_mpn as mpn,
      ol.chuboe_mfr_text as mfr,
      COALESCE(mfr.name, ol.chuboe_mfr_text) as mfr_resolved,
      ol.qty,
      ol.priceentered as resale_price,
      ol.chuboe_date_code as date_code,
      ol.chuboe_lead_time as lead_time,
      ol.chuboe_cpc as cpc,
      ol.description,
      o.value as offer_key,
      o.description as offer_description,
      o.created as offer_created
    FROM adempiere.chuboe_offer o
    JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON ol.chuboe_mfr_id = mfr.chuboe_mfr_id
    WHERE o.isactive = 'Y'
      AND ol.isactive = 'Y'
      AND o.c_bpartner_id = $1
      AND o.chuboe_offer_type_id = $2
    ORDER BY ol.chuboe_mpn
  `;

  const result = await pool.query(query, [LAM_BP_ID, LAM_KITTING_OFFER_TYPE]);

  if (result.rows.length === 0) {
    return {
      rows: [],
      metadata: {
        offerKey: null,
        created: null,
        lineCount: 0,
        stale: true,
        error: 'No active LAM Kitting Inventory offer found',
      },
    };
  }

  const firstRow = result.rows[0];
  const offerCreated = new Date(firstRow.offer_created);
  const now = new Date();
  const ageInDays = (now - offerCreated) / (1000 * 60 * 60 * 24);

  return {
    rows: result.rows,
    metadata: {
      offerKey: firstRow.offer_key,
      offerDescription: firstRow.offer_description,
      created: firstRow.offer_created,
      lineCount: result.rows.length,
      ageInDays: Math.round(ageInDays * 10) / 10,
      stale: ageInDays > 7, // Consider stale if older than 7 days
    },
  };
}

/**
 * Get inventory aggregated by MPN for LAM threshold comparison
 *
 * @returns {Promise<Map<string, { qty: number, cpc: string, mfr: string }>>}
 */
async function getLAMInventoryByMPN() {
  const { rows, metadata } = await getLAMInventory();

  const byMPN = new Map();

  for (const row of rows) {
    const mpn = (row.mpn || '').trim().toUpperCase();
    if (!mpn) continue;

    if (byMPN.has(mpn)) {
      // Aggregate qty for duplicate MPNs (shouldn't happen but handle it)
      const existing = byMPN.get(mpn);
      existing.qty += parseFloat(row.qty) || 0;
    } else {
      byMPN.set(mpn, {
        mpn: row.mpn,
        cpc: row.cpc,
        mfr: row.mfr_resolved || row.mfr,
        qty: parseFloat(row.qty) || 0,
        resalePrice: parseFloat(row.resale_price) || 0,
        leadTime: row.lead_time,
        dateCode: row.date_code,
      });
    }
  }

  return { byMPN, metadata };
}

/**
 * Check if OT inventory data is fresh enough to use
 *
 * @param {number} maxAgeDays - Maximum acceptable age in days
 * @returns {Promise<{ fresh: boolean, ageInDays: number, offerKey: string }>}
 */
async function checkInventoryFreshness(maxAgeDays = 7) {
  const { metadata } = await getLAMInventory();

  return {
    fresh: !metadata.stale && metadata.ageInDays <= maxAgeDays,
    ageInDays: metadata.ageInDays,
    offerKey: metadata.offerKey,
    created: metadata.created,
    lineCount: metadata.lineCount,
  };
}

/**
 * Close the database connection pool
 */
async function close() {
  await pool.end();
}

module.exports = {
  getOfferInventory,
  getInventoryByGroups,
  getLAMInventory,
  getLAMInventoryByMPN,
  checkInventoryFreshness,
  close,
  WAREHOUSE_GROUP_MAPPING,
  LAM_GROUPS,
  LAM_KITTING_OFFER_TYPE,
  LAM_BP_ID,
};
