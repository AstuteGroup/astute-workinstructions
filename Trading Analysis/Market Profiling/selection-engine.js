#!/usr/bin/env node
/**
 * Selection Engine for Active Sourcing
 *
 * Selects priority MPNs from inventory for price-checking via NetComponents.
 *
 * Priority hierarchy:
 * 1. Top-requested MPNs (most RFQ hits in last 90 days)
 * 2. High-end MFRs (ADI, TI, Intel, Maxim, etc.)
 * 3. Shortage RFQ MPNs (customer specifically asked)
 * 4. Rotation through remaining inventory
 *
 * Usage:
 *   node selection-engine.js --limit 200 --dry-run
 *   node selection-engine.js --limit 200 --output active-sourcing-batch.json
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// ─── Configuration ─────────────────────────────────────────────────────────

// Default batch size
const DEFAULT_LIMIT = 200;

// Selection modes based on day of week:
// - 'monday': Skip top-requested MPNs (don't delist hot parts early in week
//             when customer RFQ activity is running). Focus on high-value MFRs
//             and inventory rotation.
// - 'thursday': Include top-requested MPNs (midweek, safe to price-check hot parts)
const SELECTION_MODES = {
  monday: { includeTopRequested: false },
  thursday: { includeTopRequested: true },
  default: { includeTopRequested: true }
};

// High-value MFRs to prioritize
const HIGH_VALUE_MFRS = [
  'ANALOG DEVICES', 'ADI', 'LINEAR TECHNOLOGY', 'LINEAR TECH', 'MAXIM',
  'TEXAS INSTRUMENTS', 'TI', 'INTEL', 'XILINX', 'AMD',
  'BROADCOM', 'NVIDIA', 'QUALCOMM', 'INFINEON', 'NXP',
  'MICROCHIP', 'ATMEL', 'RENESAS', 'ON SEMICONDUCTOR', 'ONSEMI',
  'ST MICROELECTRONICS', 'STM', 'MICRON', 'SAMSUNG', 'HYNIX',
  'MURATA', 'TDK', 'VISHAY', 'AVX', 'KEMET'
];

// How far back to look for RFQ hits
const RFQ_WINDOW_DAYS = 90;

// MPNs profiled within this window are skipped
const PROFILE_SKIP_DAYS = 14;

// ─── Database Queries ──────────────────────────────────────────────────────

function psqlQuery(sql) {
  try {
    const out = execFileSync('psql', ['-At', '-c', sql], { encoding: 'utf8' });
    return out.trim();
  } catch (e) {
    return '';
  }
}

function psqlQueryRows(sql) {
  try {
    // Increase maxBuffer to handle large result sets (84k+ inventory rows)
    const out = execFileSync('psql', ['-At', '-F', '|', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error(`  SQL error: ${e.message}`);
    if (e.stderr) console.error(`  stderr: ${e.stderr.toString().slice(0, 200)}`);
    return [];
  }
}

// BPs that represent Astute's actual inventory
// Must match WAREHOUSE_WRITEBACK from inventory_cleanup.js exactly.
// BP 1000363 "Astute Group" contains stale 2024 data - do NOT include.
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
 * Get all inventory MPNs with basic info.
 * Only pulls from Astute's actual stock offers (~5k MPNs), not all offers (~39k).
 */
function getInventoryMPNs() {
  const bpList = STOCK_BP_IDS.join(', ');
  const sql = `
    SELECT
      ol.chuboe_mpn,
      UPPER(COALESCE(ol.chuboe_mfr_text, '')) as mfr,
      SUM(ol.qty) as total_qty
    FROM adempiere.chuboe_offer o
    JOIN adempiere.chuboe_offer_line ol ON o.chuboe_offer_id = ol.chuboe_offer_id
    WHERE o.c_bpartner_id IN (${bpList})
      AND o.isactive = 'Y'
      AND ol.isactive = 'Y'
      AND ol.chuboe_mpn IS NOT NULL
      AND LENGTH(ol.chuboe_mpn) > 0
    GROUP BY ol.chuboe_mpn, UPPER(COALESCE(ol.chuboe_mfr_text, ''))
    HAVING SUM(ol.qty) > 0
    ORDER BY total_qty DESC
  `;
  const rows = psqlQueryRows(sql);
  return rows.map(r => {
    const [mpn, mfr, qty] = r.split('|');
    return { mpn, mfr, qty: parseInt(qty, 10) || 0 };
  });
}

/**
 * Get MPNs with most Stock RFQ hits in last N days.
 * "Hot parts" = parts customers are actively requesting via stockrfq@ inbox.
 * Only counts Stock RFQs (type 1000007), not Shortage/PPV/internal RFQs.
 */
