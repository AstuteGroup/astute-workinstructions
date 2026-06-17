#!/usr/bin/env node
/**
 * Inventory Profiler
 *
 * Profiles inventory MPNs via NetComponents scraping to gather market availability data.
 * Creates weekly RFQs and reconciles "already profiled" status by querying actual VQs.
 *
 * Usage:
 *   node inventory-profiler.js --rate 100 --commit          # Full inventory at 100/hour
 *   node inventory-profiler.js --bucket consignment --rate 50 --commit
 *   node inventory-profiler.js --dry-run                    # Preview what would be profiled
 *
 * Buckets:
 *   all          - All inventory (default)
 *   free-stock   - Astute Electronics Inc (BP 1000332) only
 *   consignment  - All consignment BPs
 *   franchise    - Franchise stock BP
 */

const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

// Shared utilities
const sharedPath = path.join(__dirname, '../../shared');
const { apiPost, apiGet } = require(path.join(sharedPath, 'api-client'));

// NC Python script location
const NC_SCRIPT = path.join(__dirname, '../RFQ Sourcing/netcomponents/python/batch_rfqs_from_system.py');

// Carryover registry location
const CARRYOVER_DIR = path.join(__dirname, '../Inventory File Cleanup/carryover-registry');

// ─── Bucket Definitions ─────────────────────────────────────────────────────

const BUCKETS = {
  'all': {
    name: 'All Inventory',
    bpIds: [1000332, 1000325, 1003236, 1003621, 1005225, 1010966, 1011267]
  },
  'free-stock': {
    name: 'Free Stock',
    bpIds: [1000332]  // Astute Electronics Inc
  },
  'consignment': {
    name: 'Consignment',
    bpIds: [1003236, 1003621, 1005225, 1010966, 1011267]
  },
  'franchise': {
    name: 'Franchise Stock',
    bpIds: [1000325]
  }
};

// Days to consider an MPN "recently profiled" - skip if profiled within this window
const PROFILE_FRESHNESS_DAYS = 14;

// Global flag for full run (ignore recently profiled)
let FULL_RUN = false;

// ─── Database Helpers ───────────────────────────────────────────────────────

function psqlQuery(sql) {
  try {
    const out = execFileSync('psql', ['-AtX', '-c', sql], { encoding: 'utf8' });
    return out.trim() || null;
  } catch (e) {
    return null;
  }
}

function psqlQueryRows(sql) {
  try {
    const out = execFileSync('psql', ['-At', '-F', '|', '-X', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error('  DB query failed:', e.message);
    return [];
  }
}

// ─── Inventory Reading ──────────────────────────────────────────────────────

/**
 * Get inventory MPNs for a given bucket
 */
function getInventoryMPNs(bucket) {
  const config = BUCKETS[bucket];
  if (!config) throw new Error(`Unknown bucket: ${bucket}`);

  console.log(`  Querying inventory for bucket: ${config.name}`);
  console.log(`  BPs: ${config.bpIds.join(', ')}`);

  const bpList = config.bpIds.join(', ');
  const sql = `
    WITH all_mpns AS (
      SELECT ol.chuboe_mpn as mpn, ol.qty
      FROM adempiere.chuboe_offer o
      JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
      WHERE o.c_bpartner_id IN (${bpList})
        AND o.isactive = 'Y'
        AND ol.isactive = 'Y'
        AND ol.chuboe_mpn IS NOT NULL
        AND ol.chuboe_mpn <> ''
      UNION ALL
      SELECT olm.chuboe_mpn as mpn, ol.qty
      FROM adempiere.chuboe_offer o
      JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
      JOIN adempiere.chuboe_offer_line_mpn olm ON ol.chuboe_offer_line_id = olm.chuboe_offer_line_id
      WHERE o.c_bpartner_id IN (${bpList})
        AND o.isactive = 'Y'
        AND ol.isactive = 'Y'
        AND olm.chuboe_mpn IS NOT NULL
        AND olm.chuboe_mpn <> ''
    )
    SELECT mpn, SUM(qty) as total_qty
    FROM all_mpns
    GROUP BY mpn
    HAVING SUM(qty) > 0
    ORDER BY total_qty DESC
  `;

  const rows = psqlQueryRows(sql);
  console.log(`  Inventory MPNs from OT: ${rows.length}`);

  const mpnQtyMap = {};
  for (const row of rows) {
    const [mpn, qty] = row.split('|');
    const key = mpn.toUpperCase();
    mpnQtyMap[key] = { mpn, qty: parseInt(qty, 10) || 0 };
  }

  // Add carryover MPNs (if bucket is 'all')
  if (bucket === 'all') {
    const carryoverMPNs = loadCarryoverMPNs();
    let carryoverNew = 0;
    for (const item of carryoverMPNs) {
      const key = item.mpn.toUpperCase();
      if (!mpnQtyMap[key]) {
        mpnQtyMap[key] = item;
        carryoverNew++;
      }
    }
    console.log(`  Carryover MPNs added: ${carryoverNew}`);
  }

  return Object.values(mpnQtyMap).sort((a, b) => b.qty - a.qty);
}

function loadCarryoverMPNs() {
  if (!fs.existsSync(CARRYOVER_DIR)) return [];

  const mpnQtyMap = {};
  const files = fs.readdirSync(CARRYOVER_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CARRYOVER_DIR, file), 'utf8'));
      for (const line of (data.lines || [])) {
        const mpn = String(line.MPN || line.mpn || '').trim();
        if (!mpn) continue;
        const qty = parseInt(line.Qty || line.qty || 1, 10);
        const key = mpn.toUpperCase();
        if (!mpnQtyMap[key]) mpnQtyMap[key] = { mpn, qty: 0 };
        mpnQtyMap[key].qty += qty;
      }
    } catch (e) {
      // Skip invalid files
    }
  }

  return Object.values(mpnQtyMap);
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Get MPNs that have been profiled recently (have $0 VQs from profile RFQs)
 * This reconciles across ALL profile RFQs, not just the current week.
 */
