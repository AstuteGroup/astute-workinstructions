#!/usr/bin/env node
/**
 * Market Profiler Orchestrator
 *
 * Continuous market intelligence gathering via NetComponents scraping.
 * Scrapes broker availability WITHOUT sending RFQ emails.
 *
 * Workflow:
 * 1. Read inventory MPNs from the weekly Infor export (same source as nc-listing.js)
 * 2. Filter out MPNs profiled in the last N days (watermark)
 * 3. Create or reuse a weekly "Stock Profiling" RFQ in OT
 * 4. Run NC scraper in --check-only mode
 * 5. Load availability as $0 VQs
 * 6. Update profiling watermark
 *
 * Usage:
 *   node market-profiler.js --limit 500 --dry-run
 *   node market-profiler.js --limit 500 --commit
 */

const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

// Shared utilities
const sharedPath = path.join(__dirname, '../../shared');
const { apiPost, apiGet } = require(path.join(sharedPath, 'api-client'));
const logger = require(path.join(sharedPath, 'logger')).createLogger('MarketProfiler');

// Local modules
const { processResults } = require('./availability-vq-loader');

// ─── Configuration ─────────────────────────────────────────────────────────

// Self-regulating: process this many MPNs per tick. Small batches spread load
// and avoid rate limiting. At 50 MPNs per 30-min tick = ~2400/day = full
// inventory rotation every ~2-3 days.
const DEFAULT_BATCH_SIZE = 50;

// Skip MPNs profiled within this window - defines the rotation cycle
const PROFILE_SKIP_DAYS = 14;

const WATERMARK_FILE = path.join(process.env.HOME, 'workspace/.market-profiling-watermark.json');

// NC Python script location
const NC_SCRIPT = path.join(__dirname, '../RFQ Sourcing/netcomponents/python/batch_rfqs_from_system.py');

// ─── Inventory File Helpers ─────────────────────────────────────────────────

function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split('T')[0];
}

function getThisWeekInventoryFile() {
  const weekStart = getWeekStartDate();
  const persistentPath = path.join(INVENTORY_STORAGE_DIR, `inventory_${weekStart}.xlsx`);
  if (fs.existsSync(persistentPath)) {
    return persistentPath;
  }
  return null;
}

// ─── Watermark Management ──────────────────────────────────────────────────

function loadWatermark() {
  if (!fs.existsSync(WATERMARK_FILE)) {
    return { lastRun: null, mpnsProfiled: {}, totalRuns: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(WATERMARK_FILE, 'utf8'));
  } catch (e) {
    return { lastRun: null, mpnsProfiled: {}, totalRuns: 0 };
  }
}

function saveWatermark(data) {
  fs.writeFileSync(WATERMARK_FILE, JSON.stringify(data, null, 2));
}

function updateWatermark(mpns) {
  const watermark = loadWatermark();
  const now = new Date().toISOString();

  for (const mpn of mpns) {
    watermark.mpnsProfiled[mpn.toUpperCase()] = now;
  }
  watermark.lastRun = now;
  watermark.totalRuns = (watermark.totalRuns || 0) + 1;

  // Prune old entries (keep last 30 days)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const [mpn, date] of Object.entries(watermark.mpnsProfiled)) {
    if (date < cutoff) {
      delete watermark.mpnsProfiled[mpn];
    }
  }

  saveWatermark(watermark);
  return watermark;
}

// ─── Database Queries ──────────────────────────────────────────────────────

