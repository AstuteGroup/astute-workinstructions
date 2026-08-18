/**
 * shared/outreach-recipients.js
 *
 * Resolve internal Astute recipients for workflow escalation/confirmation emails.
 * Used by all loaders (rfq-loading, vq-loading, excess, stockrfq) to ensure
 * consistent recipient logic: internal forwarders get looped in, external
 * parties are recorded but NOT emailed.
 *
 * POLICY: Escalation and confirmation emails go to internal Astute people only.
 * External senders (customers, brokers) are never auto-emailed — the operator
 * can manually loop them in if needed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ASTUTE_DOMAIN = '@astutegroup.com';
const ADDR_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Load registry data (cached for performance)
let _registryCache = null;
function loadRegistry() {
  if (_registryCache) return _registryCache;
  try {
    const registryPath = path.join(__dirname, 'data', 'user-role-registry.json');
    _registryCache = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch (_) {
    _registryCache = {};
  }
  return _registryCache;
}

// Get workflow-specific CC list from registry
function getWorkflowCcList(workflow) {
  if (!workflow) return [];
  const registry = loadRegistry();
  const workflowCc = registry.workflow_cc && registry.workflow_cc[workflow];
  if (Array.isArray(workflowCc)) {
    return workflowCc.map(entry => entry.email?.toLowerCase()).filter(Boolean);
  }
  return [];
}

// Get rfq_support emails from registry (for conditional CC logic)
function getRfqSupportEmails() {
  const registry = loadRegistry();
  if (!Array.isArray(registry.rfq_support)) return new Set();
  // We need to look up emails for these users - for now use name-based email pattern
  // These are: William Robinson, Maya Gomez, Gabriela Bernal, Gustavo Orozco, Ivy Song, Vicky Ma01
  const supportEmails = new Set([
    'william.robinson@astutegroup.com',
    'maya.gomez@astutegroup.com',
    'gabriela.bernal@astutegroup.com',
    'gustavo.orozco@astutegroup.com',
    'ivy.song@astutegroup.com',
    'vicky.ma01@astutegroup.com',
  ]);
  return supportEmails;
}

/**
 * Resolve internal Astute recipients for an escalation/confirmation email.
 *
 * @param {object} payload - Action payload (may contain outerFrom, senderEmail, salesrepId, buyerId)
 * @param {object} ctx - Workflow context (jakeEmail, inbox, currentFrom, currentCc, workflow)
 * @param {object} [opts] - Options
 * @param {function} [opts.resolveUserById] - Function to resolve userId → {email, name}
 * @param {string} [opts.workflow] - Workflow name for workflow-specific CCs (e.g., 'rfq-loading')
 * @returns {object} { to, cc, externalSender, recipientList }
 *   - to: comma-separated list of internal recipients
 *   - cc: null (reserved for future use)
 *   - externalSender: the external sender's email (if any) — NOT emailed, for operator reference
 *   - recipientList: array of individual email addresses
 */
