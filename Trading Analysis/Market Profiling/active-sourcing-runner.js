#!/usr/bin/env node
/**
 * Active Sourcing Runner
 *
 * Orchestrates the active sourcing workflow:
 * 1. Run selection engine to pick priority MPNs
 * 2. Add selected MPNs to exclusion list (hide from NC during sourcing)
 * 3. Create Active Sourcing RFQ in OT
 * 4. Add lines to RFQ
 * 5. Enrich with franchise APIs (DigiKey, Mouser, Arrow, etc.) — baseline pricing
 * 6. Run NC scraper in FULL mode (sends RFQ emails to brokers)
 * 7. Load scraped availability as $0 VQs (market profiling)
 * 8. Real pricing comes via VQ Loading workflow over next few days
 *
 * The franchise enrichment step (5) gives buyers baseline pricing context BEFORE
 * going to brokers. This helps evaluate broker quotes against franchise alternatives.
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
const { createNotifier } = require(path.join(sharedPath, 'notifier'));

// Franchise enrichment (DigiKey, Mouser, etc.)
const { enrichRFQ } = require('../RFQ API Enrichment/enrich-rfq');

// Email configuration
const NOTIFICATION_EMAIL = 'jake.harris@astutegroup.com';

// Local modules (we'll require them dynamically to avoid circular deps)

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 200;

// Gate file: Active Sourcing waits for inventory upload confirmation before running.
// Jake forwards/replies to inventory upload email → creates this file → cron can proceed.
// File is consumed (deleted) after successful run.
const INVENTORY_GATE_FILE = path.join(process.env.HOME, 'workspace/.inventory-upload-confirmed');

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
  const forceRun = options.force === true;

  // Gate check: Wait for inventory upload confirmation before sourcing.
  // This ensures we only source parts that are actually listed on NetComponents.
  // Re-enabled 2026-06-11 after shakeout complete.
  if (!forceRun && !fs.existsSync(INVENTORY_GATE_FILE)) {
    console.log('='.repeat(60));
    console.log('Active Sourcing Runner — GATE CLOSED');
    console.log('='.repeat(60));
    console.log('');
    console.log('Waiting for inventory upload confirmation.');
    console.log('');
    console.log('To open the gate:');
    console.log('  1. NetComponents replies with "upload completed" to stockrfq@');
    console.log('  2. OR you forward/send email with "inventory uploaded" in subject');
    console.log('  3. OR run: node active-sourcing-runner.js --gate-open');
    console.log('  4. OR run with --force to bypass');
    console.log('');
    console.log('Gate file: ' + INVENTORY_GATE_FILE);
    console.log('='.repeat(60));
    return { skipped: true, reason: 'gate_closed' };
  }

  // Generate batch ID and determine selection mode based on day of week
  const now = new Date();
  const batchId = `AS-${now.toISOString().slice(0, 10)}`;
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, 4=Thu

  // Monday (1): Skip top-requested to preserve hot parts for customer RFQs
  // Thursday (4): Include top-requested for midweek price-check
  const selectionMode = dayOfWeek === 1 ? 'monday' : dayOfWeek === 4 ? 'thursday' : 'default';

  console.log('='.repeat(60));
  console.log('Active Sourcing Runner');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no RFQs sent)' : 'COMMIT (WILL SEND RFQs)'}`);
  console.log(`Batch: ${batchId}`);
  console.log(`Selection: ${selectionMode} (${selectionMode === 'monday' ? 'skip hot parts' : 'include hot parts'})`);
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
  console.log(`  Selection mode: ${selectionMode}`);

  // Run selection engine with day-appropriate mode
  const selectionResult = execFileSync('node', [
    path.join(__dirname, 'selection-engine.js'),
    '--limit', String(limit),
    '--mode', selectionMode,
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
    // Check if this means first pass is complete
    const { isFirstPassComplete, getQueueStats } = require('./selection-engine');
    if (isFirstPassComplete()) {
      const stats = getQueueStats();
      console.log('');
      console.log('='.repeat(60));
      console.log('🎉 FIRST PASS COMPLETE — ALL DELISTED PARTS SOURCED');
      console.log('='.repeat(60));
      console.log(`Total delisted parts: ${stats.total}`);
      console.log(`All sourced: ${stats.sourced}`);
      console.log('');
      console.log('Phase 2 prioritization can now begin with full pricing data.');
      console.log('='.repeat(60));

      // Send notification email
      try {
        const notifier = createNotifier({
          fromEmail: 'stockrfq@orangetsunami.com',
          fromName: 'Active Sourcing',
          smtpPass: process.env.WORKMAIL_PASS
        });
        await notifier.sendEmail(
          NOTIFICATION_EMAIL,
          'Active Sourcing: First Pass Complete — All Delisted Parts Sourced',
          `All ${stats.total} delisted parts have been sourced.\n\n` +
          `The first pass through the delisted inventory queue is complete.\n\n` +
          `Phase 2 prioritization can now begin with the full pricing data collected.\n\n` +
          `Queue stats:\n` +
          `  - Total parts: ${stats.total}\n` +
          `  - Sourced: ${stats.sourced}\n` +
          `  - Last updated: ${stats.lastUpdated}\n`
        );
        console.log('Notification sent to operator.');
      } catch (e) {
        console.warn(`Could not send notification: ${e.message}`);
      }
    } else {
      console.log('  No MPNs selected (queue empty or all recently sourced).');
    }
    return { selected: 0, rfqsSent: 0, firstPassComplete: isFirstPassComplete() };
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

  // Step 2b: Email delisted parts notification
  console.log('  Sending delisting notification...');
  try {
    const notifier = createNotifier({
      fromEmail: 'stockrfq@orangetsunami.com',
      fromName: 'Active Sourcing',
      smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
    });

    // Build delisting summary
    const delistLines = selectedMpns.map(m =>
      `${m.mpn.padEnd(30)} ${String(m.qty).padStart(12)} pcs  [P${m.priority}] ${m.source || ''}`
    ).join('\n');

    const delistBody = `Active Sourcing Batch: ${batchId}

The following ${selectedMpns.length} parts are being temporarily DELISTED from NetComponents for price-check:

${'MPN'.padEnd(30)} ${'QTY'.padStart(12)}      PRIORITY / SOURCE
${'─'.repeat(70)}
${delistLines}
${'─'.repeat(70)}

These parts will be excluded from NetComponents uploads until the exclusion expires (7 days) or next Monday's inventory upload, whichever comes first.

This is an automated notification from the Active Sourcing workflow.`;

    await notifier.sendEmail(NOTIFICATION_EMAIL, `Active Sourcing Delisting — ${batchId} (${selectedMpns.length} parts)`, delistBody);
    console.log('  Notification sent to ' + NOTIFICATION_EMAIL);
  } catch (e) {
    console.warn(`  Failed to send delisting notification: ${e.message}`);
  }

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

  // Step 5: Franchise API enrichment (DigiKey, Mouser, Arrow, etc.)
  // Get baseline franchise pricing BEFORE going to brokers
  console.log('');
  console.log('Step 5: Enriching with franchise APIs (DigiKey, Mouser, etc.)...');
  let enrichmentResult = null;
  try {
    enrichmentResult = await enrichRFQ(rfq.searchKey, {
      dryRun: false,
      force: false,   // Use cache if fresh
      onProgress: (line, idx, total) => {
        if ((idx + 1) % 25 === 0 || idx === total - 1) {
          process.stderr.write(`  [${idx + 1}/${total}] ${line.mpn}\n`);
        }
      }
    });
    console.log(`  API calls:   ${enrichmentResult.apiCalls}`);
    console.log(`  Cache hits:  ${enrichmentResult.cacheHits}`);
    console.log(`  VQs written: ${enrichmentResult.vqsWritten}`);
    console.log(`  Coverage:    FULL=${enrichmentResult.qtyMatches}  PARTIAL=${enrichmentResult.partialCoverage}  NONE=${enrichmentResult.noCoverage}`);
    if (enrichmentResult.errors.length > 0) {
      console.log(`  Errors: ${enrichmentResult.errors.length} (see log for details)`);
    }
  } catch (e) {
    console.warn(`  Franchise enrichment failed (non-fatal): ${e.message}`);
    console.warn('  Continuing with broker sourcing...');
  }

  // Step 5b: Filter out MPNs with good franchise coverage
  // If franchise has plenty of stock at known price, no need to bother brokers
  let mpnsForBrokers = selectedMpns.length;
  let franchiseSkipped = 0;
  const franchiseCoveredMpns = [];

  if (enrichmentResult && enrichmentResult.qtyMatches > 0) {
    console.log('');
    console.log('Step 5b: Filtering MPNs with good franchise coverage...');

    // Query which MPNs got full franchise coverage
    const coverageQuery = `
      SELECT DISTINCT rlm.chuboe_mpn_clean
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.chuboe_vq_line vq ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vq.c_bpartner_id
      WHERE r.value = '${rfq.searchKey}'
        AND vq.isactive = 'Y'
        AND vq.qty >= rlm.qty
        AND vq.cost > 0
        AND bp.name IN ('Digi-Key Electronics', 'Mouser', 'Arrow Electronics', 'Future Electronics Corporation', 'Newark in One (Element 14)', 'TTI Inc')
    `;

    try {
      const covered = psqlQueryRows(coverageQuery);
      if (covered.length > 0) {
        franchiseCoveredMpns.push(...covered);
        franchiseSkipped = covered.length;
        mpnsForBrokers = selectedMpns.length - franchiseSkipped;

        console.log(`  Franchise-covered (skipping broker RFQ): ${franchiseSkipped} MPNs`);
        console.log(`  Sending to brokers: ${mpnsForBrokers} MPNs`);

        // Log a few examples
        if (covered.length <= 5) {
          covered.forEach(mpn => console.log(`    - ${mpn} (franchise has full qty)`));
        } else {
          covered.slice(0, 3).forEach(mpn => console.log(`    - ${mpn} (franchise has full qty)`));
          console.log(`    ... and ${covered.length - 3} more`);
        }
      } else {
        console.log('  No MPNs with full franchise coverage - all going to brokers');
      }
    } catch (e) {
      console.warn(`  Coverage query failed: ${e.message} - sending all to brokers`);
    }
  }

  // Step 6: Run NC scraper (full mode)
  console.log('');
  console.log('Step 6: Running NetComponents scraper (FULL MODE)...');
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

  // Step 7: Load availability VQs from scraped data
  // The real pricing comes via VQ Loading workflow when vendors respond
  console.log('');
  console.log('Step 7: Loading availability VQs (from scrape data)...');
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

  // Step 8: Mark selected MPNs as sourced in delisted queue
  console.log('');
  console.log('Step 8: Marking MPNs as sourced in delisted queue...');
  const { markAsSourced, getQueueStats } = require('./selection-engine');
  const sourcedMpns = selectedMpns.map(m => m.mpn);
  const markedCount = markAsSourced(sourcedMpns);
  console.log(`  Marked ${markedCount} MPNs as sourced (won't be re-selected)`);

  // Get queue stats for digest
  const queueStats = getQueueStats();
  const progressPct = queueStats.total > 0 ? Math.round(queueStats.sourced / queueStats.total * 100) : 0;

  console.log('');
  console.log('='.repeat(60));
  console.log('ACTIVE SOURCING COMPLETE');
  console.log('='.repeat(60));
  console.log(`RFQ: ${rfq.searchKey}`);
  console.log(`Lines: ${linesAdded}`);
  if (enrichmentResult) {
    console.log(`Franchise enrichment: ${enrichmentResult.vqsWritten} VQs (${enrichmentResult.apiCalls} API + ${enrichmentResult.cacheHits} cache)`);
    const franchiseCoverage = enrichmentResult.qtyMatches + enrichmentResult.partialCoverage;
    const coveragePct = linesAdded > 0 ? Math.round(franchiseCoverage / linesAdded * 100) : 0;
    console.log(`Franchise coverage: ${franchiseCoverage}/${linesAdded} (${coveragePct}%) — baseline pricing before broker sourcing`);
  }
  if (franchiseSkipped > 0) {
    console.log(`Franchise-covered (skipped broker RFQ): ${franchiseSkipped} MPNs`);
  }
  console.log(`Batch: ${batchId} (exclusions expire in 7 days)`);
  console.log('');
  console.log('Queue progress:');
  console.log(`  Sourced: ${queueStats.sourced} / ${queueStats.total} (${progressPct}%)`);
  console.log(`  Remaining: ${queueStats.unsourced} parts`);
  console.log('='.repeat(60));

  // Step 9: Send batch digest email
  console.log('');
  console.log('Step 9: Sending batch digest...');
  try {
    const franchiseCoverage = enrichmentResult ? enrichmentResult.qtyMatches + enrichmentResult.partialCoverage : 0;
    const franchisePct = linesAdded > 0 ? Math.round(franchiseCoverage / linesAdded * 100) : 0;

    const notifier = createNotifier({
      fromEmail: 'stockrfq@orangetsunami.com',
      fromName: 'Active Sourcing',
      smtpPass: process.env.WORKMAIL_PASS
    });

    await notifier.sendEmail(
      NOTIFICATION_EMAIL,
      `Active Sourcing Batch Complete — ${progressPct}% through delisted queue`,
      `Active Sourcing batch ${batchId} complete.\n\n` +
      `THIS BATCH:\n` +
      `  RFQ: ${rfq.searchKey}\n` +
      `  Parts sourced: ${linesAdded}\n` +
      `  Franchise coverage: ${franchiseCoverage}/${linesAdded} (${franchisePct}%)\n` +
      (enrichmentResult ? `  API calls: ${enrichmentResult.apiCalls} (${enrichmentResult.cacheHits} cache hits)\n` : '') +
      (franchiseSkipped > 0 ? `  Skipped broker RFQ (full franchise coverage): ${franchiseSkipped}\n` : '') +
      `\n` +
      `QUEUE PROGRESS:\n` +
      `  Total delisted parts: ${queueStats.total}\n` +
      `  Sourced so far: ${queueStats.sourced} (${progressPct}%)\n` +
      `  Remaining: ${queueStats.unsourced}\n` +
      `\n` +
      (queueStats.unsourced === 0
        ? `🎉 FIRST PASS COMPLETE — All delisted parts have been sourced!\n`
        : `Next batch: ${Math.min(200, queueStats.unsourced)} parts on next scheduled run.\n`)
    );
    console.log('  Digest sent.');
  } catch (e) {
    console.warn(`  Could not send digest: ${e.message}`);
  }

  // Consume the gate file after successful run
  if (fs.existsSync(INVENTORY_GATE_FILE)) {
    fs.unlinkSync(INVENTORY_GATE_FILE);
    console.log('\nGate file consumed — next run will wait for new confirmation.');
  }

  return {
    selected: selectedMpns.length,
    rfq,
    linesAdded,
    batchId,
    franchiseSkipped,
    mpnsForBrokers,
    enrichment: enrichmentResult ? {
      apiCalls: enrichmentResult.apiCalls,
      cacheHits: enrichmentResult.cacheHits,
      vqsWritten: enrichmentResult.vqsWritten,
      qtyMatches: enrichmentResult.qtyMatches,
      partialCoverage: enrichmentResult.partialCoverage,
      noCoverage: enrichmentResult.noCoverage
    } : null
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let limit = DEFAULT_LIMIT;
  let dryRun = true;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--commit') {
      dryRun = false;
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--help') {
      console.log('Usage: node active-sourcing-runner.js [options]');
      console.log('');
      console.log('Options:');
      console.log('  --limit N     Number of MPNs to source (default: 200)');
      console.log('  --dry-run     Preview without sending RFQs (default)');
      console.log('  --commit      Actually run sourcing (WILL SEND RFQs!)');
      console.log('  --force       Bypass inventory upload confirmation gate');
      console.log('');
      console.log('This runs in FULL mode - RFQs are sent to vendors.');
      console.log('Selected MPNs are excluded from NetComponents uploads');
      console.log('for 7 days to hide inventory during price-check.');
      console.log('');
      console.log('GATE: Requires inventory upload confirmation before running.');
      console.log('Forward email to stockrfq@ with "inventory uploaded" in subject,');
      console.log('or use --force to bypass.');
      process.exit(0);
    }
  }

  try {
    await runActiveSourcing({ limit, dryRun, force });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

// Helper: Set the inventory gate (called when Jake confirms upload)
function setInventoryGate() {
  fs.writeFileSync(INVENTORY_GATE_FILE, new Date().toISOString());
  console.log('Inventory upload gate SET — Active Sourcing can now proceed.');
  console.log(`Gate file: ${INVENTORY_GATE_FILE}`);
}

// Helper: Check gate status
function checkGateStatus() {
  if (fs.existsSync(INVENTORY_GATE_FILE)) {
    const ts = fs.readFileSync(INVENTORY_GATE_FILE, 'utf8').trim();
    console.log(`Gate: OPEN (set at ${ts})`);
    console.log('Active Sourcing will proceed on next run.');
  } else {
    console.log('Gate: CLOSED');
    console.log('Waiting for inventory upload confirmation.');
    console.log('');
    console.log('To open: node active-sourcing-runner.js --gate-open');
    console.log('Or forward confirmation email to stockrfq@ with "inventory uploaded" in subject.');
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--gate-open')) {
    setInventoryGate();
  } else if (args.includes('--gate-status')) {
    checkGateStatus();
  } else {
    main();
  }
}

module.exports = { runActiveSourcing, setInventoryGate, INVENTORY_GATE_FILE };
