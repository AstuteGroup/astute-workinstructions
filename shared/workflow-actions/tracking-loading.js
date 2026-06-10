/**
 * shared/workflow-actions/tracking-loading.js
 *
 * Workflow module for loading tracking numbers from forwarded shipping
 * confirmations. Consumed by shared/email-workflow-poller.js when invoked
 * with --workflow tracking-loading.
 *
 * Inbox: tracking@orangetsunami.com
 * Doc:   Trading Analysis/Tracking Loading/tracking-loading.md
 */

'use strict';

const { Pool } = require('pg');
const { patchRecord } = require('../record-updater');
const breadcrumbs = require('../breadcrumbs');

// DB pool for PO lookups (read-only replica)
const pool = new Pool({ database: 'idempiere_replica' });

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Look up a purchase order by OT documentno (PO######).
 * @param {string} documentno - e.g., "PO809588"
 * @returns {Promise<Object|null>}
 */
async function lookupPOByDocumentNo(documentno) {
  const sql = `
    SELECT
      o.c_order_id,
      o.documentno,
      o.c_bpartner_id,
      bp.name AS vendor_name,
      o.chuboe_trackingnumbers AS existing_tracking,
      o.docstatus
    FROM adempiere.c_order o
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    WHERE o.issotrx = 'N'
      AND o.isactive = 'Y'
      AND o.documentno = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [documentno]);
  return rows[0] || null;
}

/**
 * Look up a purchase order by Infor POV number (POV#######).
 * POV is stored on c_orderline.chuboe_po_string.
 * @param {string} pov - e.g., "POV0075528"
 * @returns {Promise<Object|null>}
 */
async function lookupPOByPOV(pov) {
  const sql = `
    SELECT DISTINCT
      o.c_order_id,
      o.documentno,
      o.c_bpartner_id,
      bp.name AS vendor_name,
      o.chuboe_trackingnumbers AS existing_tracking,
      o.docstatus,
      ol.chuboe_po_string AS pov
    FROM adempiere.c_order o
    JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
    JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
    WHERE o.issotrx = 'N'
      AND o.isactive = 'Y'
      AND ol.chuboe_po_string = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [pov]);
  return rows[0] || null;
}

/**
 * Look up a purchase order by either OT PO or Infor POV.
 * Tries documentno first (if provided), falls back to POV.
 * @param {string|null} documentno - OT PO number (PO######)
 * @param {string|null} pov - Infor POV number (POV#######)
 * @returns {Promise<{po: Object|null, lookupType: string}>}
 */
async function lookupPO(documentno, pov) {
  // Try OT PO first
  if (documentno) {
    const po = await lookupPOByDocumentNo(documentno);
    if (po) return { po, lookupType: 'documentno' };
  }
  // Fall back to POV
  if (pov) {
    const po = await lookupPOByPOV(pov);
    if (po) return { po, lookupType: 'pov' };
  }
  return { po: null, lookupType: null };
}

/**
 * Get order lines for a purchase order.
 * @param {number} orderId - c_order_id
 * @returns {Promise<Array<{c_orderline_id, chuboe_mpn, chuboe_trackingnumbers}>>}
 */
async function getOrderLines(orderId) {
  const sql = `
    SELECT
      c_orderline_id,
      chuboe_mpn,
      chuboe_trackingnumbers AS existing_tracking
    FROM adempiere.c_orderline
    WHERE c_order_id = $1
      AND isactive = 'Y'
    ORDER BY line
  `;
  const { rows } = await pool.query(sql, [orderId]);
  return rows;
}

/**
 * Find order line by MPN (case-insensitive, normalized match).
 * @param {Array} lines - order lines from getOrderLines
 * @param {string} mpn - MPN to match
 * @returns {Object|null}
 */
function findLineByMPN(lines, mpn) {
  if (!mpn) return null;
  const normalized = mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return lines.find(l => {
    if (!l.chuboe_mpn) return false;
    const lineMpn = l.chuboe_mpn.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return lineMpn === normalized;
  }) || null;
}

