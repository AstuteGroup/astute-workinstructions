/**
 * shared/workflow-actions/lam-kitting.js
 *
 * Email workflow handler for LAM Kitting inbox. Processes:
 *   - Price change approvals from LAM
 *   - Lead time change approvals from LAM
 *   - New award line additions
 *   - Rejections
 *   - Clarifications and general correspondence
 *
 * APPROVAL + FLAGGING PATTERN:
 *   1. Explicit approvals (price, lead time) are applied immediately
 *   2. Discrepancies detected between email and roster are FLAGGED (not auto-applied)
 *   3. Status = "Additional Review" is set when discrepancies exist
 *   4. Summary email sent: "Applied X, please review Y"
 *   5. Operator replies APPROVE/SKIP for flagged items
 *   6. Downstream workflows (reorder alerts) show parts with "Additional Review" status
 *
 * Inbox: lamkitting@orangetsunami.com
 * Doc:   Trading Analysis/LAM 3PL/lam-kitting-agent.md
 *
 * Master Roster: Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx
 */

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const pending = require('../workflow-pending-state');
const breadcrumbs = require('../breadcrumbs');

// ─── PATHS ───────────────────────────────────────────────────────────────────

const ASTUTE = path.join(process.env.HOME, 'workspace', 'astute-workinstructions');
const ROSTER_PATH = path.join(ASTUTE, 'Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const FLAGGED_REVIEW_PATH = path.join(ASTUTE, 'Trading Analysis/LAM 3PL/data/lam-flagged-review.json');

// ─── ROSTER COLUMN MAPPING ───────────────────────────────────────────────────
// Must match lam-kitting-reorder.js and lam-3pl.md spec

const ROSTER_COLS = {
  CPC: 'CPC',
  MPN: 'MPN',
  MFR: 'Manufacturer',
  DESCRIPTION: 'Description',
  AWARD: 'Award',
  BASE_PRICE: 'Base Unit Price',
  RESALE_PRICE: 'Resale Price',
  REORDER_THRESHOLD: 'Reorder Threshold',
  MOQ: 'MOQ',
  LEAD_TIME: 'Contractual Lead Time',
  BUYER: 'Buyer',
  PENDING: 'Pending',
  PROPOSED_RESALE: 'Proposed Resale',
  LAST_APPROVED: 'Last Approved',
  STATUS: 'Status',
  SUBMITTED_DATE: 'Submitted Date',
};

// Fields to check for discrepancies
const DISCREPANCY_FIELDS = [
  { key: 'leadTime', col: 'LEAD_TIME', label: 'Lead Time' },
  { key: 'moq', col: 'MOQ', label: 'MOQ' },
  { key: 'reorderThreshold', col: 'REORDER_THRESHOLD', label: 'Reorder Threshold' },
  { key: 'basePrice', col: 'BASE_PRICE', label: 'Base Unit Price' },
];

// ─── EMAIL OPTIONS HELPER ────────────────────────────────────────────────────

/**
 * Build email options with CC to original sender (if different from Jake).
 * All summary emails go to Jake AND the original email sender.
 */
function buildEmailOpts(ctx, extraOpts = {}) {
  const opts = { html: true, replyTo: ctx.inbox, ...extraOpts };

  // CC the original sender if different from Jake
  if (ctx.currentFrom && ctx.currentFrom !== ctx.jakeEmail.toLowerCase()) {
    opts.cc = ctx.currentFrom;
  }

  return opts;
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Price approval with discrepancy detection.
 *
 * 1. Apply the approved price change immediately
 * 2. Detect discrepancies between email mentions and roster values
 * 3. If discrepancies found:
 *    - Set Status = "Additional Review"
 *    - Write flagged items to sidecar
 *    - Send summary email with applied + flagged sections
 *
 * Required payload: { cpc, approvedResale }
 * Optional: { mpn, approvalDate, approvedBy, notes, investigation_summary }
 * Optional (for discrepancy detection): { emailMentions: { leadTime, moq, basePrice, ... } }
 */
async function action_approve_price(payload, ctx) {
  const {
    cpc, mpn, approvedResale, approvalDate, approvedBy, notes,
    emailMentions,  // Object with fields detected in email (for discrepancy check)
    investigation_summary,
  } = payload;

  const effectiveDate = approvalDate || new Date().toISOString().slice(0, 10);

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_update: { cpc, mpn, approvedResale, approvalDate: effectiveDate },
      would_check_discrepancies: emailMentions || null,
    };
  }

  // Find the part first to get current state
  const match = findRosterRow(cpc, mpn);
  if (!match.found) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'approve-price-failed',
      uid: ctx.uid,
      cpc,
      mpn,
      error: 'Part not found',
    });
    return { error: `Part not found: CPC=${cpc}, MPN=${mpn}`, fallback: 'needs_review' };
  }

  const { row, cols } = match;
  const currentState = extractCurrentState(row, cols);
  const previousResale = currentState.resalePrice;

  // Detect discrepancies between email mentions and roster
  const discrepancies = detectDiscrepancies(emailMentions, currentState);

  // Apply the approved price change
  const result = updateRosterPrice(cpc, mpn, {
    resalePrice: approvedResale,
    lastApproved: effectiveDate,
    clearPending: true,
    // Set "Additional Review" if discrepancies found
    setAdditionalReview: discrepancies.length > 0,
  });

  if (!result.success) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'approve-price-failed',
      uid: ctx.uid,
      cpc,
      mpn,
      error: result.error,
    });
    return { error: result.error, fallback: 'needs_review' };
  }

  // If discrepancies found, write to flagged review file
  if (discrepancies.length > 0) {
    writeFlaggedReview(cpc, {
      uid: ctx.uid,
      messageId: ctx.currentMessageId || ctx.anchorMessageId,
      flaggedAt: new Date().toISOString(),
      discrepancies,
      currentState,
      appliedChange: { field: 'Resale Price', from: previousResale, to: approvedResale },
    });
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'price-approved',
    uid: ctx.uid,
    cpc,
    mpn: result.mpn || mpn,
    previousResale,
    newResale: approvedResale,
    approvalDate: effectiveDate,
    approvedBy: approvedBy || null,
    discrepanciesFound: discrepancies.length,
    hasAdditionalReview: discrepancies.length > 0,
  });

  // Send summary email
  const html = buildApprovalSummaryEmail({
    cpc,
    mpn: result.mpn || mpn,
    applied: [{ field: 'Resale Price', from: previousResale, to: approvedResale }],
    discrepancies,
    currentState,
    notes,
  }, ctx);

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    discrepancies.length > 0
      ? `LAM Approval Applied + Review Needed: ${cpc}`
      : `LAM Approval Applied: ${cpc}`,
    html,
    buildEmailOpts(ctx),
  );

  return {
    updated: true,
    cpc,
    mpn: result.mpn || mpn,
    previousResale,
    newResale: approvedResale,
    lastApproved: effectiveDate,
    discrepanciesFound: discrepancies.length,
    additionalReviewSet: discrepancies.length > 0,
    notified: ctx.jakeEmail,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
  };
}