function getRecentlyProfiledMPNs() {
  console.log(`  Checking for MPNs profiled in last ${PROFILE_FRESHNESS_DAYS} days...`);

  const sql = `
    SELECT DISTINCT UPPER(v.chuboe_mpn_clean) as mpn
    FROM adempiere.chuboe_vq_line v
    JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = v.chuboe_rfq_id
    WHERE v.cost = 0
      AND v.isactive = 'Y'
      AND v.created > NOW() - INTERVAL '${PROFILE_FRESHNESS_DAYS} days'
      AND (r.description LIKE 'Stock Profiling%' OR r.description LIKE 'Inventory Profile%')
  `;

  const rows = psqlQueryRows(sql);
  const profiled = new Set(rows.map(r => r.trim().toUpperCase()));
  console.log(`  Recently profiled MPNs: ${profiled.size}`);
  return profiled;
}

/**
 * Filter inventory to just unprofiled MPNs (unless FULL_RUN)
 */
function getUnprofiledMPNs(bucket) {
  const inventory = getInventoryMPNs(bucket);

  if (FULL_RUN) {
    console.log(`  FULL RUN: Profiling all ${inventory.length} MPNs (ignoring previous profiles)`);
    return inventory;
  }

  const profiled = getRecentlyProfiledMPNs();

  const unprofiled = inventory.filter(item => {
    const clean = item.mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return !profiled.has(clean);
  });

  console.log(`  Unprofiled MPNs: ${unprofiled.length}`);
  return unprofiled;
}

// ─── RFQ Management ─────────────────────────────────────────────────────────

/**
 * Get week string for RFQ naming
 */
function getWeekString() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get or create this week's profiling RFQ
 */
async function getOrCreateProfilingRFQ() {
  const weekStr = getWeekString();
  const description = `Inventory Profile ${weekStr}`;

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
    console.log(`  Using existing RFQ: ${value} (${description})`);
    return { searchKey: value, id: parseInt(id, 10), description, isNew: false };
  }

  // Create new RFQ
  console.log(`  Creating new RFQ: ${description}`);
  const payload = {
    C_BPartner_ID: 1000332,        // Astute Electronics Inc
    Chuboe_RFQ_Type_ID: 1000007,   // Stock
    SalesRep_ID: 1000004,          // Jake Harris
    R_Status_ID: 1000022,          // New
    Description: description
  };

  const result = await apiPost('chuboe_rfq', payload);
  const searchKey = result.Value || result.value;
  console.log(`  Created RFQ: ${searchKey}`);
  return { searchKey, id: result.id, description, isNew: true };
}

/**
 * Add MPNs to RFQ as lines (skips duplicates)
 */
