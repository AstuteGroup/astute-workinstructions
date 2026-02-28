const { execSync } = require('child_process');
const logger = require('../utils/logger');

/**
 * Query the database for an RFQ containing the given MPN
 * @param {string} cleanMPN - Cleaned/normalized MPN to search for
 * @returns {string|null} - RFQ number or null if not found
 */
function queryRFQByMPN(cleanMPN) {
  if (!cleanMPN || cleanMPN.length < 3) return null;

  try {
    const query = `
      SELECT r.value as rfq_number
      FROM adempiere.chuboe_rfq_line_mpn m
      JOIN adempiere.chuboe_rfq r ON m.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE m.chuboe_mpn_clean ILIKE '%${cleanMPN}%'
        AND m.isactive = 'Y'
        AND r.isactive = 'Y'
      ORDER BY m.created DESC
      LIMIT 1;
    `;

    const result = execSync(`psql -t -A -c "${query}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim();

    return result && result !== '' ? result : null;
  } catch (err) {
    logger.debug(`DB query failed for MPN ${cleanMPN}: ${err.message}`);
    return null;
  }
}

/**
 * Get the RFQ MPN that matched (to compare with quoted MPN)
 * @param {string} cleanMPN - Cleaned MPN that was searched
 * @returns {string|null} - The actual MPN from the RFQ line
 */
function getRFQMPN(cleanMPN) {
  if (!cleanMPN || cleanMPN.length < 3) return null;

  try {
    const query = `
      SELECT m.chuboe_mpn
      FROM adempiere.chuboe_rfq_line_mpn m
      JOIN adempiere.chuboe_rfq r ON m.chuboe_rfq_id = r.chuboe_rfq_id
      WHERE m.chuboe_mpn_clean ILIKE '%${cleanMPN}%'
        AND m.isactive = 'Y'
        AND r.isactive = 'Y'
      ORDER BY m.created DESC
      LIMIT 1;
    `;

    const result = execSync(`psql -t -A -c "${query}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim();

    return result && result !== '' ? result : null;
  } catch (err) {
    return null;
  }
}

/**
 * Clean MPN for database search
 */
function cleanMPNForSearch(mpn) {
  if (!mpn) return '';
  return mpn.toUpperCase().replace(/[\s\-\.\/]/g, '');
}

/**
 * Extract the original requested MPN from NetComponents email format
 * NetComponents responses include the original RFQ part at the bottom
 *
 * @param {string} emailBody - The email body text
 * @returns {string|null} - Extracted original MPN or null
 */
function extractOriginalMPNFromEmail(emailBody) {
  if (!emailBody) return null;

  // NetComponents format patterns:
  // "RFQ from netCOMPONENTS Member (Astute Electronics | TG110-S050N2RLTR)"
  // "Your RFQ for TG110-S050N2RLTR"
  // "Anfrage von einem netCOMPONENTS Mitglied (Astute Electronics | MSP430F149IPM)"
  const patterns = [
    /netCOMPONENTS.*?\(.*?\|\s*([A-Z0-9][A-Z0-9\-\/\.]{3,})\s*\)/gi,
    /Your RFQ for\s+([A-Z0-9][A-Z0-9\-\/\.]{3,})/gi,
    /RFQ.*?for\s+([A-Z0-9][A-Z0-9\-\/\.]{3,})/gi,
    /regarding\s+([A-Z0-9][A-Z0-9\-\/\.]{3,})/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...emailBody.matchAll(pattern)];
    if (matches.length > 0) {
      // Take the last match (original RFQ is usually at the bottom)
      const mpn = matches[matches.length - 1][1].trim();
      logger.debug(`Found original RFQ MPN in email: ${mpn}`);
      return mpn;
    }
  }

  return null;
}

/**
 * Try fuzzy matching by progressively trimming the MPN
 * Removes characters from the end to find partial matches
 *
 * @param {string} mpn - The MPN to search for
 * @param {number} minLength - Minimum MPN length to try (default 5)
 * @returns {{rfq: string, matchedMPN: string}|null}
 */