/**
 * Lead time approval with discrepancy detection.
 *
 * Required payload: { cpc, newLeadTime }
 * Optional: { mpn, approvalDate, emailMentions, investigation_summary }
 */
async function action_approve_leadtime(payload, ctx) {
  const { cpc, mpn, newLeadTime, approvalDate, emailMentions, investigation_summary } = payload;
  const effectiveDate = approvalDate || new Date().toISOString().slice(0, 10);

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_update: { cpc, newLeadTime, approvalDate: effectiveDate },
    };
  }

  // Find the part first
  const match = findRosterRow(cpc, mpn);
  if (!match.found) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'approve-leadtime-failed',
      uid: ctx.uid,
      cpc,
      error: 'Part not found',
    });
    return { error: `Part not found: CPC=${cpc}, MPN=${mpn}`, fallback: 'needs_review' };
  }

  const { row, cols } = match;
  const currentState = extractCurrentState(row, cols);
  const previousLeadTime = currentState.leadTime;

  // Detect discrepancies (excluding lead time since we're explicitly updating it)
  const mentionsWithoutLeadTime = { ...emailMentions };
  delete mentionsWithoutLeadTime.leadTime;
  const discrepancies = detectDiscrepancies(mentionsWithoutLeadTime, currentState);

  const result = updateRosterLeadTime(cpc, mpn, {
    leadTime: newLeadTime,
    lastApproved: effectiveDate,
    setAdditionalReview: discrepancies.length > 0,
  });

  if (!result.success) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'approve-leadtime-failed',
      uid: ctx.uid,
      cpc,
      error: result.error,
    });
    return { error: result.error, fallback: 'needs_review' };
  }

  // If discrepancies found, write to flagged review file
  if (discrepancies.length > 0) {
    writeFlaggedReview(cpc, {
      uid: ctx.uid,
      messageId: ctx.currentMessageId || ctx.anchorMessageId,
      flaggedAt: new Date().toISOString(),
      discrepancies,
      currentState,
      appliedChange: { field: 'Lead Time', from: previousLeadTime, to: newLeadTime },
    });
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'leadtime-approved',
    uid: ctx.uid,
    cpc,
    previousLeadTime,
    newLeadTime,
    approvalDate: effectiveDate,
    discrepanciesFound: discrepancies.length,
  });

  // Send summary email
  const html = buildApprovalSummaryEmail({
    cpc,
    mpn: match.row[cols.MPN],
    applied: [{ field: 'Lead Time', from: previousLeadTime, to: newLeadTime }],
    discrepancies,
    currentState,
  }, ctx);

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    discrepancies.length > 0
      ? `LAM Approval Applied + Review Needed: ${cpc}`
      : `LAM Approval Applied: ${cpc}`,
    html,
    buildEmailOpts(ctx),
  );

  return {
    updated: true,
    cpc,
    previousLeadTime,
    newLeadTime,
    lastApproved: effectiveDate,
    discrepanciesFound: discrepancies.length,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
    additionalReviewSet: discrepancies.length > 0,
    notified: ctx.jakeEmail,
  };
}

