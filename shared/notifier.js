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

const nodemailer = require('nodemailer');
const logger = require('./logger');

// AWS WorkMail SMTP settings (shared across all OT email accounts)
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);

function createNotifier({ fromEmail, fromName, smtpUser, smtpPass } = {}) {
  if (!fromEmail) throw new Error('notifier: fromEmail is required');

  const user = smtpUser || fromEmail;
  const pass = smtpPass || process.env.SMTP_PASS;
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

  async function sendEmail(to, subject, body) {
    if (!to) {
      logger.warn('No recipient specified');
      return false;
    }
    if (!pass) {
      logger.warn(`Notifier [${displayName}]: Skipping send — no SMTP password`);
      return false;
    }

    try {
      await transporter.sendMail({
        from: `"${displayName}" <${fromEmail}>`,
        to: to,
        subject: subject,
        text: body
      });
      logger.info(`Email sent to ${to}: ${subject}`);
      return true;
    } catch (err) {
      logger.error('Failed to send email:', err.message);
      return false;
    }
  }

  async function sendWithAttachment(to, subject, body, attachments) {
    if (!to) {
      logger.warn('No recipient specified');
      return false;
    }
    if (!pass) {
      logger.warn(`Notifier [${displayName}]: Skipping send — no SMTP password`);
      return false;
    }

    try {
      await transporter.sendMail({
        from: `"${displayName}" <${fromEmail}>`,
        to: to,
        subject: subject,
        text: body,
        attachments: attachments
      });
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
