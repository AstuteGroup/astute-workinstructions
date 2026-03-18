/**
 * Shared Partner Lookup Module
 *
 * Canonical 3-tier matching logic for resolving business partners (vendors OR customers)
 * from email addresses and company names against the iDempiere database.
 *
 * Used by:
 *   - VQ Loading (vendor matching)
 *   - Market Offer Uploading (partner matching)
 *   - Stock RFQ Loading (customer matching)
 *
 * IMPORTANT: Changes here apply to ALL workflows above.
 * See shared/partner-matching.md for documentation.
 */

const { execSync } = require('child_process');

// Generic domains where the domain itself gives no company info
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'mail.com', 'email.com', 'noreply.com', 'protonmail.com', 'icloud.com',
  'live.com', 'msn.com', 'ymail.com',
  // Chinese generic domains
  '163.com', 'vip.163.com', '126.com', 'qq.com', 'sina.com', 'sohu.com',
  'foxmail.com', 'aliyun.com',
]);

// Common company name suffixes to strip when extracting domain hints
// Applied repeatedly to peel off layered suffixes (e.g., 'electronicsco' → 'electronics' → '')
const DOMAIN_SUFFIXES = ['electronics', 'electronic', 'elec', 'intl', 'international', 'group',
  'corp', 'inc', 'ltd', 'technology', 'tech', 'usa', 'uk', 'eu', 'semi', 'semiconductor',
  'global', 'trading', 'co', 'hk', 'cn'];

/**
 * Execute a psql query and return raw result string.
 * Returns empty string on error.
 */
function psqlQuery(sql, timeout = 10000) {
  try {
    return execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout
    }).trim();
  } catch (err) {
    return '';
  }
}

/**
 * Parse psql pipe-delimited result into array of objects.
 */
function parseResults(result, fields) {
  if (!result) return [];
  return result.split('\n')
    .filter(l => l.trim())
    .map(line => {
      const parts = line.split('|');
      const obj = {};
      fields.forEach((f, i) => { obj[f] = (parts[i] || '').trim(); });
      return obj;
    });
}

/**
 * Build the WHERE clause for partner type filtering.
 *
 * @param {string} partnerType - 'vendor', 'customer', or 'any'
 * @returns {string} SQL fragment
 */
function partnerTypeFilter(partnerType) {
  switch (partnerType) {
    case 'vendor': return "AND bp.isvendor = 'Y'";
    case 'customer': return "AND bp.iscustomer = 'Y'";
    default: return ''; // 'any' — no filter
  }
}

// ─── TIER 1: Exact Email Match ──────────────────────────────────────────────

/**
 * Look up partner by exact email match in ad_user table.
 * Handles "USE XXXXX" redirect patterns.
 *
 * @param {string} email - Sender email address
 * @param {string} partnerType - 'vendor', 'customer', or 'any'
 * @returns {object|null} { search_key, name, c_bpartner_id } or null
 */