/**
 * Approve a flagged discrepancy item.
 *
 * Operator replied "APPROVE LEADTIME" or similar — apply the flagged change.
 *
 * Required payload: { cpc, field, newValue }
 * field: 'leadTime' | 'moq' | 'reorderThreshold' | 'basePrice'
 */
async function action_approve_flagged(payload, ctx) {
  const { cpc, field, newValue, investigation_summary } = payload;

  if (ctx.dryRun) {
    return { dry_run: true, would_approve_flagged: { cpc, field, newValue } };
  }

  const match = findRosterRow(cpc, null);
  if (!match.found) {
    return { error: `Part not found: CPC=${cpc}`, fallback: 'needs_review' };
  }

  const { wb, data, cols, rowIdx, row } = match;
  const fieldConfig = DISCREPANCY_FIELDS.find(f => f.key === field);
  if (!fieldConfig) {
    return { error: `Unknown field: ${field}`, fallback: 'needs_review' };
  }

  const previousValue = row[cols[fieldConfig.col]];
  row[cols[fieldConfig.col]] = newValue;
  row[cols.LAST_APPROVED] = new Date().toISOString().slice(0, 10);

  // Remove from flagged review
  const remaining = removeFlaggedItem(cpc, field);

  // Clear "Additional Review" if no more flagged items for this CPC
  if (remaining === 0) {
    if (row[cols.STATUS] === 'Additional Review') {
      row[cols.STATUS] = '';
    }
  }

  data[rowIdx] = row;
  writeRoster(wb, data);

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'flagged-approved',
    uid: ctx.uid,
    cpc,
    field: fieldConfig.label,
    previousValue,
    newValue,
    remainingFlagged: remaining,
  });

  return {
    approved: true,
    cpc,
    field: fieldConfig.label,
    previousValue,
    newValue,
    remainingFlagged: remaining,
    statusCleared: remaining === 0,
  };
}

/**
 * Skip a flagged discrepancy item — don't apply, just clear the flag.
 *
 * Required payload: { cpc, field }
 */
