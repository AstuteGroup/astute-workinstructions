const fs = require('fs');
const logger = require('../utils/logger');
const PDFExtract = require('pdf.js-extract').PDFExtract;
const { COLUMN_ALIASES } = require('../../config/columns');

/**
 * Parse a PDF file and extract quote data
 * @param {string} filepath - Path to the PDF file
 * @returns {Promise<{lines: Array, confidence: number, strategy: string}>}
 */
async function parsePDF(filepath) {
  try {
    const pdfExtract = new PDFExtract();
    const data = await pdfExtract.extract(filepath, {});

    // Combine all text from all pages
    let text = '';
    for (const page of data.pages) {
      const pageText = page.content
        .map(item => item.str)
        .join(' ');
      text += pageText + '\n';
    }

    logger.debug(`PDF text extracted (${text.length} chars)`);
    logger.debug(`PDF text preview: ${text.substring(0, 300)}`);

    // Try to parse the extracted text
    const result = parseQuoteText(text);

    return {
      lines: result.lines,
      confidence: result.confidence,
      strategy: 'pdf-' + result.strategy,
      rawText: text
    };

  } catch (err) {
    logger.error(`Failed to parse PDF ${filepath}: ${err.message}`);
    return { lines: [], confidence: 0, strategy: 'pdf-failed' };
  }
}

/**
 * Parse extracted text to find quote data
 */
function parseQuoteText(text) {
  const lines = [];
  let confidence = 0;
  let strategy = 'none';

  // Normalize text
  const normalizedText = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Strategy 1: Look for tabular data with known column patterns
  const tableResult = parseTableFormat(normalizedText);
  if (tableResult.lines.length > 0) {
    return { ...tableResult, strategy: 'table' };
  }

  // Strategy 2: Regex-based extraction for line-item patterns (most PDF quotes use this)
  const regexResult = parseWithPatterns(normalizedText);
  if (regexResult.lines.length > 0) {
    return { ...regexResult, strategy: 'regex' };
  }

  // Strategy 3: Look for key-value pairs (fallback for simpler formats)
  const kvResult = parseKeyValueFormat(normalizedText);
  if (kvResult.lines.length > 0) {
    return { ...kvResult, strategy: 'key-value' };
  }

  return { lines, confidence, strategy };
}

// Common header/label words that should NOT be extracted as MPNs
const INVALID_MPN_WORDS = [
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
  'manufacture', 'brand', 'vendor', 'supplier', 'dc', 'd/c'
];

/**
 * Validate if a string looks like a valid MPN
 */
function isValidMPN(mpn) {
  if (!mpn || typeof mpn !== 'string') return false;

  const cleaned = mpn.trim().toUpperCase();

  // Too short or too long
  if (cleaned.length < 4 || cleaned.length > 40) return false;

  // Must contain at least one letter AND one number (typical for part numbers)
  const hasLetters = /[A-Z]/.test(cleaned);
  const hasNumbers = /[0-9]/.test(cleaned);
  if (!hasLetters || !hasNumbers) return false;

  // Check against invalid words
  const lowerMPN = mpn.toLowerCase().trim();
  if (INVALID_MPN_WORDS.includes(lowerMPN)) return false;

  // Check if it starts with an invalid word or contains only invalid words
  // Split by common separators to check each part
  const parts = lowerMPN.split(/[\s\/\-_]+/);
  const allPartsInvalid = parts.every(p => INVALID_MPN_WORDS.includes(p) || p.length < 2);
  if (allPartsInvalid && parts.length > 0) return false;

  // Check if it starts with an invalid word
  for (const word of INVALID_MPN_WORDS) {
    if (lowerMPN === word || lowerMPN.startsWith(word + ' ')) return false;
  }

  // Reject if it looks like a URL
  if (/^(www\.|http|ftp)/i.test(cleaned)) return false;

  // Reject if it's mostly punctuation or spaces
  const alphanumCount = (cleaned.match(/[A-Z0-9]/g) || []).length;
  if (alphanumCount < cleaned.length * 0.5) return false;

  return true;
}

/**
 * Parse table-formatted text
 */
