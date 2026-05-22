/**
 * shared/writer-attribution.js
 *
 * Per-row writer-outcome persistence for email-driven workflow handlers.
 *
 * Why this exists
 * ---------------
 * Before 2026-05-22, handlers wrote one summary `loaded` breadcrumb capturing
 * bucket COUNTS (written:N, skipped:N, failed:N) but NOT the per-row reasons.
 * On UID 8541 (RFQ 1133479, Ivy 5/21), the breadcrumb said
 * `failed:73, detail:unknown` — and we could not tell *why* any of those 73
 * fell over without re-running the agent (non-deterministic, expensive).
 *
 * This module appends one JSONL row per failed / skipped quote to a central
 * log so the next post-mortem doesn't need a replay.
 *
 * File: ~/workspace/.writer-attribution.jsonl
 *   - One file across all workflows (workflow tagged on every row).
 *   - Append-only. No rotation today; small grow rate (failures and skips
 *     only, not writes).
 *
 * Counterpart for SUCCESSFUL writes already exists at
 * ~/workspace/.vq-batch-attribution.jsonl for vq-loading specifically. This
 * file is the dual for failures + intentional skips.
 *
 * Writer-result shapes handled:
 *
 *   Bucket-style (loadBulkSummary, writeVQFromAPI/Batch, writeCQ/Batch):
 *     result = { written, skipped, failed, [flagged] }
 *     Each row in skipped/failed/flagged is a quote object plus reason/detail.
 *
 *   Count-style (writeRFQ, writeOffer):
 *     result = { ..., errors: [string, string, ...] }
 *     Errors are bare strings (no per-row context); persisted as-is so the
 *     trail is preserved, but they carry less forensic value than bucket-style
 *     rows.
 *
 * Caller contract:
 *   persistWriterDetails({ workflow, ctx, result })
 *     - workflow:  'vq-loading' | 'stockrfq' | 'stockrfq-cq' | 'excess' | etc.
 *     - ctx:       handler ctx (must have .uid; .currentMessageId optional)
 *     - result:    writer return value (bucket or count shape; auto-detected)
 *   Returns { written: N } — how many JSONL rows were appended (0 if nothing
 *   to persist).
 *
 *   Never throws on the persistence path. Failure to log must not fail the
 *   load itself.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(
  process.env.HOME || '/home/analytics_user',
  'workspace',
  '.writer-attribution.jsonl',
);

function appendLines(lines) {
  if (!lines.length) return;
  try {
    fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n');
  } catch (_) {
    // best-effort; never fail the load on a log write
  }
}

/**
 * Persist per-row writer outcomes (failures + skips) to the central JSONL.
 *
 * @param {object} opts
 * @param {string} opts.workflow         workflow name (e.g., 'vq-loading')
 * @param {object} opts.ctx              handler ctx
 * @param {object} opts.result           writer return value
 * @returns {{ written: number }}        rows appended
 */
function persistWriterDetails({ workflow, ctx, result }) {
  if (!result || typeof result !== 'object') return { written: 0 };

  const ts = new Date().toISOString();
  const base = {
    ts,
    workflow,
    sourceUid: (ctx && ctx.uid) || null,
    messageId: (ctx && ctx.currentMessageId) || null,
  };

  const out = [];

  // Bucket-style: failed[] / skipped[] / flagged[] arrays of row objects
  for (const bucket of ['failed', 'skipped', 'flagged']) {
    const rows = result[bucket];
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      out.push(JSON.stringify({
        ...base,
        bucket,
        reason: r.reason || null,
        detail: r.detail || r.error || null,
        // Capture the row's identifying fields. Different writers attach
        // different keys (vendorName vs vendor, mpn, mfr/mfrText, cost/price,
        // qty, bpId, vqLineId for skipped dups, etc.) — include all of them
        // verbatim so the post-mortem has the full picture.
        row: {
          mpn:            r.mpn || null,
          vendor:         r.vendor || r.vendorName || null,
          vendorSearchKey:r.vendorSearchKey || null,
          mfr:            r.mfr || r.mfrText || null,
          qty:            r.qty != null ? r.qty : null,
          cost:           r.cost != null ? r.cost : (r.price != null ? r.price : null),
          bpId:           r.bpId || null,
          vqLineId:       r.vqLineId || null,
          cqLineId:       r.cqLineId || null,
          existingId:     r.existingCqLineId || null,
          rfqLineId:      r.rfqLineId || null,
          cpc:            r.cpc || null,
          channel:        r.channel || null,
        },
      }));
    }
  }

  // Count-style: errors[] is an array of strings (rfq-writer, offer-writeback)
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    for (const errStr of result.errors) {
      out.push(JSON.stringify({
        ...base,
        bucket: 'errors',
        reason: 'WRITE_ERROR',
        detail: typeof errStr === 'string' ? errStr : JSON.stringify(errStr),
        row: null,  // count-style writers don't expose per-row context
      }));
    }
  }

  appendLines(out);
  return { written: out.length };
}

/**
 * Read recent attribution rows for a given workflow + (optional) messageId.
 * Used by post-mortem and ad-hoc forensic scripts.
 *
 * @param {object} [opts]
 * @param {string} [opts.workflow]
 * @param {string} [opts.messageId]
 * @param {string} [opts.bucket]   'failed' | 'skipped' | 'flagged' | 'errors'
 * @param {number} [opts.sinceMs]  cutoff timestamp; default last 30 days
 * @returns {object[]}             matching rows, newest last
 */
function readAttribution(opts = {}) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const sinceMs = opts.sinceMs != null
    ? opts.sinceMs
    : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj.ts) continue;
    if (Date.parse(obj.ts) < sinceMs) continue;
    if (opts.workflow && obj.workflow !== opts.workflow) continue;
    if (opts.messageId && obj.messageId !== opts.messageId) continue;
    if (opts.bucket && obj.bucket !== opts.bucket) continue;
    out.push(obj);
  }
  return out;
}

module.exports = {
  persistWriterDetails,
  readAttribution,
  LOG_FILE,
};
