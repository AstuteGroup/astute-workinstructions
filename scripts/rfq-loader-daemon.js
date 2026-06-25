#!/usr/bin/env node
/**
 * RFQ Loader Daemon — long-running process that loads queued RFQs concurrently
 *
 * Reads from the rfq-load-queue JSON file. Dispatches jobs to rfq-fast-loader.
 * Small RFQs (<500 lines) preempt large ones mid-load.
 *
 * LIFECYCLE:
 *   - Cron healthcheck (every 5 min) starts the daemon if not running
 *   - PID file prevents duplicate instances
 *   - Graceful shutdown on SIGTERM/SIGINT — writes checkpoint, releases PID
 *
 * USAGE:
 *   node rfq-loader-daemon.js              # normal daemon mode
 *   node rfq-loader-daemon.js --status     # show queue status and exit
 *   node rfq-loader-daemon.js --once       # process one job and exit (testing)
 *
 * LOG: /tmp/rfq-loader-daemon.log
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { loadRFQ } = require('../shared/rfq-fast-loader');
const queue = require('../shared/rfq-load-queue');
const { logout } = require('../shared/api-client');
const breadcrumbs = require('../shared/breadcrumbs');
const { createNotifier } = require('../shared/notifier');
const { resolveOutreachRecipients } = require('../shared/outreach-recipients');
const { execSync } = require('child_process');
const { evaluateFailureRate } = require('../shared/failure-rate-gate');
const writerAttribution = require('../shared/writer-attribution');

/**
 * Look up partner name from bpartnerId if not provided in payload.
 * Fallback for when agent doesn't pass partnerName.
 */