function getTopRequestedMPNs(limit = 100) {
  const sql = `
    SELECT
      rlm.chuboe_mpn,
      COUNT(DISTINCT r.chuboe_rfq_id) as rfq_count,
      MAX(r.created) as last_rfq
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND r.chuboe_rfq_type_id = 1000007  -- Stock RFQs only
      AND r.created > NOW() - INTERVAL '${RFQ_WINDOW_DAYS} days'
      AND rlm.chuboe_mpn IS NOT NULL
    GROUP BY rlm.chuboe_mpn
    HAVING COUNT(DISTINCT r.chuboe_rfq_id) >= 2
    ORDER BY rfq_count DESC, last_rfq DESC
    LIMIT ${limit}
  `;
  const rows = psqlQueryRows(sql);
  return rows.map(r => {
    const [mpn, count, lastRfq] = r.split('|');
    return { mpn, rfqCount: parseInt(count, 10), lastRfq };
  });
}

/**
 * Get MPNs from shortage RFQs (type = 1000000)
 */
function getShortageMPNs(limit = 50) {
  const sql = `
    SELECT DISTINCT
      rlm.chuboe_mpn,
      r.created as rfq_date
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE r.isactive = 'Y'
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND r.chuboe_rfq_type_id = 1000000
      AND r.created > NOW() - INTERVAL '30 days'
      AND rlm.chuboe_mpn IS NOT NULL
    ORDER BY r.created DESC
    LIMIT ${limit}
  `;
  const rows = psqlQueryRows(sql);
  return rows.map(r => {
    const [mpn, rfqDate] = r.split('|');
    return { mpn, rfqDate };
  });
}

/**
 * Get MPNs recently profiled (to skip)
 */
function getRecentlyProfiledMPNs() {
  // Check for availability VQs (cost = 0) in the last N days
  const sql = `
    SELECT DISTINCT chuboe_mpn
    FROM adempiere.chuboe_vq_line
    WHERE isactive = 'Y'
      AND cost = 0
      AND created > NOW() - INTERVAL '${PROFILE_SKIP_DAYS} days'
      AND chuboe_note_user LIKE '%Market profile%'
  `;
  const rows = psqlQueryRows(sql);
  return new Set(rows);
}

/**
 * Get MPNs currently in exclusion list (being price-checked)
 */
function getCurrentlyExcludedMPNs() {
  const exclusionPath = path.join(__dirname, '../../.sourcing-exclusions.json');
  if (!fs.existsSync(exclusionPath)) return new Set();

  try {
    const data = JSON.parse(fs.readFileSync(exclusionPath, 'utf8'));
    return new Set(data.mpns || []);
  } catch (e) {
    return new Set();
  }
}

// ─── Selection Logic ───────────────────────────────────────────────────────

/**
 * Check if MFR is high-value
 */
function isHighValueMfr(mfr) {
  if (!mfr) return false;
  const upper = mfr.toUpperCase();
  return HIGH_VALUE_MFRS.some(hv => upper.includes(hv));
}

/**
 * Select priority MPNs for active sourcing
 *
 * @param {number} limit - Max MPNs to select
 * @param {string} mode - 'monday' | 'thursday' | 'default'
 *   monday: Skip top-requested (don't delist hot parts early week)
 *   thursday: Include top-requested (midweek price-check is safe)
 */