function lookupByEmail(email, partnerType = 'any') {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim().replace(/'/g, "''");

  const sql = `
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(u.email) = '${cleanEmail}'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      ${partnerTypeFilter(partnerType)}
    ORDER BY bp.created DESC
    LIMIT 5
  `;

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key']);

  for (const r of results) {
    // Handle "USE XXXXX" redirects
    const useMatch = r.name.match(/^USE\s+(\d+)/i);
    if (useMatch) {
      const redirected = lookupById(useMatch[1]);
      if (redirected) return redirected;
      continue;
    }
    return r;
  }
  return null;
}

/**
 * Look up partner by c_bpartner_id (used for "USE XXXXX" redirects).
 */
function lookupById(bpId) {
  const sql = `
    SELECT c_bpartner_id, name, value as search_key
    FROM adempiere.c_bpartner
    WHERE c_bpartner_id = ${parseInt(bpId, 10)}
      AND isactive = 'Y'
    LIMIT 1
  `;
  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key']);
  return results[0] || null;
}

// ─── TIER 2: Domain Hint Matching ───────────────────────────────────────────

/**
 * Extract company name hints from an email domain.
 * e.g., bliss@hongdaelectronicsco.com.cn → ['hongdaelectronicsco', 'hongda']
 *
 * Skips generic domains (gmail, 163.com, etc.)
 */
function extractDomainHints(email) {
  if (!email) return [];

  const domainMatch = email.match(/@([^@]+)$/);
  if (!domainMatch) return [];

  const fullDomain = domainMatch[1].toLowerCase();

  // Skip generic domains
  if (GENERIC_DOMAINS.has(fullDomain)) return [];
  // Also check if the base+tld is generic (e.g., vip.163.com)
  const parts = fullDomain.split('.');
  if (parts.length > 2) {
    const baseTld = parts.slice(-2).join('.');
    if (GENERIC_DOMAINS.has(baseTld)) return [];
  }

  // Extract the company-identifying part (first segment before TLD)
  // For hongdaelectronicsco.com.cn → hongdaelectronicsco
  // For sales-victorytech.us → sales-victorytech
  const companyPart = parts[0].replace(/^(sales|info|rfq|purchasing|procurement|quotes?|orders?|support|admin|contact)-?/i, '');

  const hints = [];
  const addHint = (h, derived) => {
    if (h && h.length >= 4 && !hints.some(x => x.value === h)) {
      hints.push({ value: h, derived: !!derived });
    }
  };

  // Full domain segment (before stripping) — primary hint
  addHint(parts[0], false);

  // Cleaned version (after removing sales- etc. prefix) — primary hint
  if (companyPart !== parts[0]) addHint(companyPart, false);

  // Iteratively strip common company suffixes to peel off layers
  // e.g., 'hongdaelectronicsco' → 'hongdaelectronics' → 'hongda'
  // These are "derived" hints — used with starts-with matching only
  let current = (companyPart || parts[0]).toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of DOMAIN_SUFFIXES) {
      if (current.endsWith(suffix) && current.length > suffix.length) {
        current = current.slice(0, -suffix.length);
        addHint(current, true); // derived = true
        changed = true;
        break; // restart loop after each strip
      }
    }
  }

  return hints;
}

/**
 * Look up partner by domain-derived company name hints.
 * Searches c_bpartner.name with starts-with preference.
 *
 * @param {string} email - Sender email address
 * @param {string} partnerType - 'vendor', 'customer', or 'any'
 * @returns {object|null}
 */