/**
 * Merge new tracking numbers with existing, deduplicating.
 * @param {string|null} existing - Comma-separated existing tracking
 * @param {string[]} newTracking - New tracking numbers to add
 * @returns {string}
 */
function mergeTracking(existing, newTracking) {
  const existingSet = new Set(
    (existing || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  for (const t of newTracking) {
    existingSet.add(t.trim());
  }
  return [...existingSet].join(', ');
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Patch tracking numbers onto a purchase order.
 *
 * Required payload: { tracking[] } + one of { documentno } or { pov }
 * Optional: { carrier, mpn }
 *
 * Lookup priority: documentno (OT PO) first, then pov (Infor POV).
 *
 * Line logic:
 * - Single-line order: patch order header (no MPN needed)
 * - Multi-line order: MPN required to identify which line; returns error if missing
 */
async function action_patch_tracking(payload, ctx) {
  const { documentno, pov, tracking, carrier, mpn } = payload;

  if (!Array.isArray(tracking) || tracking.length === 0) {
    return { error: 'Missing tracking array' };
  }

  if (!documentno && !pov) {
    return { error: 'Missing documentno or pov — need at least one PO reference' };
  }

  // Lookup the PO (tries documentno first, then pov)
  const { po, lookupType } = await lookupPO(documentno, pov);
  if (!po) {
    return {
      error: 'PO not found',
      documentno: documentno || null,
      pov: pov || null,
      tracking,
    };
  }

  // Get order lines to determine single vs multi-line
  const lines = await getOrderLines(po.c_order_id);
  const lineCount = lines.length;

  // Multi-line order requires MPN to identify which line
  if (lineCount > 1 && !mpn) {
    return {
      error: 'Multi-line order requires MPN to identify line',
      documentno: po.documentno,
      pov: pov || null,
      lineCount,
      lines: lines.map(l => l.chuboe_mpn).filter(Boolean),
      tracking,
    };
  }

  // For multi-line with MPN, find the matching line
  let targetLine = null;
  if (lineCount > 1 && mpn) {
    targetLine = findLineByMPN(lines, mpn);
    if (!targetLine) {
      return {
        error: 'MPN not found on order',
        documentno: po.documentno,
        mpn,
        availableMPNs: lines.map(l => l.chuboe_mpn).filter(Boolean),
        tracking,
      };
    }
  }

  // Check for already-loaded (idempotency via breadcrumbs)
  if (ctx.currentMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(ctx.currentMessageId, {
      cog: 'tracking-loading-agent',
      events: ['tracking-loaded'],
    });
    if (dupCheck.loaded) {
      return {
        already_processed: true,
        messageId: ctx.currentMessageId,
        prior: dupCheck.breadcrumb,
      };
    }
  }

  // Determine what we're patching: order header for single-line, line for multi-line
  const patchTarget = targetLine ? 'line' : 'order';
  const existingTracking = targetLine ? targetLine.existing_tracking : po.existing_tracking;

  // Merge tracking numbers
  const merged = mergeTracking(existingTracking, tracking);

  // Check if anything new was actually added
  const existingSet = new Set(
    (existingTracking || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const newAdded = tracking.filter(t => !existingSet.has(t.trim()));

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_patch: {
        target: patchTarget,
        orderId: po.c_order_id,
        documentno: po.documentno,
        lineId: targetLine ? targetLine.c_orderline_id : null,
        mpn: targetLine ? targetLine.chuboe_mpn : null,
        vendor: po.vendor_name,
        existing: existingTracking,
        merged,
        new_added: newAdded,
      },
    };
  }

  // Skip PATCH if nothing new
  if (newAdded.length === 0) {
    breadcrumbs.write({
      cog: 'tracking-loading-agent',
      event: 'tracking-already-present',
      uid: ctx.uid,
      messageId: ctx.currentMessageId,
      documentno: po.documentno,
      patchTarget,
      tracking,
    });
    return {
      already_present: true,
      documentno: po.documentno,
      patchTarget,
      tracking,
    };
  }

  // PATCH either order header or specific line
  if (patchTarget === 'line') {
    await patchRecord('c_orderline', targetLine.c_orderline_id, {
      Chuboe_TrackingNumbers: merged,
    });
  } else {
    await patchRecord('c_order', po.c_order_id, {
      Chuboe_TrackingNumbers: merged,
    });
  }

  // Write breadcrumb
  breadcrumbs.write({
    cog: 'tracking-loading-agent',
    event: 'tracking-loaded',
    uid: ctx.uid,
    messageId: ctx.currentMessageId,
    orderId: po.c_order_id,
    documentno: po.documentno,
    pov: po.pov || pov || null,
    lookupType,
    patchTarget,
    lineId: targetLine ? targetLine.c_orderline_id : null,
    mpn: targetLine ? targetLine.chuboe_mpn : null,
    vendor: po.vendor_name,
    tracking_added: newAdded,
    carrier: carrier || null,
  });

  // Send confirmation email
  const trackingList = newAdded.map(t => `<li>${esc(t)}${carrier ? ` (${esc(carrier)})` : ''}</li>`).join('');
  const povLine = (po.pov || pov) ? `<b>POV:</b> ${esc(po.pov || pov)}<br/>` : '';
  const mpnLine = targetLine ? `<b>MPN:</b> ${esc(targetLine.chuboe_mpn)}<br/>` : '';
  const targetNote = patchTarget === 'line' ? ' (line-level)' : ' (order-level)';
  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#080">Tracking loaded: ${esc(po.documentno)}${targetNote}</h2>
<p><b>Vendor:</b> ${esc(po.vendor_name)}<br/>
   <b>PO:</b> ${esc(po.documentno)}<br/>
   ${povLine}${mpnLine}</p>
<p><b>Tracking numbers added:</b></p>
<ul>${trackingList}</ul>
<p style="color:#666;font-size:11px">UID: ${ctx.uid} | Lookup: ${lookupType} | Target: ${patchTarget}</p>
</body></html>`;

  await ctx.notifier.sendEmail(
    'jake.harris@astutegroup.com',
    `Tracking loaded: ${po.documentno}`,
    html,
    { html: true }
  );

  return {
    patched: true,
    patchTarget,
    orderId: po.c_order_id,
    documentno: po.documentno,
    lineId: targetLine ? targetLine.c_orderline_id : null,
    mpn: targetLine ? targetLine.chuboe_mpn : null,
    vendor: po.vendor_name,
    tracking_added: newAdded,
  };
}

/**
 * Escalate to operator when tracking can't be loaded automatically.
 *
 * Required payload: { reason }
 * Optional: { extracted_po, extracted_tracking, subject, from }
 */
async function action_needs_review(payload, ctx) {
  const { reason, extracted_po, extracted_tracking, subject, from } = payload;

  const trackingList = Array.isArray(extracted_tracking) && extracted_tracking.length > 0
    ? extracted_tracking.map(t => `<li>${esc(typeof t === 'object' ? t.token : t)}</li>`).join('')
    : '<li>(none extracted)</li>';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Tracking Loading — needs review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(from)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
<p><b>Extracted PO reference:</b> ${esc(extracted_po || '(none)')}</p>
<p><b>Extracted tracking:</b></p>
<ul>${trackingList}</ul>
<p style="color:#666;font-size:11px">Message moved to NeedsReview in ${ctx.inbox} inbox.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify: { reason, extracted_po, extracted_tracking } };
  }

  await ctx.notifier.sendEmail(
    'jake.harris@astutegroup.com',
    `Tracking Loading — needs review: ${subject || '(no subject)'}`,
    html,
    { html: true }
  );

  breadcrumbs.write({
    cog: 'tracking-loading-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    reason,
    extracted_po,
    extracted_tracking,
  });

  return { notified: 'jake.harris@astutegroup.com', reason };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'tracking@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'tracking@orangetsunami.com',
    fromName: 'Tracking Loading',
  },
  actions: {
    patch_tracking: {
      folder: 'Processed',
      requires: ['tracking'],  // + one of documentno or pov (validated in handler)
      handler: action_patch_tracking,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_tracking: {
      folder: 'NotTracking',
      handler: null,  // move-only, no side effects
    },
  },
};
