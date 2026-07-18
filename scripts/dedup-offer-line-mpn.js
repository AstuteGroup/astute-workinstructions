#!/usr/bin/env node
/**
 * dedup-offer-line-mpn.js — Remove duplicate chuboe_offer_line_mpn records
 *
 * BACKGROUND:
 *   iDempiere has a bean callout on chuboe_offer_line that auto-creates a
 *   chuboe_offer_line_mpn sub-record. Our offer-writeback.js was ALSO writing
 *   one (when writeMpnRecords: true), causing duplicates. Discovered 2026-07-07.
 *
 *   This script deactivates the duplicates (keeps the bean-created record,
 *   deactivates the explicit one we wrote).
 *
 * USAGE:
 *   node scripts/dedup-offer-line-mpn.js --dry-run                    # Preview all
 *   node scripts/dedup-offer-line-mpn.js --dry-run --type="Broker Stock Offer"
 *   node scripts/dedup-offer-line-mpn.js --apply --limit=1000         # First 1000
 *   node scripts/dedup-offer-line-mpn.js --apply --type="Customer Excess"
 *
 * OPTIONS:
 *   --dry-run         Preview duplicates without making changes
 *   --apply           Actually deactivate duplicates
 *   --limit=N         Process only first N duplicates
 *   --type="Name"     Filter to specific offer type (use quotes for spaces)
 *   --offset=N        Skip first N duplicates (for resuming)
 *
 * SAFETY:
 *   - Deactivates (IsActive=N), does NOT hard-delete
 *   - Keeps the LOWER ID (bean-created, earlier timestamp)
 *   - Deletes the HIGHER ID (explicit write, later timestamp)
 *   - Only touches records where same (offer_line_id, mpn_clean) appears 2+ times
 *   - Does NOT touch AVL patterns (different mpn_clean values on same line)
 *
 * SCOPE:
 *   - Only active offers (o.isactive = 'Y')
 *   - Only active offer lines (ol.isactive = 'Y')
 *   - Only active offer line MPNs (olm.isactive = 'Y')
 *   - Only records created in the past 9 months
 *
 * ESTIMATED DUPLICATES (2026-07-07, with above filters):
 *   Broker Stock Offer:       639,522
 *   Franchise Stock Offers:   112,743
 *   Customer Excess:          112,414
 *   ─────────────────────────────────
 *   Total:                   ~864,679
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { execSync } = require('child_process');
const { apiPut } = require('../shared/api-client');
const { checkBudget, recordWrites } = require('../shared/ot-api-budget');
const logger = require('../shared/logger').createLogger('dedup-offer-line-mpn');

const CALLER = 'data-cleanup';  // Lowest priority - only runs when spare capacity

// Progress checkpoint file
const PROGRESS_FILE = path.resolve(__dirname, '../logs/dedup-offer-line-mpn-progress.json');

// ── Configuration ──
const CHUNK_SIZE = 100;           // Deactivate in batches
const CHUNK_DELAY_MS = 2000;      // Pause between chunks
const API_DELAY_MS = 50;          // Pause between individual API calls

// ── Parse args ──
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const offsetArg = args.find(a => a.startsWith('--offset='));
const offset = offsetArg ? parseInt(offsetArg.split('=')[1], 10) : 0;
const typeArg = args.find(a => a.startsWith('--type='));
const offerType = typeArg ? typeArg.split('=')[1].replace(/^["']|["']$/g, '') : null;

if (!dryRun && !apply) {
  console.log('Usage: node scripts/dedup-offer-line-mpn.js [--dry-run | --apply] [options]');
  console.log('');
  console.log('  --dry-run           Preview duplicates without making changes');
  console.log('  --apply             Actually deactivate duplicates');
  console.log('  --limit=N           Process only first N duplicates');
  console.log('  --offset=N          Skip first N duplicates (for resuming)');
  console.log('  --type="Name"       Filter to specific offer type');
  console.log('');
  console.log('Offer types with duplicates (past 9 months, active only):');
  console.log('  "Broker Stock Offer"       (~640K)');
  console.log('  "Franchise Stock Offers"   (~113K)');
  console.log('  "Customer Excess"          (~112K)');
  process.exit(1);
}

/**
 * Query duplicate offer_line_mpn records.
 * Returns array of { keep_id, deactivate_id, offer_line_id, mpn_clean, offer_type }
 */