function parseTableFormat(text) {
  const lines = [];
  const textLines = text.split('\n').map(l => l.trim()).filter(l => l);

  // Look for header row
  let headerIndex = -1;
  let headers = [];

  for (let i = 0; i < Math.min(textLines.length, 20); i++) {
    const line = textLines[i].toLowerCase();
    const matches = Object.entries(COLUMN_ALIASES).filter(([col, aliases]) => {
      return aliases.some(alias => line.includes(alias.toLowerCase()));
    });

    if (matches.length >= 2) {
      headerIndex = i;
      headers = textLines[i].split(/\s{2,}|\t/).map(h => h.trim());
      break;
    }
  }

  if (headerIndex === -1) {
    return { lines: [], confidence: 0 };
  }

  // Map headers to column names
  const headerMap = {};
  headers.forEach((header, idx) => {
    const lowerHeader = header.toLowerCase();
    for (const [col, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.some(alias => lowerHeader.includes(alias.toLowerCase()))) {
        headerMap[idx] = col;
        break;
      }
    }
  });

  // Parse data rows
  for (let i = headerIndex + 1; i < textLines.length; i++) {
    const line = textLines[i];
    if (!line || line.length < 5) continue;

    // Split by multiple spaces or tabs
    const values = line.split(/\s{2,}|\t/).map(v => v.trim());

    if (values.length >= 2) {
      const row = {};
      values.forEach((val, idx) => {
        if (headerMap[idx]) {
          row[headerMap[idx]] = val;
        }
      });

      // Validate MPN if present
      if (row['chuboe_mpn'] && !isValidMPN(row['chuboe_mpn'])) {
        logger.debug(`Skipping invalid MPN: "${row['chuboe_mpn']}"`);
        continue;
      }

      // Only add if we have a valid MPN or price
      if (row['chuboe_mpn'] || row['cost']) {
        lines.push(row);
      }
    }
  }

  const confidence = lines.length > 0 ? Math.min(0.8, 0.4 + (lines.length * 0.1)) : 0;
  return { lines, confidence };
}

/**
 * Parse key-value formatted text (common in PDF quotes)
 */
