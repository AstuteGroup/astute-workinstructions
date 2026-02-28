const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const logger = require('../utils/logger');

const CACHE_FILE = path.join(__dirname, '../../data/vendor-cache.json');

// Initialize Anthropic client (will use ANTHROPIC_API_KEY env var)
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic();
  }
} catch (err) {
  logger.warn('Anthropic SDK not initialized:', err.message);
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Failed to load vendor cache:', err.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save vendor cache:', err.message);
  }
}

/**
 * Look up vendor by exact email match in ad_user table
 * Filters: active user, active BP, excludes "USE XXXXX" BPs (follows reference instead)
 */
function lookupVendorByEmailDB(email) {
  if (!email) return null;

  const cleanEmail = email.toLowerCase().trim();

  try {
    // First, try exact email match
    const sql = `
      SELECT bp.c_bpartner_id, bp.name, bp.value as search_key
      FROM adempiere.ad_user u
      JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
      WHERE LOWER(u.email) = '${cleanEmail.replace(/'/g, "''")}'
        AND u.isactive = 'Y'
        AND bp.isactive = 'Y'
      ORDER BY bp.created DESC
      LIMIT 5
    `;

    const result = execSync(`psql -t -A -F '|' -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim();

    if (!result) return null;

    const lines = result.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const [bpId, bpName, searchKey] = line.split('|');

      // Check for "USE XXXXX" pattern - follow the reference
      const useMatch = bpName.match(/^USE\s+(\d+)/i);
      if (useMatch) {
        const referencedId = useMatch[1];
        logger.debug(`BP "${bpName}" redirects to ${referencedId}`);
        const redirected = lookupVendorById(referencedId);
        if (redirected) return redirected;
        continue; // Try next result if redirect fails
      }

      return {
        c_bpartner_id: bpId.trim(),
        name: bpName.trim(),
        search_key: searchKey ? searchKey.trim() : bpId.trim()
      };
    }
  } catch (err) {
    logger.debug(`Email DB lookup failed for ${email}: ${err.message}`);
  }

  return null;
}

/**
 * Look up vendor by ID (used for "USE XXXXX" redirects)
 */
function lookupVendorById(bpId) {
  try {
    const sql = `
      SELECT c_bpartner_id, name, value as search_key
      FROM adempiere.c_bpartner
      WHERE c_bpartner_id = ${parseInt(bpId, 10)}
        AND isactive = 'Y'
      LIMIT 1
    `;

    const result = execSync(`psql -t -A -F '|' -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim();

    if (result) {
      const [id, name, searchKey] = result.split('|');
      return {
        c_bpartner_id: id.trim(),
        name: name.trim(),
        search_key: searchKey ? searchKey.trim() : id.trim()
      };
    }
  } catch (err) {
    logger.debug(`BP ID lookup failed for ${bpId}: ${err.message}`);
  }
  return null;
}

/**
 * Look up vendor by name (fuzzy match)
 */
function lookupVendorByNameDB(vendorName) {
  if (!vendorName || vendorName.length < 3) return null;

  try {
    // Clean the name for searching
    const cleanName = vendorName.replace(/'/g, "''").trim();

    const sql = `
      SELECT c_bpartner_id, name, value as search_key
      FROM adempiere.c_bpartner
      WHERE name ILIKE '%${cleanName}%'
        AND isactive = 'Y'
        AND name NOT ILIKE 'USE %'
        AND isvendor = 'Y'
      ORDER BY
        CASE WHEN LOWER(name) = LOWER('${cleanName}') THEN 0 ELSE 1 END,
        created DESC
      LIMIT 5
    `;

    const result = execSync(`psql -t -A -F '|' -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim();

    if (result) {
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const [id, name, searchKey] = lines[0].split('|');
        return {
          c_bpartner_id: id.trim(),
          name: name.trim(),
          search_key: searchKey ? searchKey.trim() : id.trim()
        };
      }
    }
  } catch (err) {
    logger.debug(`Name lookup failed for "${vendorName}": ${err.message}`);
  }
  return null;
}

/**
 * Use LLM to extract vendor information from email body
 * Looks at: signature, letterhead, From: lines, company references
 */
async function extractVendorWithLLM(emailBody, senderEmail = '', senderName = '') {
  if (!anthropic) {
    logger.debug('LLM extraction skipped - no API key configured');
    return null;
  }

  // Truncate email body to avoid token limits
  const truncatedBody = emailBody.substring(0, 8000);

  const prompt = `Analyze this supplier quote email and extract the VENDOR (supplier) information.

The email may be forwarded, so look for the ORIGINAL sender (not the forwarder).

Look for vendor information in:
1. The "From:" line of the original/forwarded email
2. Email signature blocks (company name, person name, title)
3. Quote letterhead or header
4. Company references in the quote itself

Known sender email: ${senderEmail || 'unknown'}
Known sender name: ${senderName || 'unknown'}

EMAIL BODY:
${truncatedBody}

Extract and respond with ONLY a JSON object (no markdown, no explanation):
{
  "vendor_company": "Company Name or null if not found",
  "contact_name": "Person's Name or null if not found",
  "contact_email": "email@domain.com or null if not found",
  "confidence": "high/medium/low"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const extracted = JSON.parse(jsonMatch[0]);
      logger.info(`LLM extracted vendor: ${extracted.vendor_company} (${extracted.confidence})`);
      return extracted;
    }
  } catch (err) {
    logger.error('LLM vendor extraction failed:', err.message);
  }

  return null;
}

/**
 * Main vendor lookup function - tries multiple strategies
 *
 * Strategy order:
 * 1. Exact email match in ad_user.email (with active filters, USE redirect handling)
 * 2. LLM inference from email body → then name match in c_bpartner
 * 3. Return extracted info even if no DB match (for manual assignment)
 */
async function resolveVendor(emailBody, senderEmail = '', senderName = '') {
  const cache = loadCache();
  const cacheKey = `v2:${senderEmail.toLowerCase().trim()}`;

  // Check cache first
  if (cacheKey in cache && cache[cacheKey]) {
    const cached = cache[cacheKey];
    if (cached.c_bpartner_id) {
      logger.debug(`Vendor from cache: ${cached.name} (${cached.c_bpartner_id})`);
      return cached;
    }
  }

  // Strategy 1: Exact email lookup
  const emailResult = lookupVendorByEmailDB(senderEmail);
  if (emailResult) {
    logger.info(`Vendor resolved by email: ${emailResult.name} (${emailResult.c_bpartner_id})`);
    cache[cacheKey] = emailResult;
    saveCache(cache);
    return emailResult;
  }

  // Strategy 2: LLM inference
  const llmResult = await extractVendorWithLLM(emailBody, senderEmail, senderName);

  if (llmResult && llmResult.vendor_company) {
    // Try to match extracted company name to database
    const nameResult = lookupVendorByNameDB(llmResult.vendor_company);

    if (nameResult) {
      logger.info(`Vendor resolved by LLM + name match: ${nameResult.name} (${nameResult.c_bpartner_id})`);
      cache[cacheKey] = nameResult;
      saveCache(cache);
      return nameResult;
    }

    // No DB match - return extracted info for manual assignment
    const extracted = {
      c_bpartner_id: '',
      name: llmResult.vendor_company,
      contact_name: llmResult.contact_name,
      contact_email: llmResult.contact_email || senderEmail,
      search_key: '',
      needs_assignment: true
    };

    logger.warn(`Vendor extracted but not in DB: ${llmResult.vendor_company}`);
    cache[cacheKey] = extracted;
    saveCache(cache);
    return extracted;
  }

  // No vendor found
  logger.warn(`Could not resolve vendor for email: ${senderEmail}`);
  return {
    c_bpartner_id: '',
    name: senderName || '',
    contact_email: senderEmail,
    search_key: '',
    needs_assignment: true
  };
}

/**
 * Legacy function for backward compatibility
 * Synchronous wrapper - won't use LLM
 */
function lookupVendor(vendorName) {
  if (!vendorName) return '';

  const result = lookupVendorByNameDB(vendorName);
  if (result) {
    return result.c_bpartner_id;
  }
  return '';
}

/**
 * Legacy function for backward compatibility
 * Synchronous - only does email DB lookup, no LLM
 */
function lookupVendorByEmail(email) {
  if (!email) return '';

  const result = lookupVendorByEmailDB(email);
  if (result) {
    return result.c_bpartner_id;
  }
  return '';
}

module.exports = {
  resolveVendor,
  lookupVendor,
  lookupVendorByEmail,
  lookupVendorByEmailDB,
  lookupVendorByNameDB,
  extractVendorWithLLM
};
