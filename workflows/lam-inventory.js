#!/usr/bin/env node
/**
 * LAM Inventory Workflow
 *
 * Writes LAM inventory offers to OT from cached parse data.
 * Subordinate to fetch-and-parse — loads from cache, not xlsx directly.
 *
 * Warehouses:
 *   - W115 (LAM Dead Inventory) → OT offer
 *   - W118 (LAM Consignment) → OT offer
 *   - W111 (LAM 3PL) → internal-only, NOT written to OT
 *
 * Usage:
 *   node lam-inventory.js                    # Write offers from cache
 *   node lam-inventory.js --dry-run          # Preview without writing
 *   node lam-inventory.js --threshold-only   # Run threshold check only
 *
 * Cron: Monday 12 PM CT (after fetch-and-parse at 5 AM)
 *
 * @module workflows/lam-inventory
 */

const path = require('path');
const { loadCachedInventory, getWarehouseRowsFromCache } = require('../shared/inventory-fetch-and-parse');
const { writeOffer } = require('../shared/offer-writeback');
const { runThresholdCheck } = require('../shared/lam-threshold-check');
const { createNotifier } = require('../shared/notifier');

// =============================================================================
// CONFIGURATION
// =============================================================================

// LAM warehouses
const LAM_WAREHOUSES = {
  W115: {
    name: 'LAM_Dead_Inventory',
    description: 'LAM Dead/Stale Inventory',
    bpartnerId: 1000332,      // Astute Electronics Inc
    offerTypeId: 1000008,     // Austin
    writeToOT: true,
  },
  W118: {
    name: 'LAM_Consignment',
    description: 'LAM Consignment',
    bpartnerId: 1011267,      // Astute - LAM Consignment
    offerTypeId: 1000014,     // Philippines
    writeToOT: true,
  },
  W111: {
    name: 'LAM_3PL',
    description: 'LAM 3PL (Internal Only)',
    writeToOT: false,         // Internal-only, not marketed
  },
};

// Email config
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: 'lamkitting@orangetsunami.com',
  fromName: 'LAM Inventory',
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
function transformToOfferLine(row, warehouseConfig) {
  return {
    Chuboe_MPN: row.mpn || '',
    Chuboe_MFR_Text: row.mfr || '',
    Qty: row.qty || 0,
    PriceEntered: row.unitCost || 0,
    Chuboe_Date_Code: row.dateCode || '',
    Description: row.description || '',
    // Additional fields from parser
    _lot: row.lot || '',
    _location: row.location || '',
    _warehouse: row.warehouse || '',
  };
}

// =============================================================================
// MAIN WORKFLOW
// =============================================================================

async function runLAMInventory(options = {}) {
  const { dryRun = false, thresholdOnly = false } = options;

  log('='.repeat(60));
  log('LAM INVENTORY WORKFLOW');
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

  // Get LAM warehouse rows
  const warehouseData = {};
  for (const [code, config] of Object.entries(LAM_WAREHOUSES)) {
    const rows = cache.byWarehouse[code] || [];
    warehouseData[code] = {
      config,
      rows,
      lines: rows.map(r => transformToOfferLine(r, config)),
    };
    log(`  ${code} (${config.name}): ${rows.length} rows`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Write OT offers (unless threshold-only)
  // -------------------------------------------------------------------------
  if (!thresholdOnly) {
    log('\nStep 2: Writing OT offers...');

    const writeResults = { success: 0, failed: 0, skipped: 0 };

    for (const [code, data] of Object.entries(warehouseData)) {
      if (!data.config.writeToOT) {
        log(`  ${code}: SKIPPED (internal-only)`);
        writeResults.skipped++;
        continue;
      }

      if (data.rows.length === 0) {
        log(`  ${code}: SKIPPED (no rows)`);
        writeResults.skipped++;
        continue;
      }

      if (dryRun) {
        log(`  ${code}: [DRY RUN] Would write ${data.rows.length} lines`);
        writeResults.success++;
        continue;
      }

      try {
        log(`  ${code}: Writing ${data.rows.length} lines...`);

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

    log(`\n  Results: ${writeResults.success} written, ${writeResults.failed} failed, ${writeResults.skipped} skipped`);
  }

  // -------------------------------------------------------------------------
  // Step 3: Run threshold check
  // -------------------------------------------------------------------------
  log('\nStep 3: Running threshold check...');

  try {
    const thresholdResult = await runThresholdCheck({
      source: 'ot',  // Use OT data (just written)
    });

    log(`  Below threshold: ${thresholdResult.candidates.length}`);
    log(`    CRITICAL: ${thresholdResult.counts.CRITICAL}`);
    log(`    HIGH: ${thresholdResult.counts.HIGH}`);
    log(`    MEDIUM: ${thresholdResult.counts.MEDIUM}`);
    log(`    LOW: ${thresholdResult.counts.LOW}`);
  } catch (err) {
    log(`  Threshold check failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log('\n' + '='.repeat(60));
  log('COMPLETE');
  log('='.repeat(60));

  return {
    warehouseData,
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
  const thresholdOnly = args.includes('--threshold-only');

  if (args.includes('--help')) {
    console.log(`
LAM Inventory Workflow

Usage:
  node lam-inventory.js                    Write offers from cache
  node lam-inventory.js --dry-run          Preview without writing
  node lam-inventory.js --threshold-only   Run threshold check only
  node lam-inventory.js --help             Show this help

Warehouses:
  W115 - LAM Dead Inventory (written to OT)
  W118 - LAM Consignment (written to OT)
  W111 - LAM 3PL (internal-only, NOT written)
`);
    process.exit(0);
  }

  try {
    await runLAMInventory({ dryRun, thresholdOnly });
  } catch (err) {
    log(`ERROR: ${err.message}`);

    // Send failure notification
    try {
      await notifier.sendEmail(
        NOTIFY_EMAIL,
        'FAILED: LAM Inventory Workflow',
        `LAM inventory workflow failed at ${new Date().toISOString()}\n\nError: ${err.message}`
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
  runLAMInventory,
  LAM_WAREHOUSES,
};
