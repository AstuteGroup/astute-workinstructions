/**
 * shared/large-payload-gate.js
 *
 * Generic approval-gate state machine for any "pause until operator clears it"
 * pattern. Factor of large-rfq-gate.js — the RFQ-specific bits (fetching RFQ
 * context, scanning the franchise API cache, rendering RFQ approval HTML) stay
 * in large-rfq-gate.js. THIS module is just the sentinel/cleared/rejected/
 * processed bookkeeping, parameterized by `kind` and `sentinelDir`.
 *
 * Each consumer instantiates one gate per kind:
 *
 *   const { createGate } = require('./large-payload-gate');
 *   const gate = createGate({
 *     kind: 'rfq',                                  // namespace label
 *     sentinelDir: '~/workspace/.large-rfq-pending', // one dir per kind
 *     defaultThreshold: 5000,                       // fallback threshold
 *     envOverride: 'LARGE_RFQ_THRESHOLD',           // env var to override
 *   });
 *
 *   if (lineCount > gate.threshold() && !gate.hasSentinel(id)) {
 *     gate.writeSentinel(id, { ...whateverContextYouWantToStore });
 *     // ... send approval email
 *   }
 *   if (gate.isCleared(id) && !gate.isProcessed(id)) {
 *     // ... do the work, then:
 *     gate.markProcessed(id);
 *   }
 *
 * State directory (per gate instance):
 *   <sentinelDir>/{id}.json       sentinel: pending, contains whatever context
 *                                 was passed to writeSentinel
 *   <sentinelDir>/{id}.cleared    approval flag (JSON body: { maxLines?,
 *                                 cacheOnly?, approvedAt, approvedBy?, note? })
 *   <sentinelDir>/{id}.rejected   rejection flag (JSON body: { reason?,
 *                                 rejectedAt, rejectedBy? })
 *   <sentinelDir>/{id}.processed  internal: work ran on the cleared sentinel
 *
 * Identity precedence per id:
 *   processed > rejected > cleared > pending (sentinel only) > nothing
 *
 * Each call returns either the stored JSON or a falsy value — never throws on
 * missing state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function createGate({ kind, sentinelDir, defaultThreshold = 5000, envOverride }) {
  if (!kind || typeof kind !== 'string') {
    throw new Error("large-payload-gate: 'kind' is required");
  }
  if (!sentinelDir || typeof sentinelDir !== 'string') {
    throw new Error("large-payload-gate: 'sentinelDir' (absolute path) is required");
  }

  const PENDING_DIR = sentinelDir;

  function threshold() {
    if (!envOverride) return defaultThreshold;
    const env = parseInt(process.env[envOverride], 10);
    return Number.isFinite(env) && env > 0 ? env : defaultThreshold;
  }

  function ensurePendingDir() {
    if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  }

  function sentinelPath(id)  { return path.join(PENDING_DIR, `${id}.json`); }
  function clearedPath(id)   { return path.join(PENDING_DIR, `${id}.cleared`); }
  function rejectedPath(id)  { return path.join(PENDING_DIR, `${id}.rejected`); }
  function processedPath(id) { return path.join(PENDING_DIR, `${id}.processed`); }

  function readJsonSafe(p, fallback = null) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { return fallback; }
  }

  function hasSentinel(id) { return fs.existsSync(sentinelPath(id)); }
  function isPending(id) {
    return hasSentinel(id)
      && !fs.existsSync(clearedPath(id))
      && !fs.existsSync(rejectedPath(id));
  }
  function isCleared(id) {
    const p = clearedPath(id);
    if (!fs.existsSync(p)) return null;
    return readJsonSafe(p, { approved: true });
  }
  function isRejected(id) {
    const p = rejectedPath(id);
    if (!fs.existsSync(p)) return null;
    return readJsonSafe(p, { rejected: true });
  }
  function isProcessed(id) { return fs.existsSync(processedPath(id)); }

  function writeSentinel(id, meta) {
    ensurePendingDir();
    const payload = {
      ...meta,
      _gate_kind: kind,
      queued_at: meta && meta.queued_at ? meta.queued_at : new Date().toISOString(),
    };
    fs.writeFileSync(sentinelPath(id), JSON.stringify(payload, null, 2));
    return payload;
  }

  function markApproved(id, opts = {}) {
    ensurePendingDir();
    fs.writeFileSync(clearedPath(id), JSON.stringify({
      approved: true,
      maxLines: Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0
        ? Number(opts.maxLines) : null,
      cacheOnly: opts.cacheOnly === true,
      approvedAt: new Date().toISOString(),
      approvedBy: opts.approvedBy || null,
      note: opts.note || null,
    }, null, 2));
  }

  function markRejected(id, opts = {}) {
    ensurePendingDir();
    fs.writeFileSync(rejectedPath(id), JSON.stringify({
      rejected: true,
      reason: opts.reason || null,
      rejectedAt: new Date().toISOString(),
      rejectedBy: opts.rejectedBy || null,
    }, null, 2));
  }

  function markProcessed(id) {
    ensurePendingDir();
    fs.writeFileSync(processedPath(id), JSON.stringify({
      processedAt: new Date().toISOString(),
    }, null, 2));
  }

  /**
   * Return cleared sentinels that haven't been processed yet — used by
   * the work-processing tick to pick up approvals that arrived after the
   * watermark moved past the original detection point.
   *
   * Each returned object is the stored sentinel JSON merged with:
   *   _id          the id (filename stem) — convenience for callers that
   *                don't want to depend on knowing which field carries the id
   *                in the stored meta
   *   _approval    the parsed .cleared JSON
   */
  function listClearedUnprocessed() {
    if (!fs.existsSync(PENDING_DIR)) return [];
    const files = fs.readdirSync(PENDING_DIR);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.cleared')) continue;
      const id = f.slice(0, -'.cleared'.length);
      if (isProcessed(id)) continue;
      const sentinel = readJsonSafe(sentinelPath(id));
      const cleared = readJsonSafe(clearedPath(id), { approved: true });
      if (!sentinel) continue;  // sentinel deleted, nothing to do
      out.push({ ...sentinel, _id: id, _approval: cleared });
    }
    return out;
  }

  return {
    kind,
    pendingDir: PENDING_DIR,
    threshold,
    sentinelPath, clearedPath, rejectedPath, processedPath,
    hasSentinel, isPending, isCleared, isRejected, isProcessed,
    writeSentinel,
    markApproved, markRejected, markProcessed,
    listClearedUnprocessed,
  };
}

module.exports = { createGate };
