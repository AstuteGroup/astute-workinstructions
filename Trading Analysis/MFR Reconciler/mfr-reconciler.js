#!/usr/bin/env node
/**
 * MFR Reconciler — daily cron that backfills Chuboe_MFR_ID on rows where the
 * text is populated but the FK is null.
 *
 * Forward-only by design: processes rows created since the last successful
 * run (watermark-based). Historical backfill of ~2.5M legacy rows is parked
 * as a separate roadmap item (J4-backfill).
 *
 * Tables in scope:
 *   - chuboe_rfq_line_mpn  (PK: chuboe_rfq_line_mpn_id, no `processed` flag)
 *   - chuboe_vq_line       (PK: chuboe_vq_line_id, has `processed` flag)
 *   - chuboe_cq_line       (PK: chuboe_cq_line_id, has `processed` flag)
 *
 * Resolution chain reuses shared/mfr-lookup.js lookupMfr():
 *   alias → cache → DB strict → DB fuzzy → passthrough
 *
 * Skip rules:
 *   - text matches a known distributor name → skip (data-entry error, not a real MFR)
 *   - lookupMfr returns matched=false → skip (passthrough only)
 * NOTE: System MFRs (AD_Client_ID=0) work fine — verified 2026-07-17 with Crystek.
 *
 * USAGE:
 *   node mfr-reconciler.js                        # normal cron invocation
 *   node mfr-reconciler.js --dry-run              # query + resolve, no PATCH, no watermark update
 *   node mfr-reconciler.js --since '2026-04-13'   # override watermark for ad-hoc backfill
 *   node mfr-reconciler.js --table vq_line        # restrict to one table
 *
 * Cron entry (install with `crontab -e`):
 *   0 6 * * * /usr/bin/node "/home/.../MFR Reconciler/mfr-reconciler.js" >> /tmp/mfr-reconciler.log 2>&1
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { lookupMfr } = require('../../shared/mfr-lookup');
const { patchBatch } = require('../../shared/record-updater');
const { createNotifier } = require('../../shared/notifier');
const apiPause = require('../../shared/api-pause');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/analytics_user';
const WATERMARK_FILE = path.resolve(HOME, 'workspace/.last-mfr-reconcile');
const PID_FILE = path.resolve(HOME, 'workspace/.mfr-reconciler.pid');
const LOG_FILE = '/tmp/mfr-reconciler.log';
const AUDIT_BASE_DIR = path.resolve(HOME, 'workspace/logs/mfr-reconciler');

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const FROM_EMAIL = 'rfqloading@orangetsunami.com';

const CONCURRENCY = 5; // conservative — iDempiere REST is the bottleneck

// Distributor names that show up as MFR text by mistake. Don't try to resolve
// these — flag them in the report so the operator can decide what to do.
const DISTRIBUTOR_NAMES = new Set([
  'arrow', 'arrow electronics', 'avnet', 'future', 'future electronics',
  'newark', 'newark element14', 'farnell', 'rs components',
  'digikey', 'digi-key', 'mouser', 'tti', 'master', 'master electronics',
  'rutronik', 'sager', 'waldom', 'heilind', 'verical',
]);

const TABLES = [
  {
    name: 'chuboe_rfq_line_mpn',
    pkColumn: 'chuboe_rfq_line_mpn_id',
    apiTable: 'chuboe_rfq_line_mpn',
    hasProcessed: false,
  },
  {
    name: 'chuboe_vq_line',
    pkColumn: 'chuboe_vq_line_id',
    apiTable: 'Chuboe_VQ_Line',
    hasProcessed: true,
  },
  {
    name: 'chuboe_cq_line',
    pkColumn: 'chuboe_cq_line_id',
    apiTable: 'Chuboe_CQ_Line',
    hasProcessed: true,
  },
];

// ─── PID GUARD ───────────────────────────────────────────────────────────────

function claimPid() {
  if (fs.existsSync(PID_FILE)) {
    const existing = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(existing, 0);
      log(`Already running (PID ${existing}), exiting cleanly.`);
      return false;
    } catch {
      log(`Stale PID file (${existing} not running), claiming.`);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  return true;
}

function releasePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(...args) {
  const line = `${new Date().toISOString()} - ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─── WATERMARK ───────────────────────────────────────────────────────────────

function readWatermark() {
  try {
    if (!fs.existsSync(WATERMARK_FILE)) return null;
    const txt = fs.readFileSync(WATERMARK_FILE, 'utf-8').trim();
    return txt || null;
  } catch (err) {
    log('WARN: failed to read watermark:', err.message);
    return null;
  }
}

function writeWatermark(iso) {
  try {
    fs.writeFileSync(WATERMARK_FILE, iso, 'utf-8');
  } catch (err) {
    log('WARN: failed to write watermark:', err.message);
  }
}

// ─── DB ──────────────────────────────────────────────────────────────────────

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

/**
 * Find rows in `table` with NULL Chuboe_MFR_ID and populated Chuboe_MFR_Text,
 * created after `sinceIso` (UTC ISO timestamp).
 *
 * TZ note: iDempiere writes `created` as America/Chicago into TZ-naive column.
 * Same fix as enrich-poller.js — convert on the fly before comparing.
 */