function lookupByDomainHint(email, partnerType = 'any') {
  const hints = extractDomainHints(email);
  if (hints.length === 0) return null;

  // Try hints longest-first (most specific first)
  const primaryHints = hints.filter(h => !h.derived).sort((a, b) => b.value.length - a.value.length);
  const sortedHints = [...hints].sort((a, b) => b.value.length - a.value.length);

  for (const { value: hint, derived } of sortedHints) {
    if (hint.length < 4) continue;
    const cleanHint = hint.replace(/'/g, "''");

    // Primary hints: use LIKE '%hint%' (contains match)
    // Derived hints (suffix-stripped): use LIKE 'hint%' (starts-with only)
    // This prevents false positives like 'victory' matching 'Victory Telecom'
    // when the actual company is 'VictoryTech' (not in DB)
    const nameCondition = derived
      ? `LOWER(bp.name) LIKE '${cleanHint}%'`
      : `LOWER(bp.name) LIKE '%${cleanHint}%'`;

    const sql = `
      SELECT bp.c_bpartner_id, bp.name, bp.value as search_key
      FROM adempiere.c_bpartner bp
      WHERE ${nameCondition}
        AND bp.isactive = 'Y'
        AND bp.name NOT ILIKE 'USE %'
        ${partnerTypeFilter(partnerType)}
      ORDER BY
        CASE WHEN LOWER(bp.name) LIKE '${cleanHint}%' THEN 0 ELSE 1 END,
        bp.created DESC
      LIMIT 3
    `;

    const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key']);

    if (results.length > 0) {
      if (derived) {
        // For derived hints, verify the match is consistent with the original
        // domain. The matched company name should contain the longest primary
        // hint (or vice versa). This prevents 'victory' (from 'victorytech')
        // from matching unrelated 'Victory Telecom'.
        const longestPrimary = primaryHints[0] ? primaryHints[0].value.toLowerCase() : '';
        const matchedName = results[0].name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (longestPrimary && !matchedName.includes(longestPrimary) && !longestPrimary.includes(matchedName)) {
          continue; // matched name doesn't relate to the original domain
        }
      }
      return results[0];
    }
  }
  return null;
}

// ─── TIER 3: Name-Based Fuzzy Match ─────────────────────────────────────────

/**
 * Look up partner by company name (from email signature, body, etc.)
 *
 * @param {string} companyName - Company name extracted from email
 * @param {string} partnerType - 'vendor', 'customer', or 'any'
 * @returns {object|null}
 */
function lookupByName(companyName, partnerType = 'any') {
  if (!companyName || companyName.length < 3) return null;
  const cleanName = companyName.replace(/'/g, "''").trim();

  const sql = `
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key
    FROM adempiere.c_bpartner bp
    WHERE bp.name ILIKE '%${cleanName}%'
      AND bp.isactive = 'Y'
      AND bp.name NOT ILIKE 'USE %'
      ${partnerTypeFilter(partnerType)}
    ORDER BY
      CASE WHEN LOWER(bp.name) = LOWER('${cleanName}') THEN 0 ELSE 1 END,
      bp.created DESC
    LIMIT 5
  `;

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key']);
  return results[0] || null;
}

// ─── TIER 1.5: Domain-Based Email Match ─────────────────────────────────────

/**
 * Look up partner by matching any ad_user email at the same domain.
 * This catches cases where the company has contacts registered under
 * different emails at the same domain.
 *
 * @param {string} email - Sender email address
 * @param {string} partnerType - 'vendor', 'customer', or 'any'
 * @returns {object|null}
 */
function lookupByEmailDomain(email, partnerType = 'any') {
  if (!email) return null;

  const domainMatch = email.match(/@([^@]+)$/);
  if (!domainMatch) return null;
  const domain = domainMatch[1].toLowerCase();

  // Skip generic domains
  if (GENERIC_DOMAINS.has(domain)) return null;

  const cleanDomain = domain.replace(/'/g, "''");

  const sql = `
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(u.email) LIKE '%@${cleanDomain}'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND bp.name NOT ILIKE 'USE %'
      ${partnerTypeFilter(partnerType)}
    GROUP BY bp.c_bpartner_id, bp.name, bp.value
    ORDER BY MAX(bp.created) DESC
    LIMIT 3
  `;

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key']);

  for (const r of results) {
    const useMatch = r.name.match(/^USE\s+(\d+)/i);
    if (useMatch) {
      const redirected = lookupById(useMatch[1]);
      if (redirected) return redirected;
      continue;
    }
    return r;
  }
  return null;
}

// ─── MAIN RESOLVER ──────────────────────────────────────────────────────────

/**
 * Resolve a business partner from email and/or company name.
 * Runs all tiers in order, returns first match.
 *
 * @param {object} opts
 * @param {string} opts.email - Sender email address
 * @param {string} [opts.companyName] - Company name (from signature, etc.)
 * @param {string} [opts.partnerType='any'] - 'vendor', 'customer', or 'any'
 * @returns {object} { search_key, name, c_bpartner_id, matched, tier }
 *   matched=true if found, false if not. tier indicates which tier matched.
 */
function resolvePartner({ email, companyName, partnerType = 'any' } = {}) {
  // Tier 1: Exact email
  const t1 = lookupByEmail(email, partnerType);
  if (t1) return { ...t1, matched: true, tier: 1, tierName: 'exact_email' };

  // Tier 1.5: Same-domain email match
  const t15 = lookupByEmailDomain(email, partnerType);
  if (t15) return { ...t15, matched: true, tier: 1.5, tierName: 'email_domain' };

  // Tier 2: Domain hint → name search
  const t2 = lookupByDomainHint(email, partnerType);
  if (t2) return { ...t2, matched: true, tier: 2, tierName: 'domain_hint' };

  // Tier 3: Company name from email body/signature
  if (companyName) {
    const t3 = lookupByName(companyName, partnerType);
    if (t3) return { ...t3, matched: true, tier: 3, tierName: 'name_match' };
  }

  // No match
  return {
    c_bpartner_id: '',
    name: companyName || '',
    search_key: '',
    matched: false,
    tier: null,
    tierName: 'not_found'
  };
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  // Main entry point
  resolvePartner,

  // Individual tiers (for testing / direct use)
  lookupByEmail,
  lookupByEmailDomain,
  lookupByDomainHint,
  lookupByName,
  lookupById,

  // Utilities
  extractDomainHints,
  GENERIC_DOMAINS,
};
