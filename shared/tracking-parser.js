/**
 * shared/tracking-parser.js
 *
 * Utilities for extracting tracking numbers and PO references from
 * shipping confirmation emails. Used by the tracking-loading workflow.
 *
 * Logic derived from terminal sessions (tmp/extract_tracking.js) where
 * we processed January 2026 POs and built carrier detection heuristics.
 */

'use strict';

// ─── CARRIER DETECTION ───────────────────────────────────────────────────────

/**
 * Detect carrier from tracking number format.
 * @param {string} token - Tracking number
 * @returns {string} Carrier name
 */
function detectCarrier(token) {
  const t = String(token).toUpperCase().trim();

  // UPS: starts with 1Z, 18 characters
  if (t.startsWith('1Z') && t.length === 18) return 'UPS';

  // FedEx Express: 12 digits
  if (/^\d{12}$/.test(t)) return 'FedEx';

  // FedEx Express: 15 digits
  if (/^\d{15}$/.test(t)) return 'FedEx';

  // FedEx Ground: 20-22 digits
  if (/^\d{20,22}$/.test(t)) return 'FedEx Ground';

  // DHL: 10 digits
  if (/^\d{10}$/.test(t)) return 'DHL';

  // USPS: EZ followed by 9 digits and US
  if (/^EZ\d{9}US$/i.test(t)) return 'USPS';

  // USPS: starts with 9, 19-22 digits
  if (/^9\d{19,21}$/.test(t)) return 'USPS';

  // USPS: 20-22 digits starting with 94
  if (/^94\d{18,20}$/.test(t)) return 'USPS';

  return 'Unknown';
}

// ─── TRACKING NUMBER EXTRACTION ──────────────────────────────────────────────

/**
 * Words/phrases that indicate the text is NOT a tracking number.
 */
const EXCLUSION_PATTERNS = [
  /sent/i,
  /purchas/i,
  /visa/i,
  /invoice/i,
  /payment/i,
  /credit/i,
  /debit/i,
  /account/i,
  /balance/i,
  /total/i,
  /amount/i,
  /price/i,
  /cost/i,
  /phone/i,
  /fax/i,
  /ext\./i,
];

/**
 * Check if a string looks like a tracking number vs other numeric data.
 * @param {string} s - Candidate string
 * @returns {boolean}
 */
function isLikelyTracking(s) {
  if (!s || s.length < 8 || s.length > 30) return false;

  // Must be mostly alphanumeric
  if (!/^[A-Z0-9-]{8,30}$/i.test(s)) return false;

  // Reject if it matches exclusion patterns
  for (const pat of EXCLUSION_PATTERNS) {
    if (pat.test(s)) return false;
  }

  return true;
}

/**
 * Extract tracking numbers from text.
 * @param {string} text - Email body text
 * @returns {Array<{token: string, carrier: string}>}
 */
function extractTrackingNumbers(text) {
  if (!text) return [];

  const results = [];
  const seen = new Set();

  // Split on whitespace, commas, newlines
  const tokens = text.split(/[\s,\n\r]+/).filter(Boolean);

  for (const raw of tokens) {
    const token = raw.replace(/[^\w-]/g, '').toUpperCase();

    if (!isLikelyTracking(token)) continue;
    if (seen.has(token)) continue;

    const carrier = detectCarrier(token);

    // Only include if we can identify the carrier OR it's a plausible format
    if (carrier !== 'Unknown' || /^\d{12,22}$/.test(token) || /^1Z/.test(token)) {
      seen.add(token);
      results.push({ token, carrier });
    }
  }

  return results;
}

// ─── PO REFERENCE EXTRACTION ─────────────────────────────────────────────────

/**
 * Extract OT PO references from text.
 * Looks for PO###### (6 digits) and POV####### (7 digits) patterns.
 * @param {string} text - Email body text
 * @returns {Array<{type: string, reference: string}>}
 */
function extractPOReferences(text) {
  if (!text) return [];

  const results = [];
  const seen = new Set();

  // OT Purchase Order: PO followed by 6 digits
  const poMatches = text.matchAll(/\bPO\s*#?\s*(\d{6})\b/gi);
  for (const m of poMatches) {
    const ref = `PO${m[1]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      results.push({ type: 'ot_po', reference: ref, documentno: ref });
    }
  }

  // Infor POV: POV followed by 7 digits
  const povMatches = text.matchAll(/\bPOV\s*#?\s*(\d{7})\b/gi);
  for (const m of povMatches) {
    const ref = `POV${m[1]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      results.push({ type: 'infor_pov', reference: ref });
    }
  }

  // Generic "Purchase Order" or "Order #" followed by digits
  // Only capture if 6+ digits (avoid invoice numbers, etc.)
  const genericMatches = text.matchAll(/(?:Purchase\s+Order|Order\s*#|P\.?O\.?\s*#)\s*:?\s*(\d{6,})\b/gi);
  for (const m of genericMatches) {
    // Normalize to PO format if 6 digits
    if (m[1].length === 6) {
      const ref = `PO${m[1]}`;
      if (!seen.has(ref)) {
        seen.add(ref);
        results.push({ type: 'ot_po', reference: ref, documentno: ref });
      }
    }
  }

  return results;
}

// ─── COMBINED EXTRACTION ─────────────────────────────────────────────────────

/**
 * Extract all shipping data from email text.
 * @param {string} text - Email body (plain text preferred, HTML fallback)
 * @returns {{tracking: Array, poRefs: Array, summary: string}}
 */
function parseShippingEmail(text) {
  const tracking = extractTrackingNumbers(text);
  const poRefs = extractPOReferences(text);

  const trackingSummary = tracking.length > 0
    ? tracking.map(t => `${t.token} (${t.carrier})`).join(', ')
    : 'none found';

  const poSummary = poRefs.length > 0
    ? poRefs.map(p => p.reference).join(', ')
    : 'none found';

  return {
    tracking,
    poRefs,
    summary: `Tracking: ${trackingSummary}; PO: ${poSummary}`,
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  detectCarrier,
  isLikelyTracking,
  extractTrackingNumbers,
  extractPOReferences,
  parseShippingEmail,
};