async function findUnresolvedRows(table, sinceIso) {
  const processedFilter = table.hasProcessed
    ? "AND (processed IS NULL OR processed = 'N')"
    : '';
  const sql = `
    SELECT ${table.pkColumn} AS id, chuboe_mfr_text AS text
    FROM adempiere.${table.name}
    WHERE isactive = 'Y'
      ${processedFilter}
      AND chuboe_mfr_id IS NULL
      AND chuboe_mfr_text IS NOT NULL
      AND TRIM(chuboe_mfr_text) <> ''
      AND (created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') > $1
    ORDER BY ${table.pkColumn}
  `;
  const { rows } = await pool.query(sql, [sinceIso]);
  return rows;
}

// ─── RESOLVE ─────────────────────────────────────────────────────────────────

function isDistributor(text) {
  return DISTRIBUTOR_NAMES.has(text.trim().toLowerCase());
}

/**
 * Resolve a batch of (id, text) rows. Returns:
 *   - updates: [{ id, payload: { Chuboe_MFR_ID } }] for rows ready to PATCH
 *   - skippedSystem: count of rows resolved to a system-level MFR (can't write)
 *   - skippedDistributor: count of rows where text looked like a distributor name
 *   - unresolved: { textValue: count } map for the report
 */
function resolveRows(rows) {
  const updates = [];
  let skippedSystem = 0;
  let skippedDistributor = 0;
  const unresolved = new Map();

  for (const row of rows) {
    const text = String(row.text || '').trim();
    if (!text) continue;

    if (isDistributor(text)) {
      skippedDistributor++;
      continue;
    }

    const result = lookupMfr(text);

    if (!result.matched || !result.id) {
      unresolved.set(text, (unresolved.get(text) || 0) + 1);
      continue;
    }

    // System MFRs work fine — verified 2026-07-17 with Crystek. No skip needed.
    updates.push({ id: row.id, payload: { Chuboe_MFR_ID: result.id } });
  }

  return { updates, skippedSystem, skippedDistributor, unresolved };
}

// ─── EMAIL REPORT ────────────────────────────────────────────────────────────