function findDuplicates() {
  // Build WHERE clause for offer type filter
  const typeFilter = offerType
    ? `AND ot.name = '${offerType.replace(/'/g, "''")}'`
    : '';

  const sql = `
    WITH ranked AS (
      SELECT
        olm.chuboe_offer_line_mpn_id,
        ol.chuboe_offer_line_id,
        olm.chuboe_mpn_clean,
        ot.name as offer_type,
        ROW_NUMBER() OVER (
          PARTITION BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean
          ORDER BY olm.chuboe_offer_line_mpn_id ASC
        ) AS rn,
        COUNT(*) OVER (
          PARTITION BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean
        ) AS cnt
      FROM chuboe_offer_line_mpn olm
      JOIN chuboe_offer_line ol ON olm.chuboe_offer_line_id = ol.chuboe_offer_line_id
      JOIN chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
      JOIN chuboe_offer_type ot ON o.chuboe_offer_type_id = ot.chuboe_offer_type_id
      WHERE olm.isactive = 'Y'
        AND ol.isactive = 'Y'
        AND o.isactive = 'Y'
        AND olm.created >= NOW() - INTERVAL '9 months'
        ${typeFilter}
    )
    SELECT
      r1.chuboe_offer_line_mpn_id AS keep_id,
      r2.chuboe_offer_line_mpn_id AS deactivate_id,
      r1.chuboe_offer_line_id,
      r1.chuboe_mpn_clean,
      r1.offer_type
    FROM ranked r1
    JOIN ranked r2
      ON r1.chuboe_offer_line_id = r2.chuboe_offer_line_id
      AND r1.chuboe_mpn_clean = r2.chuboe_mpn_clean
      AND r1.rn = 1
      AND r2.rn = 2
    WHERE r1.cnt = 2
    ORDER BY r1.chuboe_offer_line_id
    ${offset > 0 ? `OFFSET ${offset}` : ''}
    ${limit ? `LIMIT ${limit}` : ''};
  `;

  const result = execSync(`psql -d idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,  // 100MB buffer for large result sets
  });

  const rows = result.trim().split('\n').filter(Boolean).map(line => {
    const [keep_id, deactivate_id, offer_line_id, mpn_clean, offer_type] = line.split('|');
    return {
      keep_id: parseInt(keep_id, 10),
      deactivate_id: parseInt(deactivate_id, 10),
      offer_line_id: parseInt(offer_line_id, 10),
      mpn_clean: mpn_clean || '',
      offer_type: offer_type || '',
    };
  });

  return rows;
}

/**
 * Deactivate a single offer_line_mpn record
 */
async function deactivateRecord(id) {
  await apiPut('chuboe_offer_line_mpn', id, { IsActive: false });
  recordWrites('chuboe_offer_line_mpn', 1, { caller: CALLER });
}

/**
 * Wait for budget availability, checking every 30 seconds
 */
async function waitForBudget(count = 1) {
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes max wait
  const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds
  const startWait = Date.now();

  while (true) {
    const check = checkBudget({ caller: CALLER, table: 'chuboe_offer_line_mpn', count });
    if (check.allowed) return true;

    const waited = Date.now() - startWait;
    if (waited > MAX_WAIT_MS) {
      logger.warn(`Budget not available after ${MAX_WAIT_MS / 1000}s, proceeding anyway: ${check.reason}`);
      return false;
    }

    logger.info(`Budget constrained (P0 lowest priority): ${check.reason}. Waiting 30s...`);
    await sleep(CHECK_INTERVAL_MS);
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Save progress checkpoint
 */
function saveProgress(data) {
  try {
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn(`Failed to save progress: ${err.message}`);
  }
}

/**
 * Main
 */
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  dedup-offer-line-mpn.js — Remove duplicate offer_line_mpn records       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // ── Display filters ──
  if (offerType) console.log(`Filter: offer type = "${offerType}"`);
  if (offset > 0) console.log(`Offset: skipping first ${offset.toLocaleString()} records`);
  if (limit) console.log(`Limit: processing at most ${limit.toLocaleString()} records`);
  if (offerType || offset > 0 || limit) console.log('');

  // ── Step 1: Find duplicates ──
  logger.info('Finding duplicates...');
  const duplicates = findDuplicates();

  if (duplicates.length === 0) {
    console.log('No duplicates found. Nothing to do.');
    return;
  }

  console.log(`Found ${duplicates.length.toLocaleString()} duplicate pairs to process.`);

  // Show breakdown by offer type if not filtered
  if (!offerType) {
    const byType = {};
    duplicates.forEach(d => {
      byType[d.offer_type] = (byType[d.offer_type] || 0) + 1;
    });
    console.log('');
    console.log('By offer type:');
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`  ${type.padEnd(30)} ${count.toLocaleString()}`);
      });
  }
  console.log('');

  // ── Step 2: Preview ──
  console.log('Sample (first 10):');
  console.log('─'.repeat(100));
  console.log('  Keep ID       Deactivate ID   MPN Clean                       Offer Type');
  console.log('─'.repeat(100));
  duplicates.slice(0, 10).forEach(d => {
    console.log(`  ${d.keep_id.toString().padEnd(12)}  ${d.deactivate_id.toString().padEnd(14)}  ${d.mpn_clean.slice(0, 30).padEnd(30)}  ${d.offer_type.slice(0, 25)}`);
  });
  if (duplicates.length > 10) {
    console.log(`  ... and ${(duplicates.length - 10).toLocaleString()} more`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — no changes made.');
    console.log(`Would deactivate ${duplicates.length.toLocaleString()} records.`);
    return;
  }

  // ── Step 3: Apply ──
  console.log('APPLY MODE — deactivating duplicates...');
  console.log('');

  const startTime = Date.now();
  let deactivated = 0;
  let errors = 0;
  const errorDetails = [];

  const chunks = [];
  for (let i = 0; i < duplicates.length; i += CHUNK_SIZE) {
    chunks.push(duplicates.slice(i, i + CHUNK_SIZE));
  }

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const chunkNum = chunkIdx + 1;
    const totalChunks = chunks.length;

    // Check budget before each chunk (P0 = lowest priority, yields to all other agents)
    await waitForBudget(chunk.length);

    logger.info(`Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} records)...`);

    for (const dup of chunk) {
      try {
        await deactivateRecord(dup.deactivate_id);
        deactivated++;

        if (deactivated % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = deactivated / elapsed;
          const remaining = (duplicates.length - deactivated) / rate;
          const eta = remaining > 60
            ? `${Math.round(remaining / 60)}m remaining`
            : `${Math.round(remaining)}s remaining`;
          process.stdout.write(`\r  Deactivated: ${deactivated.toLocaleString()} / ${duplicates.length.toLocaleString()} (${rate.toFixed(1)}/s, ~${eta})      `);
        }
      } catch (err) {
        errors++;
        errorDetails.push({ id: dup.deactivate_id, error: err.message });
        logger.error(`Failed to deactivate ${dup.deactivate_id}: ${err.message}`);
      }

      await sleep(API_DELAY_MS);
    }

    // Save progress checkpoint
    saveProgress({
      timestamp: new Date().toISOString(),
      offerType: offerType || 'all',
      totalDuplicates: duplicates.length,
      processed: (chunkIdx + 1) * CHUNK_SIZE,
      deactivated,
      errors,
      lastDeactivatedId: chunk[chunk.length - 1]?.deactivate_id,
      resumeOffset: offset + (chunkIdx + 1) * CHUNK_SIZE,
    });

    // Pause between chunks
    if (chunkIdx < chunks.length - 1) {
      logger.info(`Chunk ${chunkNum} complete. Pausing ${CHUNK_DELAY_MS}ms...`);
      await sleep(CHUNK_DELAY_MS);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  const elapsedStr = elapsed > 60
    ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`
    : `${elapsed.toFixed(1)}s`;

  console.log('');
  console.log('');
  console.log('═'.repeat(80));
  console.log('SUMMARY');
  console.log('═'.repeat(80));
  console.log(`  Duplicates found:         ${duplicates.length.toLocaleString()}`);
  console.log(`  Successfully deactivated: ${deactivated.toLocaleString()}`);
  console.log(`  Errors:                   ${errors}`);
  console.log(`  Elapsed time:             ${elapsedStr}`);

  if (errorDetails.length > 0) {
    console.log('');
    console.log('Errors (first 10):');
    errorDetails.slice(0, 10).forEach(e => {
      console.log(`  ID ${e.id}: ${e.error}`);
    });
  }

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
