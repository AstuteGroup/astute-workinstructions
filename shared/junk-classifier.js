/**
 * shared/junk-classifier.js — pre-extraction filter to weed out non-offers.
 *
 * Three outcomes per message:
 *
 *   high-confidence-junk  — auto-route to NotOffer, no operator email
 *                           (OOO, undeliverable, empty body, etc.)
 *   low-confidence-junk   — likely junk but ambiguous; send a single yes/no
 *                           email asking the operator to confirm. Hold in
 *                           NeedsReview with a junk-check-pending tag.
 *   likely-offer          — proceed to extraction normally.
 *
 * Heuristics are conservative on the high-conf side: only auto-classify if
 * the signal is unambiguous (OOO subject keywords, undeliverable bounces,
 * effectively-empty body). Borderline cases default to low-conf or
 * likely-offer so we never silently drop a real offer.
 *
 * USAGE:
 *   const { classifyJunk } = require('../shared/junk-classifier');
 *   const verdict = classifyJunk({ subject, body, outerFrom, attachmentNames });
 *   // verdict.tier: 'high-confidence-junk' | 'low-confidence-junk' | 'likely-offer'
 *   // verdict.signals: array of strings explaining the decision
 */

'use strict';

// Subject patterns that are categorically junk — exact substrings work fine.
// Keep this list focused; if it grows beyond ~20 entries it's worth moving to a JSON file.
const HIGH_CONF_SUBJECT_PATTERNS = [
  /\bout of office\b/i,
  /\bauto[- ]?reply\b/i,
  /\bautomatic reply\b/i,
  /\bvacation reply\b/i,
  /\bUndeliverable\b/i,
  /\bUndelivered Mail Returned to Sender\b/i,
  /\bDelivery Status Notification\b/i,
  /\bMail Delivery (Failure|Subsystem)\b/i,
  /\bRead:\s/i, // read receipts
  /\bnewsletter\b/i,
  /\bunsubscribe\b/i,
  // "Upload MO_*" — internal sender notifications that confirm a manual market
  // offer was uploaded. Body is just text + a screenshot, no MPN data. The
  // search key in the subject (e.g. "MO_Search Key 1008289") is processed by
  // the operator manually and isn't an offer to load. Discovered 2026-05-07.
  /\bUpload\s+MO[_\s]/i,
];

// Bare-MPN patterns — alphanumeric token with both letters and numbers, length 5+.
// Used as a "does this look like it could mention a part?" check.
function hasMpnLikeTokens(text) {
  if (!text) return false;
  const tokens = text.split(/[\s,;:]+/);
  let count = 0;
  for (const t of tokens) {
    const cleaned = t.replace(/[^A-Za-z0-9\-/.]/g, '');
    if (cleaned.length < 5 || cleaned.length > 40) continue;
    if (!/[A-Z]/i.test(cleaned)) continue;
    if (!/[0-9]/.test(cleaned)) continue;
    // Skip obvious noise: dates, version numbers, pure numbers
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(cleaned)) continue;
    if (/^v?\d+\.\d+(\.\d+)?$/i.test(cleaned)) continue;
    count++;
    if (count >= 2) return true; // Two MPN-shaped tokens = probably real
  }
  return count >= 1;
}

// Strip quoted-message blocks ("On <date>... wrote:" and below) so we can
// measure how much actual content the operator sent.
function topOfMessage(body) {
  if (!body) return '';
  return body
    .split(/^(?:On\s.+wrote:|From:\s|-+\s*Original Message\s*-+)/m)[0]
    .replace(/^>+.*$/gm, '')   // line-quoted text
    .trim();
}

/**
 * Classify a message. Returns { tier, signals, confidence }.
 *
 * @param {object} input
 *   subject:           message subject string
 *   body:              full body text
 *   outerFrom:         sender email
 *   attachmentNames:   string[] of attachment filenames (optional)
 */
function classifyJunk({ subject = '', body = '', outerFrom = '', attachmentNames = [] }) {
  const signals = [];
  const top = topOfMessage(body);
  const hasAttachment = (attachmentNames || []).filter(n => n && !/^image\//i.test(n)).length > 0;

  // ── Tier 1: high-confidence junk ──────────────────────────────────────────

  // Subject pattern match
  for (const re of HIGH_CONF_SUBJECT_PATTERNS) {
    if (re.test(subject)) {
      signals.push(`subject matches "${re.source}"`);
      return { tier: 'high-confidence-junk', signals };
    }
  }

  // Effectively empty after stripping quotes (operator forwarded with no commentary,
  // attachment with no MPN content, etc.). Only apply if there's also no attachment
  // we could parse — an empty body WITH an xlsx attachment is a normal offer.
  if (top.length < 30 && !hasAttachment) {
    signals.push(`body effectively empty (${top.length} chars after stripping quotes)`);
    return { tier: 'high-confidence-junk', signals };
  }

  // Bounce / NDR detection — body contains both "Subject:" and "Reporting-MTA"
  // or similar SMTP failure signatures.
  if (/Reporting-MTA:/i.test(body) || /Final-Recipient:/i.test(body) || /Diagnostic-Code:/i.test(body)) {
    signals.push('body contains SMTP bounce headers');
    return { tier: 'high-confidence-junk', signals };
  }

  // ── Tier 2: low-confidence junk (worth asking operator) ───────────────────

  // No attachment AND body has no MPN-shaped tokens AND body is short — could
  // be an inquiry, FYI, or social.
  const topMpnish = hasMpnLikeTokens(top);
  if (!hasAttachment && !topMpnish && top.length < 400) {
    signals.push(`no attachment, no MPN-like tokens, short body (${top.length} chars)`);
    return { tier: 'low-confidence-junk', signals };
  }

  // Forward chain depth — count "From:" headers in the body. >2 forwards
  // with no attachment suggests it's been bouncing around without the original
  // offer data surviving.
  if (!hasAttachment) {
    const forwardCount = (body.match(/^[ \t]*From:\s/gim) || []).length;
    if (forwardCount >= 3) {
      signals.push(`deep forward chain (${forwardCount} "From:" headers, no attachment)`);
      return { tier: 'low-confidence-junk', signals };
    }
  }

  // Inquiry signal — body asks "do you have" / "any availability" without offering anything
  if (!hasAttachment && /\b(?:do you have|any (?:availability|stock|qty)|looking for|need(?:ed)? quote|please quote)\b/i.test(top) && !topMpnish) {
    signals.push('inquiry language detected, no attachment, no MPN tokens');
    return { tier: 'low-confidence-junk', signals };
  }

  // ── Tier 3: looks legit, proceed to extraction ────────────────────────────

  if (hasAttachment) signals.push(`has ${(attachmentNames || []).length} attachment(s)`);
  if (topMpnish) signals.push('body contains MPN-like tokens');
  return { tier: 'likely-offer', signals: signals.length ? signals : ['default — no junk signals matched'] };
}

module.exports = { classifyJunk, hasMpnLikeTokens, topOfMessage };