async function addRFQLines(rfqId, mpns, progressCallback) {
  // Get existing MPNs in this RFQ
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
  const maxLine = parseInt(psqlQuery(`
    SELECT COALESCE(MAX(line), 0)
    FROM adempiere.chuboe_rfq_line
    WHERE chuboe_rfq_id = ${rfqId}
  `), 10) || 0;

  let nextLine = maxLine;
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < mpns.length; i++) {
    const item = mpns[i];

    if (existingMpns.has(item.mpn.toUpperCase())) {
      skipped++;
      continue;
    }

    nextLine += 10;

    try {
      const lineResult = await apiPost('chuboe_rfq_line', {
        Chuboe_RFQ_ID: rfqId,
        Line: nextLine,
        Qty: item.qty
      });

      await apiPost('chuboe_rfq_line_mpn', {
        Chuboe_RFQ_Line_ID: lineResult.id,
        Chuboe_RFQ_ID: rfqId,
        Chuboe_MPN: item.mpn,
        Chuboe_MPN_Clean: item.mpn.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        Qty: item.qty
      });

      added++;

      if (progressCallback && added % 100 === 0) {
        progressCallback(added, mpns.length - skipped);
      }
    } catch (e) {
      console.error(`  Failed to add ${item.mpn}: ${e.message}`);
    }
  }

  return { added, skipped, total: existingMpns.size + added };
}

// ─── NC Scraper ─────────────────────────────────────────────────────────────

/**
 * Get count of already-scraped lines for this RFQ
 */
function getScrapedCount(rfqId) {
  const sql = `
    SELECT COUNT(DISTINCT rlm.chuboe_rfq_line_mpn_id)
    FROM adempiere.chuboe_rfq_line_mpn rlm
    JOIN adempiere.chuboe_vq_line v ON v.chuboe_rfq_id = rlm.chuboe_rfq_id
      AND v.chuboe_mpn_clean = rlm.chuboe_mpn_clean
    WHERE rlm.chuboe_rfq_id = ${rfqId}
      AND rlm.isactive = 'Y'
      AND v.cost = 0
      AND v.isactive = 'Y'
  `;
  return parseInt(psqlQuery(sql), 10) || 0;
}

/**
 * Get total line count for RFQ
 */
function getRFQLineCount(rfqId) {
  const sql = `
    SELECT COUNT(*)
    FROM adempiere.chuboe_rfq_line_mpn rlm
    WHERE rlm.chuboe_rfq_id = ${rfqId}
      AND rlm.isactive = 'Y'
  `;
  return parseInt(psqlQuery(sql), 10) || 0;
}

/**
 * Run NC scraper with rate limiting
 */