async function action_skip_flagged(payload, ctx) {
  const { cpc, field, investigation_summary } = payload;

  if (ctx.dryRun) {
    return { dry_run: true, would_skip_flagged: { cpc, field } };
  }

  const fieldConfig = DISCREPANCY_FIELDS.find(f => f.key === field);
  const fieldLabel = fieldConfig ? fieldConfig.label : field;

  // Remove from flagged review
  const remaining = removeFlaggedItem(cpc, field);

  // Clear "Additional Review" if no more flagged items for this CPC
  if (remaining === 0) {
    const match = findRosterRow(cpc, null);
    if (match.found) {
      const { wb, data, cols, rowIdx, row } = match;
      if (row[cols.STATUS] === 'Additional Review') {
        row[cols.STATUS] = '';
        data[rowIdx] = row;
        writeRoster(wb, data);
      }
    }
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'flagged-skipped',
    uid: ctx.uid,
    cpc,
    field: fieldLabel,
    remainingFlagged: remaining,
  });

  return {
    skipped: true,
    cpc,
    field: fieldLabel,
    remainingFlagged: remaining,
    statusCleared: remaining === 0,
  };
}

/**
 * Add new award line to Master Roster.
 *
 * CRITICAL: MFR must be validated via lookupMfr() before calling this action.
 *
 * Required payload: { cpc, mpn, manufacturer, awardQty, basePrice, resalePrice }
 * Optional: { description, reorderThreshold, moq, contractualLeadTime, buyer, investigation_summary }
 */
async function action_add_award(payload, ctx) {
  const {
    cpc, mpn, manufacturer, description, awardQty,
    basePrice, resalePrice, reorderThreshold, moq,
    contractualLeadTime, buyer,
    investigation_summary,
  } = payload;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_add: { cpc, mpn, manufacturer, awardQty, basePrice, resalePrice },
    };
  }

  // Check if CPC already exists (prevent duplicates)
  const existingCheck = findRosterRowByCpc(cpc);
  if (existingCheck.found) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'add-award-duplicate',
      uid: ctx.uid,
      cpc,
      existingRow: existingCheck.rowIdx,
    });
    return {
      error: `CPC ${cpc} already exists in Master Roster at row ${existingCheck.rowIdx + 1}`,
      fallback: 'needs_review',
    };
  }

  const result = appendRosterRow({
    cpc,
    mpn,
    manufacturer,
    description: description || '',
    award: awardQty,
    basePrice,
    resalePrice,
    reorderThreshold: reorderThreshold || 0,
    moq: moq || 1,
    leadTime: contractualLeadTime || '',
    buyer: buyer || 'Jake Harris',
  });

  if (!result.success) {
    breadcrumbs.write({
      cog: 'lam-kitting-agent',
      event: 'add-award-failed',
      uid: ctx.uid,
      cpc,
      error: result.error,
    });
    return { error: result.error, fallback: 'needs_review' };
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'award-added',
    uid: ctx.uid,
    cpc,
    mpn,
    manufacturer,
    awardQty,
    basePrice,
    resalePrice,
  });

  // Send confirmation email
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#080">LAM New Award Added</h2>
<table style="border-collapse:collapse;font-size:13px">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">CPC:</td><td>${esc(cpc)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">MPN:</td><td>${esc(mpn)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Manufacturer:</td><td>${esc(manufacturer)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Award Qty:</td><td>${formatNumber(awardQty)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Base Price:</td><td>${formatCurrency(basePrice)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Resale Price:</td><td>${formatCurrency(resalePrice)}</td></tr>
  ${contractualLeadTime ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Lead Time:</td><td>${esc(contractualLeadTime)}</td></tr>` : ''}
</table>
<p style="color:#666;font-size:11px">Added to Master Roster. Will appear in next reorder cycle.</p>
</body></html>`;

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `LAM New Award Added: ${cpc}`,
    html,
    buildEmailOpts(ctx),
  );

  return {
    added: true,
    cpc,
    mpn,
    manufacturer,
    awardQty,
    basePrice,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
    resalePrice,
    notified: ctx.jakeEmail,
  };
}

/**
 * Rejection — LAM rejected the proposed price or lead time.
 */
async function action_reject(payload, ctx) {
  const { cpc, mpn, reason, rejectedBy, investigation_summary } = payload;

  if (ctx.dryRun) {
    return { dry_run: true, would_reject: { cpc, reason } };
  }

  // Update Status to "Rejected"
  const match = findRosterRow(cpc, mpn);
  if (match.found) {
    const { wb, data, cols, rowIdx, row } = match;
    row[cols.STATUS] = 'Rejected';
    data[rowIdx] = row;
    writeRoster(wb, data);
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'rejection-recorded',
    uid: ctx.uid,
    cpc,
    mpn: mpn || null,
    reason,
    rejectedBy: rejectedBy || null,
  });

  // Notify operator
  const html = buildRejectionEmail(payload, ctx);
  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `LAM Rejection: ${cpc}`,
    html,
    buildEmailOpts(ctx),
  );

  return {
    rejected: true,
    cpc,
    reason,
    notified: ctx.jakeEmail,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
  };
}

/**
 * Need info — clarification needed (internal only — NEVER email LAM).
 */
async function action_need_info(payload, ctx) {
  const { missing, subject, extracted, investigation_summary } = payload;
  const missingList = Array.isArray(missing) ? missing : [];

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      extracted: extracted || {},
      missing: missingList,
      investigation_summary: investigation_summary || null,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;

  const missingItems = missingList.map(m => `<li>${esc(typeof m === 'object' ? m.field || JSON.stringify(m) : m)}</li>`).join('');
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">LAM Kitting — info needed</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}</p>
<p><b>Missing fields:</b></p>
<ul>${missingItems || '<li>(none specified)</li>'}</ul>
${investigationBlock}
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply to ${esc(ctx.inbox)} with the missing values.</b>
</p>
<p style="color:#666;font-size:11px">To discard: reply with <code>SKIP</code> or <code>DROP</code>.</p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_notify: { to: ctx.jakeEmail, missing: missingList },
    };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `LAM Kitting — needs info: ${subject || '(no subject)'}`,
    html,
    buildEmailOpts(ctx),
  );

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'escalated-need_info',
    uid: ctx.uid,
    missing: missingList,
  });

  return {
    notified: ctx.jakeEmail,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

/**
 * Needs review — cannot parse or match, requires operator triage.
 */
async function action_needs_review(payload, ctx) {
  const { reason, details, subject, from, investigation_summary } = payload;

  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">LAM Kitting — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(from)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${investigationBlock}
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify: { to: ctx.jakeEmail, reason } };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `LAM Kitting — needs review: ${subject || '(no subject)'}`,
    html,
    buildEmailOpts(ctx),
  );

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    reason,
  });

  return {
    notified: ctx.jakeEmail,
    ccSender: ctx.currentFrom !== ctx.jakeEmail.toLowerCase() ? ctx.currentFrom : null,
  };
}