function renderEmail(perTableResults, sinceIso, untilIso) {
  let html = `<html><body style="font-family:Arial,sans-serif;max-width:800px">
<h3>MFR Reconciler — daily run summary</h3>
<p>Window: ${sinceIso} → ${untilIso}</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr style="background:#f0f0f0">
  <th>Table</th><th>Scanned</th><th>Patched</th><th>Skipped<br/>(system MFR)</th>
  <th>Skipped<br/>(distributor)</th><th>Unresolved<br/>(unique texts)</th><th>Errors</th>
</tr>`;

  let totalScanned = 0, totalPatched = 0, totalSysSkip = 0, totalDistSkip = 0, totalErrors = 0;
  const allUnresolved = new Map();

  for (const r of perTableResults) {
    totalScanned += r.scanned;
    totalPatched += r.patched;
    totalSysSkip += r.skippedSystem;
    totalDistSkip += r.skippedDistributor;
    totalErrors += r.errors;
    for (const [text, count] of r.unresolved) {
      allUnresolved.set(text, (allUnresolved.get(text) || 0) + count);
    }
    html += `<tr>
      <td>${r.table}</td>
      <td style="text-align:right">${r.scanned.toLocaleString()}</td>
      <td style="text-align:right">${r.patched.toLocaleString()}</td>
      <td style="text-align:right">${r.skippedSystem.toLocaleString()}</td>
      <td style="text-align:right">${r.skippedDistributor.toLocaleString()}</td>
      <td style="text-align:right">${r.unresolved.size.toLocaleString()}</td>
      <td style="text-align:right">${r.errors}</td>
    </tr>`;
  }

  html += `<tr style="background:#f0f0f0;font-weight:bold">
    <td>TOTAL</td>
    <td style="text-align:right">${totalScanned.toLocaleString()}</td>
    <td style="text-align:right">${totalPatched.toLocaleString()}</td>
    <td style="text-align:right">${totalSysSkip.toLocaleString()}</td>
    <td style="text-align:right">${totalDistSkip.toLocaleString()}</td>
    <td style="text-align:right">${allUnresolved.size.toLocaleString()}</td>
    <td style="text-align:right">${totalErrors}</td>
  </tr></table>`;

  // Top 20 unresolved by frequency
  const sorted = [...allUnresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (sorted.length > 0) {
    html += `<br/><h4>Top ${sorted.length} unresolved MFR texts (alias candidates)</h4>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr style="background:#f0f0f0"><th>Frequency</th><th>MFR Text</th></tr>`;
    for (const [text, count] of sorted) {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html += `<tr><td style="text-align:right">${count}</td><td>${escaped}</td></tr>`;
    }
    html += `</table>
<p style="font-size:12px;color:#666">Texts appearing 5+ times are good candidates for adding to <code>mfr-aliases.json</code> if they map to a known canonical brand.</p>`;
  }

  html += `</body></html>`;
  return html;
}

async function sendSummary(perTableResults, sinceIso, untilIso) {
  try {
    const notifier = createNotifier({
      fromEmail: FROM_EMAIL,
      fromName: 'MFR Reconciler',
    });
    const totalPatched = perTableResults.reduce((s, r) => s + r.patched, 0);
    const totalScanned = perTableResults.reduce((s, r) => s + r.scanned, 0);
    const subject = `MFR Reconciler — ${totalPatched.toLocaleString()} patched / ${totalScanned.toLocaleString()} scanned`;
    const html = renderEmail(perTableResults, sinceIso, untilIso);
    await notifier.sendEmail(NOTIFY_EMAIL, subject, html, { html: true });
    log('Summary email sent');
  } catch (err) {
    log('WARN: summary email failed:', err.message);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sinceIdx = argv.indexOf('--since');
  const sinceOverride = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;
  const tableIdx = argv.indexOf('--table');
  const tableFilter = tableIdx >= 0 ? argv[tableIdx + 1] : null;
  const ignorePause = argv.includes('--ignore-pause');

  if (!dryRun) {
    if (!claimPid()) process.exit(0);
    process.on('exit', releasePid);
    process.on('SIGINT', () => { releasePid(); process.exit(130); });
    process.on('SIGTERM', () => { releasePid(); process.exit(143); });
  }

  log(`MFR Reconciler starting${dryRun ? ' (DRY RUN)' : ''}`);

  // Watermark
  let sinceIso;
  if (sinceOverride) {
    sinceIso = new Date(sinceOverride).toISOString();
    log(`Using --since override: ${sinceIso}`);
  } else {
    sinceIso = readWatermark();
    if (!sinceIso) {
      sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      log(`No watermark — using last 24 hours: ${sinceIso}`);
    } else {
      log(`Watermark: ${sinceIso}`);
    }
  }
  const untilIso = new Date().toISOString();

  // Pause-file yield (skipped on dry-run or with --ignore-pause)
  if (!dryRun && !ignorePause) {
    await apiPause.waitIfPaused({ log: (m) => log(`[pause] ${m}`) });
  }

  // Audit dir for this run
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const auditDir = dryRun ? null : path.resolve(AUDIT_BASE_DIR, runStamp);
  if (auditDir) {
    try { fs.mkdirSync(auditDir, { recursive: true }); } catch {}
  }

  const perTableResults = [];
  const tables = tableFilter
    ? TABLES.filter(t => t.name.includes(tableFilter))
    : TABLES;

  for (const table of tables) {
    log(`Querying ${table.name}...`);
    let rows;
    try {
      rows = await findUnresolvedRows(table, sinceIso);
    } catch (err) {
      log(`FATAL on ${table.name}: ${err.message}`);
      perTableResults.push({
        table: table.name, scanned: 0, patched: 0,
        skippedSystem: 0, skippedDistributor: 0,
        unresolved: new Map(), errors: 1,
      });
      continue;
    }
    log(`  ${rows.length.toLocaleString()} unresolved rows in window`);

    if (rows.length === 0) {
      perTableResults.push({
        table: table.name, scanned: 0, patched: 0,
        skippedSystem: 0, skippedDistributor: 0,
        unresolved: new Map(), errors: 0,
      });
      continue;
    }

    const { updates, skippedSystem, skippedDistributor, unresolved } = resolveRows(rows);
    log(`  Resolved: ${updates.length}, system-skip: ${skippedSystem}, distributor-skip: ${skippedDistributor}, unresolved: ${unresolved.size}`);

    let patched = 0;
    let errors = 0;

    if (dryRun) {
      log(`  DRY RUN — would PATCH ${updates.length} rows`);
      patched = updates.length;
    } else if (updates.length > 0) {
      try {
        const result = await patchBatch(table.apiTable, updates, {
          skipIfNotNull: ['Chuboe_MFR_ID'],
          source: 'mfr-reconciler',
          concurrency: CONCURRENCY,
          auditDir,
        });
        patched = result.patched;
        errors = result.errors;
        log(`  PATCH: ${result.patched} patched, ${result.skipped} skipped (already set), ${result.errors} errors`);
      } catch (err) {
        log(`  ERROR during patchBatch: ${err.message}`);
        errors = updates.length;
      }
    }

    perTableResults.push({
      table: table.name,
      scanned: rows.length,
      patched,
      skippedSystem,
      skippedDistributor,
      unresolved,
      errors,
    });
  }

  // Summary
  const totalScanned = perTableResults.reduce((s, r) => s + r.scanned, 0);
  const totalPatched = perTableResults.reduce((s, r) => s + r.patched, 0);
  log(`\n=== Summary === scanned=${totalScanned} patched=${totalPatched}`);
  for (const r of perTableResults) {
    log(`  ${r.table.padEnd(24)} scanned=${r.scanned} patched=${r.patched} sys=${r.skippedSystem} dist=${r.skippedDistributor} unres=${r.unresolved.size} err=${r.errors}`);
  }

  if (!dryRun && totalScanned > 0) {
    await sendSummary(perTableResults, sinceIso, untilIso);
  }

  // Advance watermark only on a clean live run with no fatal errors
  if (!dryRun) {
    writeWatermark(untilIso);
    log(`Watermark advanced to ${untilIso}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  log('FATAL:', err.message);
  try { await pool.end(); } catch {}
  releasePid();
  process.exit(1);
});
