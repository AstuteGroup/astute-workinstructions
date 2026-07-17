#!/usr/bin/env node
/**
 * One-shot U+FFFD catch-up.
 *
 * The mfr-reconciler is forward-only (created > watermark). The U+FFFD
 * sanitizer added 2026-05-08 unblocks resolution of ~11,700 historical
 * rows whose chuboe_mfr_text contains the replacement character (e.g.
 * "Micron�", "TI���", "ANALOG DEVICE�"), going back to 2019. Running
 * the standard reconciler with --since over that window would re-scan
 * the entire 2.5M unresolved-MFR backlog (parked as J4-backfill).
 *
 * This script narrows the scope: only rows whose text contains U+FFFD,
 * regardless of created date. Uses the same lookupMfr + patchBatch
 * plumbing as the reconciler; emits the same audit logs.
 *
 * USAGE:
 *   node ufffd-catchup.js --dry-run        # preview
 *   node ufffd-catchup.js                  # commit
 *   node ufffd-catchup.js --table vq_line  # restrict to one table
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { lookupMfr } = require('../../shared/mfr-lookup');
const { patchBatch } = require('../../shared/record-updater');

const HOME = process.env.HOME || '/home/analytics_user';
const AUDIT_BASE_DIR = path.resolve(HOME, 'workspace/logs/mfr-reconciler');

const DISTRIBUTOR_NAMES = new Set([
  'arrow', 'arrow electronics', 'avnet', 'future', 'future electronics',
  'newark', 'newark element14', 'farnell', 'rs components',
  'digikey', 'digi-key', 'mouser', 'tti', 'master', 'master electronics',
  'rutronik', 'sager', 'waldom', 'heilind', 'verical',
]);

const TABLES = [
  { name: 'chuboe_rfq_line_mpn', pkColumn: 'chuboe_rfq_line_mpn_id', apiTable: 'chuboe_rfq_line_mpn', hasProcessed: false },
  { name: 'chuboe_vq_line',      pkColumn: 'chuboe_vq_line_id',      apiTable: 'Chuboe_VQ_Line',      hasProcessed: true  },
  { name: 'chuboe_cq_line',      pkColumn: 'chuboe_cq_line_id',      apiTable: 'Chuboe_CQ_Line',      hasProcessed: true  },
];

function log(...args) {
  console.log(`${new Date().toISOString()} - ${args.join(' ')}`);
}

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

async function findMangledRows(table) {
  const processedFilter = table.hasProcessed ? "AND (processed IS NULL OR processed = 'N')" : '';
  const sql = `
    SELECT ${table.pkColumn} AS id, chuboe_mfr_text AS text
    FROM adempiere.${table.name}
    WHERE isactive = 'Y'
      ${processedFilter}
      AND chuboe_mfr_id IS NULL
      AND chuboe_mfr_text IS NOT NULL
      AND TRIM(chuboe_mfr_text) <> ''
      AND chuboe_mfr_text LIKE '%' || U&'\\FFFD' || '%'
    ORDER BY ${table.pkColumn}
  `;
  const { rows } = await pool.query(sql);
  return rows;
}

function isDistributor(text) {
  return DISTRIBUTOR_NAMES.has(text.trim().toLowerCase());
}

function resolveRows(rows) {
  const updates = [];
  let skippedSystem = 0, skippedDistributor = 0;
  const unresolved = new Map();

  for (const row of rows) {
    const text = String(row.text || '').trim();
    if (!text) continue;
    if (isDistributor(text)) { skippedDistributor++; continue; }

    const result = lookupMfr(text);
    if (!result.matched || !result.id) {
      unresolved.set(text, (unresolved.get(text) || 0) + 1);
      continue;
    }
    // System MFRs work fine — verified 2026-07-17 with Crystek
    updates.push({ id: row.id, payload: { Chuboe_MFR_ID: result.id } });
  }
  return { updates, skippedSystem, skippedDistributor, unresolved };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const tableIdx = argv.indexOf('--table');
  const tableFilter = tableIdx >= 0 ? argv[tableIdx + 1] : null;

  log(`U+FFFD catch-up starting${dryRun ? ' (DRY RUN)' : ''}`);

  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const auditDir = dryRun ? null : path.resolve(AUDIT_BASE_DIR, `ufffd-catchup-${runStamp}`);
  if (auditDir) {
    try { fs.mkdirSync(auditDir, { recursive: true }); } catch {}
  }

  const tables = tableFilter ? TABLES.filter(t => t.name.includes(tableFilter)) : TABLES;
  let grandPatched = 0, grandScanned = 0, grandSys = 0, grandUnres = 0, grandErrors = 0;

  for (const table of tables) {
    log(`Querying ${table.name}...`);
    const rows = await findMangledRows(table);
    log(`  ${rows.length.toLocaleString()} mangled rows`);
    if (rows.length === 0) continue;

    const { updates, skippedSystem, skippedDistributor, unresolved } = resolveRows(rows);
    log(`  Resolved: ${updates.length}, system-skip: ${skippedSystem}, distributor-skip: ${skippedDistributor}, unresolved: ${unresolved.size}`);

    let patched = 0, errors = 0;
    if (dryRun) {
      log(`  DRY RUN — would PATCH ${updates.length} rows`);
      patched = updates.length;
    } else if (updates.length > 0) {
      const result = await patchBatch(table.apiTable, updates, {
        skipIfNotNull: ['Chuboe_MFR_ID'],
        source: 'ufffd-catchup',
        concurrency: 5,
        auditDir,
      });
      patched = result.patched;
      errors = result.errors;
      log(`  PATCH: ${result.patched} patched, ${result.skipped} skipped, ${result.errors} errors`);
    }

    grandScanned += rows.length;
    grandPatched += patched;
    grandSys += skippedSystem;
    grandUnres += unresolved.size;
    grandErrors += errors;
  }

  log(`\n=== Summary === scanned=${grandScanned} patched=${grandPatched} sys-skip=${grandSys} unresolved-uniq=${grandUnres} errors=${grandErrors}`);
  await pool.end();
}

main().catch(async (err) => {
  log('FATAL:', err.message);
  console.error(err.stack);
  try { await pool.end(); } catch {}
  process.exit(1);
});
