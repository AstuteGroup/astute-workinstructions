/**
 * shared/workflow-actions/currency-conversion.js
 *
 * Workflow module for processing Exchange Rate Matrix Excel files into
 * iDempiere-compatible currency conversion CSV files.
 *
 * Inbox: bizops@orangetsunami.com
 * Doc:   tsk-currency-conversion-upload/currency-conversion-upload.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const breadcrumbs = require('../breadcrumbs');

// Import the currency processor
const currencyProcessorPath = path.join(
  __dirname,
  '../../tsk-currency-conversion-upload/currency-processor.js'
);
let currencyProcessor;
try {
  currencyProcessor = require(currencyProcessorPath);
} catch (err) {
  console.error(`Warning: Could not load currency processor from ${currencyProcessorPath}:`, err.message);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Send email via notifier, throwing on failure.
 */
async function sendEmailOrThrow(notifier, to, subject, body, opts = {}) {
  const sent = await notifier.sendEmail(to, subject, body, opts);
  if (!sent) {
    throw new Error(`Failed to send notification email to ${to}: ${subject}`);
  }
  return sent;
}

/**
 * Format date for filename (M_D_YY).
 */
function formatDateForFilename(dateStr) {
  const [year, month, day] = dateStr.split('-');
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const yy = year.slice(-2);
  return `${m}_${d}_${yy}`;
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Process an Exchange Rate Matrix Excel file and generate the CSV.
 *
 * Required payload: { attachmentPath, startDate, endDate }
 * Optional: { outputPath }
 */
async function action_process(payload, ctx) {
  const { attachmentPath, startDate, endDate, outputPath } = payload;

  if (!currencyProcessor) {
    return { error: 'Currency processor module not loaded' };
  }

  // Validate dates
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return { error: 'Dates must be in YYYY-MM-DD format', startDate, endDate };
  }

  // Check file exists
  if (!fs.existsSync(attachmentPath)) {
    return { error: 'Attachment file not found', attachmentPath };
  }

  // Check for already-processed (idempotency via breadcrumbs)
  if (ctx.currentMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(ctx.currentMessageId, {
      cog: 'currency-conversion-agent',
      events: ['currency-processed'],
    });
    if (dupCheck.loaded) {
      return {
        already_processed: true,
        messageId: ctx.currentMessageId,
        prior: dupCheck.breadcrumb,
      };
    }
  }

  // Determine output path
  let finalOutputPath;
  if (outputPath) {
    finalOutputPath = outputPath;
  } else {
    const startFormatted = formatDateForFilename(startDate);
    const endFormatted = formatDateForFilename(endDate);
    const filename = `Currency Conversion Upload - ${startFormatted} - ${endFormatted}.csv`;
    finalOutputPath = path.join(process.env.HOME, 'workspace', 'uploaded files', filename);
  }

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_process: {
        attachmentPath,
        startDate,
        endDate,
        outputPath: finalOutputPath,
      },
    };
  }

  // Process the Excel file
  let result;
  try {
    result = currencyProcessor.processExchangeRateMatrix(attachmentPath, startDate, endDate);
  } catch (err) {
    return { error: 'Failed to process Excel file', details: err.message };
  }

  // Generate and write CSV
  const csv = currencyProcessor.generateCsv(result.rows, startDate, endDate);
  fs.writeFileSync(finalOutputPath, csv, 'utf8');

  // Write breadcrumb
  breadcrumbs.write({
    cog: 'currency-conversion-agent',
    event: 'currency-processed',
    uid: ctx.uid,
    messageId: ctx.currentMessageId,
    startDate,
    endDate,
    outputPath: finalOutputPath,
    rowCount: result.rows.length,
  });

  // Send confirmation email
  const ratesSummary = Object.entries(result.xToUSD)
    .filter(([c]) => c !== 'USD')
    .map(([c, r]) => `<li>${c}→USD: ${r.toFixed(6)}</li>`)
    .join('');

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#080">Currency Rates Processed</h2>
<p><b>Date Range:</b> ${esc(startDate)} to ${esc(endDate)}</p>
<p><b>Output File:</b> ${esc(path.basename(finalOutputPath))}</p>
<p><b>Currency Pairs:</b> ${result.rows.length}</p>
<p><b>X→USD Rates:</b></p>
<ul>${ratesSummary}</ul>
<p style="color:#666;font-size:11px">UID: ${ctx.uid} | Ready for iDempiere import</p>
</body></html>`;

  await sendEmailOrThrow(ctx.notifier,
    'jake.harris@astutegroup.com',
    `Currency Rates Processed: ${startDate} to ${endDate}`,
    html,
    { html: true }
  );

  return {
    processed: true,
    startDate,
    endDate,
    outputPath: finalOutputPath,
    rowCount: result.rows.length,
    xToUSD: result.xToUSD,
  };
}

/**
 * Escalate to operator when processing fails or needs manual intervention.
 *
 * Required payload: { reason }
 * Optional: { subject, from, details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, from, details } = payload;

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Currency Conversion — needs review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(from)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview in ${ctx.inbox} inbox.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify: { reason } };
  }

  await sendEmailOrThrow(ctx.notifier,
    'jake.harris@astutegroup.com',
    `Currency Conversion — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true }
  );

  breadcrumbs.write({
    cog: 'currency-conversion-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    reason,
  });

  return { notified: 'jake.harris@astutegroup.com', reason };
}

/**
 * Skip — not a currency conversion email.
 */
async function action_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'not currency conversion' };
  }

  breadcrumbs.write({
    cog: 'currency-conversion-agent',
    event: 'skip',
    uid: ctx.uid,
    reason: payload.reason || 'not currency conversion',
  });

  return { skipped: true, reason: payload.reason || 'not currency conversion' };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'bizops@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'bizops@orangetsunami.com',
    fromName: 'Currency Conversion',
  },
  actions: {
    process: {
      folder: 'Processed',
      requires: ['attachmentPath', 'startDate', 'endDate'],
      handler: action_process,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    skip: {
      folder: 'NotCurrency',
      requires: ['reason'],
      handler: action_skip,
    },
  },
};
