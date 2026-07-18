#!/usr/bin/env node
/**
 * dedup-direct.js — Direct dedup without pre-extraction
 *
 * Fetches small batches of duplicates and processes them incrementally.
 * Avoids the slow windowed query by using a cursor-based approach.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = require('pg');
const { apiPut } = require('../shared/api-client');
const { checkBudget, recordWrites } = require('../shared/ot-api-budget');

const CALLER = 'data-cleanup';
const BATCH_SIZE = 500;
const API_DELAY_MS = 50;

const args = process.argv.slice(2);
const offerType = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

if (!offerType || (!dryRun && !apply)) {
  console.log('Usage: node scripts/dedup-direct.js "Offer Type" [--dry-run | --apply] [--limit=N]');
  console.log('');
  console.log('Types: "Customer Excess", "Broker Stock Offer", "Franchise Stock Offers"');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForBudget(count) {
  while (true) {
    const check = checkBudget({ caller: CALLER, table: 'chuboe_offer_line_mpn', count });
    if (check.allowed) return;
    console.log(`\nBudget constrained (P0): ${check.reason}. Waiting 30s...`);
    await sleep(30000);
  }
}

async function main() {
  const pool = new Pool({ host: '/var/run/postgresql', database: 'idempiere_replica' });

  console.log(`\nDedup: ${offerType}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log('');

  // Simpler query: find offer_line_ids with duplicate MPNs, then get the higher ID to deactivate
  const countSql = `
    SELECT COUNT(*) as cnt FROM (
      SELECT ol.chuboe_offer_line_id
      FROM chuboe_offer_line_mpn olm
      JOIN chuboe_offer_line ol ON olm.chuboe_offer_line_id = ol.chuboe_offer_line_id
      JOIN chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
      JOIN chuboe_offer_type ot ON o.chuboe_offer_type_id = ot.chuboe_offer_type_id
      WHERE olm.isactive = 'Y' AND ol.isactive = 'Y' AND o.isactive = 'Y'
        AND olm.created >= NOW() - INTERVAL '9 months'
        AND ot.name = $1
      GROUP BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean
      HAVING COUNT(*) = 2
    ) sub;
  `;

  const countResult = await pool.query(countSql, [offerType]);
  const totalDuplicates = parseInt(countResult.rows[0].cnt, 10);
  console.log(`Found ${totalDuplicates.toLocaleString()} duplicate pairs`);

  if (dryRun) {
    console.log('DRY RUN - no changes made');
    await pool.end();
    return;
  }

  const startTime = Date.now();
  let processed = 0;
  let deactivated = 0;
  let errors = 0;
  let lastLineId = 0;

  const effectiveLimit = limit || totalDuplicates;

  while (processed < effectiveLimit) {
    // Fetch next batch of duplicates
    const batchSql = `
      WITH dups AS (
        SELECT ol.chuboe_offer_line_id, olm.chuboe_mpn_clean,
               MAX(olm.chuboe_offer_line_mpn_id) as deactivate_id
        FROM chuboe_offer_line_mpn olm
        JOIN chuboe_offer_line ol ON olm.chuboe_offer_line_id = ol.chuboe_offer_line_id
        JOIN chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
        JOIN chuboe_offer_type ot ON o.chuboe_offer_type_id = ot.chuboe_offer_type_id
        WHERE olm.isactive = 'Y' AND ol.isactive = 'Y' AND o.isactive = 'Y'
          AND olm.created >= NOW() - INTERVAL '9 months'
          AND ot.name = $1
          AND ol.chuboe_offer_line_id > $2
        GROUP BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean
        HAVING COUNT(*) = 2
        ORDER BY ol.chuboe_offer_line_id
        LIMIT $3
      )
      SELECT deactivate_id, chuboe_offer_line_id FROM dups;
    `;

    const batchResult = await pool.query(batchSql, [offerType, lastLineId, BATCH_SIZE]);

    if (batchResult.rows.length === 0) break;

    // Check budget before processing batch
    await waitForBudget(batchResult.rows.length);

    for (const row of batchResult.rows) {
      try {
        await apiPut('chuboe_offer_line_mpn', row.deactivate_id, { IsActive: false });
        recordWrites('chuboe_offer_line_mpn', 1, { caller: CALLER });
        deactivated++;
      } catch (err) {
        errors++;
        console.error(`\nError ${row.deactivate_id}: ${err.message}`);
      }

      processed++;
      lastLineId = Math.max(lastLineId, row.chuboe_offer_line_id);

      if (processed % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = (effectiveLimit - processed) / rate;
        const eta = remaining > 60 ? `${Math.round(remaining / 60)}m` : `${Math.round(remaining)}s`;
        process.stdout.write(`\rProcessed: ${processed.toLocaleString()} / ${effectiveLimit.toLocaleString()} (${rate.toFixed(1)}/s, ~${eta})    `);
      }

      await sleep(API_DELAY_MS);

      if (limit && processed >= limit) break;
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n\nDone.`);
  console.log(`  Processed:   ${processed.toLocaleString()}`);
  console.log(`  Deactivated: ${deactivated.toLocaleString()}`);
  console.log(`  Errors:      ${errors}`);
  console.log(`  Time:        ${Math.round(elapsed)}s`);

  await pool.end();
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
