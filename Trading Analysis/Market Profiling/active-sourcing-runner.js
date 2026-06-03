#!/usr/bin/env node
/**
 * Active Sourcing Runner
 *
 * Orchestrates the active sourcing workflow:
 * 1. Run selection engine to pick priority MPNs
 * 2. Add selected MPNs to exclusion list (hide from NC during sourcing)
 * 3. Create Active Sourcing RFQ in OT
 * 4. Run NC scraper in FULL mode (sends RFQ emails to vendors)
 * 5. Load scraped availability as $0 VQs (market profiling)
 * 6. Real pricing comes via VQ Loading workflow over next few days
 *
 * Scheduling: Mon + Thu at 8 AM CT
 *
 * Usage:
 *   node active-sourcing-runner.js --limit 200 --dry-run
 *   node active-sourcing-runner.js --limit 200 --commit
 */

const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

// Shared utilities
const sharedPath = path.join(__dirname, '../../shared');
const { apiPost, apiGet } = require(path.join(sharedPath, 'api-client'));
const logger = require(path.join(sharedPath, 'logger')).createLogger('ActiveSourcing');

// Local modules (we'll require them dynamically to avoid circular deps)

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 200;

// NC Python script location
const NC_SCRIPT = path.join(__dirname, '../RFQ Sourcing/netcomponents/python/batch_rfqs_from_system.py');

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
    const out = execFileSync('psql', ['-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ─── RFQ Management ────────────────────────────────────────────────────────

/**
 * Create Active Sourcing RFQ
 */
async function createActiveSourcingRFQ(batchId) {
  const description = `Active Sourcing ${batchId}`;

  const payload = {
    C_BPartner_ID: 1000000, // Astute Electronics Inc
    Chuboe_RFQ_Type_ID: 1000007, // Stock
    SalesRep_ID: 1000004, // Jake Harris
    R_Status_ID: 1000022, // New
    Description: description
  };

  const result = await apiPost('chuboe_rfq', payload);
  const searchKey = result.Value || result.value;
  logger.info(`Created Active Sourcing RFQ: ${searchKey} (ID ${result.id})`);

  return { searchKey, id: result.id, description };
}

/**
 * Add lines to RFQ
 */
async function addRFQLines(rfqId, mpns) {
  let added = 0;
  let lineNum = 0;

  for (const item of mpns) {
    lineNum += 10;

    try {
      // Create line
      const lineResult = await apiPost('chuboe_rfq_line', {
        Chuboe_RFQ_ID: rfqId,
        Line: lineNum,
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

  return added;
}

/**
 * Run NC scraper (full mode - sends RFQs)
 */
function runNCScraper(rfqNumber, fullMode = true, limit = 0) {
  const args = [];
  if (!fullMode) args.push('--check-only');
  if (limit > 0) args.push('--limit', String(limit));
  args.push(rfqNumber);

  const mode = fullMode ? 'FULL MODE (will send RFQs)' : 'check-only';
  logger.info(`Running NC scraper in ${mode}: python3 batch_rfqs_from_system.py ${args.join(' ')}`);

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
      if (code === 0) {
        const match = stdout.match(/Results saved to: (.+\.xlsx)/);
        const outputFile = match ? match[1] : null;
        resolve({ success: true, outputFile, stdout, stderr });
      } else {
        reject(new Error(`NC scraper exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// ─── Main Orchestrator ─────────────────────────────────────────────────────

async function runActiveSourcing(options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const dryRun = options.dryRun !== false;

  // Generate batch ID
  const now = new Date();
  const batchId = `AS-${now.toISOString().slice(0, 10)}`;

  console.log('='.repeat(60));
  console.log('Active Sourcing Runner');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no RFQs sent)' : 'COMMIT (WILL SEND RFQs)'}`);
  console.log(`Batch: ${batchId}`);
  console.log(`Limit: ${limit} MPNs`);
  console.log('='.repeat(60));

  if (!dryRun) {
    console.log('');
    console.log('*** WARNING: This will send real RFQs to vendors ***');
    console.log('*** Press Ctrl+C within 5 seconds to abort ***');
    await new Promise(r => setTimeout(r, 5000));
    console.log('Proceeding...');
  }

  console.log('');

  // Step 1: Run selection engine
  console.log('Step 1: Running selection engine...');
  const selectionEngine = require('./selection-engine');
  // We need to call the selectPriorityMPNs function directly
  // For now, we'll use a simple implementation that reuses the logic

  // Load functions from selection-engine.js by running it directly
  const selectionResult = execFileSync('node', [
    path.join(__dirname, 'selection-engine.js'),
    '--limit', String(limit),
    '--output', `/tmp/as-selection-${Date.now()}.json`
  ], { encoding: 'utf8' });

  console.log(selectionResult);

  // Find the output file
  const outputMatch = selectionResult.match(/Written to: (.+\.json)/);
  if (!outputMatch) {
    throw new Error('Selection engine did not produce output file');
  }
  const selectionFile = outputMatch[1];
  const selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
  const selectedMpns = selection.mpns || [];

  console.log(`  Selected ${selectedMpns.length} MPNs`);

  if (selectedMpns.length === 0) {
    console.log('  No MPNs selected. Done.');
    return { selected: 0, rfqsSent: 0 };
  }

  if (dryRun) {
    console.log('');
    console.log('DRY-RUN: Would process these MPNs:');
    for (const item of selectedMpns.slice(0, 10)) {
      console.log(`  [P${item.priority}] ${item.mpn} - ${item.qty.toLocaleString()} pcs`);
    }
    if (selectedMpns.length > 10) {
      console.log(`  ... and ${selectedMpns.length - 10} more`);
    }

    // Cleanup temp file
    fs.unlinkSync(selectionFile);

    return { selected: selectedMpns.length, rfqsSent: 0, dryRun: true };
  }

  // Step 2: Add to exclusion list
  console.log('');
  console.log('Step 2: Adding to exclusion list...');
  const exclusionManager = require('./exclusion-manager');
  const mpnsToExclude = selectedMpns.map(m => m.mpn);
  const exclusionResult = exclusionManager.addExclusions(mpnsToExclude, batchId);
  console.log(`  Excluded ${exclusionResult.added} MPNs (${exclusionResult.skipped} already excluded)`);

  // Step 3: Create RFQ
  console.log('');
  console.log('Step 3: Creating Active Sourcing RFQ...');
  const rfq = await createActiveSourcingRFQ(batchId);
  console.log(`  RFQ: ${rfq.searchKey} (ID ${rfq.id})`);

  // Step 4: Add lines to RFQ
  console.log('');
  console.log('Step 4: Adding lines to RFQ...');
  const linesAdded = await addRFQLines(rfq.id, selectedMpns);
  console.log(`  Added ${linesAdded} lines`);

  // Step 5: Run NC scraper (full mode)
  console.log('');
  console.log('Step 5: Running NetComponents scraper (FULL MODE)...');
  let scraperResult;
  try {
    scraperResult = await runNCScraper(rfq.searchKey, true, limit);
  } catch (e) {
    console.error(`  Scraper failed: ${e.message}`);
    return {
      selected: selectedMpns.length,
      rfq,
      linesAdded,
      error: e.message
    };
  }

  // Step 6: Load availability VQs from scraped data
  // The real pricing comes via VQ Loading workflow when vendors respond
  console.log('');
  console.log('Step 6: Loading availability VQs (from scrape data)...');
  if (scraperResult.outputFile) {
    const { processResults } = require('./availability-vq-loader');
    const outputPath = path.join(path.dirname(NC_SCRIPT), scraperResult.outputFile);
    try {
      const vqResult = await processResults(outputPath, rfq.searchKey, false);
      console.log(`  Written: ${vqResult.written} availability VQs`);
    } catch (e) {
      console.warn(`  VQ loading failed: ${e.message}`);
    }
  }

  // Cleanup temp file
  fs.unlinkSync(selectionFile);

  console.log('');
  console.log('='.repeat(60));
  console.log('ACTIVE SOURCING COMPLETE');
  console.log('='.repeat(60));
  console.log(`RFQ: ${rfq.searchKey}`);
  console.log(`Lines: ${linesAdded}`);
  console.log(`Batch: ${batchId} (exclusions will expire in 7 days)`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Monitor VQ Loading for vendor quote responses');
  console.log('2. Exclusions will auto-expire for next inventory upload');
  console.log('='.repeat(60));

  return {
    selected: selectedMpns.length,
    rfq,
    linesAdded,
    batchId
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let limit = DEFAULT_LIMIT;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--commit') {
      dryRun = false;
    } else if (args[i] === '--help') {
      console.log('Usage: node active-sourcing-runner.js [options]');
      console.log('');
      console.log('Options:');
      console.log('  --limit N     Number of MPNs to source (default: 200)');
      console.log('  --dry-run     Preview without sending RFQs (default)');
      console.log('  --commit      Actually run sourcing (WILL SEND RFQs!)');
      console.log('');
      console.log('This runs in FULL mode - RFQs are sent to vendors.');
      console.log('Selected MPNs are excluded from NetComponents uploads');
      console.log('for 7 days to hide inventory during price-check.');
      process.exit(0);
    }
  }

  try {
    await runActiveSourcing({ limit, dryRun });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runActiveSourcing };
