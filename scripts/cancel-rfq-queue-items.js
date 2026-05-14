#!/usr/bin/env node
/**
 * cancel-rfq-queue-items.js — write a cancel manifest for a rejected /
 * inactive RFQ and immediately purge matching items from the api retry queue.
 *
 * Built 2026-05-14 after RFQ 1134261 (rejected via large-rfq-gate 5/13) kept
 * grinding through 14,783 in-flight retry items for another 22 hours because
 * the gate's rejection sentinel didn't reach into the queue.
 *
 * USAGE:
 *   node cancel-rfq-queue-items.js <RFQ_NUMBER> [--reason "..."] [--dry-run]
 *
 * What it does:
 *   1. Looks up the RFQ by value (the display "RFQ #") in chuboe_rfq.
 *   2. Pulls every distinct, normalized MPN on the RFQ's active lines.
 *   3. Writes ~/workspace/.large-rfq-pending/{RFQ}.cancel-mpns.json — the
 *      manifest the worker scans each tick. This is the durable record.
 *   4. Under the queue advisory lock, marks any pending queue item whose
 *      decoded MPN matches as status='cancelled' and saves atomically.
 *      Doesn't wait for the next worker tick.
 *
 * Idempotent — re-running with the same RFQ is a no-op (manifest is
 * overwritten with identical contents; cancellation pass finds no pending
 * matches).
 *
 * Exit codes:
 *   0 — success (manifest written, queue cleaned)
 *   1 — RFQ not found, or DB / queue I/O failure
 *   2 — bad arguments
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

function parseArgs(argv) {
  const out = { rfqNumber: null, reason: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--reason') out.reason = argv[++i];
    else if (!a.startsWith('--') && !out.rfqNumber) out.rfqNumber = a;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.rfqNumber) {
    console.error('Usage: cancel-rfq-queue-items.js <RFQ_NUMBER> [--reason "..."] [--dry-run]');
    process.exit(2);
  }

  const pool = new Pool({
    host: '/var/run/postgresql',
    database: process.env.PGDATABASE || 'idempiere_replica',
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
  });

  // ─── Lookup MPNs ─────────────────────────────────────────────────────────
  // value column carries the operator-visible "RFQ #" (e.g. "1134261").
  // chuboe_rfq_id is the internal PK. We don't require isactive='Y' on the
  // RFQ itself — if the operator marked it inactive, we still want to purge
  // its in-flight retries. We DO scope lines to isactive='Y' on the line +
  // line_mpn rows so the manifest reflects current line state.
  const rfqRow = await pool.query(
    `SELECT chuboe_rfq_id, value, isactive, bpname
       FROM adempiere.chuboe_rfq
      WHERE value = $1
      ORDER BY chuboe_rfq_id DESC
      LIMIT 1`,
    [opts.rfqNumber]
  );
  if (rfqRow.rows.length === 0) {
    console.error(`error: no chuboe_rfq row with value='${opts.rfqNumber}'`);
    await pool.end();
    process.exit(1);
  }
  const rfq = rfqRow.rows[0];
  console.log(`RFQ ${rfq.value}: chuboe_rfq_id=${rfq.chuboe_rfq_id} isactive=${rfq.isactive} customer="${rfq.bpname || '?'}"`);

  const mpnRows = await pool.query(
    `SELECT DISTINCT rlm.chuboe_mpn
       FROM adempiere.chuboe_rfq_line rl
       JOIN adempiere.chuboe_rfq_line_mpn rlm
         ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
      WHERE rl.chuboe_rfq_id = $1 AND rl.isactive='Y'
        AND rlm.chuboe_mpn IS NOT NULL AND rlm.chuboe_mpn <> ''`,
    [rfq.chuboe_rfq_id]
  );

  const normalized = new Set();
  for (const r of mpnRows.rows) {
    const n = normalizeMpnForCancel(r.chuboe_mpn);
    if (n) normalized.add(n);
  }
  const mpnsArr = [...normalized].sort();
  console.log(`MPNs on RFQ ${rfq.value}: ${mpnsArr.length} distinct (normalized)`);

  // ─── Write manifest ──────────────────────────────────────────────────────
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  const manifestPath = path.join(PENDING_DIR, `${opts.rfqNumber}.cancel-mpns.json`);
  const manifest = {
    id: opts.rfqNumber,
    kind: 'rfq',
    chuboe_rfq_id: rfq.chuboe_rfq_id,
    reason: opts.reason || `RFQ ${opts.rfqNumber} cancelled`,
    written_at: new Date().toISOString(),
    written_by: process.env.USER || 'cli',
    mpns_normalized: mpnsArr,
  };

  if (opts.dryRun) {
    console.log(`[dry-run] would write manifest: ${manifestPath}`);
  } else {
    const tmp = `${manifestPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, manifestPath);
    console.log(`Wrote manifest: ${manifestPath}`);
  }

  // ─── Eager cleanup of in-flight queue items ──────────────────────────────
  // The worker will re-scan manifests on its next tick anyway, but we do it
  // here so the operator sees the queue collapse immediately and doesn't
  // have to wait up to 30 min for the next cron.
  const mpnsToCancel = new Map();
  for (const m of mpnsArr) mpnsToCancel.set(m, `rfq ${opts.rfqNumber}: ${manifest.reason}`);

  let cancelled = 0;
  let perReason = new Map();
  if (opts.dryRun) {
    // Dry-run: just count what would be cancelled, don't acquire the lock.
    const queue = readQueueSafe();
    const before = (queue.items || []).filter(i => i.status === 'pending').length;
    const result = applyCancelManifests(queue, mpnsToCancel);
    cancelled = result.cancelled;
    perReason = result.perReason;
    console.log(`[dry-run] would cancel ${cancelled} pending items (queue had ${before} pending before)`);
  } else {
    withQueueLock(() => {
      const queue = readQueueSafe();
      const before = (queue.items || []).filter(i => i.status === 'pending').length;
      const result = applyCancelManifests(queue, mpnsToCancel);
      cancelled = result.cancelled;
      perReason = result.perReason;
      if (cancelled > 0) writeQueueAtomic(queue);
      const after = (queue.items || []).filter(i => i.status === 'pending').length;
      console.log(`Cancelled ${cancelled} pending items. Queue pending: ${before} → ${after}`);
    });
  }

  await pool.end();
  console.log(`\nDone. RFQ ${opts.rfqNumber}: manifest persisted, ${cancelled} in-flight items cancelled.`);
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
