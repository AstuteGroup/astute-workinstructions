#!/usr/bin/env node
/**
 * Free Stock Inventory Workflow
 *
 * Writes free stock inventory offers to OT from cached parse data.
 * Subordinate to fetch-and-parse — loads from cache, not xlsx directly.
 *
 * Groups:
 *   - Free_Stock_Austin (W104, W112) — excludes Positronic
 *   - Free_Stock_Stevenage (W102)
 *   - Free_Stock_Hong_Kong (W108, W113)
 *   - Free_Stock_Philippines (W109, W114)
 *   - Franchise_Stock (W104 Positronic only)
 *   - GM_Stock_US (W121)
 *   - GM_Stock_HK (W122)
 *
 * Usage:
 *   node free-stock-inventory.js             # Write all offers
 *   node free-stock-inventory.js --dry-run   # Preview without writing
 *
 * Cron: Monday 6:15 AM CT (after fetch-and-parse)
 *
 * @module workflows/free-stock-inventory
 */

const path = require('path');
const { loadCachedInventory } = require('../shared/inventory-fetch-and-parse');
const { writeOffer } = require('../shared/offer-writeback');
const { createNotifier } = require('../shared/notifier');

// =============================================================================
// CONFIGURATION
// =============================================================================

const FREE_STOCK_GROUPS = {
  Free_Stock_Austin: {
    warehouses: ['W104', 'W112'],
    bpartnerId: 1000332,      // Astute Electronics Inc
    offerTypeId: 1000008,     // Austin
    description: 'Free Stock Austin',
    excludeMfr: ['positronic'],  // Positronic goes to Franchise_Stock
  },
  Free_Stock_Stevenage: {
    warehouses: ['W102'],
    bpartnerId: 1000332,
    offerTypeId: 1000006,     // Stevenage
    description: 'Free Stock Stevenage',
  },
  Free_Stock_Hong_Kong: {
    warehouses: ['W108', 'W113'],
    bpartnerId: 1000332,
    offerTypeId: 1000009,     // Hong Kong
    description: 'Free Stock Hong Kong',
  },
  Free_Stock_Philippines: {
    warehouses: ['W109', 'W114'],
    bpartnerId: 1000332,
    offerTypeId: 1000014,     // Philippines
    description: 'Free Stock Philippines',
  },
  Franchise_Stock: {
    warehouses: ['W104'],
    bpartnerId: 1000325,      // Astute - Franchise Stock
    offerTypeId: 1000008,     // Austin
    description: 'Franchise Stock',
    includeMfrOnly: ['positronic'],  // Only Positronic
  },
  GM_Stock_US: {
    // Added 2026-08-21. GM is Astute-owned free stock (not consignment) —
    // Infor's warehouseName for W121 is literally "Astute Electronics Inc
    // (GM Stock)", matching bpartner 1000332 used by every other Free_Stock_*
    // group. Offer type inferred by elimination (only US-location type tied
    // to this bpartner) and confirmed with operator 2026-08-21.
    warehouses: ['W121'],
    bpartnerId: 1000332,      // Astute Electronics Inc
    offerTypeId: 1000008,     // Austin
    description: 'GM Stock - US',
  },
  GM_Stock_HK: {
    // W122 has minimal data so far (1 row as of 2026-08-21) but wired in
    // now for consistency — same bpartner as the rest, Hong Kong offer type.
    warehouses: ['W122'],
    bpartnerId: 1000332,      // Astute Electronics Inc
    offerTypeId: 1000009,     // Hong Kong
    description: 'GM Stock - Hong Kong',
  },
};

// Email config
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: 'excess@orangetsunami.com',
  fromName: 'Free Stock Inventory',
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
 */
function transformToOfferLine(row) {
  return {
    Chuboe_MPN: row.mpn || '',
    Chuboe_MFR_Text: row.mfr || '',
    Qty: row.qty || 0,
    PriceEntered: row.unitCost || 0,
    Chuboe_Date_Code: row.dateCode || '',
    Description: row.description || '',
  };
}

/**
 * Filter rows by manufacturer
 */
function filterByMfr(rows, includeMfrOnly = null, excludeMfr = null) {
  return rows.filter(row => {
    const mfr = (row.mfr || '').toLowerCase();

    // Include only specific manufacturers
    if (includeMfrOnly && includeMfrOnly.length > 0) {
      return includeMfrOnly.some(m => mfr.includes(m.toLowerCase()));
    }

    // Exclude specific manufacturers
    if (excludeMfr && excludeMfr.length > 0) {
      return !excludeMfr.some(m => mfr.includes(m.toLowerCase()));
    }

    return true;
  });
}

// =============================================================================
// MAIN WORKFLOW
// =============================================================================

async function runFreeStockInventory(options = {}) {
  const { dryRun = false } = options;

  log('='.repeat(60));
  log('FREE STOCK INVENTORY WORKFLOW');
  log('='.repeat(60));
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log(`Date: ${getDateStamp()}`);

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

  for (const [groupName, config] of Object.entries(FREE_STOCK_GROUPS)) {
    // Combine rows from all warehouses for this group
    let rows = [];
    for (const wh of config.warehouses) {
      const whRows = cache.byWarehouse[wh] || [];
      rows.push(...whRows);
    }

    // Apply manufacturer filters
    rows = filterByMfr(rows, config.includeMfrOnly, config.excludeMfr);

    groupData[groupName] = {
      config,
      rows,
      lines: rows.map(transformToOfferLine),
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

  if (args.includes('--help')) {
    console.log(`
Free Stock Inventory Workflow

Usage:
  node free-stock-inventory.js             Write all offers
  node free-stock-inventory.js --dry-run   Preview without writing
  node free-stock-inventory.js --help      Show this help

Groups:
  Free_Stock_Austin      W104, W112 (excludes Positronic)
  Free_Stock_Stevenage   W102
  Free_Stock_Hong_Kong   W108, W113
  Free_Stock_Philippines W109, W114
  Franchise_Stock        W104 (Positronic only)
  GM_Stock_US            W121
  GM_Stock_HK            W122
`);
    process.exit(0);
  }

  try {
    await runFreeStockInventory({ dryRun });
  } catch (err) {
    log(`ERROR: ${err.message}`);

    try {
      await notifier.sendEmail(
        NOTIFY_EMAIL,
        'FAILED: Free Stock Inventory Workflow',
        `Free stock inventory workflow failed at ${new Date().toISOString()}\n\nError: ${err.message}`
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
  runFreeStockInventory,
  FREE_STOCK_GROUPS,
};
