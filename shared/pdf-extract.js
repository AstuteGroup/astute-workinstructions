/**
 * shared/pdf-extract.js — universal PDF text extraction cog.
 *
 * Lifted from `vq-parser/src/attachment/pdf-parser.js` and stripped of
 * vq-parser-specific column aliases / LLM fallback so it can be reused by
 * any workflow that ingests PDF attachments (VQ Loading, Market Offer
 * Loading, Stock RFQ Loading, etc.).
 *
 * SCOPE: text extraction + confidence scoring + light-touch line parsing.
 * Workflow-specific column mapping (e.g., chuboe_mpn vs chuboe_offer_line.mpn)
 * is the caller's job — this cog returns generic { mpn, qty, mfr, price, ... }
 * and the caller maps to its own schema.
 *
 * NO Anthropic / LLM API calls. Image-only PDFs and password-protected PDFs
 * fail silently with confidence=0 and the caller is expected to route them
 * to a NeedsReview folder (per Loading workflow conventions).
 *
 * USAGE:
 *   const { extractText, parseLines } = require('../shared/pdf-extract');
 *
 *   const { text, confidence: textConfidence } = await extractText(filepath);
 *   if (textConfidence < 0.5) {
 *     // image-only or unreadable — route to NeedsReview
 *     return null;
 *   }
 *
 *   const { lines, confidence, strategy } = parseLines(text);
 *   if (confidence < 0.7) {
 *     // text extracted but couldn't reliably parse line items — NeedsReview
 *     return null;
 *   }
 *   // lines: [ { mpn, qty?, mfr?, price?, dateCode?, leadTime? }, ... ]
 *
 * CONSUMERS (update this list when you wire a new caller):
 *   - shared/offer-poller.js                              (Market Offer Loading)
 *   - vq-parser/src/attachment/pdf-parser.js              (VQ Loading — to be repointed)
 */

'use strict';

const fs = require('fs');
const { PDFParse } = require('pdf-parse');

/** Confidence threshold below which the caller should route to NeedsReview. */
const FALLBACK_THRESHOLD = 0.7;

/**
 * Extract plain text from a PDF file on disk.
 * Returns { text, confidence, pageCount } where:
 *   - text:        all pages concatenated, normalized newlines
 *   - confidence:  0.0 (failed / image-only) → 1.0 (clean text layer)
 *   - pageCount:   number of pages
 *
 * Confidence heuristic:
 *   - 0.0 if the file can't be read or pdf-parse throws
 *   - 0.0 if extracted text < 40 chars (likely image-only PDF)
 *   - 0.5 if 40–200 chars (sparse — possibly a cover sheet only)
 *   - 0.9 if > 200 chars and >= 5 alphanumeric tokens per page average
 *   - 1.0 otherwise
 */
