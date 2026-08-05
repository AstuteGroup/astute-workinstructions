/**
 * Business Ops/tsk-excess-file-buildout/excess-processor.js
 *
 * Core processing logic for excess inspection files.
 * Parses xlsx or pdf attachments, extracts part data, applies:
 *   - PO number auto-detection
 *   - Site lookup from "Excess POs" tab
 *   - MFR code resolution (database lookup + pattern matching)
 *   - Product code classification
 *   - Description lookup/inference
 *
 * Output: Inspection log format xlsx
 *
 * See: excess-inspection-file-buildout.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');

// Load MFR lookup from shared module
let lookupMfr;
try {
  ({ lookupMfr } = require('../../shared/mfr-lookup'));
} catch (err) {
  console.error('[excess-processor] Failed to load mfr-lookup:', err.message);
  // Fallback to pass-through
  lookupMfr = (mfr) => ({ canonical: mfr, id: null, matched: false });
}

// ─── PO NUMBER DETECTION ─────────────────────────────────────────────────────

/**
 * Extract PO number from various sources.
 * Pattern: POV followed by 7-8 digits
 */
const PO_PATTERN = /\b(POV?\d{7,8})\b/i;

function detectPOFromText(text) {
  if (!text) return null;
  const match = text.match(PO_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Auto-detect PO number from email metadata and file content.
 */
function autoDetectPO(opts) {
  const { subject, body, filename, sheetData } = opts;

  // 1. Subject line
  let po = detectPOFromText(subject);
  if (po) return { po, source: 'subject' };

  // 2. Filename
  po = detectPOFromText(filename);
  if (po) return { po, source: 'filename' };

  // 3. Email body
  po = detectPOFromText(body);
  if (po) return { po, source: 'body' };

  // 4. Sheet content — look for "PO" column or cell with POV pattern
  if (sheetData && Array.isArray(sheetData)) {
    for (const row of sheetData) {
      for (const cell of Object.values(row)) {
        po = detectPOFromText(String(cell));
        if (po) return { po, source: 'sheet-content' };
      }
    }
  }

  return { po: null, source: null };
}

// ─── SITE LOOKUP ─────────────────────────────────────────────────────────────

/**
 * Lookup site from "Excess POs" tab in the workbook (if present).
 */
function lookupSiteFromExcessPOs(workbook, poNumber) {
  if (!workbook.SheetNames.includes('Excess POs')) return null;

  const ws = workbook.Sheets['Excess POs'];
  const data = XLSX.utils.sheet_to_json(ws);

  for (const row of data) {
    const rowPO = String(row['PO'] || row['PO Number'] || '').toUpperCase();
    if (rowPO === poNumber.toUpperCase()) {
      return row['Site'] || row['Site (as needed)'] || null;
    }
  }
  return null;
}

// ─── CONSIGNMENT PARTNER DETECTION ───────────────────────────────────────────

const PARTNER_PATTERNS = [
  { pattern: /GE\s*(Aviation|Aerospace)/i, partner: 'GE Aviation' },
  { pattern: /Marvell/i, partner: 'Marvell' },
  { pattern: /Plexus/i, partner: 'Plexus' },
  { pattern: /Eaton/i, partner: 'Eaton' },
  { pattern: /LAM\s*Research/i, partner: 'LAM Research' },
  { pattern: /Taxan/i, partner: 'Taxan' },
  { pattern: /Spartronics/i, partner: 'Spartronics' },
];

function detectPartner(text) {
  if (!text) return null;
  for (const { pattern, partner } of PARTNER_PATTERNS) {
    if (pattern.test(text)) return partner;
  }
  return null;
}

// ─── MFR CODE MAPPING ────────────────────────────────────────────────────────

// Common MFR prefix → MFR code mappings (fallback when DB lookup fails)
const MFR_PREFIX_MAP = {
  'CRCW': { code: 'M11888', name: 'VISHAY' },
  'C1206C': { code: 'M03110', name: 'KEMET' },
  'CK': { code: 'M03110', name: 'KEMET' },
  '1206B': { code: 'M03930', name: 'MURATA' },
  'MC79L': { code: 'M04180', name: 'ON SEMICONDUCTOR' },
  'MURA': { code: 'M04180', name: 'ON SEMICONDUCTOR' },
  'LM117': { code: 'M04095', name: 'NATIONAL SEMICONDUCTOR' },
  'LM741': { code: 'M04095', name: 'NATIONAL SEMICONDUCTOR' },
  'SMCJ': { code: 'M03395', name: 'LITTELFUSE' },
  '30KPA': { code: 'M03395', name: 'LITTELFUSE' },
  '16CTQ': { code: 'M11888', name: 'VISHAY' },
  'RC07': { code: 'M00224', name: 'ALLEN BRADLEY' },
  'RLR07': { code: 'M11888', name: 'VISHAY' },
  'WTA': { code: 'M06355', name: 'WINCHESTER' },
  'WTAV': { code: 'M06355', name: 'WINCHESTER' },
};

// Additional MFR codes from DB
const MFR_NAME_TO_CODE = {
  'YAGEO': 'M06441',
  'WALSIN': 'M06251',
  'TEXAS INSTRUMENTS': 'M05844',
  'PANASONIC': 'M04260',
  'MICROCHIP': 'M03611',
  'SAMSUNG': 'M06607',
};

// Unknown MFR placeholder
const UNKNOWN_MFR_CODE = 'M99999';

/**
 * Resolve MFR code from MPN or MFR name.
 * Uses pattern matching only (no DB queries) for fast processing.
 * TODO: Add optional DB lookup for unmatched industry MPNs.
 */
function resolveMfrCode(mpn, mfrName) {
  // Try static MFR name mapping first
  if (mfrName) {
    const upper = mfrName.toUpperCase().trim();
    if (MFR_NAME_TO_CODE[upper]) {
      return { code: MFR_NAME_TO_CODE[upper], name: upper };
    }
    // Check partial matches
    for (const [name, code] of Object.entries(MFR_NAME_TO_CODE)) {
      if (upper.includes(name) || name.includes(upper)) {
        return { code, name };
      }
    }
  }

  // Try MPN prefix mapping
  if (mpn) {
    const upperMPN = mpn.toUpperCase();
    for (const [prefix, info] of Object.entries(MFR_PREFIX_MAP)) {
      if (upperMPN.startsWith(prefix)) {
        return info;
      }
    }

    // Additional MPN patterns
    if (/^JANTX?V?/.test(upperMPN)) return { code: 'M11888', name: 'VISHAY' };  // JANTX diodes
    if (/^D55342/.test(upperMPN)) return { code: 'M11888', name: 'VISHAY' };    // MIL resistors
    if (/^M39003|^M39006|^M39014/.test(upperMPN)) return { code: 'M03110', name: 'KEMET' }; // MIL caps
    if (/^M38510|^5962-/.test(upperMPN)) return { code: 'M05844', name: 'TEXAS INSTRUMENTS' }; // MIL ICs
    if (/^CDR\d{2}/.test(upperMPN)) return { code: 'M00094', name: 'AVX' };     // AVX caps
    if (/^T49\d/.test(upperMPN)) return { code: 'M03110', name: 'KEMET' };      // Tantalum caps
    if (/^D38999/.test(upperMPN)) return { code: 'M00135', name: 'AMPHENOL' };  // MIL connectors
    if (/^MS3\d{3}/.test(upperMPN)) return { code: 'M00135', name: 'AMPHENOL' }; // MS connectors
  }

  // Unknown
  return { code: UNKNOWN_MFR_CODE, name: '' };
}

/**
 * Get MFR code (value) by chuboe_mfr_id.
 * NOTE: Disabled - resolveMfrCode now uses pattern matching only.
 */
function getMfrCodeById(mfrId) {
  // DB lookup disabled for performance
  return null;
}

// ─── CUSTOMER INTERNAL P/N DETECTION ─────────────────────────────────────────

/**
 * Detect if an item is a customer internal part number (not an industry MPN).
 * Internal P/Ns get Product Code = BTP, Description = the item itself.
 */
function isInternalPartNumber(item) {
  if (!item) return false;
  const s = item.trim();

  // Pure numeric: 6292, 10121, 9626
  if (/^\d+$/.test(s)) return true;

  // Numeric with dash: 009958-1, 010103-2, 402845-3, 173456-171, 75596-0001
  if (/^\d+-\d+$/.test(s)) return true;

  // Alphanumeric GE format: 145E2035-3, 724E2302-1, 4B4545-1
  if (/^[A-Z0-9]+E\d+-\d+$/i.test(s)) return true;

  // Mostly numeric with dash and optional letter: 72938-470J, 71305-0001
  if (/^\d+-\d+[A-Z]?$/i.test(s)) return true;

  // GE drawing numbers: single digit + letter + more: 4B4545-1
  if (/^\d[A-Z]\d+-\d+$/i.test(s)) return true;

  // Short alphanumeric with dash: 75215-1022, 756079-027
  if (/^\d{5}-\d{4}$/.test(s)) return true;

  // Pattern like 100-000-898-002 (GE 3-segment)
  if (/^\d{3}-\d{3}-\d{3}-\d{3}$/.test(s)) return true;

  // Other non-standard: LS-204-B-N, MH-056, TU70-01
  if (/^[A-Z]{2}-\d{3}-[A-Z]-[A-Z]$/i.test(s)) return true;
  if (/^[A-Z]{2}-\d{3}$/i.test(s)) return true;
  if (/^[A-Z]{2}\d{2}-\d{2}$/i.test(s)) return true;

  return false;
}

// ─── PRODUCT CODE CLASSIFICATION ─────────────────────────────────────────────

const PRODUCT_CODE_RULES = [
  { code: 'PA', keywords: ['RES', 'RESISTOR', 'CAP', 'CAPACITOR', 'INDUCTOR', 'CRYSTAL', 'THICK FILM', 'THIN FILM'] },
  { code: 'SC', keywords: ['DIODE', 'TRANS', 'IC', 'MOSFET', 'REGULATOR', 'LDO', 'VOLTAGE REG', 'OP AMP', 'AMPLIFIER', 'TVS'] },
  { code: 'CO', keywords: ['CONN', 'CONNECTOR', 'SPLICE', 'TERMINAL', 'HEADER', 'SOCKET'] },
  { code: 'EM', keywords: ['HARDWARE', 'NAS', 'MS', 'RELAY', 'SWITCH', 'FUSE', 'SCREW', 'NUT', 'WASHER'] },
  { code: 'LED', keywords: ['LED', 'DISPLAY', 'OPTO'] },
];

function classifyProductCode(description, mpn) {
  // Check if internal part number
  if (isInternalPartNumber(mpn)) {
    return 'BTP';
  }

  if (!description) return 'PA'; // Default to Passive

  const upper = description.toUpperCase();
  for (const { code, keywords } of PRODUCT_CODE_RULES) {
    for (const kw of keywords) {
      if (upper.includes(kw)) return code;
    }
  }

  // MPN-based inference for MIL-SPEC
  if (mpn) {
    const upperMPN = mpn.toUpperCase();
    if (/^M38510/.test(upperMPN)) return 'SC'; // IC MIL-SPEC
    if (/^M55342/.test(upperMPN)) return 'PA'; // Resistor Film MIL-SPEC
    if (/^M39003|^M39014/.test(upperMPN)) return 'PA'; // Capacitor MIL-SPEC
    if (/^JAN.*1N|^JANTX.*1N/.test(upperMPN)) return 'SC'; // Diode MIL-SPEC
    if (/^JAN.*2N|^JANTX.*2N/.test(upperMPN)) return 'SC'; // Transistor MIL-SPEC
    if (/^NAS|^MS/.test(upperMPN)) return 'EM'; // Hardware MIL-SPEC
  }

  return 'PA'; // Default
}

// ─── DESCRIPTION LOOKUP/INFERENCE ────────────────────────────────────────────

const DESCRIPTION_PATTERNS = [
  { pattern: /^CRCW0805/, description: 'RES THICK FILM 0805' },
  { pattern: /^CRCW1206/, description: 'RES THICK FILM 1206' },
  { pattern: /^CRCW2512/, description: 'RES THICK FILM 2512' },
  { pattern: /^M39003|^M39014/, description: 'CAPACITOR MIL-SPEC' },
  { pattern: /^JAN.*1N|^JANTX.*1N/, description: 'DIODE MIL-SPEC' },
  { pattern: /^JAN.*2N|^JANTX.*2N/, description: 'TRANSISTOR MIL-SPEC' },
  { pattern: /^M38510/, description: 'IC MIL-SPEC' },
  { pattern: /^M55342/, description: 'RESISTOR FILM MIL-SPEC' },
  { pattern: /^NAS|^MS/, description: 'HARDWARE MIL-SPEC' },
  { pattern: /^SMCJ|^30KPA/, description: 'DIODE TVS' },
  { pattern: /^MURA/, description: 'DIODE RECTIFIER ULTRA FAST' },
];

function inferDescription(mpn) {
  if (!mpn) return '';
  const upper = mpn.toUpperCase();

  // Check if internal part number — use the item as description
  if (isInternalPartNumber(mpn)) {
    return mpn;
  }

  for (const { pattern, description } of DESCRIPTION_PATTERNS) {
    if (pattern.test(upper)) return description;
  }
  return '';
}

/**
 * Lookup description from database.
 * NOTE: Disabled for performance - uses pattern inference only.
 */
function lookupDescription(mpn) {
  // DB lookup disabled for performance
  // TODO: Re-enable with caching for batch lookups
  return null;
}

function getDescription(mpn) {
  // Use pattern inference only (no DB lookup for performance)
  return inferDescription(mpn);
}

// ─── XLSX/PDF PARSING ────────────────────────────────────────────────────────

/**
 * Parse xlsx file and extract line items.
 * Uses fuzzy header matching to handle various formats.
 */
function parseXlsx(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (data.length === 0) {
    throw new Error('No data found in xlsx');
  }

  // Fuzzy header matching
  const headers = Object.keys(data[0]);
  const headerMap = {};

  const HEADER_ALIASES = {
    mpn: ['item', 'mpn', 'part number', 'part_number', 'partnumber', 'part', 'mfr part', 'component'],
    qty: ['quantity', 'qty', 'ordered', 'order qty', 'order_qty'],
    mfr: ['manufacturer', 'mfr', 'mfg', 'make'],
    dateCode: ['date code', 'datecode', 'dc', 'date_code'],
    description: ['description', 'desc', 'part description'],
  };

  for (const header of headers) {
    const lowerHeader = header.toLowerCase().trim();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some(a => lowerHeader.includes(a) || lowerHeader === a)) {
        headerMap[field] = header;
        break;
      }
    }
  }

  // Extract items
  const items = [];
  for (const row of data) {
    const mpn = String(row[headerMap.mpn] || '').trim();
    if (!mpn) continue;

    const qtyRaw = row[headerMap.qty];
    const qty = parseInt(String(qtyRaw).replace(/[,\s]/g, ''), 10) || 0;

    items.push({
      mpn,
      qty,
      mfr: headerMap.mfr ? String(row[headerMap.mfr] || '').trim() : '',
      dateCode: headerMap.dateCode ? String(row[headerMap.dateCode] || '').trim() : '',
      description: headerMap.description ? String(row[headerMap.description] || '').trim() : '',
    });
  }

  return { items, workbook, sheetName };
}