/**
 * Not an approval email — general correspondence.
 */
async function action_not_approval(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'not-approval-email' };
  }

  breadcrumbs.write({
    cog: 'lam-kitting-agent',
    event: 'not-approval',
    uid: ctx.uid,
    reason: payload.reason || 'not-approval-email',
  });

  return { reason: payload.reason || 'not-approval-email' };
}

// ─── DISCREPANCY DETECTION ───────────────────────────────────────────────────

/**
 * Extract current state from roster row.
 */
function extractCurrentState(row, cols) {
  return {
    cpc: row[cols.CPC],
    mpn: row[cols.MPN],
    manufacturer: row[cols.MFR],
    resalePrice: row[cols.RESALE_PRICE],
    basePrice: row[cols.BASE_PRICE],
    leadTime: row[cols.LEAD_TIME],
    moq: row[cols.MOQ],
    reorderThreshold: row[cols.REORDER_THRESHOLD],
    status: row[cols.STATUS],
  };
}

/**
 * Detect discrepancies between email mentions and current roster state.
 *
 * @param {Object} emailMentions - Fields mentioned in the email (e.g., { leadTime: "16 weeks" })
 * @param {Object} currentState - Current roster state
 * @returns {Array} Array of discrepancies: { field, label, emailValue, rosterValue }
 */
function detectDiscrepancies(emailMentions, currentState) {
  if (!emailMentions || typeof emailMentions !== 'object') {
    return [];
  }

  const discrepancies = [];

  for (const fieldConfig of DISCREPANCY_FIELDS) {
    const { key, label } = fieldConfig;
    const emailValue = emailMentions[key];
    const rosterValue = currentState[key];

    if (emailValue !== undefined && emailValue !== null && emailValue !== '') {
      // Normalize values for comparison
      const normalizedEmail = normalizeValue(emailValue);
      const normalizedRoster = normalizeValue(rosterValue);

      if (normalizedEmail !== normalizedRoster) {
        discrepancies.push({
          field: key,
          label,
          emailValue: emailValue,
          rosterValue: rosterValue || '(empty)',
        });
      }
    }
  }

  return discrepancies;
}