function lookupPartnerName(bpartnerId) {
  if (!bpartnerId) return null;
  try {
    const sql = `SELECT name FROM adempiere.c_bpartner WHERE c_bpartner_id = ${parseInt(bpartnerId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

/**
 * Look up RFQ type name from type ID.
 */
function lookupRfqTypeName(typeId) {
  if (!typeId) return null;
  try {
    const sql = `SELECT name FROM adempiere.chuboe_rfq_type WHERE chuboe_rfq_type_id = ${parseInt(typeId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

/**
 * Look up contact name from userId (ad_user_id).
 */
function lookupContactName(userId) {
  if (!userId) return null;
  try {
    const sql = `SELECT name FROM adempiere.ad_user WHERE ad_user_id = ${parseInt(userId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

// Notifier for confirmation emails
const notifier = createNotifier({
  fromEmail: 'rfqloading@orangetsunami.com',
  fromName: 'RFQ Loading',
});

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/analytics_user';
const PID_FILE = path.resolve(HOME, 'workspace/.rfq-loader-daemon.pid');
const LOG_FILE = '/tmp/rfq-loader-daemon.log';
const IDLE_POLL_MS = 10_000;       // 10s poll when queue empty
const WORKER_CONCURRENCY = 10;     // concurrent API workers per job
const PREEMPT_CHECK_INTERVAL = 50; // check for preemption every N completions

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(...args) {
  const line = `${new Date().toISOString()} - ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
}

// ─── PID FILE ────────────────────────────────────────────────────────────────

function claimPidFile() {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 0); // signal 0 = existence check
      log(`Already running (PID ${existingPid}), exiting.`);
      process.exit(0);
    } catch (e) {
      log(`Stale PID file (${existingPid} not running), claiming.`);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function releasePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
}

// ─── SIGNAL HANDLING ─────────────────────────────────────────────────────────

let shutdownRequested = false;
let currentAbortController = null;

function registerSignalHandlers() {
  process.on('SIGTERM', () => {
    log('SIGTERM received — requesting graceful shutdown');
    shutdownRequested = true;
    if (currentAbortController) currentAbortController.abort();
  });
  process.on('SIGINT', () => {
    log('SIGINT received — requesting graceful shutdown');
    shutdownRequested = true;
    if (currentAbortController) currentAbortController.abort();
  });
}

// ─── CRASH RECOVERY ──────────────────────────────────────────────────────────

function recoverInterruptedJobs() {
  const loading = queue.listItems('loading');
  for (const item of loading) {
    log(`Recovering interrupted job ${item.id} (was 'loading', checkpoint=${item.checkpoint})`);
    queue.updateItem(item.id, { status: 'queued' });
  }
  if (loading.length > 0) {
    log(`Recovered ${loading.length} interrupted job(s)`);
  }
}

// ─── JOB RUNNER ──────────────────────────────────────────────────────────────

async function runJob(item) {
  const ac = new AbortController();
  currentAbortController = ac;

  let preempted = false;

  const result = await loadRFQ({
    ...item.payload,
    rfqId: item.rfqId || undefined,
    startFrom: item.checkpoint || 0,
    concurrency: WORKER_CONCURRENCY,
    abortSignal: ac.signal,

    onProgress: (done, total, lps, eta) => {
      // Persist checkpoint periodically
      if (done % 100 === 0) {
        queue.updateItem(item.id, {
          linesWritten: done,
          checkpoint: done,
          lastProgressAt: new Date().toISOString(),
        });
      }

      // Check for preemption: only if we're a low-priority job
      if (item.priority === 'low' && done % PREEMPT_CHECK_INTERVAL === 0) {
        const head = queue.dequeue();
        if (head && head.priority === 'high' && head.id !== item.id) {
          log(`  Preempting ${item.id} at ${done}/${total} for high-priority ${head.id}`);
          preempted = true;
          ac.abort();
        }
      }

      log(`  [${item.id.slice(-8)}] ${done}/${total} (${lps.toFixed(1)}/s, ~${eta}s left)`);
    },
  });

  currentAbortController = null;

  // Handle preemption — save checkpoint and return to queue
  if (preempted || ac.signal.aborted) {
    const checkpoint = (item.checkpoint || 0) + result.linesWritten;
    queue.updateItem(item.id, {
      status: 'queued',
      rfqId: result.rfqId,
      searchKey: result.searchKey,
      checkpoint,
      linesWritten: checkpoint,
    });
    log(`  Job ${item.id} paused at checkpoint ${checkpoint}`);
    return;
  }

  // Job completed (or partial with errors)
  const totalWritten = (item.checkpoint || 0) + result.linesWritten;

  // Determine final status — must have actually created an RFQ and written lines
  // to be considered "loaded". Rate-limiting returns rfqId=null with errors now,
  // but defend against any path that returns null without writing.
  const actuallyLoaded = result.rfqId && totalWritten > 0;
  const finalStatus = !actuallyLoaded ? 'error' : (result.errors.length > 0 ? 'partial' : 'loaded');

  queue.updateItem(item.id, {
    status: finalStatus,
    rfqId: result.rfqId,
    searchKey: result.searchKey,
    linesWritten: totalWritten,
    mpnsWritten: (item.mpnsWritten || 0) + result.mpnsWritten,
    checkpoint: item.lineCount,
    errors: result.errors.slice(0, 20),
    completedAt: new Date().toISOString(),
  });

  // Stamp the breadcrumb that rfq-loading's action_enqueue checks for
  // future replay detection. Includes messageId from the queue payload (set
  // when the agent first enqueued) so hasMessageIdAlreadyLoaded() can match.
  // See shared/workflow-actions/rfq-loading.js — action_enqueue § Message-ID
  // idempotency guard for the receiving end of this contract.
  try {
    breadcrumbs.write({
      cog: 'rfq-loader-daemon',
      event: 'rfq-loaded',
      jobId: item.id,
      uid: item.payload && item.payload.sourceUid ? item.payload.sourceUid : null,
      messageId: item.payload && item.payload.messageId ? item.payload.messageId : null,
      rfqId: result.rfqId,
      searchKey: result.searchKey,
      linesWritten: totalWritten,
      errorCount: result.errors.length,
      finalStatus,
    });
  } catch (_) {
    // best-effort — never fail the load completion on a breadcrumb write
  }

  // ── Writer attribution: persist per-row error details to JSONL ─────────────
  // rfq-fast-loader returns count-style errors[]. writerAttribution handles both
  // bucket-style and count-style results. See shared/writer-attribution.js.
  const payload = item.payload || {};
  try {
    writerAttribution.persistWriterDetails({
      workflow: 'rfq-loading',
      ctx: {
        uid: payload.sourceUid || null,
        currentMessageId: payload.messageId || null,
      },
      result,
    });
  } catch (_) {
    // best-effort — never fail the load completion on an attribution write
  }

  // ── Failure rate evaluation ────────────────────────────────────────────────
  // Check if the load had an unhealthy failure rate. Alert operator if so.
  // Uses count-style result (linesWritten, errors[]) not bucket-style.
  const lineCount = item.lineCount || payload.lines?.length || 0;
  try {
    const gateEval = evaluateFailureRate({
      result: {
        linesWritten: totalWritten,
        errors: result.errors,
      },
      // Adjust minSubmitted since we're evaluating against total lines attempted
      minSubmitted: 10,
    });

    if (gateEval.flag && gateEval.severity !== 'none') {
      const customerName = payload.partnerName || lookupPartnerName(payload.bpartnerId) || '(unknown)';
      log(`  ⚠️  High failure rate detected: ${gateEval.reason}`);
      breadcrumbs.write({
        cog: 'rfq-loader-daemon',
        event: 'high-failure-rate',
        jobId: item.id,
        rfqId: result.rfqId,
        searchKey: result.searchKey,
        severity: gateEval.severity,
        reason: gateEval.reason,
        linesAttempted: lineCount,
        linesWritten: totalWritten,
        errorCount: result.errors.length,
        ratios: gateEval.ratios,
      });

      // Send alert email to operator
      const alertSubject = `⚠️ RFQ Load Alert: ${result.searchKey || 'unknown'} — ${gateEval.severity} failure rate`;
      const alertBody = `RFQ load completed with high failure rate.

RFQ #: ${result.searchKey || '(not created)'}
Customer: ${customerName}
Severity: ${gateEval.severity}
Reason: ${gateEval.reason}

Lines attempted: ${lineCount}
Lines written: ${totalWritten}
Errors: ${result.errors.length}
Failure rate: ${(gateEval.ratios.failed * 100).toFixed(1)}%

Sample errors:
${result.errors.slice(0, 5).map(e => `  • ${e}`).join('\n')}
${result.errors.length > 5 ? `  ... +${result.errors.length - 5} more` : ''}

— RFQ Loader Daemon (automated alert)`;

      await notifier.sendEmail('jake.harris@astutegroup.com', alertSubject, alertBody);
    }
  } catch (e) {
    log(`  Failure rate evaluation error: ${e.message}`);
  }

  // ── Send confirmation email to internal Astute people ─────────────────────
  // Mirrors the excess.js pattern: reply with the RFQ # so the forwarder knows
  // it was loaded successfully.
  //
  // IMPORTANT: Only send confirmation if actually loaded. Rate-limiting or
  // header-POST failures should NOT trigger a "success" email with null values.
  // Bug fix 2026-06-11: was sending "RFQ loaded, Customer: (unknown), RFQ #: null"
  // when rate-limited because errors[] was empty and we didn't check rfqId.
  if (!actuallyLoaded) {
    log(`  Skipping confirmation email — job ${finalStatus}, rfqId=${result.rfqId}, lines=${totalWritten}`);
  } else try {
    // payload already declared above in failure rate section
    const envelope = resolveOutreachRecipients({
      outerFrom: payload.originalSender,
      salesrepId: payload.salesrepId,
    }, {
      jakeEmail: 'jake.harris@astutegroup.com',
      inbox: 'rfqloading@orangetsunami.com',
      currentFrom: payload.originalSender,
      currentCc: payload.originalCc,
    });

    if (envelope.recipientList.length > 0) {
      const toEmail = envelope.recipientList[0];
      const ccList = envelope.recipientList.slice(1);

      // Look up metadata if not provided in payload
      const customerName = payload.partnerName || lookupPartnerName(payload.bpartnerId) || '(unknown)';
      const rfqTypeName = lookupRfqTypeName(payload.type) || '(unknown)';
      const sellerName = lookupContactName(payload.salesrepId) || '(unknown)';
      const description = payload.description || '';

      const confirmSubject = payload.originalSubject
        ? `Re: ${payload.originalSubject}`
        : `RFQ ${result.searchKey} loaded`;

      // Build confirmation body with all metadata
      let confirmBody = `RFQ loaded.

Customer: ${customerName}
RFQ #: ${result.searchKey}
Type: ${rfqTypeName}
Seller: ${sellerName}
Lines loaded: ${totalWritten}`;

      if (description) {
        confirmBody += `\nDescription: ${description}`;
      }

      confirmBody += `

This RFQ is now in Orange Tsunami.

— RFQ Loading System (automated)`;

      const threadingOpts = {};
      if (ccList.length > 0) threadingOpts.cc = ccList;
      if (payload.messageId) {
        threadingOpts.inReplyTo = payload.messageId;
        threadingOpts.references = payload.messageId;
      }

      await notifier.sendEmail(toEmail, confirmSubject, confirmBody, threadingOpts);

      breadcrumbs.write({
        cog: 'rfq-loader-daemon',
        event: 'confirmation-sent',
        jobId: item.id,
        rfqId: result.rfqId,
        searchKey: result.searchKey,
        customer: customerName,
        rfqType: rfqTypeName,
        seller: sellerName,
        linesLoaded: totalWritten,
        to: toEmail,
        cc: ccList,
      });
      log(`  Confirmation sent to ${envelope.recipientList.join(', ')}`);
    }
  } catch (e) {
    log(`  Confirmation email failed: ${e.message}`);
  }

  log(`Job ${item.id} ${finalStatus}: RFQ ${result.searchKey} (${result.rfqId}), ${totalWritten} lines, ${result.errors.length} errors, ${(result.elapsedMs / 1000).toFixed(1)}s`);
}

// ─── STATUS COMMAND ──────────────────────────────────────────────────────────

function showStatus() {
  const items = queue.listItems();
  if (items.length === 0) {
    console.log('Queue is empty.');
    return;
  }

  console.log(`\nRFQ Load Queue — ${items.length} item(s)\n`);
  console.log('  Status   | Priority | Lines  | Written | RFQ #      | ID');
  console.log('  ---------|----------|--------|---------|------------|---');
  for (const i of items) {
    console.log(`  ${(i.status || '').padEnd(8)} | ${(i.priority || '').padEnd(8)} | ${String(i.lineCount).padStart(6)} | ${String(i.linesWritten).padStart(7)} | ${String(i.searchKey || '-').padEnd(10)} | ${i.id.slice(-12)}`);
  }
  console.log('');
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);

  // --status: show queue and exit
  if (args.includes('--status')) {
    showStatus();
    process.exit(0);
  }

  const runOnce = args.includes('--once');

  claimPidFile();
  registerSignalHandlers();
  log(`Daemon started, PID ${process.pid}${runOnce ? ' (--once mode)' : ''}`);

  // Recover any jobs that were loading when we crashed
  recoverInterruptedJobs();

  // Prune old completed jobs
  const pruned = queue.pruneCompleted(7);
  if (pruned > 0) log(`Pruned ${pruned} old completed job(s)`);

  while (!shutdownRequested) {
    const item = queue.dequeue();

    if (!item) {
      if (runOnce) {
        log('--once mode: no jobs, exiting.');
        break;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }

    log(`Dispatching job ${item.id} (${item.lineCount} lines, priority=${item.priority}, checkpoint=${item.checkpoint})`);
    queue.updateItem(item.id, { status: 'loading', startedAt: item.startedAt || new Date().toISOString() });

    try {
      await runJob(item);
    } catch (e) {
      log(`Job ${item.id} FATAL: ${e.message}`);
      queue.updateItem(item.id, { status: 'error', lastError: e.message });
    }

    if (runOnce) {
      log('--once mode: job complete, exiting.');
      break;
    }
  }

  try { await logout(); } catch (e) { /* ignore */ }
  log('Daemon shutdown complete.');
  releasePidFile();
}

main().catch(e => {
  log('FATAL:', e.message);
  releasePidFile();
  process.exit(1);
});
