#!/usr/bin/env node
/**
 * cancel-inactive-rfq-retries.js — sweep newly-inactivated RFQs and cancel
 * their in-flight retry items.
 *
 * Catches the case the gate-rejection hook misses: operator marks a
 * chuboe_rfq inactive directly in OT (no gate involvement), but the api
 * retry queue still has its MPNs pending. Without this sweep, the items
 * would keep grinding until their attempt budget is exhausted.
 *
 * Mechanism:
 *   1. Read watermark from ~/workspace/.cancel-inactive-rfq.watermark
 *      (defaults to "30 days ago" on first run).
 *   2. Query chuboe_rfq for rows where isactive='N' AND updated > watermark.
 *   3. For each, fetch the MPN list, write a cancel manifest, and apply it
 *      to the queue under the queue lock (same path as the rejection hook).
 *      Idempotent — re-writing the same manifest is fine.
 *   4. Advance watermark to NOW.
 *
 * Watermark sentinel is advanced ONLY on full success. If the sweep crashes
 * partway through, next run will re-process the same window — safe because
 * manifest writes are idempotent and queue cancellations don't double-count.
 *
 * Per-sweep limits to keep tick time bounded:
 *   - Hard cap on inactivated-RFQ count per run (env: SWEEP_MAX_RFQS, default 200)
 *   - 5-min wall clock budget (env: SWEEP_MAX_WALL_MIN, default 5)
 * Hitting either: log the cap reason, advance watermark to the LATEST
 * processed RFQ's `updated` timestamp (not NOW), next run picks up where
 * this one left off.
 *
 * USAGE:
 *   node cancel-inactive-rfq-retries.js [--dry-run] [--since "ISO8601"]
 *
 * Exit codes:
 *   0 — success (zero or more RFQs processed; watermark advanced)
 *   1 — DB / queue I/O failure (watermark NOT advanced)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const apiQueue = require(path.resolve(__dirname, '..', 'shared', 'api-queue'));
const {
  withQueueLock,
  readQueueSafe,
  writeQueueAtomic,
  applyCancelManifests,
  normalizeMpnForCancel,
} = apiQueue;

const PENDING_DIR = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.large-rfq-pending'
);
const WATERMARK_PATH = path.resolve(
  process.env.HOME || '/home/analytics_user',
  'workspace/.cancel-inactive-rfq.watermark'
);

const MAX_RFQS = Number(process.env.SWEEP_MAX_RFQS) || 200;
const MAX_WALL_MS = (Number(process.env.SWEEP_MAX_WALL_MIN) || 5) * 60 * 1000;

function parseArgs(argv) {
  const out = { dryRun: false, sinceOverride: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--since') out.sinceOverride = argv[++i];
  }
  return out;
}

function readWatermark() {
  if (!fs.existsSync(WATERMARK_PATH)) {
    // First-ever run — look back 30 days. This is a one-time backfill window;
    // subsequent runs read from the persisted file.
    const fallback = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return fallback;
  }
  try {
    return fs.readFileSync(WATERMARK_PATH, 'utf-8').trim();
  } catch (err) {
    console.error(`[watermark] unreadable, falling back to 30d ago: ${err.message}`);
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function writeWatermark(iso) {
  const tmp = `${WATERMARK_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, iso);
  fs.renameSync(tmp, WATERMARK_PATH);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceIso = opts.sinceOverride || readWatermark();
  const startedAt = Date.now();

  console.log(`[sweep] inactive-RFQ sweep — since=${sinceIso} dry-run=${opts.dryRun}`);

  const pool = new Pool({
    host: '/var/run/postgresql',
    database: process.env.PGDATABASE || 'idempiere_replica',
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
  });

  // chuboe_rfq.updated is stored as CDT digits (per project memory
  // chuboe_created_cdt_storage) — must cast to UTC for comparison. Comparing
  // against an ISO sinceIso that we treat as UTC.
  const inactiveQ = await pool.query(
    `SELECT chuboe_rfq_id, value, bpname, updated
       FROM adempiere.chuboe_rfq
      WHERE isactive = 'N'
        AND (updated AT TIME ZONE 'America/Chicago') > $1::timestamptz
      ORDER BY updated ASC
      LIMIT $2`,
    [sinceIso, MAX_RFQS + 1]
  );
  const inactive = inactiveQ.rows;
  const hitLimit = inactive.length > MAX_RFQS;
  const toProcess = hitLimit ? inactive.slice(0, MAX_RFQS) : inactive;
  console.log(`[sweep] found ${inactive.length} newly-inactivated RFQ${inactive.length === 1 ? '' : 's'}${hitLimit ? ` (capped to ${MAX_RFQS})` : ''}`);

  if (toProcess.length === 0) {
    if (!opts.dryRun) writeWatermark(new Date().toISOString());
    await pool.end();
    console.log('[sweep] nothing to do; watermark advanced to NOW');
    return;
  }

  // Build one mega-manifest of MPNs covering ALL newly-inactivated RFQs,
  // and write per-RFQ manifest files for durability / audit.
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  const mpnsToCancel = new Map();
  const perRfqStats = [];
  let lastProcessedUpdated = null;

  for (const rfq of toProcess) {
    if (Date.now() - startedAt >= MAX_WALL_MS) {
      console.log(`[sweep] wall-clock cap hit after processing ${perRfqStats.length}/${toProcess.length} RFQs`);
      break;
    }
    const { rows: mpnRows } = await pool.query(
      `SELECT DISTINCT rlm.chuboe_mpn
         FROM adempiere.chuboe_rfq_line rl
         JOIN adempiere.chuboe_rfq_line_mpn rlm
           ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
        WHERE rl.chuboe_rfq_id = $1 AND rl.isactive='Y'
          AND rlm.chuboe_mpn IS NOT NULL AND rlm.chuboe_mpn <> ''`,
      [rfq.chuboe_rfq_id]
    );
    const normalized = new Set();
    for (const r of mpnRows) {
      const n = normalizeMpnForCancel(r.chuboe_mpn);
      if (n) normalized.add(n);
    }
    const mpnsArr = [...normalized].sort();
    const reasonLabel = `rfq ${rfq.value} (inactivated in OT @ ${new Date(rfq.updated).toISOString()})`;
    for (const m of mpnsArr) {
      if (!mpnsToCancel.has(m)) mpnsToCancel.set(m, reasonLabel);
    }
    perRfqStats.push({ rfq_number: rfq.value, mpns: mpnsArr.length, customer: rfq.bpname || '?' });
    lastProcessedUpdated = rfq.updated;

    // Write per-RFQ manifest (idempotent)
    const manifestPath = path.join(PENDING_DIR, `${rfq.value}.cancel-mpns.json`);
    const manifest = {
      id: String(rfq.value),
      kind: 'rfq',
      chuboe_rfq_id: rfq.chuboe_rfq_id,
      reason: `inactivated in OT @ ${new Date(rfq.updated).toISOString()}`,
      written_at: new Date().toISOString(),
      written_by: 'cancel-inactive-rfq-retries',
      mpns_normalized: mpnsArr,
    };
    if (!opts.dryRun) {
      const tmp = `${manifestPath}.tmp.${process.pid}.${rfq.chuboe_rfq_id}`;
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
      fs.renameSync(tmp, manifestPath);
    }
  }

  console.log(`[sweep] processed ${perRfqStats.length} RFQ${perRfqStats.length === 1 ? '' : 's'}, ${mpnsToCancel.size} distinct MPNs in cancel set`);
  for (const s of perRfqStats.slice(0, 10)) {
    console.log(`  • RFQ ${s.rfq_number} (${s.customer}): ${s.mpns} MPNs`);
  }
  if (perRfqStats.length > 10) console.log(`  • ... and ${perRfqStats.length - 10} more`);

  // Apply to queue
  if (opts.dryRun) {
    const queue = readQueueSafe();
    const before = (queue.items || []).filter(i => i.status === 'pending').length;
    const { cancelled } = applyCancelManifests(queue, mpnsToCancel);
    console.log(`[sweep] [dry-run] would cancel ${cancelled} pending items (queue had ${before} pending)`);
  } else {
    let cancelled = 0;
    withQueueLock(() => {
      const queue = readQueueSafe();
      const before = (queue.items || []).filter(i => i.status === 'pending').length;
      const result = applyCancelManifests(queue, mpnsToCancel);
      cancelled = result.cancelled;
      if (cancelled > 0) writeQueueAtomic(queue);
      const after = (queue.items || []).filter(i => i.status === 'pending').length;
      console.log(`[sweep] cancelled ${cancelled} pending items. Queue pending: ${before} → ${after}`);
    });
  }

  // Advance watermark
  // If we processed everything (no cap hit), advance to NOW.
  // If we hit the cap, advance to the last-processed RFQ's `updated` so the
  // next run picks up RFQs newer than that.
  if (!opts.dryRun) {
    const newWatermark = (hitLimit && lastProcessedUpdated)
      ? new Date(lastProcessedUpdated).toISOString()
      : new Date().toISOString();
    writeWatermark(newWatermark);
    console.log(`[sweep] watermark advanced to ${newWatermark}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(`[sweep] fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
