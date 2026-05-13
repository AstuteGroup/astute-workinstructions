/**
 * shared/workflow-actions/crossref-review.js
 *
 * Cross-ref review reply parser + executor.
 *
 * Surface: Cross-ref pending candidates accumulate in the per-RFQ JSON
 * files under ~/workspace/.crossref-queue/. They appear in the 3×/day
 * RFQ API Enrichment digest (CSV attachment + HTML table) and — Phase 3 —
 * on a Vortex tab per RFQ. This module closes the loop: parse the
 * operator's reply text, execute approvals (write VQs) or rejections
 * (update queue status), update the candidate, and return a summary.
 *
 * Reply syntax (matched case-insensitive, multiple per body allowed):
 *   approve cross-ref: xref-1132586-3101481-0, xref-1132586-3101481-1
 *   reject cross-ref:  xref-1133479-3104210-2
 *
 * IDs are tolerated separated by commas, whitespace, semicolons, or
 * newlines.  Anything that doesn't start with `xref-` is ignored.
 *
 * VQ writes go through writeVQFromAPI with a synthetic single-row envelope
 * and a force-auto-approve classifier, so all writer infra (BP/MFR/
 * packaging resolution, idempotency check) is reused. The audit-trail
 * note recorded on Chuboe_Note_User identifies this as an operator
 * approval, who approved, and the source candidate ID.
 *
 * Three entry points:
 *   - parseReplyBody(text)              → array of decisions
 *   - executeDecisions(decisions, opts) → walks queue + writes, returns summary
 *   - processReplyBody(text, opts)      → parse + execute in one call
 *
 * Plus the standard workflow-action `inbox / notifierConfig / actions`
 * exports so this can be wired to the email-workflow-poller in Phase 3
 * without further refactor.
 */

'use strict';

const { getCandidatesForRfq, updateCandidate } = require('../crossref-queue');
const { writeVQFromAPI } = require('../vq-writer');

// ─── PARSER ──────────────────────────────────────────────────────────────────

const APPROVE_RE = /approve\s+cross[-_\s]?ref\s*:\s*([^\r\n]+)/gi;
const REJECT_RE  = /reject\s+cross[-_\s]?ref\s*:\s*([^\r\n]+)/gi;

function extractIds(captured) {
  return captured
    .split(/[,\s;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /^xref-[A-Za-z0-9_-]+$/.test(s));
}

/**
 * Parse an email body (or any text) into approval/rejection decisions.
 * Returns array of { action: 'approve'|'reject', id: '...' } — one entry
 * per ID found. Order is preserved from the source text.
 */
function parseReplyBody(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const m of text.matchAll(APPROVE_RE)) {
    for (const id of extractIds(m[1])) out.push({ action: 'approve', id });
  }
  for (const m of text.matchAll(REJECT_RE)) {
    for (const id of extractIds(m[1])) out.push({ action: 'reject', id });
  }
  return out;
}

// ─── CANDIDATE LOOKUP ────────────────────────────────────────────────────────

function rfqValueFromId(id) {
  const m = id.match(/^xref-([^-]+)-/);
  return m ? m[1] : null;
}

function findCandidate(id) {
  const rfqValue = rfqValueFromId(id);
  if (!rfqValue) return null;
  const cands = getCandidatesForRfq(rfqValue);
  return cands.find(c => c.id === id) || null;
}

// ─── EXECUTOR ────────────────────────────────────────────────────────────────

/**
 * Build a synthetic franchise envelope for a single approved candidate.
 * Shape matches what extractStockAndLtRows returns when a distributor
 * pre-provides vqLines (Arrow does this in production, so this code path
 * is well-exercised).
 */
function envelopeForCandidate(cand) {
  return {
    distributors: [{
      name: cand.supplierName,
      bpValue: cand.bpSearchKey,
      bpName: cand.supplierName,
      found: true,
      vqLines: [{
        vendorBP: cand.bpSearchKey,
        vendorName: cand.supplierName,
        channel: cand.channel || null,
        mpn: cand.returnedMpn,
        manufacturer: cand.supplierMfrText || '',
        description: '',
        qty: Number(cand.qty || 0),
        cost: Number(cand.unitPrice || 0),
        moq: cand.moq || null,
        spq: cand.spq || null,
        dateCode: cand.dateCode || null,
        leadTime: cand.leadTime || null,
        vendorNotes: cand.vendorNotes || '',
        priceBreaks: [],
      }],
    }],
    found: ['operator-approved'],
  };
}

/**
 * Execute parsed decisions sequentially.
 *
 * @param {Array<{action: 'approve'|'reject', id: string}>} decisions
 * @param {object} [opts]
 * @param {string} [opts.approvedBy='operator']  — name/email for audit trail
 * @param {string} [opts.source='reply']         — 'reply' | 'cli' | 'vortex-reply'
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{approved: Array, rejected: Array, failed: Array, notFound: Array}>}
 */
