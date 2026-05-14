/**
 * shared/workflow-reply-grammars.js — operator-reply directive grammar
 *
 * Pure text-parsing for structured operator replies to workflow digest emails.
 * Originally lived in Trading Analysis/Customer Excess Analysis/reply-parser.js;
 * extracted here so any workflow that adds an operator-curation loop in the
 * future can adopt the same directive vocabulary instead of inventing its own.
 *
 * What this module does NOT do:
 *   - Anything with IMAP / DB / overrides — those are caller responsibilities.
 *     This is a pure (text, ctx) → (directives, unparsed) function.
 *
 * GRAMMAR (case-insensitive, one directive per line):
 *
 *   PARTNER: <uid> = <BP id (6-8 digits) OR company name>
 *      Assign the partner BP for a NeedsPartner-folder message. Used by
 *      excess to route an unresolved offer back to load_offer with the
 *      operator-supplied BP.
 *
 *   INTENT:  <searchKey> = <spec-buy | proactive | reactive>
 *      Override the auto-classified intent on an offer. Excess only (V1
 *      stub: breadcrumbed but not yet consumed by analysis cog).
 *
 *   SKIP:    <searchKey>
 *      Operator-requested skip on a search-key-identified record.
 *
 *   IGNORE:  <uid>   (or JUNK: <uid>)
 *      Same as SKIP but UID-identified; used for "this isn't even an
 *      offer/RFQ — pretend you never saw it."
 *
 *   YES      (optional :uid)
 *   NO       (optional :uid)
 *      Yes/no answers to a junk-check or other prompted question. UID
 *      pulled from subject context if not in body (see ctx.subjectUid).
 *
 *   LINES: <uid>
 *     <... captured block until blank line or next directive ...>
 *      Operator-supplied tabular block (MPN/qty/price/etc.) for a UID where
 *      our extractor failed. The captured `block` field is passed to the
 *      caller's line-table parser (currently per-workflow).
 *
 * SUBJECT-LINE PATTERNS:
 *
 *   JUNK_CHECK_SUBJECT_RE matches "Junk check — UID <n>: ..." so the
 *   reply-parser can extract the UID from a "Re: Junk check — UID 5050..."
 *   subject when the body's YES/NO doesn't include the UID inline.
 *
 * USAGE:
 *
 *   const grammar = require('../shared/workflow-reply-grammars');
 *   const { directives, unparsed } = grammar.parseDirectives(body, { subjectUid: 123 });
 *   for (const d of directives) {
 *     switch (d.type) {
 *       case 'PARTNER': // d.uid, d.value
 *       case 'INTENT':  // d.searchKey, d.intent
 *       case 'SKIP':    // d.searchKey
 *       case 'IGNORE':  // d.uid
 *       case 'YES':     // d.uid
 *       case 'NO':      // d.uid
 *       case 'LINES':   // d.uid, d.block (raw text — caller parses table)
 *     }
 *   }
 *
 * Use grammar.looksLikeActionableReply(text) for a coarse pre-filter: returns
 * true when the reply has enough content + signals to suggest the operator
 * wanted us to take an action that no directive matched. Useful for routing
 * to a "kickback" path instead of silently dropping ambiguous replies.
 */

'use strict';

// ─── DIRECTIVE PATTERNS ──────────────────────────────────────────────────────

const PARTNER_RE = /^\s*PARTNER\s*:\s*(\d+)\s*=\s*(.+?)\s*$/im;
const INTENT_RE  = /^\s*INTENT\s*:\s*(\S+)\s*=\s*(spec[-\s]buy|proactive|reactive)\s*$/im;
const SKIP_RE    = /^\s*SKIP\s*:\s*(\S+)\s*$/im;
const IGNORE_RE  = /^\s*(?:IGNORE|JUNK)\s*:\s*(\d+)\s*$/im;
const YES_RE     = /^\s*YES\s*(?::\s*(\d+))?\s*$/im;
const NO_RE      = /^\s*NO\s*(?::\s*(\d+))?\s*$/im;
const LINES_RE   = /^\s*LINES\s*:\s*(\d+)\s*$/im;

// Used by callers to extract a UID from a reply subject like
// "Re: Junk check — UID 5050: BUK9Y29-40E,115"
const JUNK_CHECK_SUBJECT_RE = /\bJunk\s+check\s*[—-]\s*UID\s+(\d+)\b/i;

// Used internally to detect "any directive shape" for the unparsed-line probe
// (a line that LOOKS like a directive but didn't match any specific pattern).
const ANY_DIRECTIVE_RE = /^\s*(?:PARTNER|INTENT|SKIP|IGNORE|JUNK|YES|NO|LINES)\s*:/i;

// ─── PARSER ──────────────────────────────────────────────────────────────────

