#!/usr/bin/env node
/**
 * Vortex Poller — inbox-driven Vortex Matches automation
 *
 * Polls vortex@orangetsunami.com for UNSEEN messages, extracts the RFQ
 * number, runs Vortex Matches, and emails the result back to the requestor.
 *
 * Designed to be invoked on a 20-minute schedule (cron / Claude scheduled
 * trigger). Idempotent: messages are marked Seen after successful processing
 * so re-runs only pick up new mail.
 *
 * Usage:
 *   node vortex-poller.js              # process all UNSEEN in INBOX
 *   node vortex-poller.js --dry-run    # parse + run, but don't send mail
 *                                       and don't mark as Seen
 *   node vortex-poller.js --uid <n>    # process only the given UID
 *
 * Recipient policy:
 *   - Direct email: To = sender, Cc = Jake + any Cc from inbound
 *   - Forwarded email: To = Jake, Cc = original sender + original Cc list
 *   (deduped, vortex inbox removed from Cc to avoid dupes)
 *
 * On error: emails Jake + the sender with the failure detail, marks message
 * Seen so the same broken message isn't retried forever.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { Pool } = require('pg');

const { runVortexForRFQ, buildSummaryHtml } = require('./vortex-matches');
const {
  runSourcingRecapForRFQ,
  buildSummaryHtml: buildRecapSummaryHtml
} = require('../Sourcing Recap/sourcing-recap');
const {
  runFranchiseXref,
  buildSummaryHtml: buildFranchiseSummaryHtml,
  discoverFranchises,
  matchKeywordToFranchise
} = require('../Franchise Catalog Cross-Reference/franchise-xref');
const { sendWithFallback } = require('../../shared/verified-send');

// ─── ENRICHMENT GATE ─────────────────────────────────────────────────────────
// Vortex Matches and Sourcing Recap are gated on RFQ enrichment completion.
// If enrichment hasn't finished, we send PRELIMINARY results immediately and
// queue for COMPLETE results once enrichment finishes.
// Franchise Cross-Ref bypasses this gate (per operator 2026-08-12).

const WATERMARK_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.last-rfq-enrich');
const BACKFILL_TRACKER_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.enrich-backfill-tracker.json');
const PENDING_QUEUE_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.vortex-pending-queue.json');
const ENRICHMENT_BACKLOG_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/astute-workinstructions/.enrich-poller-backlog.json');

// Timeouts for pending queue
const STATUS_UPDATE_THRESHOLD_MS = 60 * 60 * 1000;  // 1 hour - send status update
const TIMEOUT_THRESHOLD_MS = 4 * 60 * 60 * 1000;    // 4 hours - give up

// Database pool for enrichment status checks
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
});

const VORTEX_EMAIL = 'vortex@orangetsunami.com';
const FALLBACK_EMAIL = process.env.VORTEX_FALLBACK_SENDER || 'excess@orangetsunami.com';
const JAKE_EMAIL = 'jake.harris@astutegroup.com';

// Only accept requests from these domains; only send results to these domains
const INTERNAL_DOMAINS = ['astutegroup.com', 'orangetsunami.com'];

/**
 * Check if an email address belongs to an internal domain.
 */
function isInternalEmail(addr) {
  if (!addr) return false;
  const domain = addr.toLowerCase().split('@')[1];
  return domain && INTERNAL_DOMAINS.includes(domain);
}

const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