/**
 * Normalize values for comparison (lowercase, trim, standardize numbers).
 */
function normalizeValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return String(val);
  return String(val).toLowerCase().trim();
}

// ─── FLAGGED REVIEW MANAGEMENT ───────────────────────────────────────────────

/**
 * Read the flagged review file.
 */
function readFlaggedReview() {
  try {
    if (fs.existsSync(FLAGGED_REVIEW_PATH)) {
      return JSON.parse(fs.readFileSync(FLAGGED_REVIEW_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error reading flagged review file:', err.message);
  }
  return {};
}

/**
 * Write to the flagged review file.
 */
function writeFlaggedReviewFile(data) {
  const dir = path.dirname(FLAGGED_REVIEW_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(FLAGGED_REVIEW_PATH, JSON.stringify(data, null, 2));
}

/**
 * Add an entry to the flagged review file.
 */
function writeFlaggedReview(cpc, entry) {
  const data = readFlaggedReview();
  if (!data[cpc]) {
    data[cpc] = [];
  }
  data[cpc].push(entry);
  writeFlaggedReviewFile(data);
}

/**
 * Remove a flagged item and return the count of remaining items for this CPC.
 */
function removeFlaggedItem(cpc, field) {
  const data = readFlaggedReview();
  if (!data[cpc]) return 0;

  // Remove the specific field from all entries
  for (const entry of data[cpc]) {
    if (entry.discrepancies) {
      entry.discrepancies = entry.discrepancies.filter(d => d.field !== field);
    }
  }

  // Clean up entries with no remaining discrepancies
  data[cpc] = data[cpc].filter(entry =>
    entry.discrepancies && entry.discrepancies.length > 0
  );

  // Count remaining
  let remaining = 0;
  for (const entry of data[cpc]) {
    remaining += entry.discrepancies ? entry.discrepancies.length : 0;
  }

  // Remove CPC entry if empty
  if (data[cpc].length === 0) {
    delete data[cpc];
  }

  writeFlaggedReviewFile(data);
  return remaining;
}

/**
 * Get all flagged CPCs (for reorder workflow visibility).
 */
function getFlaggedCPCs() {
  const data = readFlaggedReview();
  return Object.keys(data);
}

// ─── ROSTER UPDATE FUNCTIONS ─────────────────────────────────────────────────

function readRoster() {
  if (!fs.existsSync(ROSTER_PATH)) {
    return { error: `Master Roster not found: ${ROSTER_PATH}` };
  }

  const wb = XLSX.readFile(ROSTER_PATH);
  const ws = wb.Sheets['Master Roster'];
  if (!ws) {
    return { error: 'Master Roster sheet not found in workbook' };
  }

  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const headers = data[0] || [];

  const cols = {};
  for (const [key, name] of Object.entries(ROSTER_COLS)) {
    cols[key] = headers.indexOf(name);
  }

  return { wb, ws, data, headers, cols };
}

function writeRoster(wb, data) {
  const newWs = XLSX.utils.aoa_to_sheet(data);
  wb.Sheets['Master Roster'] = newWs;
  XLSX.writeFile(wb, ROSTER_PATH);
}

function findRosterRowByCpc(cpc) {
  const roster = readRoster();
  if (roster.error) return { found: false, error: roster.error };

  const { data, cols } = roster;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[cols.CPC] === cpc) {
      return { found: true, rowIdx: i, row };
    }
  }
  return { found: false };
}

function findRosterRow(cpc, mpn) {
  const roster = readRoster();
  if (roster.error) return { found: false, error: roster.error };

  const { data, cols } = roster;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[cols.CPC] === cpc) {
      return { found: true, rowIdx: i, row, matchedBy: 'CPC', ...roster };
    }
  }

  if (mpn) {
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[cols.MPN] === mpn) {
        return { found: true, rowIdx: i, row, matchedBy: 'MPN', ...roster };
      }
    }
  }

  return { found: false };
}

