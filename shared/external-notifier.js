/**
 * External Email Notifier
 *
 * Sends emails to EXTERNAL recipients (customers, brokers) — bypassing the
 * internal-only filter in shared/notifier.js. Use for:
 *   - RFQ load confirmations to the original sender
 *   - Need-info requests to customers for missing data
 *
 * SAFETY CONTROLS:
 *   - Explicit opt-in (must call this module separately from internal notifications)
 *   - Reply-To always set to workflow inbox (replies come back for processing)
 *   - Rate limit: max 1 external email per Message-ID (dedup via breadcrumbs)
 *   - Breadcrumb audit trail for all external sends
 *
 * Usage:
 *   const { sendExternalNotification } = require('../shared/external-notifier');
 *   await sendExternalNotification({
 *     to: 'customer@acme.com',
 *     subject: 'Re: Your RFQ',
 *     body: 'Your RFQ has been received...',
 *     replyTo: 'rfqloading@orangetsunami.com',
 *     messageId: originalMessageId,  // for dedup + threading
 *     workflow: 'rfq-loading',
 *   });
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const nodemailer = require('nodemailer');
const fs = require('fs');
const logger = require('./logger');
const breadcrumbs = require('./breadcrumbs');

// AWS WorkMail SMTP settings
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);

/**
 * Get password from env vars or himalaya config fallback
 */
function resolvePassword() {
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

// Singleton transporter (reused across calls)
let _transporter = null;

function getTransporter(fromEmail) {
  if (_transporter) return _transporter;
  const pass = resolvePassword();
  if (!pass) {
    logger.warn('External notifier: No SMTP password configured');
    return null;
  }
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: fromEmail,
      pass: pass,
    },
  });
  return _transporter;
}

/**
 * Check if we've already sent an external notification for this Message-ID.
 * Prevents duplicate sends on retries/replays.
 *
 * @param {string} messageId - Original email's Message-ID
 * @param {string} eventType - e.g., 'external-confirmation-sent', 'external-need-info-sent'
 * @returns {boolean} true if already sent
 */
function hasAlreadySent(messageId, eventType) {
  if (!messageId) return false;
  return breadcrumbs.hasMessageIdAlreadyLoaded(messageId, {
    cog: 'external-notifier',
    events: [eventType],
  }).loaded;
}

