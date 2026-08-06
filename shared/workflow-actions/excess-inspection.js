/**
 * shared/workflow-actions/excess-inspection.js
 *
 * Workflow module for processing excess inspection files (xlsx/pdf) from
 * consignment partners. Extracts part data, applies MFR code resolution,
 * product code classification, and generates inspection log format output.
 *
 * Inbox: bizops@orangetsunami.com
 * Doc:   Business Ops/tsk-excess-file-buildout/excess-inspection-file-buildout.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const breadcrumbs = require('../breadcrumbs');

// Import the excess processor
const processorPath = path.join(
  __dirname,
  '../../Business Ops/tsk-excess-file-buildout/excess-processor.js'
);
let excessProcessor;
try {
  excessProcessor = require(processorPath);
} catch (err) {
  console.error(`Warning: Could not load excess processor from ${processorPath}:`, err.message);
}

// Output directory for generated files
const OUTPUT_DIR = path.join(process.env.HOME, 'workspace', 'excess-inspection-output');

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
 * Ensure output directory exists.
 */
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Process an excess inspection file and generate output xlsx.
 *
 * Required payload: { attachmentPath }
 * Optional: { poNumber, site, consignmentPartner }
 */
async function action_process(payload, ctx) {
  const { attachmentPath, poNumber, site, consignmentPartner, originalSubject } = payload;

  if (!excessProcessor) {
    return { error: 'Excess processor module not loaded' };
  }

  // Check file exists
  if (!fs.existsSync(attachmentPath)) {
    return { error: 'Attachment file not found', attachmentPath };
  }

  // Check for already-processed (idempotency via breadcrumbs)
  if (ctx.currentMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(ctx.currentMessageId, {
      cog: 'excess-inspection-agent',
      events: ['excess-processed'],
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
  ensureOutputDir();
  const pov = poNumber || 'UNKNOWN';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = path.join(OUTPUT_DIR, `excess-inspection-buildout-${pov}-${timestamp}.xlsx`);

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_process: {
        attachmentPath,
        poNumber,
        site,
        consignmentPartner,
        outputPath,
      },
    };
  }

  // Process the file
  let result;
  try {
    result = await excessProcessor.processExcessFile(attachmentPath, {
      poNumber,
      site,
      consignmentPartner,
      outputPath,
    });
  } catch (err) {
    return { error: 'Failed to process excess file', details: err.message };
  }

  // Write breadcrumb
  breadcrumbs.write({
    cog: 'excess-inspection-agent',
    event: 'excess-processed',
    uid: ctx.uid,
    trackingId: ctx.trackingId,
    messageId: ctx.currentMessageId,
    poNumber: result.poNumber,
    site: result.site,
    consignmentPartner: result.consignmentPartner,
    outputPath: result.outputPath,
    lineCount: result.lineCount,
  });

  // Build confirmation email
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#080">Excess Inspection File Processed</h2>
<p><b>PO:</b> ${esc(result.poNumber)}</p>
<p><b>Consignment Partner:</b> ${esc(result.consignmentPartner)}</p>
<p><b>Site:</b> ${esc(result.site)}</p>
<p><b>Lines Processed:</b> ${result.lineCount}</p>
<p><b>Product Code Breakdown:</b></p>
<ul>
${Object.entries(result.productCodeBreakdown || {}).map(([code, count]) => `<li>${esc(code)}: ${count}</li>`).join('')}
</ul>
<p><b>MFR Coverage:</b> ${result.knownMfrCount || 0} known, ${result.unknownMfrCount || 0} unknown (M99999)</p>
<p><b>Output File:</b> ${esc(path.basename(result.outputPath))}</p>
<p style="color:#666;font-size:11px">UID: ${ctx.uid} | File saved to ${esc(OUTPUT_DIR)}</p>
</body></html>`;

  // Send confirmation to operator
  await sendEmailOrThrow(ctx.notifier,
    ctx.jakeEmail,
    `Excess Inspection Processed: ${result.poNumber}`,
    html,
    {
      html: true,
      attachments: [{ path: result.outputPath, filename: path.basename(result.outputPath) }]
    }
  );

  return {
    processed: true,
    poNumber: result.poNumber,
    site: result.site,
    consignmentPartner: result.consignmentPartner,
    outputPath: result.outputPath,
    lineCount: result.lineCount,
    productCodeBreakdown: result.productCodeBreakdown,
  };
}

/**
 * Ask operator for missing info (e.g., PO number, site, consignment partner).
 *
 * Required payload: { recipient, missing }
 * Optional: { subject, extracted }
 */
async function action_need_info(payload, ctx) {
  const pending = require('../workflow-pending-state');
  const { recipient, missing, subject, extracted } = payload;

  // Build the need-info reply
  const lines = [];
  if (Array.isArray(missing)) {
    for (const m of missing) {
      if (m === 'poNumber') {
        lines.push('• **PO Number** — Could not auto-detect POV number from the file. Please provide the PO number.');
      } else if (m === 'site') {
        lines.push('• **Site** — Please provide the site location (e.g., Long Island, Plexus, Grand Rapids).');
      } else if (m === 'consignmentPartner') {
        lines.push('• **Consignment Partner** — Please provide the partner name (e.g., GE Aviation, Marvell).');
      } else {
        lines.push(`• **${m}** — Please provide this information.`);
      }
    }
  }

  const body = [
    `Hi,`, ``,
    `I received an excess inspection file but need some additional information:`, ``,
    ...lines, ``,
    `Please reply with the missing details and I'll process the file.`, ``,
    `Thanks,`,
    `BizOps Automation`,
  ].join('\n');

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: recipient || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: Array.isArray(missing) ? missing : [],
    });
  }

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_reply: { to: recipient, cc: ctx.jakeEmail, replyTo: ctx.inbox, missing },
      draft: body,
      would_write_sidecar: { anchor: ctx.anchorMessageId, extracted, missing },
    };
  }

  // Send to Jake (operator), NOT to the external sender
  await sendEmailOrThrow(ctx.notifier,
    ctx.jakeEmail,
    `RE: ${subject || 'Excess Inspection File'} — details needed`,
    body,
    { cc: null, replyTo: ctx.inbox },
  );

  return {
    replied_to: ctx.jakeEmail,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: sidecarRecord ? sidecarRecord.retry_count : null,
  };
}

