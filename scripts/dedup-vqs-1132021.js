#!/usr/bin/env node
/**
 * One-shot cleanup: deactivate the 502 dup VQ rows on RFQ 1132021 (chuboe_rfq_id 1141436)
 * that were written by today's enrich-rfq.js manual runs.
 *
 * Background: enrich-rfq.js iterated chuboe_rfq_line_mpn (which has long-standing
 * upstream dups for the same (line_id, mpn) on Sanmina PPVs) and faithfully wrote
 * one VQ per row. Result: same (line_id, mpn, vendor, cost) appears 4-5 times.
 *
 * Dedup key: (chuboe_rfq_line_id, chuboe_mpn, c_bpartner_id, cost) — verified that
 * rows within a group are byte-identical across all non-key columns (lead_time,
 * date_code, packaging, mfr_text, moq, spq, qty). Keeps the lowest chuboe_vq_line_id
 * per group, marks the rest IsActive=N via PATCH.
 *
 * Pre-cleanup: 862 active VQs from today on RFQ 1141436 (360 unique + 502 dups).
 * Post-cleanup: 360 active, 502 inactive.
 *
 * Run with --dry-run first to preview the IDs without writing.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { Pool } = require('pg');
const { patchBatch } = require('../shared/record-updater');

const DRY_RUN = process.argv.includes('--dry-run');
const RFQ_ID = 1141436; // chuboe_rfq_id for search_key 1132021
const SINCE = '2026-04-08 17:00:00';

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

async function main() {
  // Identify the 502 dup IDs — same query as the spot-check, returned as plain array
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT chuboe_vq_line_id,
             ROW_NUMBER() OVER (
               PARTITION BY chuboe_rfq_line_id, chuboe_mpn, c_bpartner_id, cost
               ORDER BY chuboe_vq_line_id
             ) AS rn
      FROM adempiere.chuboe_vq_line
      WHERE chuboe_rfq_id = $1
        AND created > $2
        AND isactive = 'Y'
    )
    SELECT chuboe_vq_line_id FROM ranked WHERE rn > 1 ORDER BY chuboe_vq_line_id
  `, [RFQ_ID, SINCE]);

  const ids = rows.map(r => Number(r.chuboe_vq_line_id));
  console.log(`Found ${ids.length} dup VQ rows to deactivate on RFQ ${RFQ_ID}`);

  if (ids.length === 0) {
    console.log('Nothing to clean up.');
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — first 10 IDs:', ids.slice(0, 10));
    console.log('Last 10 IDs:', ids.slice(-10));
    await pool.end();
    return;
  }

  // Build patchBatch updates: each row gets IsActive='N'
  const updates = ids.map(id => ({
    id,
    payload: { IsActive: 'N' },
  }));

  console.log(`PATCHing ${updates.length} rows to IsActive=N (concurrency 5)...`);
  const summary = await patchBatch('Chuboe_VQ_Line', updates, {
    concurrency: 5,
    source: 'dedup-1132021',
    onProgress: (completed, total) => {
      if (completed % 50 === 0 || completed === total) {
        process.stderr.write(`  ${completed}/${total}\n`);
      }
    },
  });

  console.log('\n─── Summary ─────────────────────────────');
  console.log(`Total:             ${summary.total}`);
  console.log(`Patched:           ${summary.patched}`);
  console.log(`Skipped:           ${summary.skipped}`);
  console.log(`Validation failed: ${summary.validationFailed}`);
  console.log(`Errors:            ${summary.errors}`);

  if (summary.errors > 0) {
    console.log('\nFirst 5 error rows:');
    summary.results.filter(r => r?.status === 'error').slice(0, 5).forEach(r => {
      console.log(`  vq_line ${r.id}: ${r.error} (${r.statusCode})`);
    });
  }

  await pool.end();
}

main().catch(async err => {
  console.error('FATAL:', err.stack || err.message);
  await pool.end();
  process.exit(1);
});
