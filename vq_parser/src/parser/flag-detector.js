const { cleanString } = require('../utils/sanitize');

const FLAG_PATTERNS = [
  { pattern: /\bNO[\s-]?BID\b/i, flag: 'NO-BID' },
  { pattern: /\bNO[\s-]?QUOTE\b/i, flag: 'NO QUOTE' },
  { pattern: /\bNO[\s-]?PRICING\b/i, flag: 'NO PRICING' },
  { pattern: /\bUNABLE\s+TO\s+QUOTE\b/i, flag: 'NO QUOTE' },
  { pattern: /\bCANNOT\s+QUOTE\b/i, flag: 'NO QUOTE' },
  { pattern: /\bDECLINE\s+TO\s+QUOTE\b/i, flag: 'NO-BID' },
  { pattern: /\bPASS\s+ON\s+THIS\b/i, flag: 'NO-BID' },
  { pattern: /\bNOT\s+AVAILABLE\b/i, flag: 'NO-BID' },
  { pattern: /\bCANNOT\s+SUPPORT\b/i, flag: 'NO-BID' },
  { pattern: /\bOUT\s+OF\s+STOCK\b/i, flag: 'NO-BID' },
];

const SUSPICIOUS_PATTERNS = [
  { pattern: /\bDKIM.*fail/i, flag: 'FLAG SUSPICIOUS: DKIM failed' },
  { pattern: /\bDMARC.*fail/i, flag: 'FLAG SUSPICIOUS: DMARC failed' },
  { pattern: /\bSPF.*fail/i, flag: 'FLAG SUSPICIOUS: SPF failed' },
  { pattern: /\bphish/i, flag: 'FLAG SUSPICIOUS: Possible phishing' },
];

const MPN_MISMATCH_PATTERN = /\bMPN[\s-]?MISMATCH\b/i;

function detectFlags(text) {
  const cleaned = cleanString(text);
  const flags = [];

  for (const { pattern, flag } of FLAG_PATTERNS) {
    if (pattern.test(cleaned)) {
      flags.push(flag);
    }
  }

  for (const { pattern, flag } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) { // Use raw text for header checks
      flags.push(flag);
    }
  }

  if (MPN_MISMATCH_PATTERN.test(cleaned)) {
    flags.push('MPN MISMATCH');
  }

  return flags;
}

function isFullNoBid(text) {
  const cleaned = cleanString(text);
  // If the entire email is basically just a no-bid message (short text)
  const isShort = cleaned.length < 500;
  const hasNoBid = FLAG_PATTERNS.some(({ pattern }) => pattern.test(cleaned));
  return isShort && hasNoBid;
}

module.exports = { detectFlags, isFullNoBid };
