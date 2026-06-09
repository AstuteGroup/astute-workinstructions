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

const ASTUTE_DOMAIN = '@astutegroup.com';
const ADDR_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Resolve internal Astute recipients for an escalation/confirmation email.
 *
 * @param {object} payload - Action payload (may contain outerFrom, senderEmail, salesrepId, buyerId)
 * @param {object} ctx - Workflow context (jakeEmail, inbox, currentFrom, currentCc)
 * @param {object} [opts] - Options
 * @param {function} [opts.resolveUserById] - Function to resolve userId → {email, name}
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

module.exports = {
  resolveOutreachRecipients,
  recipientsFooter,
  externalSenderLabel,
  ASTUTE_DOMAIN,
};