async function extractText(filepath) {
  try {
    if (!fs.existsSync(filepath)) {
      return { text: '', confidence: 0, pageCount: 0, error: 'file-not-found' };
    }
    const buf = fs.readFileSync(filepath);
    const parser = new PDFParse({ data: buf });
    const data = await parser.getText();
    const text = (data.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const pageCount = (Array.isArray(data.pages) ? data.pages.length : null) || data.numpages || 1;

    let confidence;
    if (text.length < 40) {
      confidence = 0;             // image-only, encrypted, or empty
    } else if (text.length < 200) {
      confidence = 0.5;           // possibly cover sheet only
    } else {
      const tokens = text.split(/\s+/).filter(t => /[A-Za-z0-9]/.test(t));
      const avgPerPage = tokens.length / pageCount;
      confidence = avgPerPage >= 5 ? 1.0 : 0.9;
    }

    return { text, confidence, pageCount };
  } catch (err) {
    return { text: '', confidence: 0, pageCount: 0, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Line parsing — three strategies tried in order
// ──────────────────────────────────────────────────────────────────────────

/** Header words that should NEVER be extracted as MPNs. */
const INVALID_MPN_WORDS = new Set([
  'quantity', 'qty', 'description', 'manufacturer', 'mfr', 'mfg', 'price', 'cost',
  'date', 'code', 'datecode', 'rohs', 'lead', 'time', 'leadtime', 'delivery',
  'country', 'origin', 'coo', 'packaging', 'package', 'pkg', 'moq', 'spq',
  'page', 'total', 'subtotal', 'notes', 'note', 'comment', 'remarks',
  'part', 'number', 'partnumber', 'item', 'line', 'pos', 'position',
  'stock', 'available', 'inventory', 'www', 'http', 'https', 'com', 'org',
  'sale', 'offer', 'quote', 'quotation', 'rfq', 'inquiry',
  'unit', 'each', 'per', 'usd', 'eur', 'gbp', 'currency',
  'terms', 'conditions', 'warranty', 'agree', 'accept',
  'phone', 'fax', 'email', 'address', 'contact', 'name',
  'yes', 'no', 'n/a', 'tbd', 'new', 'used', 'the', 'and', 'for', 'from',
  'manufacture', 'brand', 'vendor', 'supplier', 'dc', 'd/c',
]);

function isValidMpn(mpn) {
  if (!mpn || typeof mpn !== 'string') return false;
  const cleaned = mpn.trim().toUpperCase();
  if (cleaned.length < 4 || cleaned.length > 40) return false;
  if (!/[A-Z]/.test(cleaned) || !/[0-9]/.test(cleaned)) return false;
  const lower = mpn.toLowerCase().trim();
  if (INVALID_MPN_WORDS.has(lower)) return false;
  if (/^(www\.|http|ftp)/i.test(cleaned)) return false;
  const alphanum = (cleaned.match(/[A-Z0-9]/g) || []).length;
  if (alphanum < cleaned.length * 0.5) return false;
  return true;
}

/** Header synonyms (lowercase, normalized — caller may have its own mapping). */
const HEADER_SYNONYMS = {
  mpn:      ['mpn', 'part number', 'part #', 'partnumber', 'part no', 'manufacturer part number', 'manufacturer part #', 'mfr part number', 'mfg part number', 'p/n', 'pn'],
  qty:      ['qty', 'quantity', 'qty available', 'stock', 'available', 'on hand', 'qoh'],
  price:    ['price', 'unit price', 'cost', 'unit cost', 'offer price', 'asking price', 'usd', 'each'],
  mfr:      ['mfr', 'manufacturer', 'brand', 'make', 'mfg'],
  dateCode: ['dc', 'date code', 'datecode', 'd/c'],
  leadTime: ['lead time', 'leadtime', 'delivery'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Strategy A — table-style: find a header row, parse rows below.
 */
function parseTableStrategy(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let headerIdx = -1;
  let headerCols = [];
  let map = {};
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cols = lines[i].split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const normed = cols.map(normalizeHeader);
    const tryMap = {};
    for (let c = 0; c < normed.length; c++) {
      for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) {
        if (syns.includes(normed[c]) || syns.some(s => normed[c].includes(s))) {
          if (tryMap[field] === undefined) tryMap[field] = c;
        }
      }
    }
    if (tryMap.mpn !== undefined && Object.keys(tryMap).length >= 2) {
      headerIdx = i;
      headerCols = cols;
      map = tryMap;
      break;
    }
  }
  if (headerIdx < 0) return { lines: [], confidence: 0, strategy: 'table' };

  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i].split(/\s{2,}|\t/).map(c => c.trim());
    if (cells.length < 2) continue;
    const mpn = map.mpn !== undefined ? cells[map.mpn] : '';
    if (!isValidMpn(mpn)) continue;
    const row = { mpn };
    if (map.qty !== undefined && cells[map.qty]) {
      const n = Number(String(cells[map.qty]).replace(/[, ]/g, ''));
      if (!isNaN(n) && n > 0) row.qty = n;
    }
    if (map.price !== undefined && cells[map.price]) {
      const n = Number(String(cells[map.price]).replace(/[$, ]/g, ''));
      if (!isNaN(n) && n > 0) row.price = n;
    }
    if (map.mfr !== undefined && cells[map.mfr]) row.mfrText = cells[map.mfr];
    if (map.dateCode !== undefined && cells[map.dateCode]) row.dateCode = cells[map.dateCode];
    if (map.leadTime !== undefined && cells[map.leadTime]) row.leadTime = cells[map.leadTime];
    out.push(row);
  }
  const confidence = out.length > 0 ? Math.min(0.85, 0.5 + out.length * 0.05) : 0;
  return { lines: out, confidence, strategy: 'table', headerColumns: headerCols };
}

/**
 * Strategy B — regex line patterns (tolerates varied spacing).
 * Pattern 1: MPN Qty Manufacturer Price (Lantek/SemiXS shape)
 * Pattern 2: Qty MPN Manufacturer Price
 */
function parseRegexStrategy(text) {
  const out = [];

  const patternA = /([0-9A-Z][A-Z0-9\-/.]{4,})\s+(\d{1,7}(?:,\d{3})*)\s+([A-Z][A-Z\s\-.]+?)\s+\$?([\d,]+\.?\d*)\s*(?:each|ea)?/gi;
  let m;
  while ((m = patternA.exec(text)) !== null) {
    const mpn = m[1].trim();
    const qty = Number(m[2].replace(/,/g, ''));
    const mfr = m[3].trim();
    const price = Number(m[4].replace(/,/g, ''));
    if (!isValidMpn(mpn)) continue;
    if (mfr.length > 30) continue;
    if (price > 10000) continue;
    if (!isNaN(qty) && !isNaN(price)) out.push({ mpn, qty, mfrText: mfr, price });
  }
  if (out.length > 0) return { lines: out, confidence: 0.75, strategy: 'regex-mpn-first' };

  const patternB = /(\d{1,7}(?:,\d{3})*)\s+([A-Z0-9][A-Z0-9\-/.]{4,})\s+([A-Za-z][\w\s\-.]+?)\s+\$?([\d,]+\.?\d*)/gm;
  while ((m = patternB.exec(text)) !== null) {
    const qty = Number(m[1].replace(/,/g, ''));
    const mpn = m[2].trim();
    const mfr = m[3].trim();
    const price = Number(m[4].replace(/,/g, ''));
    if (!isValidMpn(mpn)) continue;
    if (mfr.length > 30) continue;
    if (price > 10000) continue;
    if (!isNaN(qty) && !isNaN(price)) out.push({ mpn, qty, mfrText: mfr, price });
  }
  if (out.length > 0) return { lines: out, confidence: 0.6, strategy: 'regex-qty-first' };

  return { lines: [], confidence: 0, strategy: 'regex' };
}

/**
 * Strategy C — single-line key-value (e.g., one-page quote with labels).
 */
function parseKeyValueStrategy(text) {
  const out = {};
  const patterns = {
    mpn:      [/Part\s*(?:Number|#|No\.?)[\s:]+([A-Z0-9\-/.]+)/i, /MPN[\s:]+([A-Z0-9\-/.]+)/i, /P\/N[\s:]+([A-Z0-9\-/.]+)/i],
    mfrText:  [/Manufacturer[\s:]+([A-Za-z0-9\s\-.]+?)(?:\n|$)/i, /MFR[\s:]+([A-Za-z0-9\s\-.]+?)(?:\n|$)/i, /Brand[\s:]+([A-Za-z0-9\s\-.]+?)(?:\n|$)/i],
    qty:      [/Quantity[\s:]+([\d,]+)/i, /Qty[\s:]+([\d,]+)/i, /([\d,]+)\s*(?:pcs|pieces|units)/i],
    price:    [/(?:Unit\s*)?Price[\s:]+\$?([\d,.]+)/i, /Cost[\s:]+\$?([\d,.]+)/i, /\$([\d,.]+)\s*(?:each|ea|per unit)/i],
    dateCode: [/Date\s*Code[\s:]+([0-9A-Z+/]+)/i, /D\/C[\s:]+([0-9A-Z+/]+)/i, /DC[\s:]+([0-9A-Z+/]+)/i],
    leadTime: [/Lead\s*Time[\s:]+([^\n]+)/i, /Delivery[\s:]+([^\n]+)/i, /Ships?\s+in[\s:]+([^\n]+)/i],
  };
  let hit = 0;
  for (const [field, pats] of Object.entries(patterns)) {
    for (const p of pats) {
      const m = text.match(p);
      if (m && m[1]) {
        const v = m[1].trim();
        if (field === 'qty') {
          const n = Number(v.replace(/,/g, ''));
          if (!isNaN(n) && n > 0) { out[field] = n; hit++; break; }
        } else if (field === 'price') {
          const n = Number(v.replace(/,/g, ''));
          if (!isNaN(n) && n > 0) { out[field] = n; hit++; break; }
        } else {
          out[field] = v; hit++; break;
        }
      }
    }
  }
  if (out.mpn && !isValidMpn(out.mpn)) { delete out.mpn; hit--; }
  if (hit >= 2 && out.mpn) {
    return { lines: [out], confidence: Math.min(0.7, 0.3 + hit * 0.1), strategy: 'key-value' };
  }
  return { lines: [], confidence: 0, strategy: 'key-value' };
}

/**
 * Try the three strategies in order; return the first non-empty result.
 */
function parseLines(text) {
  if (!text || typeof text !== 'string') {
    return { lines: [], confidence: 0, strategy: 'empty' };
  }
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const t = parseTableStrategy(norm);
  if (t.lines.length > 0) return t;

  const r = parseRegexStrategy(norm);
  if (r.lines.length > 0) return r;

  const k = parseKeyValueStrategy(norm);
  if (k.lines.length > 0) return k;

  return { lines: [], confidence: 0, strategy: 'no-match' };
}

/**
 * Convenience: full pipeline. Extract text, parse lines, return combined result.
 *
 * Returns:
 *   {
 *     text, pageCount,
 *     textConfidence,    // from extractText
 *     lineConfidence,    // from parseLines
 *     overallConfidence, // min(textConfidence, lineConfidence)
 *     strategy,
 *     lines,             // [{mpn, qty?, mfrText?, price?, dateCode?, leadTime?}, ...]
 *     needsReview,       // true if overallConfidence < FALLBACK_THRESHOLD
 *   }
 */
async function extractAndParse(filepath) {
  const txt = await extractText(filepath);
  if (txt.confidence === 0) {
    return {
      text: '', pageCount: txt.pageCount,
      textConfidence: 0, lineConfidence: 0, overallConfidence: 0,
      strategy: 'text-extract-failed', lines: [], needsReview: true,
      error: txt.error || 'no text layer',
    };
  }
  const parsed = parseLines(txt.text);
  const overall = Math.min(txt.confidence, parsed.confidence);
  return {
    text: txt.text,
    pageCount: txt.pageCount,
    textConfidence: txt.confidence,
    lineConfidence: parsed.confidence,
    overallConfidence: overall,
    strategy: parsed.strategy,
    lines: parsed.lines,
    needsReview: overall < FALLBACK_THRESHOLD,
  };
}

module.exports = {
  extractText,
  parseLines,
  extractAndParse,
  isValidMpn,
  FALLBACK_THRESHOLD,
};
