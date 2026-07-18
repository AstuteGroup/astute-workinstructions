#!/usr/bin/env node
/**
 * AMAT RFQ 1147485 Enrichment Script
 *
 * Re-runs franchise API enrichment with the fixed Verical/vqLines counting.
 * Writes VQ lines to OT via writeVQBatch.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { searchAllDistributors } = require('../shared/franchise-api');
const { writeVQBatch } = require('../shared/vq-writer');
const { Pool } = require('pg');

const RFQ_ID = 1147485;
const RFQ_DOC_NO = '1138070';

const pool = new Pool({
  host: '/var/run/postgresql',
  database: 'idempiere_replica',
  user: 'analytics_user'
});

async function run() {
  // Get valid-looking MPNs with RFQ line info
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (rlm.chuboe_mpn)
      rl.chuboe_rfq_line_id,
      rlm.chuboe_rfq_line_mpn_id,
      rlm.chuboe_mpn,
      rl.qty::int as qty
    FROM chuboe_rfq_line rl
    JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = $1
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND rlm.chuboe_mpn IS NOT NULL
      AND LENGTH(rlm.chuboe_mpn) >= 5
      AND rlm.chuboe_mpn ~ '^[A-Z0-9]'
      AND rlm.chuboe_mpn ~ '[0-9]'
      AND rlm.chuboe_mpn ~ '[A-Z]'
    ORDER BY rlm.chuboe_mpn, rl.chuboe_rfq_line_id
  `, [RFQ_ID]);

  console.log(`Enriching ${rows.length} valid MPNs from RFQ ${RFQ_DOC_NO} (ID ${RFQ_ID})...`);
  console.log('');

  let fullCoverage = 0;
  let partialCoverage = 0;
  let noCoverage = 0;
  let withVqLines = 0;
  let totalVqLines = 0;
  let errored = 0;

  // Build items array for writeVQBatch - format: { mpn, cpc?, franchiseResults }
  const items = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = await searchAllDistributors(row.chuboe_mpn, row.qty || 1);
      const summary = result.summary;

      if (summary.coverage === 'FULL') fullCoverage++;
      else if (summary.coverage === 'PARTIAL') partialCoverage++;
      else noCoverage++;

      if (result.vqLines && result.vqLines.length > 0) {
        withVqLines++;
        totalVqLines += result.vqLines.length;

        // Add to items for batch write
        items.push({
          mpn: row.chuboe_mpn,
          franchiseResults: result  // pass full result object
        });
      }

      if ((i + 1) % 25 === 0) {
        console.log(`Progress: ${i + 1}/${rows.length} MPNs (FULL: ${fullCoverage}, vqLines: ${totalVqLines})`);
      }
    } catch (err) {
      errored++;
      console.error(`Error on ${row.chuboe_mpn}: ${err.message}`);
    }
  }

  console.log('');
  console.log('=== Enrichment Results ===');
  console.log(`FULL coverage:    ${fullCoverage}`);
  console.log(`PARTIAL coverage: ${partialCoverage}`);
  console.log(`NO coverage:      ${noCoverage}`);
  console.log(`Errored:          ${errored}`);
  console.log('');
  console.log(`MPNs with vqLines:     ${withVqLines}`);
  console.log(`Total VQ lines found:  ${totalVqLines}`);

  await pool.end();

  // Write VQs if any - use small batches to avoid rate limit
  if (items.length > 0) {
    console.log('');
    console.log(`Writing VQs for ${items.length} MPNs (${totalVqLines} total lines) to OT...`);
    console.log('Using small batches of 20 to avoid rate limit...');

    const BATCH_SIZE = 20;
    let totalWritten = 0;
    let totalFlagged = 0;
    let totalFailed = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      console.log(`  Batch ${Math.floor(i/BATCH_SIZE) + 1}: writing ${batch.length} MPNs...`);

      try {
        const writeResult = await writeVQBatch(RFQ_DOC_NO, batch, { delayMs: 150 });
        totalWritten += writeResult.written?.length || 0;
        totalFlagged += writeResult.flagged?.length || 0;
        totalFailed += writeResult.failed?.length || 0;

        if (writeResult.rateLimited) {
          console.log(`  Rate limited: ${writeResult.rateLimitReason}`);
          console.log('  Waiting 60s for budget to reset...');
          await new Promise(r => setTimeout(r, 60000));
          i -= BATCH_SIZE; // retry this batch
        } else {
          console.log(`  Written: ${writeResult.written?.length || 0}`);
        }
      } catch (err) {
        console.error(`  Error: ${err.message}`);
      }

      // Brief pause between batches
      if (i + BATCH_SIZE < items.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log('');
    console.log('=== VQ Write Results ===');
    console.log(`Total written: ${totalWritten}`);
    console.log(`Total flagged: ${totalFlagged}`);
    console.log(`Total failed:  ${totalFailed}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