function updateRosterPrice(cpc, mpn, opts) {
  const match = findRosterRow(cpc, mpn);
  if (!match.found) {
    return { success: false, error: `Part not found: CPC=${cpc}, MPN=${mpn}` };
  }

  const { wb, data, cols, rowIdx, row } = match;
  const previousResale = row[cols.RESALE_PRICE];
  const foundMpn = row[cols.MPN];

  row[cols.RESALE_PRICE] = opts.resalePrice;
  row[cols.LAST_APPROVED] = opts.lastApproved;

  if (opts.clearPending) {
    row[cols.PENDING] = '';
    row[cols.PROPOSED_RESALE] = '';
    row[cols.SUBMITTED_DATE] = '';

    // Set status based on discrepancies
    if (opts.setAdditionalReview) {
      row[cols.STATUS] = 'Additional Review';
    } else if (row[cols.STATUS] === 'Pending Approval') {
      row[cols.STATUS] = '';
    }
  }

  data[rowIdx] = row;
  writeRoster(wb, data);

  return {
    success: true,
    previousResale,
    mpn: foundMpn,
    lastApproved: opts.lastApproved,
  };
}

function updateRosterLeadTime(cpc, mpn, opts) {
  const match = findRosterRow(cpc, mpn);
  if (!match.found) {
    return { success: false, error: `Part not found: CPC=${cpc}, MPN=${mpn}` };
  }

  const { wb, data, cols, rowIdx, row } = match;
  const previousLeadTime = row[cols.LEAD_TIME];

  row[cols.LEAD_TIME] = opts.leadTime;
  row[cols.LAST_APPROVED] = opts.lastApproved;

  if (opts.setAdditionalReview) {
    row[cols.STATUS] = 'Additional Review';
  }

  data[rowIdx] = row;
  writeRoster(wb, data);

  return {
    success: true,
    previousLeadTime,
    lastApproved: opts.lastApproved,
  };
}

function appendRosterRow(rowData) {
  const roster = readRoster();
  if (roster.error) return { success: false, error: roster.error };

  const { wb, data, cols, headers } = roster;

  const newRow = new Array(headers.length).fill('');
  newRow[cols.CPC] = rowData.cpc;
  newRow[cols.MPN] = rowData.mpn;
  newRow[cols.MFR] = rowData.manufacturer;
  newRow[cols.DESCRIPTION] = rowData.description;
  newRow[cols.AWARD] = rowData.award;
  newRow[cols.BASE_PRICE] = rowData.basePrice;
  newRow[cols.RESALE_PRICE] = rowData.resalePrice;
  newRow[cols.REORDER_THRESHOLD] = rowData.reorderThreshold;
  newRow[cols.MOQ] = rowData.moq;
  newRow[cols.LEAD_TIME] = rowData.leadTime;
  newRow[cols.BUYER] = rowData.buyer;
  newRow[cols.LAST_APPROVED] = new Date().toISOString().slice(0, 10);

  data.push(newRow);
  writeRoster(wb, data);

  return { success: true, rowIdx: data.length - 1 };
}

// ─── EMAIL BUILDERS ──────────────────────────────────────────────────────────