/**
 * Escalate to operator for manual review.
 *
 * Required payload: { reason }
 * Optional: { subject, from, details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, from, details } = payload;

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Excess Inspection — needs review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(from)}<br/>
   <b>Tracking ID:</b> ${ctx.trackingId || `(UID ${ctx.uid})`}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to Excess-NeedsReview in ${ctx.inbox} inbox.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify: { reason } };
  }

  await sendEmailOrThrow(ctx.notifier,
    ctx.jakeEmail,
    `Excess Inspection — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true }
  );

  breadcrumbs.write({
    cog: 'excess-inspection-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    trackingId: ctx.trackingId,
    reason,
  });

  return { notified: ctx.jakeEmail, reason };
}

/**
 * Skip — not an excess inspection file.
 */
async function action_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'not excess inspection' };
  }

  breadcrumbs.write({
    cog: 'excess-inspection-agent',
    event: 'skip',
    uid: ctx.uid,
    trackingId: ctx.trackingId,
    reason: payload.reason || 'not excess inspection',
  });

  return { skipped: true, reason: payload.reason || 'not excess inspection' };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'bizops@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'bizops@orangetsunami.com',
    fromName: 'Excess Inspection Processor',
  },
  actions: {
    process: {
      folder: 'Excess-Processed',
      requires: ['attachmentPath'],
      handler: action_process,
    },
    need_info: {
      folder: 'Excess-NeedInfo',
      requires: ['recipient', 'missing'],
      keepsPending: true,
      handler: action_need_info,
    },
    needs_review: {
      folder: 'Excess-NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    skip: {
      folder: 'NotExcess',
      requires: ['reason'],
      handler: action_skip,
    },
  },
};