/**
 * Send an email to an EXTERNAL recipient.
 *
 * @param {object} opts
 * @param {string} opts.to - External recipient email
 * @param {string} opts.subject - Email subject
 * @param {string} opts.body - Email body (plain text)
 * @param {string} opts.replyTo - Reply-To address (typically workflow inbox)
 * @param {string} opts.fromEmail - Sender email address
 * @param {string} [opts.fromName] - Sender display name
 * @param {string} [opts.messageId] - Original email's Message-ID (for dedup + threading)
 * @param {string} [opts.workflow] - Workflow name (for breadcrumb)
 * @param {string} [opts.eventType] - Event type for dedup (default: 'external-notification-sent')
 * @param {boolean} [opts.html] - If true, body is HTML
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendExternalNotification(opts) {
  const {
    to,
    subject,
    body,
    replyTo,
    fromEmail,
    fromName,
    messageId,
    workflow,
    eventType = 'external-notification-sent',
    html = false,
  } = opts;

  if (!to) {
    return { sent: false, reason: 'no-recipient' };
  }

  if (!fromEmail) {
    return { sent: false, reason: 'no-from-email' };
  }

  // Rate limit: check if we've already sent for this Message-ID
  if (messageId && hasAlreadySent(messageId, eventType)) {
    logger.info(`External notifier: Already sent ${eventType} for ${messageId}, skipping`);
    return { sent: false, reason: 'already-sent', messageId };
  }

  const transporter = getTransporter(fromEmail);
  if (!transporter) {
    return { sent: false, reason: 'no-smtp-password' };
  }

  const displayName = fromName || 'Astute Electronics';

  const mailPayload = {
    from: `"${displayName}" <${fromEmail}>`,
    to: to,
    subject: subject,
    replyTo: replyTo || fromEmail,
  };

  if (html) {
    mailPayload.html = body;
  } else {
    mailPayload.text = body;
  }

  // Threading: set In-Reply-To so the reply lands in the customer's thread
  if (messageId) {
    mailPayload.inReplyTo = messageId;
    mailPayload.references = messageId;
  }

  try {
    await transporter.sendMail(mailPayload);
    logger.info(`External email sent to ${to}: ${subject}`);

    // Write breadcrumb for audit trail + dedup
    breadcrumbs.write({
      cog: 'external-notifier',
      event: eventType,
      workflow: workflow || null,
      to: to,
      subject: subject,
      messageId: messageId || null,
      replyTo: replyTo || null,
    });

    return { sent: true };
  } catch (err) {
    logger.error(`Failed to send external email to ${to}:`, err.message);
    return { sent: false, reason: 'smtp-error', error: err.message };
  }
}

/**
 * Send RFQ load confirmation to external sender.
 *
 * @param {object} opts
 * @param {string} opts.to - External recipient email
 * @param {string} opts.searchKey - RFQ search key (e.g., '1138194')
 * @param {string} opts.partnerName - Customer name
 * @param {number} opts.lineCount - Number of lines loaded
 * @param {string} [opts.originalSubject] - Original email subject (for Re:)
 * @param {string} [opts.messageId] - Original Message-ID
 * @param {string} [opts.replyTo] - Reply-To address
 * @param {string} [opts.fromEmail] - Sender email
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendExternalConfirmation(opts) {
  const {
    to,
    searchKey,
    partnerName,
    lineCount,
    originalSubject,
    messageId,
    replyTo = 'rfqloading@orangetsunami.com',
    fromEmail = 'rfqloading@orangetsunami.com',
  } = opts;

  const subject = originalSubject
    ? `Re: ${originalSubject}`
    : `RFQ ${searchKey} received`;

  const body = `Your RFQ has been received and assigned reference number ${searchKey}.

Customer: ${partnerName || '(on file)'}
Lines: ${lineCount}

Our team will review and respond shortly.

— Astute Electronics`;

  return sendExternalNotification({
    to,
    subject,
    body,
    replyTo,
    fromEmail,
    fromName: 'Astute Electronics',
    messageId,
    workflow: 'rfq-loading',
    eventType: 'external-confirmation-sent',
  });
}

/**
 * Send need-info request to external sender.
 *
 * @param {object} opts
 * @param {string} opts.to - External recipient email
 * @param {string[]} opts.missing - Array of missing field names
 * @param {string} [opts.originalSubject] - Original email subject
 * @param {string} [opts.messageId] - Original Message-ID
 * @param {string} [opts.replyTo] - Reply-To address
 * @param {string} [opts.fromEmail] - Sender email
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendExternalNeedInfo(opts) {
  const {
    to,
    missing,
    originalSubject,
    messageId,
    replyTo = 'rfqloading@orangetsunami.com',
    fromEmail = 'rfqloading@orangetsunami.com',
  } = opts;

  const subject = originalSubject
    ? `Re: ${originalSubject} — Additional information needed`
    : 'Additional information needed for your RFQ';

  // Format missing items as bullet points
  const missingLabels = (missing || []).map(m => {
    if (typeof m === 'object' && m.field) {
      return formatMissingLabel(m.field, m.context);
    }
    return formatMissingLabel(m);
  });

  const missingList = missingLabels.map(l => `  - ${l}`).join('\n');

  const body = `Thank you for your RFQ. To process it, we need:

${missingList}

Please reply to this email with the requested information.

— Astute Electronics`;

  return sendExternalNotification({
    to,
    subject,
    body,
    replyTo,
    fromEmail,
    fromName: 'Astute Electronics',
    messageId,
    workflow: 'rfq-loading',
    eventType: 'external-need-info-sent',
  });
}

/**
 * Format a missing field label for external email.
 */
function formatMissingLabel(field, context) {
  const labels = {
    mpn: 'Part numbers (MPNs)',
    qty: 'Quantities for the parts',
    rfq_type: 'Type of request (shortage, PPV, etc.)',
    contact: 'Contact name',
    customer: 'Company name',
  };
  const label = labels[field] || field;
  return context ? `${label}: ${context}` : label;
}

/**
 * Check if missing fields are customer-answerable (vs internal-only).
 * External need-info should only ask for things the customer can provide.
 *
 * Customer-answerable: mpn, qty, contact, customer (company name)
 * Internal-only: rfq_type (Astute classification)
 *
 * @param {Array} missing - Array of missing field names/objects
 * @returns {boolean} true if at least one field is customer-answerable
 */
function hasCustomerAnswerableFields(missing) {
  const customerFields = new Set(['mpn', 'qty', 'contact', 'customer']);
  return (missing || []).some(m => {
    const field = typeof m === 'object' ? m.field : m;
    return customerFields.has(field);
  });
}

/**
 * Filter missing fields to only customer-answerable ones.
 *
 * @param {Array} missing - Array of missing field names/objects
 * @returns {Array} Filtered array with only customer-answerable fields
 */
function filterCustomerAnswerableFields(missing) {
  const customerFields = new Set(['mpn', 'qty', 'contact', 'customer']);
  return (missing || []).filter(m => {
    const field = typeof m === 'object' ? m.field : m;
    return customerFields.has(field);
  });
}

module.exports = {
  sendExternalNotification,
  sendExternalConfirmation,
  sendExternalNeedInfo,
  hasCustomerAnswerableFields,
  filterCustomerAnswerableFields,
  hasAlreadySent,
};