function buildApprovalSummaryEmail(opts, ctx) {
  const { cpc, mpn, applied, discrepancies, currentState, notes } = opts;

  // Applied changes section
  const appliedRows = applied.map(a =>
    `<tr style="background:#e8f5e9">
      <td style="padding:6px 12px;border:1px solid #ddd">${esc(a.field)}</td>
      <td style="padding:6px 12px;border:1px solid #ddd">${formatValue(a.from)}</td>
      <td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">${formatValue(a.to)}</td>
    </tr>`
  ).join('');

  // Discrepancies section
  let discrepancySection = '';
  if (discrepancies && discrepancies.length > 0) {
    const discRows = discrepancies.map(d =>
      `<tr style="background:#fff3e0">
        <td style="padding:6px 12px;border:1px solid #ddd">${esc(d.label)}</td>
        <td style="padding:6px 12px;border:1px solid #ddd">${formatValue(d.rosterValue)}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">${formatValue(d.emailValue)}</td>
      </tr>`
    ).join('');

    const replyCommands = discrepancies.map(d =>
      `<code>APPROVE ${d.field.toUpperCase()}</code> — update ${d.label} to ${formatValue(d.emailValue)}`
    ).join('<br/>');

    discrepancySection = `
<h3 style="color:#e65100;margin-top:20px">&#9888; Flagged for Review</h3>
<p>The email mentioned different values for these fields. Please review and reply:</p>
<table style="border-collapse:collapse;font-size:13px;margin-bottom:12px">
  <tr style="background:#f5f5f5">
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Field</th>
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Current Roster</th>
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Email Mentions</th>
  </tr>
  ${discRows}
</table>
<p style="background:#fff3e0;padding:10px;border-left:3px solid #e65100">
  <b>Reply to ${esc(ctx.inbox)} with:</b><br/>
  ${replyCommands}<br/>
  <code>SKIP ${discrepancies[0].field.toUpperCase()}</code> — leave as-is<br/>
  <code>SKIP ALL</code> — skip all flagged items
</p>
<p style="color:#666;font-size:11px">Part Status set to "Additional Review" until resolved. This will appear in reorder alerts.</p>`;
  }

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#2e7d32">LAM Approval Applied</h2>
<p><b>CPC:</b> ${esc(cpc)}<br/>
   <b>MPN:</b> ${esc(mpn)}<br/>
   <b>UID:</b> ${ctx.uid}</p>

<h3 style="color:#2e7d32">&#10004; Applied Changes</h3>
<table style="border-collapse:collapse;font-size:13px">
  <tr style="background:#f5f5f5">
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Field</th>
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Previous</th>
    <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">New Value</th>
  </tr>
  ${appliedRows}
</table>

${discrepancySection}

${notes ? `<p style="color:#666;margin-top:12px"><b>Notes:</b> ${esc(notes)}</p>` : ''}
</body></html>`;
}

function buildRejectionEmail(payload, ctx) {
  const { cpc, mpn, reason, rejectedBy, investigation_summary } = payload;

  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">LAM Rejection</h2>
<p><b>CPC:</b> ${esc(cpc)}<br/>
   ${mpn ? `<b>MPN:</b> ${esc(mpn)}<br/>` : ''}
   <b>Rejected by:</b> ${esc(rejectedBy || 'LAM Procurement')}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b></p>
<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap">${esc(reason)}</pre>
${investigationBlock}
<p style="color:#666;font-size:11px">Status set to "Rejected". Requires follow-up action.</p>
</body></html>`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatValue(val) {
  if (val === null || val === undefined || val === '') return '<em>(empty)</em>';
  if (typeof val === 'number') {
    // Check if it looks like currency
    if (val < 10000 && val !== Math.floor(val)) {
      return formatCurrency(val);
    }
    return formatNumber(val);
  }
  return esc(String(val));
}

function formatCurrency(val) {
  if (val === null || val === undefined || val === '') return '';
  const num = parseFloat(val);
  if (isNaN(num)) return esc(String(val));
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatNumber(val) {
  if (val === null || val === undefined || val === '') return '';
  const num = parseFloat(val);
  if (isNaN(num)) return esc(String(val));
  return num.toLocaleString('en-US');
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'lamkitting@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Kitting',
  },
  actions: {
    approve_price: {
      folder: 'Processed',
      requires: ['cpc', 'approvedResale'],
      handler: action_approve_price,
    },
    approve_leadtime: {
      folder: 'Processed',
      requires: ['cpc', 'newLeadTime'],
      handler: action_approve_leadtime,
    },
    approve_flagged: {
      folder: 'Processed',
      requires: ['cpc', 'field', 'newValue'],
      handler: action_approve_flagged,
    },
    skip_flagged: {
      folder: 'Processed',
      requires: ['cpc', 'field'],
      handler: action_skip_flagged,
    },
    add_award: {
      folder: 'Processed',
      requires: ['cpc', 'mpn', 'manufacturer', 'awardQty', 'basePrice', 'resalePrice'],
      handler: action_add_award,
    },
    reject: {
      folder: 'Rejected',
      requires: ['cpc', 'reason'],
      handler: action_reject,
    },
    need_info: {
      folder: 'NeedInfo',
      requires: ['missing'],
      keepsPending: true,
      handler: action_need_info,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_approval: {
      folder: 'NotApproval',
      requires: ['reason'],
      handler: action_not_approval,
    },
  },
  // Export for reorder workflow visibility
  getFlaggedCPCs,
};
