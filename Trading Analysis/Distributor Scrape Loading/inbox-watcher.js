/**
 * Distributor Scrape Inbox Watcher
 *
 * Polls ~/workspace/inbox/<source>/ for files the per-source mapper at
 * `mappers/<source>.js` recognizes as processable, then dispatches each via
 * the mapper's `processExport()`. Source-agnostic: adding a new disty means
 * dropping files in `inbox/<slug>/` + creating `mappers/<slug>.js`. No watcher
 * changes needed.
 *
 * Two supported file patterns (per desktop-scraper-contract.md § Adapter Patterns):
 *   - Pattern A/B: canonical JSON envelope (scrape-*.json). The generic JSON
 *     mapper (mappers/json-envelope.js, if/when needed) handles validation +
 *     writeVQBatch. Not used by any source today.
 *   - Pattern C:   raw export (xlsx/csv) + meta sidecar in outbox/<source>/.
 *     Each per-source mapper (mappers/heilind.js, etc.) handles parsing +
 *     writes via writeVQBatch + writePricingResult + negCache.
 *
 * On success the envelope is DELETED (not archived); the .result.json sidecar
 * in done/<YYYY-MM-DD>/<source>/<filename>.result.json is the audit record.
 * The paired outbox .meta.json (if any) is deleted too — its job ended with
 * this load. On failure the envelope is moved to failed/<source>/ for review.
 *
 * Result sidecars: ~/workspace/inbox/done/<YYYY-MM-DD>/<source>/<filename>.result.json
 * Failures:       ~/workspace/inbox/failed/<source>/<filename>.error.json
 *
 * Per-mapper interface (mappers/<source>.js MUST export):
 *   processExport({exportPath, sidecarPath, dryRun}) → result
 *   autoPairSidecar(exportPath)                       → string|null
 *   isProcessableFile(filename)                       → boolean
 *
 * Cron: every 15 minutes, gated via cron-runner.js (single-instance lock).
 *
 * Manual:
 *   node inbox-watcher.js                    # process current inbox, exit
 *   node inbox-watcher.js --dry-run          # parse/validate only, no writes
 *   node inbox-watcher.js --source=heilind   # only process one source folder
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Repo-relative resolution — keep portable if work-instructions moves.
// shared/ lives two levels up from "Trading Analysis/<wf>/".
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(REPO_ROOT, 'shared');
const MAPPERS_DIR = path.join(__dirname, 'mappers');

const { createNotifier } = require(path.join(SHARED, 'notifier'));
const logger = require(path.join(SHARED, 'logger')).createLogger('ScrapeInboxWatcher');

const WORKMAIL_PASS = process.env.WORKMAIL_PASS;
const NOTIFIER_FROM = process.env.SCRAPE_NOTIFIER_FROM || 'stockRFQ@orangetsunami.com';
const notifier = createNotifier({
  fromEmail: NOTIFIER_FROM,
  fromName: 'Distributor Scrape Loading',
  smtpUser: NOTIFIER_FROM,
  smtpPass: WORKMAIL_PASS,
});

// ─── Paths ──────────────────────────────────────────────────────────────────

const INBOX = path.join(process.env.HOME, 'workspace', 'inbox');
const DONE_ROOT = path.join(INBOX, 'done');
const FAILED = path.join(INBOX, 'failed');
const PROCESSING_TTL_MS = 5 * 60 * 1000;  // stale `.processing` markers expire after 5 min
const ROLLUP_PATH = path.join(process.env.HOME, 'workspace', '.scrape-load-rollup.json');

// File suffixes that are NEVER primary files — sidecars, markers, results.
const SKIP_SUFFIXES = ['.processing', '.partial', '.error.json', '.result.json', '.meta.json'];

// Top-level subdirs under inbox/ that aren't source folders.
const RESERVED_DIRS = new Set(['done', 'failed']);

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SOURCE_FILTER = (args.find(a => a.startsWith('--source=')) || '').split('=')[1] || null;
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';

// ─── Bootstrap dirs ─────────────────────────────────────────────────────────

function ensureDirs() {
  for (const p of [INBOX, DONE_ROOT, FAILED]) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Mapper loading ─────────────────────────────────────────────────────────

const _mapperCache = new Map();

function loadMapper(source) {
  if (_mapperCache.has(source)) return _mapperCache.get(source);
  const mapperPath = path.join(MAPPERS_DIR, `${source}.js`);
  if (!fs.existsSync(mapperPath)) {
    _mapperCache.set(source, { error: `no mapper at mappers/${source}.js` });
    return _mapperCache.get(source);
  }
  try {
    const m = require(mapperPath);
    if (typeof m.processExport     !== 'function') return _store(source, { error: 'mapper missing processExport()' });
    if (typeof m.autoPairSidecar   !== 'function') return _store(source, { error: 'mapper missing autoPairSidecar()' });
    if (typeof m.isProcessableFile !== 'function') return _store(source, { error: 'mapper missing isProcessableFile()' });
    return _store(source, { mapper: m });
  } catch (e) {
    return _store(source, { error: `mapper load threw: ${e.message}` });
  }
}
function _store(source, val) { _mapperCache.set(source, val); return val; }

// ─── File discovery ─────────────────────────────────────────────────────────

function listSources() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX, { withFileTypes: true })
    .filter(d => d.isDirectory() && !RESERVED_DIRS.has(d.name))
    .map(d => d.name)
    .filter(n => !SOURCE_FILTER || n === SOURCE_FILTER);
}

function listFilesForSource(source) {
  const dir = path.join(INBOX, source);
  if (!fs.existsSync(dir)) return [];
  const { mapper, error } = loadMapper(source);
  if (error) return [];  // no mapper → can't dispatch; surfaced in processSource
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(n => !SKIP_SUFFIXES.some(s => n.endsWith(s)))
    .filter(n => mapper.isProcessableFile(n))
    .sort();
}

// ─── Processing markers (claim/release) ─────────────────────────────────────

function processingMarker(source, filename) {
  return path.join(INBOX, source, `${filename}.processing`);
}

function isStaleProcessingMarker(source, filename) {
  const m = processingMarker(source, filename);
  if (!fs.existsSync(m)) return false;
  return (Date.now() - fs.statSync(m).mtimeMs) > PROCESSING_TTL_MS;
}

function claim(source, filename) {
  const m = processingMarker(source, filename);
  if (fs.existsSync(m) && !isStaleProcessingMarker(source, filename)) {
    logger.info(`${source}/${filename}: already processing — skip`);
    return false;
  }
  fs.writeFileSync(m, String(process.pid));
  return true;
}

function release(source, filename) {
  const m = processingMarker(source, filename);
  if (fs.existsSync(m)) fs.unlinkSync(m);
}

// ─── Move helpers ───────────────────────────────────────────────────────────

function archiveResultAndCleanup({ source, filename, sidecarPath, result }) {
  // Once a file has been retrieved for actioning and the action succeeded, the
  // envelope itself isn't worth keeping — the .result.json sidecar is enough
  // for audit, and the writes are already in OT. We:
  //   1. Write .result.json into done/<date>/<source>/ (named after the envelope)
  //   2. Delete the inbox envelope
  //   3. Delete the paired outbox .meta.json sidecar (its job is done too —
  //      it existed only to re-attach RFQ context for this load)
  const doneDir = path.join(DONE_ROOT, todayDate(), source);
  fs.mkdirSync(doneDir, { recursive: true });
  const resultAnchorPath = path.join(doneDir, filename);
  writeResultSidecar(resultAnchorPath, result);

  fs.unlinkSync(path.join(INBOX, source, filename));

  let cleanedOutboxSidecar = false;
  if (sidecarPath && sidecarPath.includes(`${path.sep}outbox${path.sep}`) && fs.existsSync(sidecarPath)) {
    fs.unlinkSync(sidecarPath);
    cleanedOutboxSidecar = true;
  }
  return { resultPath: `${resultAnchorPath}.result.json`, cleanedOutboxSidecar };
}

function moveToFailed(source, filename) {
  const dest = path.join(FAILED, source, filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(INBOX, source, filename), dest);
  return dest;
}

function writeResultSidecar(filePath, result) {
  fs.writeFileSync(`${filePath}.result.json`, JSON.stringify(result, null, 2));
}

function writeErrorSidecar(filePath, error) {
  fs.writeFileSync(`${filePath}.error.json`, JSON.stringify({
    error: error.message,
    stack: error.stack,
    at: new Date().toISOString(),
  }, null, 2));
}

// ─── Rollup + email (per CLAUDE.md § Reporting cadence) ─────────────────────

function appendRollup(entry) {
  let rollup = [];
  if (fs.existsSync(ROLLUP_PATH)) {
    try { rollup = JSON.parse(fs.readFileSync(ROLLUP_PATH, 'utf8')); } catch { rollup = []; }
  }
  rollup.push(entry);
  fs.writeFileSync(ROLLUP_PATH, JSON.stringify(rollup, null, 2));
}

async function emailError(source, filename, error) {
  const body = [
    `Distributor scrape file failed to load.`,
    ``,
    `Source: ${source}`,
    `File:   ${filename}`,
    `Error:  ${error.message}`,
    ``,
    `Moved to ~/workspace/inbox/failed/${source}/. Error sidecar at`,
    `${filename}.error.json. Fix the source/mapper and re-ship if appropriate.`,
  ].join('\n');
  await notifier
    .sendEmail(OPERATOR_EMAIL, `[scrape-inbox] FAILED: ${source}/${filename}`, body)
    .catch(e => logger.error('notifier failed', e));
}

async function emailAnomaly(source, filename, result) {
  // Per-source mappers already email their own success summaries — the
  // watcher only emails when an anomaly surfaces that the mapper didn't
  // already raise (e.g., partial flag from writeVQBatch's needs-review).
  const totalFlagged = (result.writeResults || []).reduce(
    (s, r) => s + ((r.flagged && r.flagged.length) || 0), 0);
  const totalErrored = (result.writeResults || []).filter(r => r.error).length;
  if (totalFlagged === 0 && totalErrored === 0) return;
  const subject = `[scrape-inbox] ${source}/${filename}: ${totalFlagged} flagged, ${totalErrored} RFQ errors`;
  await notifier
    .sendEmail(OPERATOR_EMAIL, subject, JSON.stringify({
      source, filename, priced: result.priced, flagged: totalFlagged, errored: totalErrored,
    }, null, 2))
    .catch(e => logger.error('notifier failed', e));
}

// ─── Core: process one file ─────────────────────────────────────────────────

async function processOne(source, filename) {
  if (!claim(source, filename)) return { source, filename, skipped: true };

  const exportPath = path.join(INBOX, source, filename);
  const { mapper, error: mapperErr } = loadMapper(source);
  if (mapperErr) {
    logger.error(`${source}/${filename}: ${mapperErr}`);
    release(source, filename);
    return { source, filename, failed: true, error: mapperErr };
  }

  // Auto-pair sidecar via the mapper's own logic
  let sidecarPath;
  try {
    sidecarPath = mapper.autoPairSidecar(exportPath);
  } catch (e) {
    sidecarPath = null;
    logger.warn(`${source}/${filename}: autoPairSidecar threw — ${e.message}`);
  }
  if (!sidecarPath) {
    // No sidecar yet — could be that the export landed before the producer's
    // sidecar; or the file is junk. Hold off; next tick will retry.
    logger.info(`${source}/${filename}: no sidecar paired — will retry next tick`);
    release(source, filename);
    return { source, filename, skipped: true, reason: 'no_sidecar' };
  }

  logger.info(`${source}/${filename}: paired sidecar ${path.basename(sidecarPath)}${DRY_RUN ? ' (DRY-RUN)' : ''}`);

  let result;
  try {
    result = await mapper.processExport({ exportPath, sidecarPath, dryRun: DRY_RUN });
  } catch (e) {
    logger.error(`${source}/${filename}: mapper threw — ${e.message}`, e);
    if (!DRY_RUN) {
      writeErrorSidecar(exportPath, e);
      moveToFailed(source, filename);
      await emailError(source, filename, e);
    }
    release(source, filename);
    return { source, filename, failed: true, error: e.message };
  }

  if (DRY_RUN) {
    logger.info(`${source}/${filename}: DRY-RUN result — ${result.priced} priced, ${result.matched_no_price} no-price, ${result.not_carried} not-carried`);
    release(source, filename);
    return { source, filename, dryRun: true, ...result };
  }

  // Success: write .result.json sidecar to done/<date>/<source>/, delete the
  // envelope from inbox/<source>/, and delete the paired outbox .meta.json.
  // The mapper's own email summary fires inside processExport; the watcher
  // only fires an anomaly email if the result had flagged/errored RFQs.
  const cleanup = archiveResultAndCleanup({ source, filename, sidecarPath, result });
  if (cleanup.cleanedOutboxSidecar) {
    logger.info(`${source}/${filename}: cleaned paired outbox sidecar ${path.basename(sidecarPath)}`);
  }
  appendRollup({
    source, filename,
    priced: result.priced,
    matched_no_price: result.matched_no_price,
    not_carried: result.not_carried,
    rfqsAffected: result.rfqsAffected,
    at: new Date().toISOString(),
  });
  await emailAnomaly(source, filename, result);
  logger.info(`${source}/${filename}: loaded — ${result.priced} priced / ${result.matched_no_price} no-price / ${result.not_carried} not-carried`);
  release(source, filename);
  return { source, filename, processed: true, ...result };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  ensureDirs();
  const sources = listSources();
  if (sources.length === 0) {
    logger.info(`no source folders in ${INBOX}`);
    return;
  }

  const allFiles = [];
  for (const source of sources) {
    const { error } = loadMapper(source);
    if (error) {
      logger.warn(`${source}: ${error} — skipping folder`);
      continue;
    }
    for (const filename of listFilesForSource(source)) {
      allFiles.push({ source, filename });
    }
  }

  if (allFiles.length === 0) {
    logger.info(`no processable files across ${sources.length} source folder(s)`);
    return;
  }

  logger.info(`processing ${allFiles.length} file(s) across ${sources.length} source(s)${DRY_RUN ? ' (DRY-RUN)' : ''}`);
  const results = { processed: 0, failed: 0, skipped: 0 };
  for (const { source, filename } of allFiles) {
    const r = await processOne(source, filename);
    if (r.processed) results.processed++;
    else if (r.failed) results.failed++;
    else if (r.skipped) results.skipped++;
  }
  logger.info(`tick complete: ${results.processed} processed / ${results.failed} failed / ${results.skipped} skipped`);
}

main().catch(e => {
  logger.error('fatal', e);
  process.exit(1);
});
