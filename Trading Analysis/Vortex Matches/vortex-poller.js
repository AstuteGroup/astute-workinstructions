#!/usr/bin/env node
/**
 * Vortex Poller — inbox-driven Vortex Matches automation
 *
 * Polls vortex@orangetsunami.com for UNSEEN messages, treats each as a
 * forwarded RFQ from Jake, extracts the RFQ number and the original
 * sender/Cc list, runs Vortex Matches, and emails the result back to
 * Jake + the original requestor + original Ccs.
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
 * Recipient policy (forward-from-Jake mode, current default):
 *   To  = Jake
 *   Cc  = original sender of the forwarded message + their Cc list
 *         (deduped, vortex inbox + Jake removed from Cc to avoid dupes)
 *
 * On error: emails Jake with the failure detail, marks message Seen so
 * the same broken message isn't retried forever.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const { runVortexForRFQ, buildSummaryHtml } = require('./vortex-matches');

const VORTEX_EMAIL = 'vortex@orangetsunami.com';
const JAKE_EMAIL = 'jake.harris@astutegroup.com';

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

// Single shared SMTP transporter (HTML + multiple recipients + Cc support)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: true,
  auth: { user: VORTEX_EMAIL, pass: WORKMAIL_PASS }
});

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

/**
 * Extract a 7-digit RFQ number. Looks at subject first, then body.
 * Prefers numbers preceded by "RFQ" (e.g. "RFQ 1130895", "RFQ #1130895").
 * Falls back to the first standalone 7-digit run.
 */
function extractRfqNumber(subject, body) {
  const sources = [subject || '', body || ''];
  // Pass 1: "RFQ" + number
  for (const src of sources) {
    const m = src.match(/RFQ[\s#:]*?(\d{7})/i);
    if (m) return m[1];
  }
  // Pass 2: bare 7-digit
  for (const src of sources) {
    const m = src.match(/\b(\d{7})\b/);
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
 */
function buildRecipients(originalFrom, originalCc) {
  const exclude = new Set([VORTEX_EMAIL.toLowerCase()]);
  // Jake is always To
  const to = [JAKE_EMAIL];
  // CC = originalFrom + originalCc, dedupe, drop Jake (already in To) and vortex
  const cc = [];
  const seen = new Set([JAKE_EMAIL.toLowerCase(), ...exclude]);
  const candidates = [originalFrom, ...originalCc].filter(Boolean);
  for (const addr of candidates) {
    const a = addr.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    cc.push(addr);
  }
  return { to, cc };
}

/**
 * Send an error notification to Jake when a message can't be processed.
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
  try {
    await transporter.sendMail({
      from: `"Vortex Matches" <${VORTEX_EMAIL}>`,
      to: JAKE_EMAIL,
      subject,
      html
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

  // We're in forward-from-Jake mode: only process forwards from Jake himself
  if (senderAddr.toLowerCase() !== JAKE_EMAIL.toLowerCase()) {
    log(`  UID ${uid}: sender ${senderAddr} not Jake, marking Seen and skipping`);
    if (!DRY_RUN) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return { uid, status: 'skipped', reason: `sender ${senderAddr}` };
  }

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

  log(`  UID ${uid}: RFQ=${rfqNumber}  originalFrom=${originalFrom || '(none)'}  ccCount=${originalCc.length}`);

  // Run vortex
  let result;
  try {
    result = await runVortexForRFQ(rfqNumber, { log: m => log('   ', m) });
  } catch (err) {
    log(`  UID ${uid}: vortex run failed: ${err.message}`);
    await sendErrorEmail(
      `Vortex Matches — RFQ ${rfqNumber} failed`,
      err.message,
      { uid, subject, from: senderAddr }
    );
    if (!DRY_RUN) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return { uid, status: 'error', reason: err.message };
  }

  // Build recipients + body
  const { to, cc } = buildRecipients(originalFrom, originalCc);
  const html = buildSummaryHtml(result);
  const emailSubject = `Vortex Matches — RFQ ${rfqNumber} (${result.customer})`;

  if (DRY_RUN) {
    log(`  [dry-run] would send to=${to.join(',')} cc=${cc.join(',')} attachments=${result.attachments.length}`);
    return { uid, status: 'dry-run', rfqNumber };
  }

  // Send. Note: notifier currently sends plain text; we pass HTML as the body
  // and rely on most mail clients rendering it. If we need true HTML/text
  // multipart we'll extend notifier.js — for now this is the smallest patch.
  await sendVortexResult({
    to, cc, subject: emailSubject, html, attachments: result.attachments
  });

  await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  log(`  UID ${uid}: sent and marked Seen`);
  return { uid, status: 'sent', rfqNumber, attachments: result.attachments.length };
}

/**
 * Send the result email (HTML body + xlsx attachments + Cc).
 */
async function sendVortexResult({ to, cc, subject, html, attachments }) {
  await transporter.sendMail({
    from: `"Vortex Matches" <${VORTEX_EMAIL}>`,
    to: to.join(', '),
    cc: cc.length ? cc.join(', ') : undefined,
    subject,
    html,
    attachments: attachments.map(a => ({ filename: a.filename, content: a.content }))
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
          if (r.status === 'sent' || r.status === 'dry-run') succeeded++;
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

  log(`done. processed=${processed} succeeded=${succeeded} errored=${errored}`);
  // Force exit so the lingering pg pool doesn't hold the process
  process.exit(0);
}

main().catch(err => {
  log('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
