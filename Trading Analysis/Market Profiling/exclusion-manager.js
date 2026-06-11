#!/usr/bin/env node
/**
 * Exclusion Manager for Active Sourcing
 *
 * Tracks MPNs that should be temporarily excluded from NetComponents uploads
 * during active sourcing price-checks. This hides our inventory from competitors
 * while we gather pricing from brokers.
 *
 * Key behaviors:
 * - Exclusions automatically expire after 7 days
 * - Only affects NetComponents CSV generation (NOT OT inventory offers)
 * - Batch ID allows managing sets of exclusions together
 *
 * Usage:
 *   node exclusion-manager.js list
 *   node exclusion-manager.js add --mpns "MPN1,MPN2" --batch "AS-2026-06-03"
 *   node exclusion-manager.js add --file batch.json --batch "AS-2026-06-03"
 *   node exclusion-manager.js remove --mpns "MPN1"
 *   node exclusion-manager.js clear --batch "AS-2026-06-03"
 *   node exclusion-manager.js cleanup   # Remove expired entries
 */

const path = require('path');
const fs = require('fs');

// ─── Configuration ─────────────────────────────────────────────────────────

// Exclusion file location (in workspace root, same level as inventory_cleanup reads)
const EXCLUSION_FILE = path.join(process.env.HOME, 'workspace/.sourcing-exclusions.json');

// How long exclusions remain active (days)
const EXCLUSION_TTL_DAYS = 7;

// ─── Data Structure ────────────────────────────────────────────────────────

/**
 * Exclusion file schema:
 * {
 *   version: 1,
 *   updated: "2026-06-03T14:30:00Z",
 *   entries: [
 *     {
 *       mpn: "MAX3232CSE+T",
 *       batch: "AS-2026-06-03",
 *       addedAt: "2026-06-03T08:00:00Z",
 *       expiresAt: "2026-06-10T08:00:00Z"
 *     }
 *   ]
 * }
 */

function loadExclusions() {
  if (!fs.existsSync(EXCLUSION_FILE)) {
    return { version: 1, updated: new Date().toISOString(), entries: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUSION_FILE, 'utf8'));
    return {
      version: data.version || 1,
      updated: data.updated || new Date().toISOString(),
      entries: data.entries || []
    };
  } catch (e) {
    console.error(`Warning: Failed to load exclusions: ${e.message}`);
    return { version: 1, updated: new Date().toISOString(), entries: [] };
  }
}

function saveExclusions(data) {
  data.updated = new Date().toISOString();
  fs.writeFileSync(EXCLUSION_FILE, JSON.stringify(data, null, 2));
}

// ─── Operations ────────────────────────────────────────────────────────────

/**
 * List all current exclusions
 */
function listExclusions(showExpired = false) {
  const data = loadExclusions();
  const now = new Date();

  // Filter by expiration
  const entries = showExpired
    ? data.entries
    : data.entries.filter(e => new Date(e.expiresAt) > now);

  console.log('='.repeat(60));
  console.log('NetComponents Exclusion List');
  console.log('='.repeat(60));
  console.log(`File: ${EXCLUSION_FILE}`);
  console.log(`Total entries: ${data.entries.length}`);
  console.log(`Active (not expired): ${entries.length}`);
  console.log('');

  if (entries.length === 0) {
    console.log('No active exclusions.');
    return;
  }

  // Group by batch
  const byBatch = {};
  for (const e of entries) {
    const batch = e.batch || 'unknown';
    if (!byBatch[batch]) byBatch[batch] = [];
    byBatch[batch].push(e);
  }

  for (const [batch, items] of Object.entries(byBatch)) {
    console.log(`Batch: ${batch} (${items.length} MPNs)`);
    for (const item of items.slice(0, 10)) {
      const expires = new Date(item.expiresAt);
      const daysLeft = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
      const status = daysLeft > 0 ? `expires in ${daysLeft}d` : 'EXPIRED';
      console.log(`  ${item.mpn} - ${status}`);
    }
    if (items.length > 10) {
      console.log(`  ... and ${items.length - 10} more`);
    }
    console.log('');
  }
}

/**
 * Add MPNs to exclusion list
 */