async function executeDecisions(decisions, opts = {}) {
  const approvedBy = opts.approvedBy || 'operator';
  const source = opts.source || 'reply';
  const dryRun = !!opts.dryRun;

  const out = { approved: [], rejected: [], failed: [], notFound: [] };

  // De-dup IDs — operator may have included the same ID twice
  const seen = new Set();
  const ordered = decisions.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  for (const { action, id } of ordered) {
    const cand = findCandidate(id);
    if (!cand) {
      out.notFound.push({ id, reason: 'Candidate not found in queue' });
      continue;
    }
    if (cand.status !== 'pending') {
      out.notFound.push({ id, reason: `Status is '${cand.status}', not pending` });
      continue;
    }

    if (action === 'reject') {
      if (!dryRun) {
        updateCandidate(id, {
          status: 'operator-rejected',
          statusReason: 'Operator rejected via reply',
          approved_by: approvedBy,
          approval_source: source,
        });
      }
      out.rejected.push({ id, rfqValue: cand.rfqValue });
      continue;
    }

    // approve
    const note = `Cross-ref operator-approved by ${approvedBy} (${source}): ` +
                 `${cand.searchedMpn} → ${cand.returnedMpn} [queue: ${id}]`;
    if (dryRun) {
      out.approved.push({ id, rfqValue: cand.rfqValue, dryRun: true, wouldWrite: { mpn: cand.returnedMpn, qty: cand.qty, cost: cand.unitPrice } });
      continue;
    }

    try {
      const envelope = envelopeForCandidate(cand);
      const result = await writeVQFromAPI(
        cand.rfqValue,
        '', // cpc unused — _rfqLineIdOverride is authoritative
        envelope,
        {
          searchedMpn: cand.searchedMpn,
          _rfqLineIdOverride: cand.rfqLineId,
          rfqMfrText: cand.rfqMfrText,
          rfqLineMpnId: cand.rfqLineMpnId,
          // Force auto-approve for THIS row — the classifier's job has
          // already been done by the operator. Returns 'auto-approve'
          // with our note attached.
          crossRefClassifier: async () => ({ action: 'auto-approve', note }),
        }
      );
      const writtenIds = (result.written || []).map(w => w.id || w.vqId).filter(Boolean);
      if ((result.written || []).length === 0) {
        // Writer didn't produce a row — could be BP/MFR/packaging resolution
        // failure. Surface the reason from the writer's output arrays.
        const reasons = [
          ...(result.flagged || []).map(f => f.reason || 'flagged'),
          ...(result.failed || []).map(f => f.reason || 'failed'),
          ...(result.skipped || []).map(s => s.reason || 'skipped'),
        ];
        out.failed.push({
          id, rfqValue: cand.rfqValue,
          reason: reasons.length ? reasons.join(' / ') : 'writer produced no row (unknown)',
          detail: JSON.stringify({ flagged: result.flagged, failed: result.failed, skipped: result.skipped }, null, 2).slice(0, 600),
        });
        continue;
      }
      updateCandidate(id, {
        status: 'written',
        statusReason: 'Operator-approved → VQ written',
        approved_by: approvedBy,
        approval_source: source,
        written_vq_id: writtenIds[0] || null,
      });
      out.approved.push({ id, rfqValue: cand.rfqValue, vqId: writtenIds[0] || null });
    } catch (err) {
      out.failed.push({ id, rfqValue: cand.rfqValue, reason: 'WRITE_THREW', detail: err.message });
    }
  }

  return out;
}

/**
 * Parse + execute in one call. Convenience for the CLI / inbox handler.
 */
async function processReplyBody(text, opts = {}) {
  const decisions = parseReplyBody(text);
  if (decisions.length === 0) return { decisions: [], approved: [], rejected: [], failed: [], notFound: [] };
  const result = await executeDecisions(decisions, opts);
  return { decisions, ...result };
}

// ─── WORKFLOW-ACTION SHAPE (for future inbox wiring) ─────────────────────────
//
// When wired into shared/email-workflow-poller.js (Phase 3), an LLM agent
// reads incoming replies, calls action_apply_reply with the parsed body,
// and routes the message to Processed (or NeedsReview if nothing parseable
// was found). For V1, processReplyBody() is called directly from a CLI.

async function action_apply_reply(payload, ctx) {
  const { body, approvedBy } = payload;
  const result = await processReplyBody(body || '', {
    approvedBy: approvedBy || ctx?.from || 'operator',
    source: 'inbox-reply',
    dryRun: !!ctx?.dryRun,
  });
  return result;
}

module.exports = {
  // Programmatic API
  parseReplyBody,
  executeDecisions,
  processReplyBody,
  envelopeForCandidate, // exported for tests
  // Workflow-action shape (Phase 3)
  inbox: 'stockRFQ@orangetsunami.com', // reuse stockRFQ inbox; subject filter applied in poller
  notifierConfig: {
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Cross-Ref Review',
  },
  actions: {
    apply_reply: {
      folder: 'Processed',
      requires: ['body'],
      handler: action_apply_reply,
    },
  },
};