/**
 * Parse a reply body into a list of directives. Some directives (LINES,
 * YES/NO without explicit UID) are multi-line or context-dependent —
 * those return as structured objects with the body slice attached so the
 * caller can act on them.
 *
 * @param {string} text — reply body (caller should trim quoted prior message)
 * @param {object} [ctx]
 *   ctx.subjectUid    — UID extracted from the reply subject (for YES/NO
 *                       without explicit UID). Optional.
 * @returns {{ directives: Array, unparsed: Array<string> }}
 */
function parseDirectives(text, ctx = {}) {
  if (!text) return { directives: [], unparsed: [] };
  const directives = [];
  const unparsedLines = [];
  const lines = text.split(/\r?\n/);
  const subjectUid = ctx.subjectUid != null ? Number(ctx.subjectUid) : null;

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }

    let m;
    if ((m = PARTNER_RE.exec(line))) {
      directives.push({ type: 'PARTNER', uid: Number(m[1]), value: m[2].trim() });
      i++; continue;
    }
    if ((m = INTENT_RE.exec(line))) {
      directives.push({
        type: 'INTENT',
        searchKey: m[1].trim(),
        intent: m[2].toLowerCase().replace(/\s+/g, '-'),
      });
      i++; continue;
    }
    if ((m = SKIP_RE.exec(line))) {
      directives.push({ type: 'SKIP', searchKey: m[1].trim() });
      i++; continue;
    }
    if ((m = IGNORE_RE.exec(line))) {
      directives.push({ type: 'IGNORE', uid: Number(m[1]) });
      i++; continue;
    }
    if ((m = YES_RE.exec(line))) {
      const uid = m[1] ? Number(m[1]) : subjectUid;
      if (uid != null) directives.push({ type: 'YES', uid });
      else unparsedLines.push(`YES with no UID and no subject context: "${line}"`);
      i++; continue;
    }
    if ((m = NO_RE.exec(line))) {
      const uid = m[1] ? Number(m[1]) : subjectUid;
      if (uid != null) directives.push({ type: 'NO', uid });
      else unparsedLines.push(`NO with no UID and no subject context: "${line}"`);
      i++; continue;
    }
    if ((m = LINES_RE.exec(line))) {
      // LINES: <uid>  →  capture everything until blank line OR another directive.
      const uid = Number(m[1]);
      const block = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) break;
        if (ANY_DIRECTIVE_RE.test(next)) break;
        block.push(next);
        i++;
      }
      directives.push({ type: 'LINES', uid, block: block.join('\n') });
      continue;
    }
    // Line LOOKED like a directive (matched the catch-all) but didn't fit any
    // specific pattern — track for caller-side clarification reply.
    if (ANY_DIRECTIVE_RE.test(line)) {
      unparsedLines.push(line);
    }
    i++;
  }

  return { directives, unparsed: unparsedLines };
}

// ─── ACTIONABILITY PROBE ─────────────────────────────────────────────────────

/**
 * Returns true when the body has enough content + signals to suggest the
 * operator wanted us to take an action that no directive matched. Used as
 * a pre-filter for the "kickback" path (reply with "I didn't understand —
 * here's what you said" instead of silently dropping).
 *
 * Heuristics (any one passes):
 *   - References a UID or 7-digit search key
 *   - Uses action verbs (change, update, fix, set, swap, ...)
 *   - Body length >= 60 chars (vs. one-word ack)
 *
 * Explicit acknowledgement-only patterns ("thanks", "got it", "ok") return
 * false even if length passes — those are polite replies, not actionable.
 */
function looksLikeActionableReply(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;  // one-word ack — silent skip

  if (/^\s*(thanks|thank you|ok|got it|noted|sounds good|will do|received|cheers|fyi|nm|nevermind|ignore me)\.?\s*$/i.test(trimmed)) {
    return false;
  }

  const hasUidOrKey   = /\b(?:UID\s*\d+|\b[1-9]\d{6}\b)/i.test(trimmed);
  const hasActionVerb = /\b(?:change|update|fix|correct|set|swap|move|merge|add|remove|delete|cancel|skip|process|reload|reprocess|retry|use|treat|reclassif|need|please)\b/i.test(trimmed);
  const isSubstantive = trimmed.length >= 60;

  return hasUidOrKey || hasActionVerb || isSubstantive;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  // Directive patterns (exported so callers can run their own quick checks
  // without re-running parseDirectives; e.g., "does this body contain any
  // PARTNER: at all?")
  PARTNER_RE, INTENT_RE, SKIP_RE, IGNORE_RE, YES_RE, NO_RE, LINES_RE,
  ANY_DIRECTIVE_RE,
  JUNK_CHECK_SUBJECT_RE,
  // Parser + probe
  parseDirectives,
  looksLikeActionableReply,
};
