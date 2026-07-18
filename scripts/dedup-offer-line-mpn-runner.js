#!/usr/bin/env node
/**
 * dedup-offer-line-mpn-runner.js — Lightweight runner that reads IDs from stdin
 *
 * Usage:
 *   # Generate IDs file first (one deactivate_id per line):
 *   psql -d idempiere_replica -t -A -c "SELECT deactivate_id FROM ..." > /tmp/dedup-ids.txt
 *
 *   # Then run:
 *   cat /tmp/dedup-ids.txt | node scripts/dedup-offer-line-mpn-runner.js --apply
 *
 *   # Or with limit:
 *   head -1000 /tmp/dedup-ids.txt | node scripts/dedup-offer-line-mpn-runner.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { apiPut } = require('../shared/api-client');
const { checkBudget, recordWrites } = require('../shared/ot-api-budget');
const readline = require('readline');

const CALLER = 'data-cleanup';
const API_DELAY_MS = 50;
const BUDGET_CHECK_INTERVAL = 100;  // Check budget every N records
const BUDGET_WAIT_MS = 30000;       // Wait 30s if budget constrained

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');

if (!dryRun && !apply) {
  console.log('Usage: cat ids.txt | node scripts/dedup-offer-line-mpn-runner.js [--dry-run | --apply]');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBudget() {
  while (true) {
    const check = checkBudget(CALLER, 'chuboe_offer_line_mpn', BUDGET_CHECK_INTERVAL);
    if (check.allowed) return;
    console.log(`Budget constrained (P0): ${check.reason}. Waiting 30s...`);
    await sleep(BUDGET_WAIT_MS);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const ids = [];

  for await (const line of rl) {
    const id = parseInt(line.trim(), 10);
    if (!isNaN(id)) ids.push(id);
  }

  console.log(`Loaded ${ids.length} IDs to deactivate`);

  if (dryRun) {
    console.log('DRY RUN - no changes made');
    console.log(`Sample: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}`);
    return;
  }

  const startTime = Date.now();
  let deactivated = 0;
  let errors = 0;

  for (let i = 0; i < ids.length; i++) {
    // Budget check every N records
    if (i % BUDGET_CHECK_INTERVAL === 0) {
      await waitForBudget();
    }

    try {
      await apiPut('chuboe_offer_line_mpn', ids[i], { IsActive: false });
      recordWrites(CALLER, 'chuboe_offer_line_mpn', 1);
      deactivated++;

      if (deactivated % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = deactivated / elapsed;
        const remaining = (ids.length - deactivated) / rate;
        const eta = remaining > 60 ? `${Math.round(remaining / 60)}m` : `${Math.round(remaining)}s`;
        process.stdout.write(`\rDeactivated: ${deactivated} / ${ids.length} (${rate.toFixed(1)}/s, ~${eta} remaining)    `);
      }
    } catch (err) {
      errors++;
      console.error(`\nError deactivating ${ids[i]}: ${err.message}`);
    }

    await sleep(API_DELAY_MS);
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n\nDone. Deactivated: ${deactivated}, Errors: ${errors}, Time: ${Math.round(elapsed)}s`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
