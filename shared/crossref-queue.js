/**
 * Cross-Ref Queue — file-backed staging for MPN_CROSS_REF candidates that
 * need operator review.
 *
 * Layout: one JSON file per RFQ at ~/workspace/.crossref-queue/{rfq_value}.json
 *
 * Status lifecycle:
 *   pending           — needs operator review
 *   auto-rejected     — MFR mismatch, recorded for accountability, no action
 *   auto-dropped      — blank RFQ MFR, recorded, no action
 *   written           — VQ written (auto-approve at classification time, OR
 *                       operator-approved via reply parser later)
 *   operator-rejected — operator declined via reply parser
 *   expired           — pending >30d, swept by expireOldCandidates
 *
 * Stable candidate ID: xref-{rfq_value}-{rfqLineMpnId}-{supplierIdx}
 *   - supplierIdx is the position in the franchise envelope's distributor
 *     output, so multiple supplier responses for the same RFQ line stay
 *     distinct.
 *
 * Consumers:
 *   - shared/workflow-actions/crossref-review.js (reply parser, future)
 *   - Trading Analysis/RFQ API Enrichment/enrich-poller.js (digest, future)
 *   - Trading Analysis/Vortex Matches/vortex-matches.js (per-RFQ tab, future)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUEUE_DIR = path.join(os.homedir(), 'workspace', '.crossref-queue');
const DEFAULT_EXPIRY_DAYS = 30;

function ensureDir() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function fileFor(rfqValue) {
  if (!rfqValue) throw new Error('crossref-queue: rfqValue required');
  // strip anything that isn't safe for a filename — RFQ values are normally
  // bare digits but defensive.
  const safe = String(rfqValue).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(QUEUE_DIR, `${safe}.json`);
}

function readFile(rfqValue) {
  const p = fileFor(rfqValue);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    // Corrupt file — preserve it for forensics, return null so callers can
    // start fresh.
    fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
    return null;
  }
}

function writeFile(rfqValue, doc) {
  ensureDir();
  doc.updated = new Date().toISOString();
  fs.writeFileSync(fileFor(rfqValue), JSON.stringify(doc, null, 2));
}

function makeCandidateId(rfqValue, rfqLineMpnId, supplierIdx) {
  return `xref-${rfqValue}-${rfqLineMpnId}-${supplierIdx}`;
}

/**
 * Add or merge a candidate into the RFQ's staging file.
 *
 * @param {object} cand - Candidate row. Must include rfqValue, rfqLineMpnId,
 *   supplierIdx, searchedMpn, returnedMpn, rfqMfrText, supplierMfrText, qty,
 *   unitPrice, supplierName, bpSearchKey, decision, status, statusReason.
 *   Optional: rfqLineId, leadTime, moq, spq, dateCode, channel, vendorNotes.
 * @returns {string} candidate ID
 */
function addCandidate(cand) {
  const { rfqValue, rfqLineMpnId, supplierIdx } = cand;
  if (!rfqValue || rfqLineMpnId == null || supplierIdx == null) {
    throw new Error('crossref-queue.addCandidate: rfqValue, rfqLineMpnId, supplierIdx required');
  }
  const id = makeCandidateId(rfqValue, rfqLineMpnId, supplierIdx);
  const now = new Date().toISOString();

  let doc = readFile(rfqValue);
  if (!doc) {
    doc = {
      rfqValue: String(rfqValue),
      created: now,
      updated: now,
      candidates: [],
    };
  }

  const existing = doc.candidates.find(c => c.id === id);
  if (existing) {
    // Re-classification (e.g., next enrichment run). Only refresh data if
    // still pending — once operator/auto decided, don't overwrite the outcome.
    if (existing.status === 'pending') {
      Object.assign(existing, {
        searchedMpn: cand.searchedMpn,
        returnedMpn: cand.returnedMpn,
        rfqMfrText: cand.rfqMfrText,
        supplierMfrText: cand.supplierMfrText,
        qty: cand.qty,
        unitPrice: cand.unitPrice,
        totalValue: Number(cand.qty || 0) * Number(cand.unitPrice || 0),
        supplierName: cand.supplierName,
        bpSearchKey: cand.bpSearchKey,
        leadTime: cand.leadTime,
        moq: cand.moq,
        spq: cand.spq,
        dateCode: cand.dateCode,
        channel: cand.channel,
        vendorNotes: cand.vendorNotes,
        statusReason: cand.statusReason,
        refreshed_at: now,
      });
    }
    writeFile(rfqValue, doc);
    return id;
  }

  doc.candidates.push({
    id,
    rfqValue: String(rfqValue),
    rfqLineId: cand.rfqLineId || null,
    rfqLineMpnId: cand.rfqLineMpnId,
    supplierIdx: cand.supplierIdx,
    searchedMpn: cand.searchedMpn,
    returnedMpn: cand.returnedMpn,
    rfqMfrText: cand.rfqMfrText || '',
    supplierMfrText: cand.supplierMfrText || '',
    qty: Number(cand.qty || 0),
    unitPrice: Number(cand.unitPrice || 0),
    totalValue: Number(cand.qty || 0) * Number(cand.unitPrice || 0),
    supplierName: cand.supplierName,
    bpSearchKey: cand.bpSearchKey || null,
    leadTime: cand.leadTime || null,
    moq: cand.moq || null,
    spq: cand.spq || null,
    dateCode: cand.dateCode || null,
    channel: cand.channel || null,
    vendorNotes: cand.vendorNotes || null,
    decision: cand.decision,
    status: cand.status,
    statusReason: cand.statusReason || '',
    decided_at: now,
    approved_at: null,
    approved_by: null,
    written_vq_id: null,
  });

  writeFile(rfqValue, doc);
  return id;
}

