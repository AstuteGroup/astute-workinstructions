#!/usr/bin/env node
/**
 * vq-loading-resumer — picks up parked VQ loads after rfq-loading creates
 * the new RFQ, AND replays OT-down deferred writes for stockrfq.
 *
 * Triggered by: cron, every ~10 min.
 *
 * Handles two sidecar types:
 *
 * 1. VQ `waiting_for_new_rfq` — parked VQ loads awaiting rfq-loading to
 *    create the new RFQ. Resumes via loadBulkSummary once the breadcrumb
 *    shows the RFQ exists.
 *
 * 2. StockRFQ `ot_unreachable_retry` — deferred RFQ writes when OT was
 *    unreachable mid-write. Silently retries when OT recovers. No operator
 *    notification for transient infra issues — only notify if TTL expires.
 *
 * TTL handling:
 *   Sidecars past their `expires_at` (7 days) are surfaced to the operator
 *   via email and a `parked-expired` breadcrumb. Sidecar stays in place for
 *   the operator to triage; the resumer stops retrying it.
 *
 * Flags:
 *   --dry-run        Log what would happen without actually writing to OT
 *   --force-expired  Retry expired sidecars (ignore TTL, extend expiration)
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

function listVqSidecars() {
  if (!fs.existsSync(SIDECAR_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SIDECAR_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(SIDECAR_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && data.kind === 'waiting_for_new_rfq') {
        out.push({ file: full, data, type: 'vq' });
      }
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

function listStockrfqSidecars() {
  if (!fs.existsSync(STOCKRFQ_SIDECAR_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(STOCKRFQ_SIDECAR_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(STOCKRFQ_SIDECAR_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && data.kind === 'ot_unreachable_retry') {
        out.push({ file: full, data, type: 'stockrfq' });
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

/**
 * Resume a stockrfq ot_unreachable_retry sidecar.
 * These are deferred RFQ writes when OT was unreachable.
 * Silent retry — no notification unless TTL expires.
 * NOTE: TTL expiration is handled in batch by the main loop; this function
 * only handles the actual replay attempt.
 */
async function resumeStockrfq(sidecar) {
  const { file, data } = sidecar;

  // Probe OT before attempting replay
  let health;
  try {
    health = await probeOT();
  } catch (e) {
    log(`OT probe failed for stockrfq sidecar ${path.basename(file)}: ${e.message}`);
    return { status: 'waiting', file };
  }

  if (!health.up) {
    // OT still down — silent skip, retry next tick
    return { status: 'waiting', file };
  }

  // OT is up — replay the write
  const payload = data.payload;
  if (!payload) {
    log(`Stockrfq sidecar ${path.basename(file)} has no payload — skipping`);
    return { status: 'errored', file, error: 'no payload' };
  }

  // If existingRfqId is set, this is a backfill (header wrote, lines/mpns didn't).
  // Pass it through so writeRFQ skips the header and writes only missing children.
  if (data.existing_rfq_id) {
    payload.existingRfqId = data.existing_rfq_id;
    payload.existingSearchKey = data.existing_search_key;
  }

  // Sidecar replays bypass budget checking — they're recovery operations
  // for writes that were already authorized when first attempted.
  payload.skipBudgetCheck = true;

  log(`Resuming stockrfq sidecar ${path.basename(file)} → ${data.customer_name || 'unknown'} (${data.line_count} lines)`);

  let result;
  try {
    // Synthesize a minimal ctx for the writer
    const ctx = { uid: data.original_uid || null, dryRun: false };
    result = await stockRfqWrite(payload, ctx);
  } catch (e) {
    log(`stockRfqWrite threw for sidecar ${path.basename(file)}: ${e.message}`);
    breadcrumbs.write({
      cog: 'vq-loading-resumer',
      event: 'stockrfq-resume-error',
      sidecar_file: path.basename(file),
      original_uid: data.original_uid,
      error: e.message,
    });
    return { status: 'errored', file, error: e.message };
  }

  // Check if still deferred (OT went down during replay)
  if (result.deferred) {
    log(`stockRfqWrite deferred again for sidecar ${path.basename(file)} — OT down mid-write`);
    return { status: 'waiting', file };
  }

  // Check for errors
  if (result.errors && result.errors.length > 0) {
    log(`stockRfqWrite had errors for sidecar ${path.basename(file)}: ${result.errors.join(', ')}`);
    breadcrumbs.write({
      cog: 'vq-loading-resumer',
      event: 'stockrfq-resume-partial',
      sidecar_file: path.basename(file),
      original_uid: data.original_uid,
      rfq_id: result.rfqId,
      search_key: result.searchKey,
      lines_written: result.linesWritten,
      errors: result.errors,
    });
    // Leave sidecar for retry if lines didn't fully write
    if (!result.rfqId || result.linesWritten === 0) {
      return { status: 'retry', file };
    }
  }

  // Success — clear sidecar
  breadcrumbs.write({
    cog: 'vq-loading-resumer',
    event: 'stockrfq-resumed',
    sidecar_file: path.basename(file),
    original_uid: data.original_uid,
    rfq_id: result.rfqId,
    search_key: result.searchKey,
    lines_written: result.linesWritten,
    customer_name: data.customer_name,
  });

  try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
  log(`Stockrfq sidecar ${path.basename(file)} resumed → RFQ ${result.searchKey} (${result.linesWritten} lines)`);
  return { status: 'resumed', file, searchKey: result.searchKey, written: result.linesWritten };
}

