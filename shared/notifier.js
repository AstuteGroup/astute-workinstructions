/**
 * Shared Email Notifier
 *
 * Factory that creates a notifier with configurable sender identity.
 * Uses nodemailer with AWS WorkMail SMTP (shared across all OT accounts).
 *
 * Usage:
 *   const { createNotifier } = require('../shared/notifier');
 *   const notifier = createNotifier({
 *     fromEmail: 'stockRFQ@orangetsunami.com',
 *     fromName: 'Stock RFQ Loader'
 *   });
 *   await notifier.sendEmail('jake@example.com', 'Subject', 'Body text');
 *   await notifier.sendWithAttachment('jake@example.com', 'Subject', 'Body', [
 *     { filename: 'output.csv', path: '/path/to/file.csv' }
 *   ]);
 */

const path = require('path');
// Load centralized credentials from ~/workspace/.env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const nodemailer = require('nodemailer');
const fs = require('fs');
const logger = require('./logger');

// ─── EXTERNAL EMAIL BLOCK ────────────────────────────────────────────────────
// orangetsunami.com should NEVER send to external addresses.
// Only @astutegroup.com recipients are allowed.
const ALLOWED_DOMAINS = ['astutegroup.com', 'orangetsunami.com'];

function isInternalEmail(email) {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1];
  return ALLOWED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

function filterExternalRecipients(recipients) {
  if (!recipients) return { allowed: [], blocked: [] };
  // Handle comma-separated string (e.g., "a@x.com,b@x.com") or array
  let list;
  if (Array.isArray(recipients)) {
    list = recipients;
  } else if (typeof recipients === 'string') {
    list = recipients.split(',').map(r => r.trim()).filter(Boolean);
  } else {
    list = [recipients];
  }
  const allowed = [];
  const blocked = [];
  for (const r of list) {
    // Handle "Name <email>" format
    const match = r.match(/<([^>]+)>/) || [null, r];
    const email = match[1] || r;
    if (isInternalEmail(email.trim())) {
      allowed.push(r);
    } else {
      blocked.push(r);
    }
  }
  return { allowed, blocked };
}

// AWS WorkMail SMTP settings (shared across all OT email accounts)
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);

/**
 * Get password from env vars or himalaya config fallback
 */