function addExclusions(mpns, batch) {
  const data = loadExclusions();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXCLUSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Build set of existing MPNs for quick lookup
  const existing = new Set(data.entries.map(e => e.mpn.toUpperCase()));

  let added = 0;
  let skipped = 0;

  for (const mpn of mpns) {
    const upperMpn = mpn.toUpperCase();
    if (existing.has(upperMpn)) {
      skipped++;
      continue;
    }

    data.entries.push({
      mpn,
      batch,
      addedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
    existing.add(upperMpn);
    added++;
  }

  saveExclusions(data);

  console.log(`Added ${added} MPNs to exclusion list (${skipped} already present)`);
  console.log(`Batch: ${batch}`);
  console.log(`Expires: ${expiresAt.toISOString().slice(0, 10)}`);

  return { added, skipped };
}

/**
 * Remove specific MPNs from exclusion list
 */
function removeExclusions(mpns) {
  const data = loadExclusions();
  const toRemove = new Set(mpns.map(m => m.toUpperCase()));

  const before = data.entries.length;
  data.entries = data.entries.filter(e => !toRemove.has(e.mpn.toUpperCase()));
  const removed = before - data.entries.length;

  saveExclusions(data);

  console.log(`Removed ${removed} MPNs from exclusion list`);

  return removed;
}

/**
 * Clear all exclusions for a batch
 */
function clearBatch(batch) {
  const data = loadExclusions();

  const before = data.entries.length;
  data.entries = data.entries.filter(e => e.batch !== batch);
  const removed = before - data.entries.length;

  saveExclusions(data);

  console.log(`Cleared batch '${batch}': ${removed} MPNs removed`);

  return removed;
}

/**
 * Remove expired entries
 */
function cleanup() {
  const data = loadExclusions();
  const now = new Date();

  const before = data.entries.length;
  data.entries = data.entries.filter(e => new Date(e.expiresAt) > now);
  const removed = before - data.entries.length;

  saveExclusions(data);

  console.log(`Cleanup: removed ${removed} expired entries`);

  return removed;
}

/**
 * Get active MPNs as a Set (for use by inventory_cleanup)
 */
function getActiveExclusions() {
  const data = loadExclusions();
  const now = new Date();

  const active = data.entries
    .filter(e => new Date(e.expiresAt) > now)
    .map(e => e.mpn.toUpperCase());

  return new Set(active);
}

/**
 * Check if an MPN is excluded
 */
function isExcluded(mpn) {
  const active = getActiveExclusions();
  return active.has(mpn.toUpperCase());
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const result = { command: null, mpns: [], batch: null, file: null, showExpired: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'list' || arg === 'add' || arg === 'remove' || arg === 'clear' || arg === 'cleanup' || arg === 'status') {
      result.command = arg;
    } else if (arg === '--mpns' && args[i + 1]) {
      result.mpns = args[i + 1].split(',').map(m => m.trim()).filter(Boolean);
      i++;
    } else if (arg === '--batch' && args[i + 1]) {
      result.batch = args[i + 1];
      i++;
    } else if (arg === '--file' && args[i + 1]) {
      result.file = args[i + 1];
      i++;
    } else if (arg === '--show-expired') {
      result.showExpired = true;
    }
  }

  return result;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: node exclusion-manager.js <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  list                           List all active exclusions');
    console.log('  add --mpns "MPN1,MPN2" --batch NAME');
    console.log('  add --file batch.json --batch NAME');
    console.log('  remove --mpns "MPN1,MPN2"      Remove specific MPNs');
    console.log('  clear --batch NAME             Clear all MPNs in a batch');
    console.log('  cleanup                        Remove expired entries');
    console.log('  status                         Show summary only');
    console.log('');
    console.log('Options:');
    console.log('  --mpns "A,B,C"    Comma-separated list of MPNs');
    console.log('  --batch NAME      Batch identifier (e.g., AS-2026-06-03)');
    console.log('  --file FILE       JSON file with mpns array');
    console.log('  --show-expired    Include expired entries in list');
    console.log('');
    console.log(`Exclusion file: ${EXCLUSION_FILE}`);
    console.log(`TTL: ${EXCLUSION_TTL_DAYS} days`);
    process.exit(0);
  }

  const opts = parseArgs(args);

  switch (opts.command) {
    case 'list':
      listExclusions(opts.showExpired);
      break;

    case 'status': {
      const data = loadExclusions();
      const now = new Date();
      const active = data.entries.filter(e => new Date(e.expiresAt) > now);
      console.log(`Active exclusions: ${active.length}`);
      console.log(`Total entries: ${data.entries.length}`);
      console.log(`File: ${EXCLUSION_FILE}`);
      break;
    }

    case 'add': {
      if (!opts.batch) {
        console.error('Error: --batch is required for add');
        process.exit(1);
      }

      let mpns = opts.mpns;

      // Load from file if specified
      if (opts.file) {
        if (!fs.existsSync(opts.file)) {
          console.error(`File not found: ${opts.file}`);
          process.exit(1);
        }
        const fileData = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
        // Support both array format and {mpns: [...]} format
        mpns = Array.isArray(fileData)
          ? fileData.map(item => typeof item === 'string' ? item : item.mpn)
          : (fileData.mpns || []).map(item => typeof item === 'string' ? item : item.mpn);
      }

      if (mpns.length === 0) {
        console.error('Error: No MPNs specified. Use --mpns or --file');
        process.exit(1);
      }

      addExclusions(mpns, opts.batch);
      break;
    }

    case 'remove':
      if (opts.mpns.length === 0) {
        console.error('Error: --mpns is required for remove');
        process.exit(1);
      }
      removeExclusions(opts.mpns);
      break;

    case 'clear':
      if (!opts.batch) {
        console.error('Error: --batch is required for clear');
        process.exit(1);
      }
      clearBatch(opts.batch);
      break;

    case 'cleanup':
      cleanup();
      break;

    default:
      console.error(`Unknown command: ${opts.command}`);
      console.log('Run with --help for usage');
      process.exit(1);
  }
}

// Export for use by other modules
module.exports = {
  loadExclusions,
  saveExclusions,
  addExclusions,
  removeExclusions,
  clearBatch,
  cleanup,
  getActiveExclusions,
  isExcluded,
  EXCLUSION_FILE,
  EXCLUSION_TTL_DAYS
};

if (require.main === module) {
  main();
}