if (!WORKMAIL_PASS) {
  console.error('FATAL: WORKMAIL_PASS not set in ~/workspace/.env');
  process.exit(1);
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const UID_ARG = (() => {
  const i = argv.indexOf('--uid');
  return i >= 0 ? parseInt(argv[i + 1], 10) : null;
})();

// SMTP transport is owned by shared/verified-send.js (sendWithFallback).

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// ─── ENRICHMENT STATUS HELPERS ───────────────────────────────────────────────

/**
 * Read the enrichment watermark (ISO timestamp of last processed line_mpn.created).
 */
function readEnrichmentWatermark() {
  try {
    if (!fs.existsSync(WATERMARK_FILE)) return null;
    return fs.readFileSync(WATERMARK_FILE, 'utf-8').trim() || null;
  } catch { return null; }
}

/**
 * Read the backfill tracker (set of RFQ numbers processed during backfill mode).
 */
function readBackfillTracker() {
  try {
    if (!fs.existsSync(BACKFILL_TRACKER_FILE)) return new Set();
    const obj = JSON.parse(fs.readFileSync(BACKFILL_TRACKER_FILE, 'utf-8'));
    return new Set(obj.processed || []);
  } catch { return new Set(); }
}

/**
 * Check if an RFQ has been enriched.
 *
 * An RFQ is considered enriched if:
 *   1. It appears in the backfill tracker (processed during backfill mode), OR
 *   2. Its MAX(line_mpn.created) <= the enrichment watermark
 *
 * Returns: { status: 'enriched' | 'pending' | 'not-found', rfqId?, customer?, ageMinutes? }
 */
async function checkEnrichmentStatus(rfqNumber) {
  // Check backfill tracker first (fast, no DB)
  const tracker = readBackfillTracker();
  if (tracker.has(rfqNumber)) {
    return { status: 'enriched', method: 'backfill-tracker' };
  }

  // Query the RFQ's max line_mpn.created
  const { rows } = await pool.query(`
    SELECT r.chuboe_rfq_id,
           bp.name AS customer,
           r.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC' AS rfq_created,
           MAX(rlm.created AT TIME ZONE 'America/Chicago' AT TIME ZONE 'UTC') AS max_line_mpn_created
    FROM adempiere.chuboe_rfq r
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
    WHERE r.value = $1 AND r.isactive='Y'
    GROUP BY r.chuboe_rfq_id, bp.name, r.created
  `, [rfqNumber]);

  if (rows.length === 0) {
    return { status: 'not-found' };
  }

  const { chuboe_rfq_id, customer, rfq_created, max_line_mpn_created } = rows[0];
  const ageMinutes = Math.round((Date.now() - new Date(rfq_created).getTime()) / (1000 * 60));

  // Compare against watermark
  const watermark = readEnrichmentWatermark();
  if (watermark && max_line_mpn_created && new Date(max_line_mpn_created) <= new Date(watermark)) {
    return { status: 'enriched', rfqId: chuboe_rfq_id, customer, method: 'watermark' };
  }

  // Not enriched yet
  return { status: 'pending', rfqId: chuboe_rfq_id, customer, ageMinutes };
}

// ─── PENDING QUEUE HELPERS ───────────────────────────────────────────────────

/**
 * Read the pending Vortex requests queue.
 */
function readPendingQueue() {
  try {
    if (!fs.existsSync(PENDING_QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(PENDING_QUEUE_FILE, 'utf-8'));
  } catch { return []; }
}

/**
 * Write the pending Vortex requests queue.
 */
function writePendingQueue(queue) {
  fs.writeFileSync(PENDING_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * Add a request to the pending queue.
 */
function addToPendingQueue(item) {
  const queue = readPendingQueue();
  // Avoid duplicates by RFQ + sender
  const exists = queue.find(q => q.rfqNumber === item.rfqNumber && q.senderEmail === item.senderEmail);
  if (exists) {
    log(`  pending queue: ${item.rfqNumber} already queued for ${item.senderEmail}, skipping`);
    return;
  }
  queue.push({
    id: crypto.randomUUID(),
    ...item,
    queuedAt: new Date().toISOString(),
    lastStatusUpdateAt: null,
    attempts: 0
  });
  writePendingQueue(queue);
  log(`  pending queue: added ${item.rfqNumber} (${item.flavor}) for ${item.senderEmail}`);
}

/**
 * Remove a request from the pending queue by ID.
 */
function removeFromPendingQueue(id) {
  const queue = readPendingQueue();
  const filtered = queue.filter(q => q.id !== id);
  writePendingQueue(filtered);
}

/**
 * Get enrichment backlog info for status updates.
 */
function getEnrichmentBacklogInfo() {
  try {
    if (!fs.existsSync(ENRICHMENT_BACKLOG_FILE)) return { pending: 0, totalLineMpns: 0 };
    const backlog = JSON.parse(fs.readFileSync(ENRICHMENT_BACKLOG_FILE, 'utf-8'));
    const pending = (backlog.items || []).filter(i => i.status === 'pending');
    const totalLineMpns = pending.reduce((sum, i) => sum + (i.line_mpns || 0), 0);
    return { pending: pending.length, totalLineMpns };
  } catch { return { pending: 0, totalLineMpns: 0 }; }
}

// ─── EMAIL HELPERS FOR ENRICHMENT GATE ───────────────────────────────────────

/**
 * Build HTML for PRELIMINARY results email.
 */
function buildPreliminaryHtml(result, flavor) {
  const baseHtml = flavor === 'recap' ? buildRecapSummaryHtml(result) : buildSummaryHtml(result);

  const notice = `
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:12px 16px;margin-bottom:16px;font-size:13px">
      <b style="color:#856404">⏳ PRELIMINARY RESULTS</b><br/>
      Franchise pricing data is currently being collected for this RFQ.
      A <b>complete report</b> with fresh franchise quotes will be sent automatically when enrichment finishes.
    </div>
  `;

  // Insert notice after opening body tag
  return baseHtml.replace(/<body[^>]*>/, match => match + notice);
}

/**
 * Build HTML for COMPLETE results email (follow-up after enrichment).
 */
function buildCompleteHtml(result, flavor) {
  const baseHtml = flavor === 'recap' ? buildRecapSummaryHtml(result) : buildSummaryHtml(result);

  const notice = `
    <div style="background:#d4edda;border:1px solid #28a745;border-radius:4px;padding:12px 16px;margin-bottom:16px;font-size:13px">
      <b style="color:#155724">✓ COMPLETE RESULTS</b><br/>
      Franchise enrichment has finished. This report includes all available data including fresh franchise pricing.
    </div>
  `;

  return baseHtml.replace(/<body[^>]*>/, match => match + notice);
}

/**
 * Build HTML for status update email.
 */
function buildStatusUpdateHtml(item, backlogInfo, waitMinutes) {
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
    <div style="background:#cce5ff;border:1px solid #004085;border-radius:4px;padding:12px 16px;margin-bottom:16px">
      <b style="color:#004085">⏳ Status Update — RFQ ${item.rfqNumber}</b>
    </div>
    <p>Your ${item.flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches'} request is still waiting for franchise enrichment to complete.</p>
    <table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #ddd;margin:12px 0">
      <tr><td><b>RFQ</b></td><td>${item.rfqNumber}</td></tr>
      <tr><td><b>Customer</b></td><td>${item.customer || '?'}</td></tr>
      <tr><td><b>Waiting</b></td><td>${waitMinutes} minutes</td></tr>
      <tr><td><b>Enrichment backlog</b></td><td>${backlogInfo.pending} RFQs (${backlogInfo.totalLineMpns.toLocaleString()} line-MPNs)</td></tr>
    </table>
    <p style="color:#666">You already received preliminary results. Complete results will be sent when enrichment finishes.</p>
    <p style="color:#888;font-size:11px">This is an automated status update from the Vortex Matches system.</p>
  </body></html>`;
}

/**
 * Build HTML for timeout error email.
 */
function buildTimeoutHtml(item, waitMinutes) {
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
    <div style="background:#f8d7da;border:1px solid #721c24;border-radius:4px;padding:12px 16px;margin-bottom:16px">
      <b style="color:#721c24">⚠ Timeout — RFQ ${item.rfqNumber}</b>
    </div>
    <p>Your ${item.flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches'} request has been waiting for enrichment for <b>${waitMinutes} minutes</b> without completion.</p>
    <p>This usually indicates:</p>
    <ul>
      <li>A large enrichment backlog</li>
      <li>The enrichment poller may be paused or experiencing issues</li>
      <li>This RFQ may have been skipped (large-RFQ gate, rejected, etc.)</li>
    </ul>
    <p>Your preliminary results (sent earlier) contain all data that was available at the time. Please investigate the enrichment status if complete results are needed.</p>
    <p style="color:#888;font-size:11px">This request has been removed from the pending queue.</p>
  </body></html>`;
}

/**
 * Subject-keyword router: does this message ask for Sourcing Recap?
 *
 * Rule (locked with operator 2026-05-20): subject contains "BEST" as a
 * standalone word (case-insensitive) AND a 7-digit RFQ#. The keyword can
 * appear anywhere — "BEST 1234567", "Best price for 1234567?", "1234567 BEST",
 * all route to the recap path. Anything else stays on Vortex Matches.
 *
 * "Best regards" alone (no RFQ#) won't trigger this. False-positive risk
 * exists for subjects like "Best price for 1234567" — that's actually the
 * intent though, so it's fine.
 */
function isSourcingRecapRequest(subject) {
  if (!subject) return false;
  // Standalone "best" token (not inside another word), case-insensitive.
  return /\bbest\b/i.test(subject) && /\b\d{7}\b/.test(subject);
}

/**
 * Subject-keyword router: does this message ask for Franchise Cross-Reference?
 *
 * Patterns:
 *   "1234567 franchise"  → all franchise catalogs
 *   "1234567 HTC"        → HTC Korea catalog only
 *   "1234567 ATGBICS"    → ATGBICS catalog only
 *   "franchise 1234567"  → all (order doesn't matter)
 *
 * Returns { isFranchise: true, franchises: ['htc-korea'] } or
 *         { isFranchise: true, franchises: ['all'] } or
 *         { isFranchise: false, franchises: [] }
 */
function parseFranchiseRequest(subject) {
  if (!subject) return { isFranchise: false, franchises: [] };

  // Must have a 7-digit RFQ number
  if (!/\b\d{7}\b/.test(subject)) return { isFranchise: false, franchises: [] };

  const subjectLower = subject.toLowerCase();

  // Discover available franchises to match keywords dynamically
  const availableFranchises = discoverFranchises();
  const matchedFranchises = [];

  // Check each word in the subject against franchise keywords
  const words = subjectLower.split(/\s+/);
  for (const word of words) {
    const cleanWord = word.replace(/[^a-z0-9]/g, '');
    if (!cleanWord) continue;

    // Check against available franchise keywords
    const franchiseKey = matchKeywordToFranchise(cleanWord, availableFranchises);
    if (franchiseKey && !matchedFranchises.includes(franchiseKey)) {
      matchedFranchises.push(franchiseKey);
    }
  }

  // Check for the generic "franchise" keyword
  if (/\bfranchise\b/i.test(subject)) {
    // "franchise" without specific franchise name means all
    if (matchedFranchises.length === 0) {
      return { isFranchise: true, franchises: ['all'] };
    }
    // "franchise htc" means just HTC (explicit overrides generic)
    return { isFranchise: true, franchises: matchedFranchises };
  }

  // If we matched specific franchise keywords, that's a franchise request
  if (matchedFranchises.length > 0) {
    return { isFranchise: true, franchises: matchedFranchises };
  }

  return { isFranchise: false, franchises: [] };
}

/**
 * Extract a 7-digit RFQ number. Looks at subject first, then body.
 * Prefers numbers preceded by "RFQ" (e.g. "RFQ 1130895", "RFQ #1130895",
 * "RFQ_1138852"). Falls back to the first standalone 7-digit run.
 */
function extractRfqNumber(subject, body) {
  const sources = [subject || '', body || ''];
  // Pass 1: "RFQ" + number (allows space, #, :, _, or nothing as separator)
  for (const src of sources) {
    const m = src.match(/RFQ[\s#:_]*(\d{7})/i);
    if (m) return m[1];
  }
  // Pass 2: bare 7-digit (handles underscore prefix since _ is a word char)
  for (const src of sources) {
    const m = src.match(/(?:^|[^\d])(\d{7})(?:$|[^\d])/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Parse a forwarded message body to recover the inner From and Cc headers.
 * Outlook/Gmail forwards both produce blocks like:
 *
 *   From: Some Person <person@vendor.com>
 *   Sent: ...
 *   To: jake.harris@astutegroup.com
 *   Cc: alice@x.com; bob@y.com
 *   Subject: ...
 *
 * Returns { originalFrom: 'person@vendor.com'|null, originalCc: ['alice@x.com',...] }
 */
function parseForwardedHeaders(body) {
  if (!body) return { originalFrom: null, originalCc: [] };

  // 1) Decode common HTML entities so escaped angle brackets become real ones
  let text = body
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');

  // 2) Convert HTML line breaks to newlines so the per-line regex still works
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n');

  // 3) Strip remaining real HTML tags. Forbidding '@' inside the tag
  //    prevents angle-bracketed addresses like <foo@x.com> from being eaten.
  text = text.replace(/<[a-zA-Z\/][^>@]*>/g, ' ');

  const fromMatch = text.match(/^[ \t]*From:[ \t]*(.+)$/im);
  const ccMatch = text.match(/^[ \t]*Cc:[ \t]*(.+)$/im);

  const extractEmails = (line) => {
    if (!line) return [];
    // Match either "Name <addr@x>" or bare addr@x
    const re = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
    const found = line.match(re) || [];
    return found.map(e => e.toLowerCase());
  };

  const fromList = extractEmails(fromMatch && fromMatch[1]);
  const ccList = extractEmails(ccMatch && ccMatch[1]);

  return {
    originalFrom: fromList[0] || null,
    originalCc: ccList
  };
}

/**
 * Build the recipient list for the outgoing Vortex result email.
 *
 * Two modes:
 *   - Forwarded email (originalFrom found): To = Jake, Cc = original sender + original Cc
 *   - Direct email (no originalFrom): To = sender, Cc = Jake + inbound Cc
 *
 * @param {string} senderAddr - The address that sent to vortex@
 * @param {string|null} originalFrom - Extracted from forwarded headers (null if direct)
 * @param {string[]} originalCc - Extracted from forwarded headers
 * @param {string[]} inboundCc - Cc recipients on the inbound email to vortex@
 */
function buildRecipients(senderAddr, originalFrom, originalCc, inboundCc = []) {
  const exclude = new Set([VORTEX_EMAIL.toLowerCase()]);

  // Forwarded mode: Jake sent it, result goes to Jake with original requestor in Cc
  if (originalFrom) {
    const to = [JAKE_EMAIL];
    const cc = [];
    const seen = new Set([JAKE_EMAIL.toLowerCase(), ...exclude]);
    // Only include internal addresses in Cc
    const candidates = [originalFrom, ...originalCc].filter(Boolean).filter(isInternalEmail);
    for (const addr of candidates) {
      const a = addr.toLowerCase();
      if (seen.has(a)) continue;
      seen.add(a);
      cc.push(addr);
    }
    return { to, cc };
  }

  // Direct mode: sender gets the result, Jake in Cc for visibility
  const to = [senderAddr];
  const cc = [];
  const seen = new Set([senderAddr.toLowerCase(), ...exclude]);
  // Add Jake to Cc (unless sender is Jake)
  if (!seen.has(JAKE_EMAIL.toLowerCase())) {
    seen.add(JAKE_EMAIL.toLowerCase());
    cc.push(JAKE_EMAIL);
  }
  // Add any Cc from inbound email (already filtered to internal at extraction)
  for (const addr of inboundCc) {
    const a = addr.toLowerCase();
    if (seen.has(a)) continue;
    if (!isInternalEmail(addr)) continue;  // double-check
    seen.add(a);
    cc.push(addr);
  }
  return { to, cc };
}

/**
 * Send an error notification when a message can't be processed.
 * Goes to both the original sender and Jake for visibility.
 */
async function sendErrorEmail(subject, errorMsg, sourceMeta) {
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Vortex Matches — processing error</h2>
<p><b>Source subject:</b> ${escapeHtml(sourceMeta.subject || '(none)')}<br/>
<b>Source from:</b> ${escapeHtml(sourceMeta.from || '(unknown)')}<br/>
<b>Source UID:</b> ${sourceMeta.uid}</p>
<p><b>Error:</b> ${escapeHtml(errorMsg)}</p>
<p style="color:#666;font-size:11px">Message has been marked Seen so it will not be retried. Investigate manually if needed.</p>
</body></html>`;
  if (DRY_RUN) {
    log('[dry-run] would send error email:', subject);
    return;
  }

  // Build recipient list: sender (if known) + Jake
  const recipients = [];
  const senderAddr = sourceMeta.from;
  if (senderAddr && senderAddr.toLowerCase() !== JAKE_EMAIL.toLowerCase()) {
    recipients.push(senderAddr);
  }
  recipients.push(JAKE_EMAIL);

  try {
    await sendWithFallback({
      primary:  { from: VORTEX_EMAIL,   pass: WORKMAIL_PASS, displayName: 'Vortex Matches' },
      fallback: { from: FALLBACK_EMAIL, pass: WORKMAIL_PASS, displayName: 'Vortex Matches' },
      mail: { to: recipients.join(', '), subject, html },
      log
    });
  } catch (e) {
    log('error-email failed:', e.message);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Process a single mailbox message: parse → match → email → mark Seen.
 */
async function processMessage(client, uid) {
  log(`processing UID ${uid}`);

  // Fetch the raw message
  const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
  if (!msg || !msg.source) {
    log(`  UID ${uid}: no source`);
    return { uid, status: 'skipped', reason: 'no source' };
  }

  const parsed = await simpleParser(msg.source);
  const subject = parsed.subject || '';
  const senderAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';

  // Reject requests from external senders
  if (!isInternalEmail(senderAddr)) {
    log(`  UID ${uid}: sender ${senderAddr} is external, notifying Jake and marking Seen`);
    await sendErrorEmail(
      `Vortex Matches — external sender rejected`,
      `Request from external address ${senderAddr} was rejected. Only internal (astutegroup.com / orangetsunami.com) requests are accepted.`,
      { uid, subject, from: senderAddr }
    );
    if (!DRY_RUN) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return { uid, status: 'rejected', reason: `external sender ${senderAddr}` };
  }

  // Extract Cc recipients from the inbound email (for direct-send mode), internal only
  const inboundCc = (parsed.cc && parsed.cc.value || [])
    .map(v => v.address)
    .filter(Boolean)
    .map(a => a.toLowerCase())
    .filter(isInternalEmail);

  const bodyText = parsed.text || parsed.html || '';
  const { originalFrom, originalCc } = parseForwardedHeaders(bodyText);

  const rfqNumber = extractRfqNumber(subject, bodyText);
  if (!rfqNumber) {
    log(`  UID ${uid}: no RFQ number found in subject or body`);
    await sendErrorEmail(
      `Vortex Matches — could not find RFQ number`,
      `No 7-digit RFQ number found in subject or body.`,
      { uid, subject, from: senderAddr }
    );
    if (!DRY_RUN) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return { uid, status: 'error', reason: 'no rfq number' };
  }

  // Subject-keyword router: determines which analysis to run.
  //   - "franchise" or specific franchise name → Franchise Cross-Reference
  //   - "best" → Sourcing Recap
  //   - Everything else → Vortex Matches
  const franchiseReq = parseFranchiseRequest(subject);
  const isRecap = !franchiseReq.isFranchise && isSourcingRecapRequest(subject);
  const flavor = franchiseReq.isFranchise ? 'franchise' : (isRecap ? 'recap' : 'vortex');

  log(`  UID ${uid}: RFQ=${rfqNumber}  flavor=${flavor}${franchiseReq.isFranchise ? ` (${franchiseReq.franchises.join(',')})` : ''}  originalFrom=${originalFrom || '(none)'}  ccCount=${originalCc.length}`);

  // ─── ENRICHMENT GATE (Vortex + Recap only, not Franchise) ─────────────────
  // If the RFQ hasn't been enriched yet, send PRELIMINARY results immediately
  // and queue for COMPLETE results once enrichment finishes.
  let enrichmentPending = false;
  let enrichmentStatus = null;
  if (flavor !== 'franchise') {
    try {
      enrichmentStatus = await checkEnrichmentStatus(rfqNumber);
      if (enrichmentStatus.status === 'pending') {
        enrichmentPending = true;
        log(`  UID ${uid}: enrichment pending (age: ${enrichmentStatus.ageMinutes}min) — will send PRELIMINARY + queue for COMPLETE`);
      } else if (enrichmentStatus.status === 'enriched') {
        log(`  UID ${uid}: enrichment complete (${enrichmentStatus.method}) — proceeding normally`);
      } else if (enrichmentStatus.status === 'not-found') {
        log(`  UID ${uid}: RFQ not found in enrichment check — proceeding anyway`);
      }
    } catch (err) {
      // Enrichment check failed (DB issue?) — proceed without gating
      log(`  UID ${uid}: enrichment check failed: ${err.message} — proceeding without gate`);
    }
  }

  // Run the chosen analysis. All share the same { customer, attachments[] }
  // contract on success — the email path below treats them uniformly.
  let result;
  try {
    if (franchiseReq.isFranchise) {
      result = await runFranchiseXref(rfqNumber, {
        franchises: franchiseReq.franchises,
        log: m => log('   ', m)
      });
      // Normalize result shape to match Vortex/Recap: flatten results[].attachment into attachments[]
      result.attachments = result.results.map(r => r.attachment);
    } else if (isRecap) {
      result = await runSourcingRecapForRFQ(rfqNumber, { log: m => log('   ', m) });
    } else {
      result = await runVortexForRFQ(rfqNumber, { log: m => log('   ', m) });
    }
  } catch (err) {
    log(`  UID ${uid}: ${flavor} run failed: ${err.message}`);
    const flavorLabel = flavor === 'franchise' ? 'Franchise Cross-Ref'
      : (flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches');
    await sendErrorEmail(
      `${flavorLabel} — RFQ ${rfqNumber} failed`,
      err.message,
      { uid, subject, from: senderAddr }
    );
    if (!DRY_RUN) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return { uid, status: 'error', reason: err.message };
  }

  // Sourcing Recap may legitimately return ok:false (Stock RFQ rejection / not
  // found). Treat as a delivered reply, not an error — the operator asked, we
  // explain why we can't help. Mark Seen so we don't loop.
  if (isRecap && result && result.ok === false) {
    log(`  UID ${uid}: sourcing-recap declined (${result.error}): ${result.message}`);
    const { to, cc } = buildRecipients(senderAddr, originalFrom, originalCc, inboundCc);
    const subj = result.error === 'stock_rfq'
      ? `Sourcing Recap — RFQ ${rfqNumber}: Stock RFQ (use Vortex Matches)`
      : `Sourcing Recap — RFQ ${rfqNumber}: ${result.error}`;
    if (!DRY_RUN) {
      await sendVortexResult({
        to, cc, subject: subj, html: buildRecapSummaryHtml(result), attachments: []
      });
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    }
    return { uid, status: 'declined', rfqNumber, reason: result.error };
  }

  // Franchise Cross-Ref with no matches: still send a reply explaining no matches found
  if (franchiseReq.isFranchise && result.results.length === 0) {
    log(`  UID ${uid}: franchise xref found no matches`);
    const { to, cc } = buildRecipients(senderAddr, originalFrom, originalCc, inboundCc);
    const subj = `Franchise Cross-Ref — RFQ ${rfqNumber}: No Matches`;
    if (!DRY_RUN) {
      await sendVortexResult({
        to, cc, subject: subj, html: buildFranchiseSummaryHtml(result), attachments: []
      });
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    }
    return { uid, status: 'no-matches', rfqNumber, flavor };
  }

  // Build recipients + body (success path, all flavors)
  const { to, cc } = buildRecipients(senderAddr, originalFrom, originalCc, inboundCc);
  let html, emailSubject;
  if (franchiseReq.isFranchise) {
    html = buildFranchiseSummaryHtml(result);
    const franchiseNames = result.results.map(r => r.displayName).join(', ');
    emailSubject = `Franchise Cross-Ref — RFQ ${rfqNumber} (${result.customer}) — ${franchiseNames}`;
  } else if (isRecap) {
    // Use PRELIMINARY template if enrichment is pending
    html = enrichmentPending
      ? buildPreliminaryHtml(result, 'recap')
      : buildRecapSummaryHtml(result);
    emailSubject = enrichmentPending
      ? `Sourcing Recap — RFQ ${rfqNumber} (${result.customer}) — PRELIMINARY`
      : `Sourcing Recap — RFQ ${rfqNumber} (${result.customer})`;
  } else {
    // Use PRELIMINARY template if enrichment is pending
    html = enrichmentPending
      ? buildPreliminaryHtml(result, 'vortex')
      : buildSummaryHtml(result);
    emailSubject = enrichmentPending
      ? `Vortex Matches — RFQ ${rfqNumber} (${result.customer}) — PRELIMINARY`
      : `Vortex Matches — RFQ ${rfqNumber} (${result.customer})`;
  }

  if (DRY_RUN) {
    log(`  [dry-run] would send (${flavor}) to=${to.join(',')} cc=${cc.join(',')} attachments=${result.attachments.length}${enrichmentPending ? ' (PRELIMINARY)' : ''}`);
    return { uid, status: 'dry-run', rfqNumber, flavor };
  }

  // Send via primary (vortex@), fall back to excess@ if primary bounces.
  const sendResult = await sendVortexResult({
    to, cc, subject: emailSubject, html, attachments: result.attachments
  });

  await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

  // If enrichment is pending, add to the pending queue for COMPLETE follow-up
  if (enrichmentPending) {
    addToPendingQueue({
      rfqNumber,
      rfqId: enrichmentStatus?.rfqId,
      customer: result.customer || enrichmentStatus?.customer || '',
      senderEmail: senderAddr,
      toEmails: to,
      ccEmails: cc,
      originalFrom,
      originalCc,
      inboundCc,
      flavor,
      sourceSubject: subject,
      sourceUid: uid
    });
    log(`  UID ${uid}: sent PRELIMINARY (${flavor}) via ${sendResult.delivered} sender, queued for COMPLETE`);
    return { uid, status: 'sent-preliminary', rfqNumber, flavor, attachments: result.attachments.length };
  }

  log(`  UID ${uid}: sent (${flavor}) via ${sendResult.delivered} sender and marked Seen` +
      (sendResult.bounceDetected ? ' (primary bounced, fallback used)' : ''));
  return { uid, status: 'sent', rfqNumber, flavor, attachments: result.attachments.length, delivered: sendResult.delivered };
}

/**
 * Process the pending queue — check each queued request for enrichment completion.
 *
 * Called at the end of each vortex-poller tick. For each pending item:
 *   - If enriched: run analysis, send COMPLETE results, remove from queue
 *   - If > 1 hour waiting: send status update
 *   - If > 4 hours: send timeout notice, remove from queue
 */
async function processPendingQueue() {
  const queue = readPendingQueue();
  if (queue.length === 0) return;

  log(`pending queue: ${queue.length} item(s) to check`);
  const backlogInfo = getEnrichmentBacklogInfo();
  const now = Date.now();
  const updatedQueue = [];

  for (const item of queue) {
    const queuedAt = new Date(item.queuedAt).getTime();
    const waitMs = now - queuedAt;
    const waitMinutes = Math.round(waitMs / (1000 * 60));

    // Check enrichment status
    let enrichmentStatus;
    try {
      enrichmentStatus = await checkEnrichmentStatus(item.rfqNumber);
    } catch (err) {
      log(`  pending ${item.rfqNumber}: enrichment check failed: ${err.message} — keeping in queue`);
      updatedQueue.push(item);
      continue;
    }

    // Case 1: Enrichment complete — send COMPLETE results
    if (enrichmentStatus.status === 'enriched') {
      log(`  pending ${item.rfqNumber}: enrichment complete — sending COMPLETE results`);
      try {
        // Run the analysis again with fresh data
        let result;
        if (item.flavor === 'recap') {
          result = await runSourcingRecapForRFQ(item.rfqNumber, { log: m => log('   ', m) });
        } else {
          result = await runVortexForRFQ(item.rfqNumber, { log: m => log('   ', m) });
        }

        // Build COMPLETE email
        const html = buildCompleteHtml(result, item.flavor);
        const flavorLabel = item.flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches';
        const emailSubject = `${flavorLabel} — RFQ ${item.rfqNumber} (${result.customer || item.customer}) — COMPLETE`;

        if (!DRY_RUN) {
          await sendVortexResult({
            to: item.toEmails,
            cc: item.ccEmails,
            subject: emailSubject,
            html,
            attachments: result.attachments || []
          });
        }
        log(`  pending ${item.rfqNumber}: COMPLETE results sent (waited ${waitMinutes}min)`);
        // Don't add to updatedQueue — effectively removes from queue
      } catch (err) {
        log(`  pending ${item.rfqNumber}: failed to send COMPLETE: ${err.message} — keeping in queue`);
        updatedQueue.push(item);
      }
      continue;
    }

    // Case 2: Timeout — send error and remove from queue
    if (waitMs >= TIMEOUT_THRESHOLD_MS) {
      log(`  pending ${item.rfqNumber}: TIMEOUT after ${waitMinutes}min — sending timeout notice`);
      try {
        const html = buildTimeoutHtml(item, waitMinutes);
        const flavorLabel = item.flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches';
        const emailSubject = `${flavorLabel} — RFQ ${item.rfqNumber} — Timeout`;

        if (!DRY_RUN) {
          await sendVortexResult({
            to: item.toEmails,
            cc: item.ccEmails,
            subject: emailSubject,
            html,
            attachments: []
          });
        }
        log(`  pending ${item.rfqNumber}: timeout notice sent, removed from queue`);
      } catch (err) {
        log(`  pending ${item.rfqNumber}: failed to send timeout notice: ${err.message}`);
      }
      // Don't add to updatedQueue — remove from queue regardless
      continue;
    }

    // Case 3: Status update (> 1 hour, not yet sent this hour)
    const lastUpdateAt = item.lastStatusUpdateAt ? new Date(item.lastStatusUpdateAt).getTime() : 0;
    const timeSinceLastUpdate = now - lastUpdateAt;
    if (waitMs >= STATUS_UPDATE_THRESHOLD_MS && timeSinceLastUpdate >= STATUS_UPDATE_THRESHOLD_MS) {
      log(`  pending ${item.rfqNumber}: sending status update (waited ${waitMinutes}min)`);
      try {
        const html = buildStatusUpdateHtml(item, backlogInfo, waitMinutes);
        const flavorLabel = item.flavor === 'recap' ? 'Sourcing Recap' : 'Vortex Matches';
        const emailSubject = `${flavorLabel} — RFQ ${item.rfqNumber} — Status Update`;

        if (!DRY_RUN) {
          await sendVortexResult({
            to: item.toEmails,
            cc: item.ccEmails,
            subject: emailSubject,
            html,
            attachments: []
          });
        }
        item.lastStatusUpdateAt = new Date().toISOString();
        log(`  pending ${item.rfqNumber}: status update sent`);
      } catch (err) {
        log(`  pending ${item.rfqNumber}: failed to send status update: ${err.message}`);
      }
    }

    // Keep in queue
    item.attempts = (item.attempts || 0) + 1;
    updatedQueue.push(item);
  }

  // Write updated queue
  writePendingQueue(updatedQueue);
  const removed = queue.length - updatedQueue.length;
  if (removed > 0) {
    log(`pending queue: ${removed} item(s) completed/removed, ${updatedQueue.length} remaining`);
  }
}

/**
 * Send the result email via primary sender with bounce-verified fallback.
 * See shared/verified-send.js for the pattern and why it exists.
 */
async function sendVortexResult({ to, cc, subject, html, attachments }) {
  return sendWithFallback({
    primary:  { from: VORTEX_EMAIL,   pass: WORKMAIL_PASS, displayName: 'Vortex Matches' },
    fallback: { from: FALLBACK_EMAIL, pass: WORKMAIL_PASS, displayName: 'Vortex Matches' },
    mail: {
      to: to.join(', '),
      cc: cc.length ? cc.join(', ') : undefined,
      subject,
      html,
      attachments: attachments.map(a => ({ filename: a.filename, content: a.content }))
    },
    log
  });
}

/**
 * Main poll loop.
 */
async function main() {
  log(`vortex-poller starting (dry-run=${DRY_RUN}, uid=${UID_ARG || 'all unseen'})`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: VORTEX_EMAIL, pass: WORKMAIL_PASS },
    logger: false
  });

  try {
    await client.connect();
  } catch (err) {
    log('FATAL: cannot connect to vortex inbox:', err.message);
    log('Has the vortex@orangetsunami.com mailbox been provisioned in WorkMail?');
    process.exit(2);
  }

  let processed = 0;
  let succeeded = 0;
  let errored = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for UIDs to process
      let uids;
      if (UID_ARG) {
        uids = [UID_ARG];
      } else {
        const search = await client.search({ seen: false }, { uid: true });
        uids = search || [];
      }
      log(`found ${uids.length} message(s) to process`);

      for (const uid of uids) {
        processed++;
        try {
          const r = await processMessage(client, uid);
          if (r.status === 'sent' || r.status === 'sent-preliminary' || r.status === 'dry-run') succeeded++;
          else if (r.status === 'error') errored++;
        } catch (err) {
          errored++;
          log(`  UID ${uid}: unexpected error:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  log(`inbox done. processed=${processed} succeeded=${succeeded} errored=${errored}`);

  // Process pending queue (requests waiting for enrichment to complete)
  try {
    await processPendingQueue();
  } catch (err) {
    log(`pending queue processing failed: ${err.message}`);
  }

  // Clean up database pool
  await pool.end().catch(() => {});

  log('vortex-poller complete');
  // Force exit so any lingering resources don't hold the process
  process.exit(0);
}

main().catch(err => {
  log('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