const FORCE_EXPIRED = process.argv.includes('--force-expired');
const DRY_RUN = process.argv.includes('--dry-run');

(async function main() {
  log('tick start' + (FORCE_EXPIRED ? ' [--force-expired]' : '') + (DRY_RUN ? ' [--dry-run]' : ''));

  // Collect sidecars from both workflows
  const vqSidecars = listVqSidecars();
  const stockrfqSidecars = listStockrfqSidecars();
  const totalCount = vqSidecars.length + stockrfqSidecars.length;

  if (totalCount === 0) {
    log('no sidecars pending');
    log('tick end (0 processed)');
    process.exit(0);
  }

  log(`found ${vqSidecars.length} VQ sidecar(s), ${stockrfqSidecars.length} stockrfq sidecar(s)`);

  let resumed = 0, waiting = 0, expired = 0, retry = 0, errored = 0;

  // Process VQ sidecars (waiting_for_new_rfq)
  for (const s of vqSidecars) {
    const out = await resumeOne(s);
    if (out.status === 'resumed') resumed++;
    else if (out.status === 'waiting') waiting++;
    else if (out.status === 'expired') expired++;
    else if (out.status === 'retry') retry++;
    else errored++;
  }

  // Process stockrfq sidecars (ot_unreachable_retry)
  // Check OT health once upfront — if OT is down, skip all stockrfq replays.
  let otUp = false;
  if (stockrfqSidecars.length > 0) {
    try {
      const health = await probeOT();
      otUp = health.up;
      if (!otUp) {
        log(`OT unreachable (${health.reason}) — skipping ${stockrfqSidecars.length} stockrfq sidecars`);
      }
    } catch (e) {
      log(`OT probe error: ${e.message} — skipping stockrfq sidecars`);
    }
  }

  // Collect expired sidecars for batch notification
  const expiredSidecars = [];

  for (const s of stockrfqSidecars) {
    // Check expiration first (skip if --force-expired)
    const expiresAt = s.data.expires_at ? Date.parse(s.data.expires_at) : null;
    const isExpired = expiresAt && Date.now() > expiresAt;

    if (isExpired && !FORCE_EXPIRED) {
      expiredSidecars.push(s);
      expired++;
      continue;
    }

    // If --force-expired and sidecar was expired, extend its TTL and log
    if (isExpired && FORCE_EXPIRED) {
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      s.data.expires_at = newExpiry;
      s.data.updated_at = new Date().toISOString();
      s.data.force_retry_at = new Date().toISOString();
      try {
        fs.writeFileSync(s.file, JSON.stringify(s.data, null, 2));
        log(`Extended TTL on expired sidecar ${path.basename(s.file)} → retry`);
      } catch (e) {
        log(`Failed to extend TTL on ${path.basename(s.file)}: ${e.message}`);
      }
    }

    // If OT is down, all non-expired sidecars just wait
    if (!otUp) {
      waiting++;
      continue;
    }

    const out = await resumeStockrfq(s);
    if (out.status === 'resumed') resumed++;
    else if (out.status === 'waiting') waiting++;
    else if (out.status === 'expired') { expired++; expiredSidecars.push(s); }
    else if (out.status === 'retry') retry++;
    else errored++;
  }

  // Send ONE batch notification for all expired sidecars (skip if --force-expired since we're retrying)
  if (expiredSidecars.length > 0 && !FORCE_EXPIRED) {
    const lines = expiredSidecars.map(s =>
      `<li><b>${esc(s.data.customer_name || 'Unknown')}</b> — ${s.data.line_count} line(s), UID ${s.data.original_uid}, file: <code>${path.basename(s.file)}</code></li>`
    ).join('\n');
    try {
      await notifier.sendEmail(
        JAKE_EMAIL,
        `[StockRFQ Resumer] ${expiredSidecars.length} parked RFQ(s) expired — triage needed`,
        `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h3 style="color:#b00">${expiredSidecars.length} Parked Stock RFQ(s) past TTL</h3>
<p>These RFQs were parked due to OT being unreachable, but haven't been replayed within 7 days:</p>
<ul>${lines}</ul>
<p>Inspect <code>~/workspace/.stockrfq-pending/</code> and manually load if needed, or delete the sidecars if the RFQs are stale.</p>
</body></html>`,
        { html: true },
      );
      log(`Sent batch expiration notification for ${expiredSidecars.length} sidecars`);
    } catch (e) {
      log(`Failed to send batch expiration notification: ${e.message}`);
    }
    // Write breadcrumbs for each expired sidecar
    for (const s of expiredSidecars) {
      breadcrumbs.write({
        cog: 'vq-loading-resumer',
        event: 'stockrfq-parked-expired',
        sidecar_file: path.basename(s.file),
        original_uid: s.data.original_uid,
        customer_name: s.data.customer_name,
        line_count: s.data.line_count,
        expires_at: s.data.expires_at,
      });
    }
  }

  log(`tick end (resumed=${resumed} waiting=${waiting} expired=${expired} retry=${retry} errored=${errored})`);
  process.exit(0);
})().catch(e => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
