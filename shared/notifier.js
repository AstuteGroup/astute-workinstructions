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

    // opts.html=true → send `body` as HTML instead of plain text
    const mailPayload = {
      from: `"${displayName}" <${fromEmail}>`,
      to: to,
      subject: subject,
    };
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

    // opts.html=true → send `body` as HTML instead of plain text
    const mailPayload = {
      from: `"${displayName}" <${fromEmail}>`,
      to: to,
      subject: subject,
      attachments: attachments,
    };
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