function parseKeyValueFormat(text) {
  const line = {};

  // Common patterns for key-value extraction
  const patterns = {
    'chuboe_mpn': [
      /Part\s*(?:Number|#|No\.?)[\s:]+([A-Z0-9\-\/\.]+)/i,
      /MPN[\s:]+([A-Z0-9\-\/\.]+)/i,
      /P\/N[\s:]+([A-Z0-9\-\/\.]+)/i,
      /Your\s*RFQ[\s:]+([A-Z0-9][A-Z0-9\-\/\.]{4,})/i,
      /(?:regarding|for|re:?)\s+([A-Z0-9][A-Z0-9\-\/\.]{4,})/i,
      /\d\.\d\s+([A-Z0-9][A-Z0-9\-\/\.]{5,}),\s*[A-Za-z]/i,  // "1.1 TG110S050N2RLTR, Halo Electronics"
    ],
    'chuboe_mfr_text': [
      /Manufacturer[\s:]+([A-Za-z0-9\s\-\.]+?)(?:\n|$)/i,
      /MFR[\s:]+([A-Za-z0-9\s\-\.]+?)(?:\n|$)/i,
      /Brand[\s:]+([A-Za-z0-9\s\-\.]+?)(?:\n|$)/i,
    ],
    'qty': [
      /Quantity[\s:]+([0-9,\.]+)/i,
      /Qty[\s:]+([0-9,\.]+)/i,
      /([0-9,]+)\s*(?:pcs|pieces|units)/i,
      /\b(\d{3,6})\s+\d{4}\s+USD/i,  // "2000 0618 USD" - qty before datecode
    ],
    'cost': [
      /(?:Unit\s*)?Price[\s:]+\$?([0-9,\.]+)/i,
      /Cost[\s:]+\$?([0-9,\.]+)/i,
      /\$([0-9,\.]+)\s*(?:each|ea|per unit)/i,
      /USD\s+([0-9]+[,\.]\d+)\s*\//i,  // "USD 0,55 /" - capture with comma/dot
      /EUR\s+([0-9]+[,\.]\d+)\s*\//i,
    ],
    'chuboe_date_code': [
      /Date\s*Code[\s:]+([0-9A-Z\+\/]+)/i,
      /D\/C[\s:]+([0-9A-Z\+\/]+)/i,
      /DC[\s:]+([0-9A-Z\+\/]+)/i,
    ],
    'c_country_id': [
      /Country\s*(?:of\s*)?Origin[\s:]+([A-Za-z]{2,})/i,
      /COO[\s:]+([A-Za-z]{2,})/i,
      /Made\s*in[\s:]+([A-Za-z]{2,})/i,
    ],
    'chuboe_rohs': [
      /RoHS[\s:]+(\w+)/i,
      /RoHS\s+Compliant/i,
    ],
    'chuboe_lead_time': [
      /Lead\s*Time[\s:]+([^\n]+)/i,
      /Delivery[\s:]+([^\n]+)/i,
      /Ships?\s+in[\s:]+([^\n]+)/i,
    ],
  };

  let matchCount = 0;
  for (const [field, fieldPatterns] of Object.entries(patterns)) {
    for (const pattern of fieldPatterns) {
      const match = text.match(pattern);
      if (match) {
        line[field] = match[1] ? match[1].trim() : 'Y';
        matchCount++;
        break;
      }
    }
  }

  // Validate MPN if extracted
  if (line['chuboe_mpn'] && !isValidMPN(line['chuboe_mpn'])) {
    logger.debug(`Skipping invalid MPN from key-value: "${line['chuboe_mpn']}"`);
    delete line['chuboe_mpn'];
    matchCount--;
  }

  if (matchCount >= 2) {
    const confidence = Math.min(0.7, 0.3 + (matchCount * 0.1));
    return { lines: [line], confidence };
  }

  return { lines: [], confidence: 0 };
}

/**
 * Parse with regex patterns for common quote formats
 */
function parseWithPatterns(text) {
  const lines = [];

  // Pattern 1: MPN Qty Manufacturer Price (Lantek/SemiXS format)
  // e.g., "0251002.MRT1L 1,300   LITTEL FUSE   $0.320 each"
  // MPN must be at least 5 chars and contain both letters and numbers
  const lantekPattern = /([0-9A-Z][A-Z0-9\-\/\.]{4,})\s+(\d{1,6}(?:,\d{3})*)\s+([A-Z][A-Z\s\-\.]+?)\s+\$?([\d,]+\.?\d*)\s*(?:each|ea)?/gi;

  let match;
  while ((match = lantekPattern.exec(text)) !== null) {
    const mpn = match[1].trim();
    const qty = match[2].replace(/,/g, '');
    const mfr = match[3].trim();
    const cost = match[4].replace(/,/g, '');

    // Validate MPN: must contain both letters and numbers (typical for part numbers)
    const hasLetters = /[A-Z]/i.test(mpn);
    const hasNumbers = /[0-9]/.test(mpn);

    // Skip common false positives
    if (/^(PAGE|WWW|HTTP|COM|USA|NEW|THE|AND|FOR)\b/i.test(mpn)) continue;
    if (!hasLetters || !hasNumbers) continue;
    if (mfr.length > 30) continue; // Manufacturer name too long
    if (parseFloat(cost) > 10000) continue; // Unrealistic price

    lines.push({
      'chuboe_mpn': mpn,
      'qty': qty,
      'chuboe_mfr_text': mfr,
      'cost': cost
    });
  }

  if (lines.length > 0) {
    return { lines, confidence: 0.75 };
  }

  // Pattern 2: Qty MPN Manufacturer Price
  const linePattern = /(\d{1,6}(?:,\d{3})*)\s+([A-Z0-9][A-Z0-9\-\/\.]{4,})\s+([A-Za-z][\w\s\-\.]+?)\s+\$?([\d,]+\.?\d*)/gm;

  while ((match = linePattern.exec(text)) !== null) {
    const mpn = match[2];
    const hasLetters = /[A-Z]/i.test(mpn);
    const hasNumbers = /[0-9]/.test(mpn);

    if (!hasLetters || !hasNumbers) continue;

    lines.push({
      'qty': match[1].replace(/,/g, ''),
      'chuboe_mpn': mpn,
      'chuboe_mfr_text': match[3].trim(),
      'cost': match[4].replace(/,/g, '')
    });
  }

  if (lines.length > 0) {
    return { lines, confidence: 0.6 };
  }

  return { lines: [], confidence: 0 };
}

module.exports = { parsePDF };