/**
 * Mark a candidate's outcome. For operator-approval/rejection or for stamping
 * the written VQ id once the auto-approve write completes.
 *
 * @param {string} candidateId - e.g. 'xref-1132586-3101481-0'
 * @param {object} patch - Fields to merge: status, statusReason, approved_by,
 *   written_vq_id, etc.
 * @returns {boolean} true if candidate was found and updated
 */
function updateCandidate(candidateId, patch) {
  // Parse rfqValue from ID for file lookup.
  const m = candidateId.match(/^xref-([^-]+)-/);
  if (!m) throw new Error(`Invalid candidate ID: ${candidateId}`);
  const rfqValue = m[1];

  const doc = readFile(rfqValue);
  if (!doc) return false;

  const cand = doc.candidates.find(c => c.id === candidateId);
  if (!cand) return false;

  Object.assign(cand, patch);
  if (patch.status && patch.status !== 'pending') {
    cand.approved_at = cand.approved_at || new Date().toISOString();
  }
  writeFile(rfqValue, doc);
  return true;
}

function getCandidatesForRfq(rfqValue, opts = {}) {
  const doc = readFile(rfqValue);
  if (!doc) return [];
  const cands = doc.candidates || [];
  if (opts.status) return cands.filter(c => c.status === opts.status);
  return cands;
}

/**
 * Walk all RFQ queue files and return candidates matching the filter.
 * @param {object} [opts]
 * @param {string|string[]} [opts.status] - filter by single status or list
 * @param {string}          [opts.sinceIso] - only return candidates with decided_at >= this
 */
function getAllCandidates(opts = {}) {
  ensureDir();
  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
  const allowedStatuses = opts.status
    ? (Array.isArray(opts.status) ? new Set(opts.status) : new Set([opts.status]))
    : null;
  const out = [];
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const c of doc.candidates || []) {
      if (allowedStatuses && !allowedStatuses.has(c.status)) continue;
      if (opts.sinceIso && c.decided_at && c.decided_at < opts.sinceIso) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Sweep pending candidates older than `days` days, marking them expired.
 * Returns count of expired candidates.
 */
function expireOldCandidates(days = DEFAULT_EXPIRY_DAYS) {
  ensureDir();
  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
  let expired = 0;
  for (const f of files) {
    const p = path.join(QUEUE_DIR, f);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    let mutated = false;
    for (const c of doc.candidates || []) {
      if (c.status !== 'pending') continue;
      const decidedMs = c.decided_at ? Date.parse(c.decided_at) : 0;
      if (decidedMs > 0 && decidedMs < cutoffMs) {
        c.status = 'expired';
        c.expired_at = new Date().toISOString();
        expired++;
        mutated = true;
      }
    }
    if (mutated) writeFile(doc.rfqValue, doc);
  }
  return expired;
}

module.exports = {
  QUEUE_DIR,
  makeCandidateId,
  addCandidate,
  updateCandidate,
  getCandidatesForRfq,
  getAllCandidates,
  expireOldCandidates,
};