function resolveOutreachRecipients(payload, ctx, opts = {}) {
  const seen = new Set();
  const internal = [];
  const inbox = (ctx && ctx.inbox) ? ctx.inbox.toLowerCase() : '';
  const workflow = opts.workflow || (ctx && ctx.workflow) || null;

  const add = (addr) => {
    const a = String(addr == null ? '' : addr).toLowerCase().trim();
    if (!a || seen.has(a)) return;
    if (inbox && a === inbox) return;              // never the workflow inbox (loop guard)
    if (!a.endsWith(ASTUTE_DOMAIN)) return;        // internal-only
    seen.add(a);
    internal.push(a);
  };

  // 1. Operator (Jake) — always.
  if (ctx && ctx.jakeEmail) {
    add(ctx.jakeEmail);
  }

  // 2. Original sender. Internal forwarder → include. External → record but DO NOT email.
  //    Poller-parsed ctx.currentFrom is authoritative; payload fields are fallbacks.
  const fromCtx = (ctx && ctx.currentFrom) ? String(ctx.currentFrom).trim() : '';
  const originalSender = (fromCtx || (payload && payload.outerFrom) || (payload && payload.senderEmail) || '').trim();
  let externalSender = null;
  if (originalSender) {
    if (originalSender.toLowerCase().endsWith(ASTUTE_DOMAIN)) {
      add(originalSender);
    } else if (ADDR_RE.test(originalSender)) {
      externalSender = originalSender.toLowerCase();
    }
  }

  // 3. Internal addresses already on the original CC — captures the salesperson/buyer
  //    when support CC'd them on the forward, plus any other Astute folks looped in.
  if (ctx && ctx.currentCc) {
    for (const addr of String(ctx.currentCc).match(ADDR_RE) || []) {
      add(addr);
    }
  }

  // 4. Resolved responsible party (salesrep for RFQ, buyer for VQ) — resolve ID → email.
  //    Caller passes resolveUserById if they want this enrichment.
  const responsibleId = (payload && payload.salesrepId) || (payload && payload.buyerId);
  if (responsibleId && opts.resolveUserById) {
    try {
      const u = opts.resolveUserById(responsibleId);
      if (u && u.email) add(u.email);
    } catch (_) {
      // Enrichment is best-effort; never fail the send
    }
  }

  // 5. Workflow-specific support CCs — from user-role-registry.json workflow_cc section.
  //    Only added when the email involves support staff (rfq_support members).
  //    e.g., Will Robinson gets CC'd when Maya/Gabriela/etc. forward an RFQ, but NOT
  //    when a regular salesrep handles their own RFQ directly.
  if (workflow === 'rfq-loading') {
    const rfqSupportEmails = getRfqSupportEmails();
    const involvesSupport = internal.some(email => rfqSupportEmails.has(email));
    if (involvesSupport) {
      const workflowCcList = getWorkflowCcList(workflow);
      for (const email of workflowCcList) {
        add(email);
      }
    }
  }

  return {
    to: internal.join(', '),
    cc: null,
    senderUsed: null,
    externalSender,
    recipientList: internal,
  };
}

/**
 * Format a footer showing who was/wasn't emailed (for operator-facing emails).
 */
function recipientsFooter(envelope) {
  const lines = [];
  if (envelope.recipientList && envelope.recipientList.length > 0) {
    lines.push(`<b>Sent to:</b> ${envelope.recipientList.join(', ')}`);
  }
  if (envelope.externalSender) {
    lines.push(`<b>External sender (NOT emailed):</b> ${envelope.externalSender}`);
  }
  if (lines.length === 0) return '';
  return `<p style="color:#888;font-size:11px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">${lines.join('<br/>')}</p>`;
}

/**
 * Format external sender label for email body.
 */
function externalSenderLabel(envelope, fallback) {
  if (envelope.externalSender) {
    return `${envelope.externalSender} (external — not emailed)`;
  }
  return fallback || '(unknown)';
}

/**
 * Extract the external sender email from payload/context.
 *
 * Used by external-notifier to determine where to send customer-facing
 * notifications. Returns the first non-internal email found in the
 * resolution chain.
 *
 * @param {object} payload - Action payload (may contain outerFrom, senderEmail, externalSender)
 * @param {object} ctx - Workflow context (currentFrom, parsedExternalSender)
 * @returns {string|null} External sender email or null if none found
 */
function extractExternalSender(payload, ctx) {
  // 1. Explicit external sender from payload (set by poller parsing)
  if (payload && payload.externalSender) {
    return payload.externalSender.toLowerCase().trim();
  }

  // 2. Context-level external sender (set by read command parsing)
  if (ctx && ctx.parsedExternalSender) {
    return ctx.parsedExternalSender.toLowerCase().trim();
  }

  // 3. Check outerFrom/senderEmail — only if external
  const candidates = [
    payload && payload.outerFrom,
    payload && payload.senderEmail,
    ctx && ctx.currentFrom,
  ];

  for (const addr of candidates) {
    if (!addr) continue;
    const email = String(addr).toLowerCase().trim();
    // Extract email from "Name <email>" format
    const match = email.match(ADDR_RE);
    if (match) {
      const extracted = match[0];
      if (!extracted.endsWith(ASTUTE_DOMAIN)) {
        return extracted;
      }
    }
  }

  return null;
}

module.exports = {
  resolveOutreachRecipients,
  recipientsFooter,
  externalSenderLabel,
  extractExternalSender,
  ASTUTE_DOMAIN,
};
