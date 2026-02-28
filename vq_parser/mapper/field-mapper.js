const { VQ_COLUMNS, BUYER_EMAIL_MAP } = require('../../config/columns');
const { resolveRFQ } = require('./rfq-resolver');
const { resolveVendor, lookupVendorByEmail } = require('./vendor-lookup');
const { normalizeMfr } = require('./mfr-lookup');
const { cleanString, stripCurrency, normalizePartNumber, extractNumber, normalizeRoHS } = require('../utils/sanitize');
const logger = require('../utils/logger');

// Invalid MPN words - these are table headers/labels, not part numbers
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
  'manufacture', 'brand', 'vendor', 'supplier', 'dc', 'd/c', 'negligence',
  'employees', 'parties', 'shall', 'reserve', 'right', 'prove', 'remove'
]);

/**
 * Validate if a string looks like a valid MPN
 */
function isValidMPN(mpn) {
  if (!mpn || typeof mpn !== 'string') return false;

  const cleaned = mpn.trim().toUpperCase();

  // Too short or too long
  if (cleaned.length < 4 || cleaned.length > 40) return false;

  // Must contain at least one letter AND one number
  const hasLetters = /[A-Z]/.test(cleaned);
  const hasNumbers = /[0-9]/.test(cleaned);
  if (!hasLetters || !hasNumbers) return false;

  // Check against invalid words - split and check each part
  const lowerMPN = mpn.toLowerCase().trim();
  const parts = lowerMPN.split(/[\s\/\-_,]+/);

  // If ALL parts are invalid words, reject
  const validParts = parts.filter(p => p.length >= 2 && !INVALID_MPN_WORDS.has(p));
  if (validParts.length === 0) return false;

  // If it's a single invalid word
  if (INVALID_MPN_WORDS.has(lowerMPN)) return false;

  // Reject URLs
  if (/^(www\.|http|ftp)/i.test(cleaned)) return false;

  // Reject if mostly punctuation/spaces
  const alphanumCount = (cleaned.match(/[A-Z0-9]/g) || []).length;
  if (alphanumCount < cleaned.length * 0.5) return false;

  return true;
}

/**
 * Extract MPN from email subject line
 */
function extractMPNFromSubject(subject) {
  if (!subject) return null;

  // Common patterns in subject lines
  const patterns = [
    /\|\s*([A-Z0-9][A-Z0-9\-\/\.]{4,})\s*\)?$/i,           // "... | TPS73801DCQR)"
    /for\s+([A-Z0-9][A-Z0-9\-\/\.]{4,})/i,                  // "Your RFQ for TG110-S050N2RLTR"
    /Item\s+([A-Z0-9][A-Z0-9\-\/\.]{4,})/i,                 // "Item IXDD609SI"
    /quotation[^A-Z0-9]*([A-Z0-9][A-Z0-9\-\/\.]{4,})/i,     // "quotation BAS16,235"
    /Quote[^A-Z0-9]*\d+[^A-Z0-9]*([A-Z0-9][A-Z0-9\-\/\.]{4,})/i, // "Quote #123 for MPN"
  ];

  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match && match[1]) {
      const mpn = match[1].trim();
      if (isValidMPN(mpn)) {
        return mpn;
      }
    }
  }

  return null;
}

/**
 * Resolve buyer from envelope or email body
 */
function resolveBuyer(envelope, emailBody) {
  if (envelope.from) {
    const fromAddr = typeof envelope.from === 'string' ? envelope.from : envelope.from.addr || '';
    for (const [email, name] of Object.entries(BUYER_EMAIL_MAP)) {
      if (fromAddr.toLowerCase().includes(email.toLowerCase())) {
        return name;
      }
    }
  }

  if (envelope.to) {
    const toAddr = typeof envelope.to === 'string' ? envelope.to : envelope.to.addr || '';
    for (const [email, name] of Object.entries(BUYER_EMAIL_MAP)) {
      if (toAddr.toLowerCase().includes(email.toLowerCase())) {
        return name;
      }
    }
  }

  if (emailBody) {
    for (const [email, name] of Object.entries(BUYER_EMAIL_MAP)) {
      if (emailBody.toLowerCase().includes(email.toLowerCase())) {
        return name;
      }
    }
  }

  return '';
}

/**
 * Extract vendor email/name from forwarded email body
 * Looks for "From:" lines that aren't from known buyers
 */