function psqlQuery(sql) {
  try {
    return execFileSync('psql', ['-At', '-c', sql], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

function psqlQueryRows(sql) {
  try {
    const out = execFileSync('psql', ['-At', '-F', '|', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer for safety
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ─── Inventory Reading ─────────────────────────────────────────────────────

// All BPs used for inventory offers (from inventory_cleanup.js WAREHOUSE_WRITEBACK)
const STOCK_BP_IDS = [
  1000332, // Astute Electronics Inc (Free Stock Austin/Stevenage/HK/Philippines, LAM Dead)
  1000325, // Astute - Franchise Stock
  1003236, // Astute - GE Aviation Excess (consignment)
  1003621, // Astute - Taxan Excess (consignment)
  1005225, // Astute - Spartronics Excess (consignment)
  1010966, // Astute Inc - Eaton Consignment
  1011267, // Astute - LAM Consignment
];

/**
 * Get inventory MPNs not profiled recently.
 *
 * Reads from the OT stock offers (all inventory BPs) rather than re-parsing raw files.
 * This captures static lists, carryovers, consignment inventory, and any other
 * adjustments that were applied during inventory cleanup.
 */
function getUnprofiledMPNs(limit = DEFAULT_BATCH_SIZE) {
  console.log(`  Querying OT stock offers (${STOCK_BP_IDS.length} BPs)...`);

  // Query active stock offers from all inventory BPs
  // Get distinct MPNs with total qty across all offer lines
  const bpList = STOCK_BP_IDS.join(', ');
  const sql = `
    SELECT
      olm.chuboe_mpn,
      COALESCE(SUM(ol.qty), 0) as total_qty
    FROM adempiere.chuboe_offer o
    JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
    LEFT JOIN adempiere.chuboe_offer_line_mpn olm ON ol.chuboe_offer_line_id = olm.chuboe_offer_line_id
    WHERE o.c_bpartner_id IN (${bpList})
      AND o.isactive = 'Y'
      AND ol.isactive = 'Y'
      AND olm.chuboe_mpn IS NOT NULL
      AND olm.chuboe_mpn <> ''
    GROUP BY olm.chuboe_mpn
    HAVING COALESCE(SUM(ol.qty), 0) > 0
    ORDER BY total_qty DESC
  `;

  const rows = psqlQueryRows(sql);
  console.log(`  Total inventory MPNs in OT: ${rows.length}`);

  if (rows.length === 0) {
    console.error(`  WARNING: No stock offers found for inventory BPs`);
    console.error('  Run inventory_cleanup.js fetch first to load inventory offers.');
    return [];
  }

  // Parse results
  const allMPNs = rows.map(row => {
    const [mpn, qty] = row.split('|');
    return { mpn, qty: parseInt(qty, 10) || 0 };
  });

  // Load watermark to filter out recently profiled
  const watermark = loadWatermark();
  const skipDate = new Date(Date.now() - PROFILE_SKIP_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Get MPNs already profiled recently
  const recentlyProfiled = new Set(
    Object.entries(watermark.mpnsProfiled)
      .filter(([mpn, date]) => date > skipDate)
      .map(([mpn]) => mpn)
  );

  console.log(`  Recently profiled (skip): ${recentlyProfiled.size}`);

  // Filter and limit
  const result = [];
  for (const item of allMPNs) {
    if (result.length >= limit) break;
    if (!recentlyProfiled.has(item.mpn.toUpperCase())) {
      result.push(item);
    }
  }

  return result;
}

/**
 * Get or create weekly profiling RFQ
 */
async function getOrCreateProfilingRFQ() {
  // Weekly RFQ naming: "Stock Profiling YYYY-WW"
  const now = new Date();
  const weekNum = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
  const weekStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const description = `Stock Profiling ${weekStr}`;

  // Check if exists
  const existingSql = `
    SELECT value, chuboe_rfq_id
    FROM adempiere.chuboe_rfq
    WHERE description = '${description}'
      AND isactive = 'Y'
    ORDER BY created DESC
    LIMIT 1
  `;
  const existing = psqlQuery(existingSql);
  if (existing) {
    const [value, id] = existing.split('|');
    logger.info(`Using existing profiling RFQ: ${value} (ID ${id})`);
    return { searchKey: value, id: parseInt(id, 10), created: false };
  }

  // Create new RFQ
  // Using Astute Electronics Inc (BP ID 1049385) as the profiling customer
  const payload = {
    C_BPartner_ID: 1000332, // Astute Electronics Inc
    Chuboe_RFQ_Type_ID: 1000007, // Stock
    SalesRep_ID: 1000004, // Jake Harris
    R_Status_ID: 1000022, // New
    Description: description
  };

  try {
    const result = await apiPost('chuboe_rfq', payload);
    const searchKey = result.Value || result.value;
    logger.info(`Created profiling RFQ: ${searchKey} (ID ${result.id})`);
    return { searchKey, id: result.id, created: true };
  } catch (e) {
    throw new Error(`Failed to create profiling RFQ: ${e.message}`);
  }
}

/**
 * Add MPNs to the profiling RFQ as lines
 */
async function addRFQLines(rfqId, mpns) {
  // Check existing lines
  const existingMpns = new Set(
    psqlQueryRows(`
      SELECT UPPER(rlm.chuboe_mpn)
      FROM adempiere.chuboe_rfq_line rl
      JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
      WHERE rl.chuboe_rfq_id = ${rfqId}
        AND rl.isactive = 'Y'
        AND rlm.isactive = 'Y'
    `)
  );

  // Get next line number
  const maxLineSql = `
    SELECT COALESCE(MAX(line), 0)
    FROM adempiere.chuboe_rfq_line
    WHERE chuboe_rfq_id = ${rfqId}
  `;
  let nextLine = parseInt(psqlQuery(maxLineSql), 10) || 0;

  let added = 0;
  let skipped = 0;

  for (const item of mpns) {
    if (existingMpns.has(item.mpn.toUpperCase())) {
      skipped++;
      continue;
    }

    nextLine += 10;

    try {
      // Create line
      const lineResult = await apiPost('chuboe_rfq_line', {
        Chuboe_RFQ_ID: rfqId,
        Line: nextLine,
        Qty: item.qty
      });

      // Create line MPN
      await apiPost('chuboe_rfq_line_mpn', {
        Chuboe_RFQ_Line_ID: lineResult.id,
        Chuboe_RFQ_ID: rfqId,
        Chuboe_MPN: item.mpn,
        Chuboe_MPN_Clean: item.mpn.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        Qty: item.qty
      });

      added++;
    } catch (e) {
      logger.warn(`Failed to add line for ${item.mpn}: ${e.message}`);
    }
  }

  return { added, skipped };
}

/**
 * Run NC scraper in check-only mode
 */
function runNCScraper(rfqNumber, limit = 0) {
  const args = ['--check-only'];
  if (limit > 0) args.push('--limit', String(limit));
  args.push(rfqNumber);

  logger.info(`Running NC scraper: python3 ${NC_SCRIPT} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [NC_SCRIPT, ...args], {
      cwd: path.dirname(NC_SCRIPT),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data); // Pass through
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // Find output file
        const match = stdout.match(/Results saved to: (.+\.xlsx)/);
        const outputFile = match ? match[1] : null;
        resolve({ success: true, outputFile, stdout, stderr });
      } else {
        reject(new Error(`NC scraper exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// ─── Main Orchestrator ─────────────────────────────────────────────────────

async function runMarketProfiling(options = {}) {
  const limit = options.limit || DEFAULT_BATCH_SIZE;
  const dryRun = options.dryRun !== false;
  const skipNc = options.skipNc || false;

  console.log('='.repeat(60));
  console.log('Market Profiler (Inventory-Based)');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'COMMIT'}`);
  console.log(`Batch size: ${limit} MPNs per tick`);
  console.log(`Rotation window: ${PROFILE_SKIP_DAYS} days`);
  console.log('='.repeat(60));
  console.log('');

  // Step 1: Get unprofiled MPNs from inventory file
  console.log('Step 1: Getting unprofiled MPNs from inventory file...');
  const mpns = getUnprofiledMPNs(limit);
  console.log(`  Found ${mpns.length} MPNs to profile`);

  if (mpns.length === 0) {
    console.log('  No MPNs need profiling. Done.');
    return { mpnsFound: 0, vqsWritten: 0 };
  }

  if (dryRun) {
    console.log('');
    console.log('DRY-RUN: Would profile these MPNs:');
    for (const item of mpns.slice(0, 10)) {
      console.log(`  ${item.mpn} (${item.qty.toLocaleString()} pcs)`);
    }
    if (mpns.length > 10) {
      console.log(`  ... and ${mpns.length - 10} more`);
    }
    return { mpnsFound: mpns.length, vqsWritten: 0, dryRun: true };
  }

  // Step 2: Get or create profiling RFQ
  console.log('');
  console.log('Step 2: Getting/creating profiling RFQ...');
  const rfq = await getOrCreateProfilingRFQ();
  console.log(`  RFQ: ${rfq.searchKey} (ID ${rfq.id})`);

  // Step 3: Add lines to RFQ
  console.log('');
  console.log('Step 3: Adding lines to RFQ...');
  const lineResult = await addRFQLines(rfq.id, mpns);
  console.log(`  Added ${lineResult.added} lines (${lineResult.skipped} already present)`);

  if (skipNc) {
    console.log('');
    console.log('SKIP-NC: Skipping NetComponents scrape');
    return { mpnsFound: mpns.length, linesAdded: lineResult.added, vqsWritten: 0, rfq };
  }

  // Step 4: Run NC scraper
  console.log('');
  console.log('Step 4: Running NetComponents scraper (check-only)...');
  let scraperResult;
  try {
    scraperResult = await runNCScraper(rfq.searchKey, limit);
  } catch (e) {
    console.error(`  Scraper failed: ${e.message}`);
    return { mpnsFound: mpns.length, linesAdded: lineResult.added, vqsWritten: 0, error: e.message };
  }

  if (!scraperResult.outputFile) {
    console.error('  No output file found');
    return { mpnsFound: mpns.length, linesAdded: lineResult.added, vqsWritten: 0, error: 'No output file' };
  }

  // Step 5: Load availability VQs
  console.log('');
  console.log('Step 5: Loading availability VQs...');
  const outputPath = path.join(path.dirname(NC_SCRIPT), scraperResult.outputFile);
  const vqResult = await processResults(outputPath, rfq.searchKey, false);
  console.log(`  Written: ${vqResult.written} VQs`);
  console.log(`  Skipped: ${vqResult.skipped} (${vqResult.duplicates} duplicates)`);
  console.log(`  Failed: ${vqResult.failed}`);

  // Step 6: Update watermark
  console.log('');
  console.log('Step 6: Updating watermark...');
  const watermark = updateWatermark(mpns.map(m => m.mpn));
  console.log(`  Total MPNs tracked: ${Object.keys(watermark.mpnsProfiled).length}`);
  console.log(`  Total runs: ${watermark.totalRuns}`);

  console.log('');
  console.log('='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));

  return {
    mpnsFound: mpns.length,
    linesAdded: lineResult.added,
    vqsWritten: vqResult.written,
    vqsSkipped: vqResult.skipped,
    vqsFailed: vqResult.failed,
    rfq
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let limit = DEFAULT_BATCH_SIZE;
  let dryRun = true;
  let skipNc = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--commit') {
      dryRun = false;
    } else if (args[i] === '--skip-nc') {
      skipNc = true;
    } else if (args[i] === '--help') {
      console.log('Usage: node market-profiler.js [options]');
      console.log('');
      console.log('Inventory-based market intelligence scraper. Reads MPNs from the');
      console.log('weekly Infor inventory export (same source as nc-listing.js),');
      console.log('scrapes NC for broker availability, and loads $0 VQs.');
      console.log('');
      console.log('Options:');
      console.log(`  --limit N     Batch size per tick (default: ${DEFAULT_BATCH_SIZE})`);
      console.log('  --dry-run     Preview what would be done (default)');
      console.log('  --commit      Actually run profiling');
      console.log('  --skip-nc     Skip NC scrape (just add RFQ lines)');
      console.log('');
      console.log('This runs in check-only mode - no RFQs are sent to vendors.');
      console.log('');
      console.log('Inventory file location:');
      console.log(`  ${INVENTORY_STORAGE_DIR}/inventory_<week-start>.xlsx`);
      process.exit(0);
    }
  }

  try {
    await runMarketProfiling({ limit, dryRun, skipNc });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runMarketProfiling };