function fuzzyMPNLookup(mpn, minLength = 5) {
  const cleanMPN = cleanMPNForSearch(mpn);
  if (cleanMPN.length < minLength) return null;

  // Try progressively shorter versions
  for (let len = cleanMPN.length; len >= minLength; len--) {
    const partial = cleanMPN.substring(0, len);
    const rfq = queryRFQByMPN(partial);

    if (rfq) {
      const matchedMPN = getRFQMPN(partial);
      logger.info(`Fuzzy match found: "${mpn}" matched RFQ ${rfq} (DB MPN: ${matchedMPN}) using ${len} chars`);
      return { rfq, matchedMPN };
    }
  }

  return null;
}

/**
 * Resolve RFQ for a quote - uses multiple strategies
 *
 * Strategy order:
 * 1. Exact MPN match from quoted part
 * 2. Extract original MPN from email body (NetComponents format)
 * 3. Fuzzy MPN match (progressively trim characters)
 * 4. Extract MPN from subject line
 *
 * @param {string} quotedMPN - The MPN from the supplier quote
 * @param {string} subject - Email subject
 * @param {string} emailBody - Email body text
 * @returns {{rfq: string, rfqMPN: string|null, mismatch: boolean}}
 */
function resolveRFQ(quotedMPN, subject = '', emailBody = '') {
  const cleanQuotedMPN = cleanMPNForSearch(quotedMPN);

  // Strategy 1: Exact match on quoted MPN
  if (cleanQuotedMPN.length >= 3) {
    const rfq = queryRFQByMPN(cleanQuotedMPN);
    if (rfq) {
      logger.info(`RFQ found by exact MPN match: ${rfq} (MPN: ${quotedMPN})`);
      return { rfq, rfqMPN: quotedMPN, mismatch: false };
    }
  }

  // Strategy 2: Extract original MPN from email body (NetComponents format)
  const originalMPN = extractOriginalMPNFromEmail(emailBody);
  if (originalMPN) {
    const cleanOriginalMPN = cleanMPNForSearch(originalMPN);
    const rfq = queryRFQByMPN(cleanOriginalMPN);
    if (rfq) {
      const mismatch = cleanOriginalMPN !== cleanQuotedMPN;
      logger.info(`RFQ found by original email MPN: ${rfq} (Original: ${originalMPN}, Quoted: ${quotedMPN}, Mismatch: ${mismatch})`);
      return { rfq, rfqMPN: originalMPN, mismatch };
    }
  }

  // Strategy 3: Fuzzy match on quoted MPN
  if (cleanQuotedMPN.length >= 5) {
    const fuzzyResult = fuzzyMPNLookup(quotedMPN);
    if (fuzzyResult) {
      const mismatch = cleanMPNForSearch(fuzzyResult.matchedMPN) !== cleanQuotedMPN;
      return { rfq: fuzzyResult.rfq, rfqMPN: fuzzyResult.matchedMPN, mismatch };
    }
  }

  // Strategy 4: Try MPN from subject line
  const subjectMPNMatch = subject.match(/(?:for|regarding|re:|ref:?)\s+([A-Z0-9][A-Z0-9\-\/\.]{4,})/i);
  if (subjectMPNMatch) {
    const subjectMPN = subjectMPNMatch[1];
    const cleanSubjectMPN = cleanMPNForSearch(subjectMPN);

    // Try exact match
    const rfq = queryRFQByMPN(cleanSubjectMPN);
    if (rfq) {
      const mismatch = cleanSubjectMPN !== cleanQuotedMPN;
      logger.info(`RFQ found by subject MPN: ${rfq} (Subject: ${subjectMPN})`);
      return { rfq, rfqMPN: subjectMPN, mismatch };
    }

    // Try fuzzy match on subject MPN
    const fuzzyResult = fuzzyMPNLookup(subjectMPN);
    if (fuzzyResult) {
      return { rfq: fuzzyResult.rfq, rfqMPN: fuzzyResult.matchedMPN, mismatch: true };
    }
  }

  logger.warn(`Could not resolve RFQ for MPN: ${quotedMPN || 'none'}`);
  return { rfq: 'UNKNOWN', rfqMPN: null, mismatch: false };
}

module.exports = { resolveRFQ, extractOriginalMPNFromEmail, fuzzyMPNLookup, cleanMPNForSearch };