function resolvePassword(explicit) {
  if (explicit) return explicit;
  if (process.env.WORKMAIL_PASS) return process.env.WORKMAIL_PASS;
  if (process.env.SMTP_PASS) return process.env.SMTP_PASS;

  // Fallback: read from himalaya config if available
  try {
    const configPath = path.join(process.env.HOME, '.config', 'himalaya', 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/backend\.auth\.raw\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch (e) { /* ignore */ }
  return null;
}

function createNotifier({ fromEmail, fromName, smtpUser, smtpPass } = {}) {
  if (!fromEmail) throw new Error('notifier: fromEmail is required');

  const user = smtpUser || fromEmail;
  const pass = resolvePassword(smtpPass);
  const displayName = fromName || fromEmail.split('@')[0];

  if (!pass) {
    logger.warn(`Notifier [${displayName}]: No SMTP password configured (set SMTP_PASS env var)`);
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: user,
      pass: pass
    }
  });

  async function sendEmail(to, subject, body, opts = {}) {
    if (!to) {
      logger.warn('No recipient specified');
      return false;
    }
    if (!pass) {
      logger.warn(`Notifier [${displayName}]: Skipping send — no SMTP password`);
      return false;
    }

    // ─── EXTERNAL EMAIL BLOCK ──────────────────────────────────────────────
    // Strip external recipients - only send to @astutegroup.com / @orangetsunami.com.
    // External addresses are logged and removed, internal recipients still get the email.
    const toResult = filterExternalRecipients(to);
    const ccResult = filterExternalRecipients(opts.cc);
    const bccResult = filterExternalRecipients(opts.bcc);

    const allBlocked = [...toResult.blocked, ...ccResult.blocked, ...bccResult.blocked];
    if (allBlocked.length > 0) {
      logger.warn(`Notifier [${displayName}]: STRIPPED external recipients: ${allBlocked.join(', ')} — only sending to internal addresses`);
    }

    if (toResult.allowed.length === 0) {
      logger.warn(`Notifier [${displayName}]: No internal recipients — email not sent. Subject: ${subject}`);
      return false;
    }

    // Use filtered internal-only recipients
    const internalTo = toResult.allowed.join(', ');
    const internalCc = ccResult.allowed.length > 0 ? ccResult.allowed : null;
    const internalBcc = bccResult.allowed.length > 0 ? bccResult.allowed : null;

    // opts.html=true → send `body` as HTML instead of plain text
    // opts.cc, opts.bcc, opts.replyTo → passthrough to nodemailer
    // opts.messageId → pre-assign the RFC822 Message-ID header (used by the
    //   cross-workflow forward+park pattern so the sender knows the M-ID
    //   the receiving workflow will see, before sendMail returns).
    // opts.inReplyTo → Message-ID of the email being replied to (for threading)
    // opts.references → array of Message-IDs in the thread chain (for threading)
    const mailPayload = {
      from: `"${displayName}" <${fromEmail}>`,
      to: internalTo,
      subject: subject,
    };
    if (internalCc) mailPayload.cc = internalCc;
    if (internalBcc) mailPayload.bcc = internalBcc;
    if (opts.replyTo) mailPayload.replyTo = opts.replyTo;
    if (opts.messageId) mailPayload.messageId = opts.messageId;
    if (opts.inReplyTo) mailPayload.inReplyTo = opts.inReplyTo;
    if (opts.references) mailPayload.references = Array.isArray(opts.references) ? opts.references.join(' ') : opts.references;
    if (opts.html) {
      mailPayload.html = body;
    } else {
      mailPayload.text = body;
    }

    try {
      await transporter.sendMail(mailPayload);
      logger.info(`Email sent to ${to}: ${subject}`);
      return true;
    } catch (err) {
      logger.error('Failed to send email:', err.message);
      return false;
    }
  }

  async function sendWithAttachment(to, subject, body, attachments, opts = {}) {
    if (!to) {
      logger.warn('No recipient specified');
      return false;
    }
    if (!pass) {
      logger.warn(`Notifier [${displayName}]: Skipping send — no SMTP password`);
      return false;
    }

    // ─── EXTERNAL EMAIL BLOCK ──────────────────────────────────────────────
    // Strip external recipients - only send to @astutegroup.com / @orangetsunami.com.
    // External addresses are logged and removed, internal recipients still get the email.
    const toResult = filterExternalRecipients(to);
    const ccResult = filterExternalRecipients(opts.cc);
    const bccResult = filterExternalRecipients(opts.bcc);

    const allBlocked = [...toResult.blocked, ...ccResult.blocked, ...bccResult.blocked];
    if (allBlocked.length > 0) {
      logger.warn(`Notifier [${displayName}]: STRIPPED external recipients: ${allBlocked.join(', ')} — only sending to internal addresses`);
    }

    if (toResult.allowed.length === 0) {
      logger.warn(`Notifier [${displayName}]: No internal recipients — email not sent. Subject: ${subject}`);
      return false;
    }

    // Use filtered internal-only recipients
    const internalTo = toResult.allowed.join(', ');
    const internalCc = ccResult.allowed.length > 0 ? ccResult.allowed : null;
    const internalBcc = bccResult.allowed.length > 0 ? bccResult.allowed : null;

    // opts.html=true → send `body` as HTML instead of plain text
    // opts.cc, opts.bcc, opts.replyTo → passthrough to nodemailer
    const mailPayload = {
      from: `"${displayName}" <${fromEmail}>`,
      to: internalTo,
      subject: subject,
      attachments: attachments,
    };
    if (internalCc) mailPayload.cc = internalCc;
    if (internalBcc) mailPayload.bcc = internalBcc;
    if (opts.replyTo) mailPayload.replyTo = opts.replyTo;
    if (opts.html) {
      mailPayload.html = body;
    } else {
      mailPayload.text = body;
    }

    try {
      await transporter.sendMail(mailPayload);
      logger.info(`Email with attachment sent to ${to}: ${subject}`);
      return true;
    } catch (err) {
      logger.error('Failed to send email with attachment:', err.message);
      return false;
    }
  }

  return {
    sendEmail,
    sendWithAttachment
  };
}

module.exports = { createNotifier };