function selectPriorityMPNs(limit = DEFAULT_LIMIT, mode = 'default') {
  const modeConfig = SELECTION_MODES[mode] || SELECTION_MODES.default;

  console.log('Loading data...');
  console.log(`  Mode: ${mode} (includeTopRequested: ${modeConfig.includeTopRequested})`);

  // Load all data sources
  const inventory = getInventoryMPNs();
  console.log(`  Inventory: ${inventory.length} unique MPNs`);

  let topRequested = [];
  if (modeConfig.includeTopRequested) {
    topRequested = getTopRequestedMPNs(Math.ceil(limit * 0.4));
    console.log(`  Top requested: ${topRequested.length} MPNs with 2+ RFQs`);
  } else {
    console.log(`  Top requested: SKIPPED (${mode} mode - preserving hot parts for customer RFQs)`);
  }

  const shortage = getShortageMPNs(Math.ceil(limit * 0.2));
  console.log(`  Shortage RFQs: ${shortage.length} MPNs`);

  const recentlyProfiled = getRecentlyProfiledMPNs();
  console.log(`  Recently profiled: ${recentlyProfiled.size} MPNs (skipping)`);

  const excluded = getCurrentlyExcludedMPNs();
  console.log(`  Currently excluded: ${excluded.size} MPNs`);

  // Build inventory lookup for qty/mfr
  const inventoryMap = new Map();
  for (const item of inventory) {
    const key = item.mpn.toUpperCase();
    if (!inventoryMap.has(key)) {
      inventoryMap.set(key, item);
    }
  }

  // Track selected MPNs
  const selected = [];
  const seen = new Set();

  function addMPN(mpn, source, priority, metadata = {}) {
    const key = mpn.toUpperCase();
    if (seen.has(key)) return false;
    if (recentlyProfiled.has(key) || recentlyProfiled.has(mpn)) return false;
    if (excluded.has(key) || excluded.has(mpn)) return false;

    // Must be in inventory
    const inv = inventoryMap.get(key);
    if (!inv) return false;

    seen.add(key);
    selected.push({
      mpn: inv.mpn, // Use inventory's casing
      mfr: inv.mfr,
      qty: inv.qty,
      source,
      priority,
      ...metadata
    });
    return true;
  }

  console.log('\nSelecting priority MPNs...');

  // Priority 1: Top-requested MPNs in inventory (Thursday only)
  let added = 0;
  if (modeConfig.includeTopRequested) {
    for (const item of topRequested) {
      if (selected.length >= limit) break;
      if (addMPN(item.mpn, 'top_requested', 1, { rfqCount: item.rfqCount })) {
        added++;
      }
    }
    console.log(`  Priority 1 (top requested): ${added} added`);
  } else {
    console.log(`  Priority 1 (top requested): SKIPPED`);
  }

  // Priority 2: High-value MFRs from inventory
  added = 0;
  const highValueItems = inventory
    .filter(i => isHighValueMfr(i.mfr))
    .sort((a, b) => b.qty - a.qty);
  for (const item of highValueItems) {
    if (selected.length >= limit) break;
    if (addMPN(item.mpn, 'high_value_mfr', 2)) {
      added++;
    }
  }
  console.log(`  Priority 2 (high-value MFR): ${added} added`);

  // Priority 3: Shortage RFQs
  added = 0;
  for (const item of shortage) {
    if (selected.length >= limit) break;
    if (addMPN(item.mpn, 'shortage', 3)) {
      added++;
    }
  }
  console.log(`  Priority 3 (shortage): ${added} added`);

  // Priority 4: Fill remaining with high-qty inventory rotation
  added = 0;
  for (const item of inventory) {
    if (selected.length >= limit) break;
    if (addMPN(item.mpn, 'inventory_rotation', 4)) {
      added++;
    }
  }
  console.log(`  Priority 4 (rotation): ${added} added`);

  return selected;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let limit = DEFAULT_LIMIT;
  let outputPath = null;
  let dryRun = true;
  let mode = 'default';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1];
      dryRun = false;
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--help') {
      console.log('Usage: node selection-engine.js [options]');
      console.log('');
      console.log('Options:');
      console.log('  --limit N      Number of MPNs to select (default: 200)');
      console.log('  --mode MODE    Selection mode: monday | thursday | default');
      console.log('                   monday: Skip hot parts (early week customer RFQs)');
      console.log('                   thursday: Include hot parts (midweek price-check)');
      console.log('  --output FILE  Write selection to JSON file');
      console.log('  --dry-run      Preview selection without writing (default)');
      console.log('');
      console.log('Examples:');
      console.log('  node selection-engine.js --limit 200 --dry-run');
      console.log('  node selection-engine.js --limit 200 --mode monday --output batch.json');
      process.exit(0);
    }
  }

  console.log('='.repeat(60));
  console.log('Active Sourcing Selection Engine');
  console.log('='.repeat(60));
  console.log(`Target: ${limit} MPNs`);
  console.log(`Selection mode: ${mode}`);
  console.log(`Output: ${dryRun ? 'DRY-RUN (preview)' : outputPath}`);
  console.log('='.repeat(60));
  console.log('');

  // Run selection
  const selected = selectPriorityMPNs(limit, mode);

  console.log('');
  console.log('='.repeat(60));
  console.log('SELECTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Selected: ${selected.length} MPNs`);

  // Breakdown by source
  const bySource = {};
  for (const item of selected) {
    bySource[item.source] = (bySource[item.source] || 0) + 1;
  }
  console.log('By source:');
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source}: ${count}`);
  }

  // Total qty
  const totalQty = selected.reduce((sum, item) => sum + item.qty, 0);
  console.log(`Total inventory qty: ${totalQty.toLocaleString()} pcs`);
  console.log('='.repeat(60));

  // Show sample
  console.log('');
  console.log('Sample (first 10):');
  for (const item of selected.slice(0, 10)) {
    const meta = item.rfqCount ? ` (${item.rfqCount} RFQs)` : '';
    console.log(`  [P${item.priority}] ${item.mpn} - ${item.mfr || 'N/A'} - ${item.qty.toLocaleString()} pcs${meta}`);
  }

  // Output to file
  if (outputPath) {
    const output = {
      timestamp: new Date().toISOString(),
      count: selected.length,
      mpns: selected.map(s => ({
        mpn: s.mpn,
        mfr: s.mfr,
        qty: s.qty,
        source: s.source,
        priority: s.priority
      }))
    };
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log('');
    console.log(`Written to: ${outputPath}`);
  }
}

main();