/**
 * Parse PDF file using pdfjs-dist.
 * Extracts line items based on common PO formats.
 */
async function parsePdf(filePath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

  // Read and parse PDF
  let text = '';
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjsLib.getDocument({ data }).promise;

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      text += pageText + '\n';
    }
  } catch (err) {
    throw new Error(`Failed to parse PDF: ${err.message}`);
  }

  const items = [];

  // GE Aviation PO format: items are listed in columns, PDF extraction joins them.
  // Extract all MPN-like patterns from the text.
  //
  // MPN patterns to match:
  // - GE internal: 173456-171, 174442-10, 181222-240
  // - MIL-SPEC: M39014/22-0357, M38510/65201BCX, RWR82SR499FR
  // - Standard: TNPW08051003BT9RT1, JANTXV2N5745, CDR01BX102BKYM
  // - With slashes: D38999/20MB35PN

  // Noise patterns to skip
  const NOISE_PATTERNS = [
    /^Page\s+\d+/i,
    /^QR\d+/i,
    /^\d{2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/i,
    /^Order\s+No:/i,
    /^Tax\s+Resale/i,
    /^Tax\s+ID/i,
    /^Vendor:/i,
    /^Deliver\s+To:/i,
    /^Ship\s+Via/i,
    /^Buyer/i,
    /^This\s+order/i,
    /^Invoices\s+must/i,
    /^Only\s+new/i,
    /^It\s+is\s+a\s+condition/i,
    /astutegroup/i,
    /accountspayable/i,
    /orangetsunami/i,
    /^\d+\.\d{2}$/,  // prices like 1.00
    /^EA$/i,
    /^USD$/i,
    /^n\/a$/i,
    /^United\s+States$/i,
    /^(Austin|Grand\s+Rapids|MI|TX)/i,
    /^POV\d+$/i,  // PO number
    /^V\d{6}$/i,  // Vendor code
    /^\d{3}-\d{3}-\d{4}$/,  // Phone number
    /^EX-WORKS$/i,
    /^UPS/i,
    /^Pro\s+Forma$/i,
    /^Suite\s+\d+$/i,
    /^75-\d+$/,  // Tax ID
    /^32\d{9}$/,  // Certificate number
    /Iss\.\d+/i,
    /^\d{5}$/,  // Zip codes
    /^NRE$/i,
    /^Charge$/i,
    /^\d{2}\/\d{2}$/,  // Date patterns
    /@.*\.(com|net|org)/i,  // Emails
    /INCORPORATED/i,
    /ELECTRONICS/i,
    /UNITED/i,
    /CENTER/i,
    /DRIVE/i,
    /SUITE/i,
    /AVENUE/i,
    /STREET/i,
    /,\d{5},/,  // Address with zip
  ];

  // MPN pattern: alphanumeric with dashes/slashes, 4+ chars
  // Must start with letter or digit, contain at least one dash or slash or be mixed alphanumeric
  const MPN_PATTERN = /\b([A-Z0-9][A-Z0-9\-\/]{3,}[A-Z0-9])\b/gi;

  // Split text into tokens and find MPNs
  const tokens = text.split(/\s+/);
  const seenMpns = new Set();

  for (const token of tokens) {
    const cleaned = token.trim();
    if (!cleaned || cleaned.length < 4) continue;

    // Skip noise
    let isNoise = false;
    for (const pat of NOISE_PATTERNS) {
      if (pat.test(cleaned)) {
        isNoise = true;
        break;
      }
    }
    if (isNoise) continue;

    // Skip pure numbers (prices, dates, etc.)
    if (/^\d+(\.\d+)?$/.test(cleaned)) continue;

    // Skip pure alpha (words)
    if (/^[a-zA-Z]+$/.test(cleaned)) continue;

    // Check if it looks like an MPN
    // Must have: letter+digit OR digit+letter OR contain - or /
    const hasMixedAlphaNum = /[A-Za-z]/.test(cleaned) && /\d/.test(cleaned);
    const hasSpecialChar = /[\-\/]/.test(cleaned);

    if (hasMixedAlphaNum || hasSpecialChar) {
      // Clean up trailing/leading punctuation
      let mpn = cleaned.replace(/^[,.\s]+|[,.\s]+$/g, '');

      // Skip if too short after cleaning
      if (mpn.length < 4) continue;

      // Skip duplicates
      const mpnUpper = mpn.toUpperCase();
      if (seenMpns.has(mpnUpper)) continue;
      seenMpns.add(mpnUpper);

      items.push({
        mpn: mpn,
        qty: 1,  // Default qty - GE PO doesn't show qty in extractable format
        mfr: '',
        dateCode: '',
        description: '',
      });
    }
  }

  // Try to detect partner and site from text
  let detectedPartner = null;
  let detectedSite = null;

  if (/GE\s*Aviation/i.test(text)) detectedPartner = 'GE Aviation';
  else if (/Marvell/i.test(text)) detectedPartner = 'Marvell';
  else if (/Plexus/i.test(text)) detectedPartner = 'Plexus';
  else if (/Eaton/i.test(text)) detectedPartner = 'Eaton';

  if (/Grand\s*Rapids/i.test(text)) detectedSite = 'Grand Rapids';
  else if (/Long\s*Island/i.test(text)) detectedSite = 'Long Island';
  else if (/Jacksonville/i.test(text)) detectedSite = 'Jacksonville';
  else if (/Clearwater/i.test(text)) detectedSite = 'Clearwater';

  return { items, text, detectedPartner, detectedSite };
}