function extractVendorFromBody(emailBody) {
  const fromPatterns = [
    /From:\s*([^<\n]+?)\s*<([^>]+)>/gm,
    /From:\s*"?([^"<\n]+)"?\s*<([^>]+)>/gm,
  ];

  const fromMatches = [];

  for (const pattern of fromPatterns) {
    let match;
    while ((match = pattern.exec(emailBody)) !== null) {
      fromMatches.push({
        name: match[1] ? match[1].trim().replace(/^["']|["']$/g, '') : '',
        addr: match[2].trim()
      });
    }
  }

  // Return the last non-buyer "From:" (original sender in forwarded chain)
  for (let i = fromMatches.length - 1; i >= 0; i--) {
    const fm = fromMatches[i];
    const isBuyer = Object.keys(BUYER_EMAIL_MAP).some(e =>
      fm.addr.toLowerCase().includes(e.toLowerCase())
    );
    if (!isBuyer && fm.addr && !fm.addr.includes('netcomponents.com')) {
      return fm;
    }
  }

  return null;
}

// Internal friendly names used by parsers → DB column names
const FIELD_TO_DB = {
  'MPN': 'chuboe_mpn',
  'MFR Text': 'chuboe_mfr_text',
  'Quoted Quantity': 'qty',
  'Cost': 'cost',
  'Currency': 'c_currency_id',
  'Date Code': 'chuboe_date_code',
  'MOQ': 'chuboe_moq',
  'SPQ': 'chuboe_spq',
  'Packaging': 'chuboe_packaging_id',
  'Lead Time': 'chuboe_lead_time',
  'COO': 'c_country_id',
  'RoHS': 'chuboe_rohs',
  'Vendor Notes': 'chuboe_note_public',
  'Contact': 'ad_user_id',
};

/**
 * Map parsed quote data to VQ upload format
 * Now async to support LLM vendor inference
 */
async function mapFields(parsedData, envelope, emailBody = '') {
  const { lines, flags, noBid } = parsedData;
  const subject = envelope.subject || '';
  const buyer = resolveBuyer(envelope, emailBody);

  // Extract MPN from subject line as fallback
  const subjectMPN = extractMPNFromSubject(subject);

  // First, validate/fix MPNs - get the best MPN for RFQ lookup
  let firstMPN = '';
  if (lines.length > 0) {
    const rawMPN = lines[0]['MPN'] || lines[0]['chuboe_mpn'] || '';
    if (rawMPN && isValidMPN(rawMPN)) {
      firstMPN = normalizePartNumber(rawMPN);
    } else if (subjectMPN) {
      firstMPN = normalizePartNumber(subjectMPN);
      logger.debug(`Using subject MPN for RFQ lookup: "${subjectMPN}" instead of "${rawMPN}"`);
    }
  } else if (subjectMPN) {
    firstMPN = normalizePartNumber(subjectMPN);
  }

  // Resolve RFQ by looking up the MPN in the database
  const rfqResult = resolveRFQ(firstMPN, subject, emailBody);
  const rfq = rfqResult.rfq;
  const mpnMismatch = rfqResult.mismatch;
  const rfqMPN = rfqResult.rfqMPN;

  // Extract vendor info from forwarded email body
  const vendorFromBody = extractVendorFromBody(emailBody);
  const vendorEmail = vendorFromBody ? vendorFromBody.addr : '';
  const vendorName = vendorFromBody ? vendorFromBody.name : '';

  // Resolve vendor using multi-strategy approach (DB lookup + LLM inference)
  const vendorResult = await resolveVendor(emailBody, vendorEmail, vendorName);

  // Extract vendor fields
  const bpId = vendorResult.c_bpartner_id || '';
  const resolvedVendorName = vendorResult.name || vendorName || '';
  const contactName = vendorResult.contact_name || '';
  const contactEmail = vendorResult.contact_email || vendorEmail || '';
  const needsAssignment = vendorResult.needs_assignment || false;

  // Build vendor note if not matched to DB
  let vendorNote = '';
  if (needsAssignment && resolvedVendorName) {
    vendorNote = `[VENDOR NOT IN DB: ${resolvedVendorName}${contactEmail ? ' <' + contactEmail + '>' : ''}] `;
  }

  if (noBid) {
    const flagText = flags.join('. ');
    return [{
      'chuboe_rfq_id': rfq,
      'chuboe_buyer_id': buyer,
      'c_bpartner_id': bpId,
      'ad_user_id': contactName,
      'chuboe_mpn': '',
      'chuboe_mfr_text': '',
      'qty': '0',
      'cost': '0',
      'c_currency_id': '',
      'chuboe_date_code': '',
      'chuboe_moq': '',
      'chuboe_spq': '',
      'chuboe_packaging_id': '',
      'chuboe_lead_time': '',
      'c_country_id': '',
      'chuboe_rohs': '',
      'chuboe_note_public': vendorNote + (flagText || 'NO-BID')
    }];
  }

  // Filter out lines with invalid MPNs, but try to salvage with subject MPN
  const validLines = [];
  let filteredCount = 0;

  for (const line of lines) {
    let mpn = line['MPN'] || line['chuboe_mpn'] || '';

    if (!mpn || !isValidMPN(mpn)) {
      // Try subject MPN as fallback
      if (subjectMPN && isValidMPN(subjectMPN)) {
        logger.debug(`Using subject MPN "${subjectMPN}" instead of invalid "${mpn}"`);
        line['MPN'] = subjectMPN;
        line['chuboe_mpn'] = subjectMPN;
        validLines.push(line);
      } else {
        logger.debug(`Filtering invalid MPN: "${mpn}"`);
        filteredCount++;
      }
    } else {
      validLines.push(line);
    }
  }

  if (filteredCount > 0) {
    logger.info(`Filtered ${filteredCount} lines with invalid MPNs`);
  }

  const rows = validLines.map(line => {
    const flagNotes = flags.length > 0 ? flags.join('. ') + '. ' : '';
    const existingNotes = line['Vendor Notes'] || line['chuboe_note_public'] || '';

    // Get the quoted MPN from this line
    const quotedMPN = normalizePartNumber(line['MPN'] || line['chuboe_mpn'] || '');

    // If there's an MPN mismatch (quoted differs from RFQ), add note
    let mismatchNote = '';
    if (mpnMismatch && quotedMPN && rfqMPN) {
      mismatchNote = `Quoted MPN: ${quotedMPN} (RFQ MPN: ${rfqMPN}). `;
      logger.debug(`MPN mismatch noted: Quoted=${quotedMPN}, RFQ=${rfqMPN}`);
    }

    const cost = stripCurrency(line['Cost'] || line['cost'] || '');
    const qty = extractNumber(line['Quoted Quantity'] || line['qty'] || '');

    // Flag partial data - missing price or qty requires manual review
    let partialDataNote = '';
    const missingFields = [];
    if (!cost) missingFields.push('price');
    if (!qty) missingFields.push('qty');
    if (missingFields.length > 0) {
      partialDataNote = `[PARTIAL - needs: ${missingFields.join(', ')}] `;
      logger.debug(`Partial data flagged: missing ${missingFields.join(', ')}`);
    }

    const allNotes = (vendorNote + partialDataNote + mismatchNote + flagNotes + existingNotes).trim();

    return {
      'chuboe_rfq_id': rfq,
      'chuboe_buyer_id': buyer,
      'c_bpartner_id': bpId,
      'ad_user_id': cleanString(line['Contact'] || line['ad_user_id'] || contactName || ''),
      'chuboe_mpn': quotedMPN,
      'chuboe_mfr_text': normalizeMfr(line['MFR Text'] || line['chuboe_mfr_text'] || ''),
      'qty': qty,
      'cost': cost,
      'c_currency_id': cleanString(line['Currency'] || line['c_currency_id'] || (cost ? 'USD' : '')),
      'chuboe_date_code': cleanString(line['Date Code'] || line['chuboe_date_code'] || ''),
      'chuboe_moq': extractNumber(line['MOQ'] || line['chuboe_moq'] || ''),
      'chuboe_spq': extractNumber(line['SPQ'] || line['chuboe_spq'] || ''),
      'chuboe_packaging_id': cleanString(line['Packaging'] || line['chuboe_packaging_id'] || ''),
      'chuboe_lead_time': cleanString(line['Lead Time'] || line['chuboe_lead_time'] || ''),
      'c_country_id': cleanString(line['COO'] || line['c_country_id'] || ''),
      'chuboe_rohs': normalizeRoHS(line['RoHS'] || line['chuboe_rohs'] || ''),
      'chuboe_note_public': allNotes
    };
  });

  return rows;
}

module.exports = { mapFields, resolveBuyer, extractVendorFromBody, isValidMPN, extractMPNFromSubject };
