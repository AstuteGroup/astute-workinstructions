#!/usr/bin/env node
/**
 * vq-loading-resumer — picks up parked VQ loads after rfq-loading creates
 * the new RFQ.
 *
 * Triggered by: cron, every ~10 min.
 *
 * Inputs:
 *   - Sidecars under `~/workspace/.vq-loading-pending/*.json` with
 *     `kind === 'waiting_for_new_rfq'` (written by
 *     `action_forward_to_rfq_loading` in vq-loading.js).
 *   - Breadcrumbs at `~/workspace/.offer-pipeline/breadcrumbs.jsonl` —
 *     looks for `rfq-loader-daemon` `rfq-loaded` events whose `messageId`
 *     matches a sidecar's `forwarded_message_id` (correlation key).
 *
 * Per matched sidecar:
 *   1. Call loadBulkSummary against the new RFQ's searchKey with the
 *      sidecar's parked quotes.
 *   2. On success: clear the sidecar, emit a `resumed-load` breadcrumb,
 *      log the result.
 *   3. On failure: leave the sidecar in place (next tick will retry).
 *
 * TTL handling:
 *   Sidecars past their `expires_at` (7 days) are surfaced to the operator
 *   via email and a `parked-expired` breadcrumb. Sidecar stays in place for
 *   the operator to triage; the resumer stops retrying it.
 *
 * Exit codes:
 *   0  - one tick completed cleanly (zero or more sidecars processed)
 *   1  - fatal setup error (no env, breadcrumb file unreadable, etc.)
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const ROOT = process.env.HOME || '/home/analytics_user';
const SIDECAR_DIR = path.join(ROOT, 'workspace', '.vq-loading-pending');
const STOCKRFQ_SIDECAR_DIR = path.join(ROOT, 'workspace', '.stockrfq-pending');
const BREADCRUMBS = path.join(ROOT, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');

const { loadBulkSummary } = require('../shared/load-bulk-summary');
const breadcrumbs = require('../shared/breadcrumbs');
const { createNotifier } = require('../shared/notifier');
const { probeOT } = require('../shared/ot-health');
// Replays a parked stockrfq RFQ (fresh, or backfill via existingRfqId).
const { doWriteRFQ: stockRfqWrite } = require('../shared/workflow-actions/stockrfq');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const JAKE_EMAIL = 'jake.harris@astutegroup.com';
const notifier = createNotifier({
  fromEmail: 'vq@orangetsunami.com',
  fromName: 'VQ Loading Resumer',
});

function log(msg) {
  const line = `${new Date().toISOString()} resumer: ${msg}`;
  console.log(line);
}

function listSidecars() {
  if (!fs.existsSync(SIDECAR_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SIDECAR_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(SIDECAR_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && data.kind === 'waiting_for_new_rfq') {
        out.push({ file: full, data });
      }
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

function findRfqLoadedBreadcrumb(forwardedMessageId) {
  if (!fs.existsSync(BREADCRUMBS)) return null;
  if (!forwardedMessageId) return null;
  // Reverse scan so the most recent match wins. The breadcrumb file is
  // append-only; reading the tail captures the latest state.
  const raw = fs.readFileSync(BREADCRUMBS, 'utf8');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.cog !== 'rfq-loader-daemon') continue;
    if (obj.event !== 'rfq-loaded') continue;
    if (obj.messageId !== forwardedMessageId) continue;
    return obj;
  }
  return null;
}

async function resumeOne(sidecar) {
  const { file, data } = sidecar;
  const forwardedMid = data.forwarded_message_id;
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : null;

  // TTL check first — don't waste a DB call if the sidecar is already expired.
  if (expiresAt && Date.now() > expiresAt) {
    breadcrumbs.write({
      cog: 'vq-loading-resumer',
      event: 'parked-expired',
      sidecar_file: path.basename(file),
      forwarded_message_id: forwardedMid,
      forwarded_at: data.forwarded_at,
      expires_at: data.expires_at,
      pending_quote_count: (data.pending_quotes || []).length,
      correlation: data.correlation || null,
    });
    try {
      await notifier.sendEmail(
        JAKE_EMAIL,
        `[VQ Resumer] Parked load expired — operator triage needed`,
        `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h3 style="color:#b00">Parked VQ load past TTL</h3>
<p>A VQ load was parked on <code>${forwardedMid}</code> (forwarded to rfqloading@) but no matching <code>rfq-loaded</code> breadcrumb has appeared after 7 days.</p>
<p>Pending quotes: <b>${(data.pending_quotes || []).length}</b><br/>
Correlation: <code>${JSON.stringify(data.correlation || {})}</code><br/>
Forwarded at: ${data.forwarded_at}<br/>
Sidecar: <code>${path.basename(file)}</code></p>
<p>Likely causes: (a) rfq-loading agent silently rejected the forward, (b) rfq-loader-daemon failed to write the breadcrumb, or (c) the new RFQ was created but under a different Message-ID. Inspect <code>~/workspace/.vq-loading-pending/${path.basename(file)}</code> and the rfq-loader-daemon log for details.</p>
</body></html>`,
        { html: true },
      );
    } catch (_) { /* best-effort */ }
    return { status: 'expired', file };
  }

  const match = findRfqLoadedBreadcrumb(forwardedMid);
  if (!match) {
    // Not yet — the rfq-loading agent hasn't finished creating the RFQ.
    return { status: 'waiting', file };
  }

  const searchKey = match.searchKey;
  if (!searchKey) {
    log(`Found rfq-loaded breadcrumb for ${forwardedMid} but no searchKey — skipping until next tick`);
    return { status: 'waiting', file };
  }

  log(`Resuming sidecar ${path.basename(file)} → RFQ ${searchKey} (${(data.pending_quotes || []).length} quotes)`);

  let result;
  try {
    result = await loadBulkSummary({
      rfqSearchKey: searchKey,
      buyerId: data.proposed_buyer_id || 1000004,  // default to Jake if sidecar didn't capture one
      quotes: data.pending_quotes || [],
    });
  } catch (e) {
    log(`loadBulkSummary threw for sidecar ${path.basename(file)}: ${e.message}`);
    breadcrumbs.write({
      cog: 'vq-loading-resumer',
      event: 'resume-load-error',
      sidecar_file: path.basename(file),
      forwarded_message_id: forwardedMid,
      rfq_search_key: searchKey,
      error: e.message,
    });
    return { status: 'errored', file, error: e.message };
  }

  breadcrumbs.write({
    cog: 'vq-loading-resumer',
    event: 'resumed-load',
    sidecar_file: path.basename(file),
    forwarded_message_id: forwardedMid,
    rfq_search_key: searchKey,
    new_rfq_id: match.rfqId,
    quotes_submitted: (data.pending_quotes || []).length,
    written: result.written.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  });

  // Clear the sidecar on a clean run (at least one quote wrote OR all
  // skipped as legitimate duplicates). Leave it for retry if every quote
  // failed — likely the RFQ's lines aren't fully indexed yet.
  const cleanRun = result.written.length > 0
    || (result.skipped.length > 0 && result.failed.length === 0);
  if (cleanRun) {
    try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    return { status: 'resumed', file, searchKey, written: result.written.length };
  }
  return { status: 'retry', file, failed: result.failed.length };
}

(async function main() {
  log('tick start');
  const sidecars = listSidecars();
  if (sidecars.length === 0) {
    log('no sidecars pending');
    log('tick end (0 processed)');
    process.exit(0);
  }
  log(`found ${sidecars.length} sidecar(s) with kind=waiting_for_new_rfq`);

  let resumed = 0, waiting = 0, expired = 0, retry = 0, errored = 0;
  for (const s of sidecars) {
    const out = await resumeOne(s);
    if (out.status === 'resumed') resumed++;
    else if (out.status === 'waiting') waiting++;
    else if (out.status === 'expired') expired++;
    else if (out.status === 'retry') retry++;
    else errored++;
  }
  log(`tick end (resumed=${resumed} waiting=${waiting} expired=${expired} retry=${retry} errored=${errored})`);
  process.exit(0);
})().catch(e => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