// ─── MAIN PROCESSOR ──────────────────────────────────────────────────────────

/**
 * Process an excess inspection file (xlsx or pdf).
 *
 * @param {string} filePath - Path to the input file
 * @param {object} opts - Processing options
 * @param {string} opts.poNumber - PO number (or auto-detect)
 * @param {string} opts.site - Site name (or lookup from file)
 * @param {string} opts.consignmentPartner - Partner name (or auto-detect)
 * @param {string} opts.outputPath - Output file path
 * @param {string} opts.emailSubject - Email subject (for PO detection)
 * @param {string} opts.emailBody - Email body (for PO detection)
 * @param {string} opts.filename - Original filename (for PO detection)
 * @returns {Promise<object>} Processing result
 */
async function processExcessFile(filePath, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  let parsed;
  let workbook = null;

  // Parse file based on type
  if (ext === '.xlsx' || ext === '.xls') {
    parsed = parseXlsx(filePath);
    workbook = parsed.workbook;
  } else if (ext === '.pdf') {
    parsed = await parsePdf(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext}. Expected .xlsx, .xls, or .pdf`);
  }

  const { items } = parsed;
  if (items.length === 0) {
    throw new Error('No line items found in file');
  }

  // Auto-detect PO if not provided
  let poNumber = opts.poNumber;
  if (!poNumber) {
    const detected = autoDetectPO({
      subject: opts.emailSubject,
      body: opts.emailBody,
      filename: opts.filename || path.basename(filePath),
      sheetData: ext.includes('xls') ? items : null,
    });
    poNumber = detected.po;
  }

  // Lookup site from Excess POs tab or PDF detection
  let site = opts.site;
  if (!site && workbook && poNumber) {
    site = lookupSiteFromExcessPOs(workbook, poNumber);
  }
  if (!site && parsed.detectedSite) {
    site = parsed.detectedSite;
  }

  // Detect consignment partner if not provided
  let consignmentPartner = opts.consignmentPartner;
  if (!consignmentPartner) {
    consignmentPartner = detectPartner(opts.emailSubject) ||
                         detectPartner(opts.emailBody) ||
                         detectPartner(path.basename(filePath));
  }
  if (!consignmentPartner && parsed.detectedPartner) {
    consignmentPartner = parsed.detectedPartner;
  }

  // Process each line item
  const outputRows = [];
  const productCodeCounts = {};
  let knownMfrCount = 0;
  let unknownMfrCount = 0;

  for (const item of items) {
    // Check if internal P/N first (skip expensive MFR lookup)
    const isInternal = isInternalPartNumber(item.mpn);

    // Resolve MFR code - skip DB lookup for internal P/Ns
    let mfrInfo;
    if (isInternal) {
      mfrInfo = { code: UNKNOWN_MFR_CODE, name: '' };
      unknownMfrCount++;
    } else {
      mfrInfo = resolveMfrCode(item.mpn, item.mfr);
      if (mfrInfo.code === UNKNOWN_MFR_CODE) {
        unknownMfrCount++;
      } else {
        knownMfrCount++;
      }
    }

    // Get description
    let description = item.description;
    if (!description) {
      // For internal P/Ns, use the item as description; skip DB lookup
      if (isInternal) {
        description = item.mpn;
      } else {
        description = getDescription(item.mpn);
      }
    }

    // Classify product code
    const productCode = classifyProductCode(description, item.mpn);
    productCodeCounts[productCode] = (productCodeCounts[productCode] || 0) + 1;

    outputRows.push({
      'Consignment Partner': consignmentPartner || '',
      'Site': site || '',
      'PO': poNumber || '',
      'Item': item.mpn,
      'Ordered': item.qty,
      'Description': description,
      'U/M': 'EA',
      'Product Code': productCode,
      'Name': mfrInfo.code,
      'MFR': mfrInfo.name,
      'OTIN': '', // Filled during receiving
      'Location': '', // Filled after inspection
    });
  }

  // Generate output xlsx
  const outputPath = opts.outputPath || path.join(
    process.env.HOME,
    'workspace',
    'excess-inspection-output',
    `excess-inspection-buildout-${poNumber || 'UNKNOWN'}.xlsx`
  );

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create workbook with formatted output
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(outputRows);

  // Set column widths
  ws['!cols'] = [
    { wch: 18 }, // Consignment Partner
    { wch: 12 }, // Site
    { wch: 14 }, // PO
    { wch: 25 }, // Item
    { wch: 10 }, // Ordered
    { wch: 30 }, // Description
    { wch: 5 },  // U/M
    { wch: 12 }, // Product Code
    { wch: 10 }, // Name
    { wch: 20 }, // MFR
    { wch: 12 }, // OTIN
    { wch: 12 }, // Location
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Inspection Log');
  XLSX.writeFile(wb, outputPath);

  return {
    poNumber,
    site,
    consignmentPartner,
    outputPath,
    lineCount: outputRows.length,
    productCodeBreakdown: productCodeCounts,
    knownMfrCount,
    unknownMfrCount,
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  processExcessFile,
  autoDetectPO,
  detectPOFromText,
  lookupSiteFromExcessPOs,
  resolveMfrCode,
  classifyProductCode,
  getDescription,
  isInternalPartNumber,
  parseXlsx,
  parsePdf,
};

// ─── CLI MODE ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  }

  const filePath = getArg('file');
  const poNumber = getArg('po');
  const site = getArg('site');
  const partner = getArg('partner');

  if (!filePath) {
    console.log(`Usage: node excess-processor.js --file <path> [--po <POV>] [--site <site>] [--partner <name>]

Process an excess inspection file (xlsx, xls, or pdf) and generate inspection log output.

Options:
  --file <path>      Path to the input file (required)
  --po <POV>         PO number (auto-detected if not provided)
  --site <site>      Site name (looked up from file if not provided)
  --partner <name>   Consignment partner name (auto-detected if not provided)

Output: ~/workspace/excess-inspection-output/excess-inspection-buildout-<POV>-<timestamp>.xlsx

Examples:
  node excess-processor.js --file ~/Downloads/POV0069002.xlsx
  node excess-processor.js --file ~/Downloads/GE_Excess.pdf --po POV0069002 --site "Long Island"
`);
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Processing: ${filePath}`);
  if (poNumber) console.log(`  PO: ${poNumber}`);
  if (site) console.log(`  Site: ${site}`);
  if (partner) console.log(`  Partner: ${partner}`);

  processExcessFile(filePath, {
    poNumber,
    site,
    consignmentPartner: partner,
  }).then(result => {
    console.log(`\nProcessing complete:`);
    console.log(`  PO: ${result.poNumber}`);
    console.log(`  Site: ${result.site || '(not detected)'}`);
    console.log(`  Partner: ${result.consignmentPartner || '(not detected)'}`);
    console.log(`  Lines: ${result.lineCount}`);
    console.log(`  MFR Coverage: ${result.knownMfrCount} known, ${result.unknownMfrCount} unknown`);
    console.log(`\nProduct Code Breakdown:`);
    for (const [code, count] of Object.entries(result.productCodeBreakdown || {})) {
      console.log(`  ${code}: ${count}`);
    }
    console.log(`\nOutput: ${result.outputPath}`);
  }).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
