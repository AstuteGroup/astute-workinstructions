/**
 * Distributor Scrape Inbox Watcher
 *
 * Polls ~/workspace/inbox/ for scrape-*.json envelopes produced by the local
 * Windows Claude instance (see ./local-windows-CLAUDE.md). Validates each
 * envelope, then hands items to shared/vq-writer.js#writeVQBatch for VQ
 * loading. Files with no rfqSearchKey are recorded as pricing intel via
 * shared/api-result-writer.js#writePricingResult instead.
 *
 * Result sidecars land in ~/workspace/inbox/done/<YYYY-MM-DD>/.
 * Validation/load failures land in ~/workspace/inbox/failed/.
 *
 * Cron: every minute, gated via cron-runner.js (single-instance lock).
 *
 * Manual:
 *   node inbox-watcher.js                    # process current inbox, exit
 *   node inbox-watcher.js --dry-run          # parse + validate only
 *   node inbox-watcher.js --file=NAME.json   # process one named file
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Repo-relative resolution — keep this script portable if the work-instructions
// directory ever moves. shared/ lives two levels up from "Trading Analysis/<wf>/".
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(REPO_ROOT, 'shared');

const { writeVQBatch } = require(path.join(SHARED, 'vq-writer'));
const { writePricingResult } = require(path.join(SHARED, 'api-result-writer'));
const { createNotifier } = require(path.join(SHARED, 'notifier'));
const logger = require(path.join(SHARED, 'logger')).createLogger('ScrapeInboxWatcher');

// .env (WORKMAIL_PASS) is loaded by ~/workspace/.env via the cron-runner's
// dotenv preload (consistent with other shared cogs).
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
const PROCESSING_TTL_MS = 5 * 60 * 1000; // stale `.processing` markers expire after 5 min

const ROLLUP_PATH = path.join(process.env.HOME, 'workspace', '.scrape-load-rollup.json');

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SPECIFIC_FILE = (args.find(a => a.startsWith('--file=')) || '').split('=')[1] || null;
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';

// ─── Bootstrap dirs ─────────────────────────────────────────────────────────

function ensureDirs() {
  for (const p of [INBOX, DONE_ROOT, FAILED]) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

// ─── Schema validation ──────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

function validateEnvelope(env) {
  if (env == null || typeof env !== 'object') throw new ValidationError('$', 'envelope is not an object');
  if (env.version !== 1) throw new ValidationError('$.version', `must be 1, got ${env.version}`);
  if (env.type !== 'distributor_scrape') throw new ValidationError('$.type', `must be "distributor_scrape", got ${env.type}`);
  if (typeof env.createdAt !== 'string') throw new ValidationError('$.createdAt', 'must be an ISO-8601 string');
  if (typeof env.operator !== 'string') throw new ValidationError('$.operator', 'must be a string');
  if (typeof env.source !== 'string') throw new ValidationError('$.source', 'must be a string');
  if (env.rfqSearchKey != null && typeof env.rfqSearchKey !== 'string') {
    throw new ValidationError('$.rfqSearchKey', 'must be a string when present');
  }
  if (!Array.isArray(env.items) || env.items.length === 0) {
    throw new ValidationError('$.items', 'must be a non-empty array');
  }

  env.items.forEach((item, i) => {
    const p = `$.items[${i}]`;
    if (!item || typeof item !== 'object') throw new ValidationError(p, 'must be an object');
    if (typeof item.searchedMpn !== 'string' || !item.searchedMpn.trim()) {
      throw new ValidationError(`${p}.searchedMpn`, 'required, non-empty string');
    }
    if (!item.franchiseResults || typeof item.franchiseResults !== 'object') {
      throw new ValidationError(`${p}.franchiseResults`, 'required object');
    }
    const dists = item.franchiseResults.distributors;
    if (!Array.isArray(dists)) {
      throw new ValidationError(`${p}.franchiseResults.distributors`, 'must be an array');
    }
    dists.forEach((d, j) => {
      const dp = `${p}.franchiseResults.distributors[${j}]`;
      if (typeof d.distributor !== 'string') throw new ValidationError(`${dp}.distributor`, 'required string slug');
      if (typeof d.found !== 'boolean') throw new ValidationError(`${dp}.found`, 'required boolean');
      if (d.found) {
        // Loose: bpValue OR bpName must be present so the BP resolver has something to chew on.
        if (!d.bpValue && !d.bpName) throw new ValidationError(`${dp}`, 'found:true requires bpValue or bpName');
      }
    });
  });
}

// ─── File listing ───────────────────────────────────────────────────────────

// Recursively walks INBOX (excluding done/ and failed/), returns paths RELATIVE
// to INBOX so per-source subfolders (e.g. "mouser/scrape-1131217-...json") are
// preserved through claim → move-to-done / move-to-failed.
function listInboxFiles() {
  if (SPECIFIC_FILE) {
    const full = path.join(INBOX, SPECIFIC_FILE);
    return fs.existsSync(full) ? [SPECIFIC_FILE] : [];
  }
  const out = [];
  const SKIP_TOPLEVEL_DIRS = new Set(['done', 'failed']);
  const walk = (absDir, relDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const childRel = relDir ? path.join(relDir, ent.name) : ent.name;
      const childAbs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (!relDir && SKIP_TOPLEVEL_DIRS.has(ent.name)) continue;
        walk(childAbs, childRel);
      } else if (
        ent.isFile()
        && ent.name.startsWith('scrape-')
        && ent.name.endsWith('.json')
        && !ent.name.endsWith('.partial')
      ) {
        out.push(childRel);
      }
    }
  };
  walk(INBOX, '');
  return out.sort(); // chronological-ish by filename timestamp, stable across subfolders
}

// ─── Processing markers ─────────────────────────────────────────────────────

function processingMarker(filename) { return path.join(INBOX, `${filename}.processing`); }

function isStaleProcessingMarker(filename) {
  const m = processingMarker(filename);
  if (!fs.existsSync(m)) return false;
  const age = Date.now() - fs.statSync(m).mtimeMs;
  return age > PROCESSING_TTL_MS;
}

function claim(filename) {
  const m = processingMarker(filename);
  if (fs.existsSync(m) && !isStaleProcessingMarker(filename)) {
    logger.info(`${filename}: already being processed (marker fresh) — skipping`);
    return false;
  }
  fs.writeFileSync(m, String(process.pid));
  return true;
}

function release(filename) {
  const m = processingMarker(filename);
  if (fs.existsSync(m)) fs.unlinkSync(m);
}

// ─── Move helpers ───────────────────────────────────────────────────────────

// `relPath` is relative to INBOX (e.g. "mouser/scrape-1131217-...json").
// Preserves the per-source subdir under done/<date>/ and failed/ so audit
// trails keep the distributor attribution.
function moveToDone(relPath) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(DONE_ROOT, date, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(INBOX, relPath), dest);
  return dest;
}

function moveToFailed(relPath) {
  const dest = path.join(FAILED, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(INBOX, relPath), dest);
  return dest;
}

function writeResultSidecar(envelopePath, result) {
  fs.writeFileSync(`${envelopePath}.result.json`, JSON.stringify(result, null, 2));
}

function writeErrorSidecar(envelopePath, error) {
  fs.writeFileSync(`${envelopePath}.error.json`, JSON.stringify({
    error: error.message,
    path: error.path || null,
    stack: error.stack,
    at: new Date().toISOString(),
  }, null, 2));
}

// ─── Rollup (for 11/16/20 UTC digest) ──────────────────────────────────────

function appendRollup(entry) {
  let rollup = [];
  if (fs.existsSync(ROLLUP_PATH)) {
    try { rollup = JSON.parse(fs.readFileSync(ROLLUP_PATH, 'utf8')); } catch { rollup = []; }
  }
  rollup.push(entry);
  fs.writeFileSync(ROLLUP_PATH, JSON.stringify(rollup, null, 2));
}

// ─── Email helpers ─────────────────────────────────────────────────────────

async function emailError(filename, error) {
  const body = [
    `Distributor scrape envelope failed to load.`,
    ``,
    `File: ${filename}`,
    `Error: ${error.message}`,
    error.path ? `Field: ${error.path}` : null,
    ``,
    `The file has been moved to ~/workspace/inbox/failed/. The error sidecar`,
    `is at ${filename}.error.json. Fix the local scraper and re-ship.`,
  ].filter(Boolean).join('\n');
  await notifier
    .sendEmail(OPERATOR_EMAIL, `[scrape-inbox] FAILED: ${filename}`, body)
    .catch(e => logger.error('notifier failed', e));
}

async function emailSuccess(filename, summary) {
  // Per CLAUDE.md § Reporting cadence — success is rolled into the 11/16/20
  // digest, not emailed immediately. Anomalies (flagged > 0 or failed > 0
  // within the success path) still get an immediate notification.
  const hasAnomaly = (summary.flagged || 0) > 0 || (summary.failed || 0) > 0;
  if (!hasAnomaly) return;
  const subject = `[scrape-inbox] ${filename}: ${summary.written} written, ${summary.flagged} flagged, ${summary.failed} failed`;
  await notifier
    .sendEmail(OPERATOR_EMAIL, subject, JSON.stringify(summary, null, 2))
    .catch(e => logger.error('notifier failed', e));
}

// ─── Core: process one envelope ────────────────────────────────────────────

async function processOne(filename) {
  if (!claim(filename)) return;
  const inboxPath = path.join(INBOX, filename);
  let envelope;

  // Parse + validate
  try {
    envelope = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    validateEnvelope(envelope);
  } catch (err) {
    logger.error(`${filename}: validation/parse failed — ${err.message}`);
    if (!DRY_RUN) {
      writeErrorSidecar(inboxPath, err);
      moveToFailed(filename);
      await emailError(filename, err);
    }
    release(filename);
    return;
  }

  if (DRY_RUN) {
    logger.info(`${filename}: DRY-RUN — schema OK, would load ${envelope.items.length} items` +
      (envelope.rfqSearchKey ? ` to RFQ ${envelope.rfqSearchKey}` : ' as pricing intel'));
    release(filename);
    return;
  }

  // Load
  try {
    let result;
    if (envelope.rfqSearchKey) {
      // VQ-load mode
      result = await writeVQBatch(envelope.rfqSearchKey, envelope.items, {
        buyerId: envelope.defaults?.buyerId,
        applyRestrictedMfrGate: envelope.defaults?.applyRestrictedMfrGate || false,
        pass2Auto: envelope.defaults?.pass2Auto || false,
      });
    } else {
      // Pricing-intel mode — one chuboe_pricing_api_result per (item, distributor)
      const written = [];
      const failed = [];
      for (const item of envelope.items) {
        for (const d of (item.franchiseResults?.distributors || [])) {
          if (!d.found) continue;
          try {
            const r = await writePricingResult({
              searchedMpn: item.searchedMpn,
              distributor: d.distributor,
              bpValue: d.bpValue,
              result: d, // the raw distributor envelope; api-result-writer extracts what it needs
              source: envelope.source,
            });
            written.push({ mpn: item.searchedMpn, distributor: d.distributor, id: r?.id });
          } catch (e) {
            failed.push({ mpn: item.searchedMpn, distributor: d.distributor, error: e.message });
          }
        }
      }
      result = {
        mode: 'pricing-intel',
        summary: { written: written.length, failed: failed.length },
        written, failed,
      };
    }

    const donePath = moveToDone(filename);
    writeResultSidecar(donePath, result);
    appendRollup({
      filename, rfqSearchKey: envelope.rfqSearchKey || null,
      mode: envelope.rfqSearchKey ? 'vq-batch' : 'pricing-intel',
      summary: result.summary || {}, at: new Date().toISOString(),
    });
    await emailSuccess(filename, result.summary || {});
    logger.info(`${filename}: loaded — ${JSON.stringify(result.summary || {})}`);
  } catch (err) {
    logger.error(`${filename}: load failed — ${err.message}`, err);
    writeErrorSidecar(inboxPath, err);
    moveToFailed(filename);
    await emailError(filename, err);
  } finally {
    release(filename);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  ensureDirs();
  const files = listInboxFiles();
  if (files.length === 0) {
    logger.info('no envelopes in inbox');
    return;
  }
  logger.info(`processing ${files.length} envelope(s)${DRY_RUN ? ' (DRY-RUN)' : ''}`);
  for (const f of files) {
    await processOne(f);
  }
}

main().catch(e => {
  logger.error('fatal', e);
  process.exit(1);
});