function runNCScraper(rfqNumber, batchSize, offset = 0) {
  const args = ['--check-only'];
  if (offset > 0) args.push('--offset', String(offset));
  if (batchSize > 0) args.push('--limit', String(batchSize));
  args.push(rfqNumber);

  console.log(`  Running: python3 batch_rfqs_from_system.py ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [NC_SCRIPT, ...args], {
      cwd: path.dirname(NC_SCRIPT),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      // Find output file from stdout
      const match = stdout.match(/Results saved to: (.+\.xlsx)/) ||
                    stdout.match(/Output file: (.+\.xlsx)/);
      const outputFile = match ? match[1] : null;

      if (code === 0 || stdout.includes('Processing 0 line items')) {
        resolve({ success: true, outputFile, stdout, stderr, code });
      } else {
        // Don't reject on division by zero - it just means batch was empty
        if (stderr.includes('ZeroDivisionError')) {
          resolve({ success: true, outputFile: null, stdout, stderr, code, empty: true });
        } else {
          reject(new Error(`NC scraper exited with code ${code}`));
        }
      }
    });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let bucket = 'all';
  let rate = 50;        // MPNs per hour
  let dryRun = true;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bucket' && args[i + 1]) {
      bucket = args[++i];
    } else if (args[i] === '--rate' && args[i + 1]) {
      rate = parseInt(args[++i], 10);
    } else if (args[i] === '--commit') {
      dryRun = false;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--full') {
      FULL_RUN = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      help = true;
    }
  }

  if (help) {
    console.log(`
Inventory Profiler - NC market availability scraper

Usage: node inventory-profiler.js [options]

Options:
  --bucket BUCKET   Inventory bucket to profile (default: all)
                    Buckets: all, free-stock, consignment, franchise
  --rate N          MPNs per hour (default: 50)
  --full            Profile ALL inventory, ignore recently profiled
  --dry-run         Preview mode, don't actually scrape (default)
  --commit          Actually run the scraper
  --help            Show this help

Examples:
  node inventory-profiler.js --dry-run
  node inventory-profiler.js --rate 100 --commit
  node inventory-profiler.js --bucket consignment --rate 50 --commit
`);
    process.exit(0);
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('INVENTORY PROFILER');
  console.log('='.repeat(70));
  console.log(`Mode:        ${dryRun ? 'DRY-RUN' : 'COMMIT'}${FULL_RUN ? ' (FULL RUN)' : ''}`);
  console.log(`Bucket:      ${bucket} (${BUCKETS[bucket]?.name || 'unknown'})`);
  console.log(`Rate:        ${rate} MPNs/hour`);
  if (FULL_RUN) {
    console.log(`Freshness:   DISABLED - profiling ALL inventory`);
  } else {
    console.log(`Freshness:   Skip if profiled in last ${PROFILE_FRESHNESS_DAYS} days`);
  }
  console.log('='.repeat(70));
  console.log('');

  // Step 1: Get unprofiled inventory
  console.log('Step 1: Getting unprofiled inventory...');
  const unprofiled = getUnprofiledMPNs(bucket);

  if (unprofiled.length === 0) {
    console.log('\nNo unprofiled MPNs found. Nothing to do.');
    process.exit(0);
  }

  // Calculate timing
  const totalHours = unprofiled.length / rate;
  const estCompletion = new Date(Date.now() + totalHours * 60 * 60 * 1000);

  console.log('');
  console.log(`To profile: ${unprofiled.length} MPNs`);
  console.log(`At ${rate}/hour: ~${totalHours.toFixed(1)} hours`);
  console.log(`Est. completion: ${estCompletion.toISOString()}`);
  console.log('');

  if (dryRun) {
    console.log('DRY-RUN: Would profile these MPNs (top 20):');
    for (const item of unprofiled.slice(0, 20)) {
      console.log(`  ${item.mpn} (${item.qty.toLocaleString()} pcs)`);
    }
    if (unprofiled.length > 20) {
      console.log(`  ... and ${unprofiled.length - 20} more`);
    }
    console.log('');
    console.log('Run with --commit to actually profile.');
    process.exit(0);
  }

  // Step 2: Get or create RFQ
  console.log('Step 2: Getting/creating profiling RFQ...');
  const rfq = await getOrCreateProfilingRFQ();
  console.log(`  RFQ: ${rfq.searchKey} (ID ${rfq.id})`);

  // Step 3: Add lines to RFQ
  console.log('');
  console.log('Step 3: Adding lines to RFQ...');
  const lineResult = await addRFQLines(rfq.id, unprofiled, (added, total) => {
    console.log(`  Progress: ${added}/${total} lines added...`);
  });
  console.log(`  Added: ${lineResult.added}, Skipped (already in RFQ): ${lineResult.skipped}`);
  console.log(`  Total lines in RFQ: ${lineResult.total}`);

  // Step 4: Run scraper in batches
  console.log('');
  console.log('Step 4: Running NC scraper...');

  const totalLines = getRFQLineCount(rfq.id);
  let scraped = getScrapedCount(rfq.id);
  const batchSize = Math.ceil(rate / 6);  // Run every 10 minutes, ~6 times per hour
  const delayMs = 10 * 60 * 1000;         // 10 minutes between batches

  console.log(`  Total lines: ${totalLines}`);
  console.log(`  Already scraped: ${scraped}`);
  console.log(`  Batch size: ${batchSize} (running every 10 min)`);
  console.log('');

  while (scraped < totalLines) {
    const remaining = totalLines - scraped;
    const thisBatch = Math.min(batchSize, remaining);

    console.log(`\n[${new Date().toISOString()}] Batch: ${scraped + 1}-${scraped + thisBatch} of ${totalLines}`);

    try {
      const result = await runNCScraper(rfq.searchKey, thisBatch, scraped);

      if (result.empty) {
        console.log('  Batch was empty, checking progress...');
      }

      // Recheck scraped count
      const newScraped = getScrapedCount(rfq.id);
      if (newScraped > scraped) {
        scraped = newScraped;
        console.log(`  Progress: ${scraped}/${totalLines} (${Math.round(scraped/totalLines*100)}%)`);
      } else {
        // No progress, might be stuck - increment offset anyway
        scraped += thisBatch;
        console.log(`  Offset advanced to ${scraped}`);
      }

    } catch (e) {
      console.error(`  Scraper error: ${e.message}`);
      console.log('  Waiting 5 minutes before retry...');
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      continue;
    }

    // Wait before next batch (unless we're done)
    if (scraped < totalLines) {
      const remaining = totalLines - scraped;
      const eta = new Date(Date.now() + (remaining / rate) * 60 * 60 * 1000);
      console.log(`  Waiting 10 min... ETA: ${eta.toISOString()}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('PROFILING COMPLETE');
  console.log('='.repeat(70));
  console.log(`RFQ: ${rfq.searchKey}`);
  console.log(`MPNs profiled: ${totalLines}`);
  console.log(`Bucket: ${bucket}`);
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
