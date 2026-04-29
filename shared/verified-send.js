/**
 * verified-send.js — send via primary sender, poll for a bounce, fall back.
 *
 * Amazon WorkMail started rejecting mail from vortex@orangetsunami.com to
 * jake.harris@astutegroup.com on 2026-04-20 with a bare `Status 5.3.0`
 * (no Diagnostic-Code). SMTP accepts the message (`250 OK`), then Amazon
 * SES generates an asynchronous "Undelivered Mail Returned to Sender"
 * bounce back to the sending mailbox within 1–2 minutes. Other mailboxes
 * in the same orangetsunami.com org (excess@, inventory@) deliver fine,
 * so the block appears to be targeted at vortex@ specifically.
 *
 * This helper wraps that pattern:
 *   1. Send via `primary` and capture the messageId.
 *   2. Poll `primary`'s INBOX for up to BOUNCE_WINDOW_MS looking for an
 *      "Undelivered Mail Returned to Sender" whose embedded rfc822 (or
 *      body text) contains our messageId.
 *   3. If a bounce is detected → re-send via `fallback` with a subject
 *      tag so the recipient knows why the From header changed.
 *
 * Returns { delivered: 'primary' | 'fallback', messageId, bounceDetected }.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const DEFAULT_BOUNCE_WINDOW_MS = 180_000; // 3 minutes
const POLL_INTERVAL_MS = 20_000;

function buildTransporter({ user, pass }) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user, pass }
  });
}

async function pollForBounce({ inboxUser, pass, messageId, windowMs, log }) {
  const deadline = Date.now() + windowMs;
  const since = new Date(Date.now() - 60_000);

  while (Date.now() < deadline) {
    try {
      const client = new ImapFlow({
        host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        secure: true,
        auth: { user: inboxUser, pass },
        logger: false
      });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search(
          { since, subject: 'Undelivered Mail Returned to Sender' },
          { uid: true }
        );
        for (const uid of uids || []) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const raw = msg.source.toString('utf8');
          if (raw.includes(messageId)) {
            return { bounced: true, uid };
          }
          // Fallback: parse attachments for embedded rfc822 containing messageId
          const parsed = await simpleParser(msg.source);
          for (const att of parsed.attachments || []) {
            if (att.contentType === 'message/rfc822' &&
                att.content.toString('utf8').includes(messageId)) {
              return { bounced: true, uid };
            }
          }
        }
      } finally {
        lock.release();
        await client.logout();
      }
    } catch (err) {
      log('bounce-poll error:', err.message);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(POLL_INTERVAL_MS, remaining)));
  }
  return { bounced: false };
}

/**
 * Send `mail` via primary sender, verify delivery, fall back if bounced.
 *
 * @param {object} opts
 * @param {{from: string, pass: string, displayName?: string}} opts.primary
 * @param {{from: string, pass: string, displayName?: string}} opts.fallback
 * @param {object} opts.mail    — nodemailer sendMail payload (to, cc, subject, html/text, attachments)
 * @param {function} [opts.log] — logger (defaults to no-op)
 * @param {number}   [opts.bounceWindowMs] — override BOUNCE_WINDOW_MS / default 3 min
 */
async function sendWithFallback({ primary, fallback, mail, log = () => {}, bounceWindowMs } = {}) {
  if (!primary?.from || !primary?.pass) throw new Error('sendWithFallback: primary.from + primary.pass required');
  if (!fallback?.from || !fallback?.pass) throw new Error('sendWithFallback: fallback.from + fallback.pass required');

  const windowMs = bounceWindowMs ||
    parseInt(process.env.BOUNCE_WINDOW_MS || String(DEFAULT_BOUNCE_WINDOW_MS), 10);

  const primaryTransport = buildTransporter({ user: primary.from, pass: primary.pass });
  const primaryName = primary.displayName || primary.from;

  const info = await primaryTransport.sendMail({
    ...mail,
    from: `"${primaryName}" <${primary.from}>`
  });
  log(`verified-send: primary ${primary.from} SMTP "${info.response}" messageId=${info.messageId}`);

  const { bounced } = await pollForBounce({
    inboxUser: primary.from,
    pass: primary.pass,
    messageId: info.messageId,
    windowMs,
    log
  });

  if (!bounced) {
    log(`verified-send: no bounce in ${Math.round(windowMs / 1000)}s window — treating primary as delivered`);
    return { delivered: 'primary', messageId: info.messageId, bounceDetected: false };
  }

  log(`verified-send: BOUNCE detected for ${primary.from} — retrying via ${fallback.from}`);
  const fallbackTransport = buildTransporter({ user: fallback.from, pass: fallback.pass });
  const fallbackName = fallback.displayName || `${primaryName} (fallback ${fallback.from})`;
  const taggedSubject = (mail.subject || '') + ` [fallback sender — ${primary.from} delivery blocked]`;

  const info2 = await fallbackTransport.sendMail({
    ...mail,
    from: `"${fallbackName}" <${fallback.from}>`,
    subject: taggedSubject
  });
  log(`verified-send: fallback ${fallback.from} SMTP "${info2.response}" messageId=${info2.messageId}`);

  return { delivered: 'fallback', messageId: info2.messageId, bounceDetected: true };
}

module.exports = { sendWithFallback };
