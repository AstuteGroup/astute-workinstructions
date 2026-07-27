#!/usr/bin/env node
/**
 * Consignment Inventory Workflow
 *
 * Writes consignment inventory offers to OT from cached parse data.
 * Subordinate to fetch-and-parse — loads from cache, not xlsx directly.
 *
 * Groups:
 *   - GE_Consignment (W103)
 *   - Taxan_Consignment (W106)
 *   - Spartronics_Consignment (W107)
 *   - Eaton_Consignment (W117)
 *
 * Note: LAM_Consignment (W118) is handled by lam-inventory.js
 *
 * Usage:
 *   node consignment-inventory.js             # Write all offers
 *   node consignment-inventory.js --dry-run   # Preview without writing
 *
 * Cron: Monday 6:15 AM CT (after fetch-and-parse)
 *
 * @module workflows/consignment-inventory
 */

const path = require('path');
const { loadCachedInventory } = require('../shared/inventory-fetch-and-parse');
const { writeOffer } = require('../shared/offer-writeback');
const { createNotifier } = require('../shared/notifier');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONSIGNMENT_GROUPS = {
  GE_Consignment: {
    warehouses: ['W103'],
    bpartnerId: 1003236,      // Astute - GE Aviation Excess
    offerTypeId: 1000008,     // Austin
    description: 'GE Consignment',
  },
  Taxan_Consignment: {
    warehouses: ['W106'],
    bpartnerId: 1003621,      // Astute - Taxan Excess
    offerTypeId: 1000008,     // Austin
    description: 'Taxan Consignment',
  },
  Spartronics_Consignment: {
    warehouses: ['W107'],
    bpartnerId: 1005225,      // Astute - Spartronics Excess
    offerTypeId: 1000008,     // Austin
    description: 'Spartronics Consignment',
  },
  Eaton_Consignment: {
    warehouses: ['W117'],
    bpartnerId: 1010966,      // Astute Inc - Eaton Consignment
    offerTypeId: 1000014,     // Philippines
    description: 'Eaton Consignment',
  },
};

// Email config
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: 'excess@orangetsunami.com',
  fromName: 'Consignment Inventory',
});

// =============================================================================
// HELPERS
// =============================================================================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getDateStamp() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Transform parser row to OT offer line format
 * Note: Consignment offers typically have prices blanked (confidential)
 */
function transformToOfferLine(row, blankPrices = false) {
  return {
    Chuboe_MPN: row.mpn || '',
    Chuboe_MFR_Text: row.mfr || '',
    Qty: row.qty || 0,
    PriceEntered: blankPrices ? 0 : (row.unitCost || 0),
    Chuboe_Date_Code: row.dateCode || '',
    Description: row.description || '',
  };
}

// =============================================================================
// MAIN WORKFLOW
// =============================================================================

async function runConsignmentInventory(options = {}) {
  const { dryRun = false, blankPrices = true } = options;

  log('='.repeat(60));
  log('CONSIGNMENT INVENTORY WORKFLOW');
  log('='.repeat(60));
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log(`Date: ${getDateStamp()}`);
  log(`Prices: ${blankPrices ? 'BLANKED (confidential)' : 'included'}`);

  // -------------------------------------------------------------------------
  // Step 1: Load from cache
  // -------------------------------------------------------------------------
  log('\nStep 1: Loading inventory from cache...');

  const cache = loadCachedInventory({ allowStale: true });
  if (!cache) {
    throw new Error('No inventory cache found. Run fetch-and-parse first.');
  }

  log(`  Cache date: ${cache.metadata.cachedAt}`);
  log(`  Week of: ${cache.metadata.weekOf}`);
  if (cache.metadata.stale) {
    log('  WARNING: Using stale cache');
  }

  // -------------------------------------------------------------------------
  // Step 2: Build group data
  // -------------------------------------------------------------------------
  log('\nStep 2: Building group data...');

  const groupData = {};

  for (const [groupName, config] of Object.entries(CONSIGNMENT_GROUPS)) {
    // Combine rows from all warehouses for this group
    let rows = [];
    for (const wh of config.warehouses) {
      const whRows = cache.byWarehouse[wh] || [];
      rows.push(...whRows);
    }

    groupData[groupName] = {
      config,
      rows,
      lines: rows.map(r => transformToOfferLine(r, blankPrices)),
    };

    log(`  ${groupName}: ${rows.length} rows (from ${config.warehouses.join(', ')})`);
  }

  // -------------------------------------------------------------------------
  // Step 3: Write OT offers
  // -------------------------------------------------------------------------
  log('\nStep 3: Writing OT offers...');

  const writeResults = { success: 0, failed: 0, skipped: 0 };

  for (const [groupName, data] of Object.entries(groupData)) {
    if (data.rows.length === 0) {
      log(`  ${groupName}: SKIPPED (no rows)`);
      writeResults.skipped++;
      continue;
    }

    if (dryRun) {
      log(`  ${groupName}: [DRY RUN] Would write ${data.rows.length} lines`);
      writeResults.success++;
      continue;
    }

    try {
      log(`  ${groupName}: Writing ${data.rows.length} lines...`);

      const result = await writeOffer({
        bpartnerId: data.config.bpartnerId,
        offerTypeId: data.config.offerTypeId,
        description: `${data.config.description} - ${getDateStamp()}`,
        lines: data.lines,
        deactivatePrior: true,
      });

      log(`    Offer created: ${result.offerKey || result.offerId}`);
      writeResults.success++;
    } catch (err) {
      log(`    ERROR: ${err.message}`);
      writeResults.failed++;
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log('\n' + '='.repeat(60));
  log(`COMPLETE: ${writeResults.success} written, ${writeResults.failed} failed, ${writeResults.skipped} skipped`);
  log('='.repeat(60));

  return {
    groupData,
    writeResults,
    cacheDate: cache.metadata.cachedAt,
    stale: cache.metadata.stale || false,
  };
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includePrices = args.includes('--include-prices');

  if (args.includes('--help')) {
    console.log(`
Consignment Inventory Workflow

Usage:
  node consignment-inventory.js                  Write all offers (prices blanked)
  node consignment-inventory.js --dry-run        Preview without writing
  node consignment-inventory.js --include-prices Include prices (not recommended)
  node consignment-inventory.js --help           Show this help

Groups:
  GE_Consignment          W103
  Taxan_Consignment       W106
  Spartronics_Consignment W107
  Eaton_Consignment       W117

Note: LAM_Consignment (W118) is handled by lam-inventory.js
`);
    process.exit(0);
  }

  try {
    await runConsignmentInventory({ dryRun, blankPrices: !includePrices });
  } catch (err) {
    log(`ERROR: ${err.message}`);

    try {
      await notifier.sendEmail(
        NOTIFY_EMAIL,
        'FAILED: Consignment Inventory Workflow',
        `Consignment inventory workflow failed at ${new Date().toISOString()}\n\nError: ${err.message}`
      );
    } catch (e) {
      log(`Could not send notification: ${e.message}`);
    }

    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  runConsignmentInventory,
  CONSIGNMENT_GROUPS,
};
