/**
 * Shared Partner Lookup Module
 *
 * Canonical 3-tier matching logic for resolving business partners (vendors OR customers)
 * from email addresses and company names against the iDempiere database.
 *
 * Used by:
 *   - VQ Loading (vendor matching)
 *   - Market Offer Loading (partner matching)
 *   - Stock RFQ Loading (customer matching)
 *
 * IMPORTANT: Changes here apply to ALL workflows above.
 * See shared/partner-matching.md for documentation.
 */

const { execSync } = require('child_process');
const { isInfrastructureError } = require('./db-helpers');

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

// Generic role words that should never be used as a Tier-3 companyName match.
// Brokers commonly set their email display-name to a role rather than a real
// name (e.g., `From: saLes <sales@globalingg.com>`). Without this filter,
// Tier 3 runs `bp.name ILIKE '%sales%'` and any BP with "Sales" in its name
// (e.g. "Magnet Sales & Manufacturing") becomes a false positive. Discovered
// 2026-05-06 after globalingg.com → Magnet Sales mismatch.
const GENERIC_ROLE_NAMES = new Set([
  'sales', 'info', 'rfq', 'rfqs', 'purchasing', 'purchase', 'procurement',
  'quote', 'quotes', 'order', 'orders', 'support', 'admin', 'administrator',
  'contact', 'noreply', 'no-reply', 'mailer', 'webmaster', 'office',
  'enquiry', 'inquiries', 'inquiry', 'team', 'service', 'services',
  'hello', 'hi', 'mail', 'email',
]);

/**
 * Execute a psql query and return raw result string.
 * Returns empty string on error.
 */
function psqlQuery(sql, timeout = 10000) {
  try {
    // Under cron, PGDATABASE / PGUSER / LOGNAME may or may not propagate via
    // crontab env-vars — empirically, even with them set in the crontab header
    // we observed ~34 fe_sendauth failures across 100 minutes. Defensive fix:
    // explicitly set them on this exec call so peer-auth always has what it
    // needs regardless of crontab propagation oddities.
    return execSync(`psql -U analytics_user -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout,
      env: {
        ...process.env,
        PGUSER: process.env.PGUSER || 'analytics_user',
        LOGNAME: process.env.LOGNAME || 'analytics_user',
        PGDATABASE: process.env.PGDATABASE || 'idempiere_replica',
      },
    }).trim();
  } catch (err) {
    // Re-throw infrastructure errors so callers can't confuse "broken
    // lookup" with "no partner found." See db-helpers.isInfrastructureError
    // for the rationale and the 2026-04-09 cron incident that motivated
    // surfacing these loudly instead of returning empty.
    if (isInfrastructureError(err)) throw err;
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
  // Always exclude IsEmployee='Y' BPs from automated matching. These are
  // internal Astute records (sales reps, payroll BPs, hybrid customer/employee
  // accounts) and silently misattribute when the matcher returns them.
  // Discovered 2026-05-07: 6 stock RFQs got assigned to Edgar Santana / Daisy
  // Mendoza employee BPs — Edgar via Tier-1 exact-email after extractOriginalSender
  // pulled an internal address from a quoted reply chain, Daisy via Tier-3 fuzzy
  // name match on the broker's first-name display ("Daisy <daisy@igzrc.cn>").
  // Edge cases where an employee BP is genuinely the right customer should be
  // set explicitly by the operator, not via this matcher.
  const employeeFilter = "AND COALESCE(bp.isemployee, 'N') != 'Y'";
  switch (partnerType) {
    case 'vendor':   return `AND bp.isvendor = 'Y' ${employeeFilter}`;
    case 'customer': return `AND bp.iscustomer = 'Y' ${employeeFilter}`;
    default:         return employeeFilter; // 'any' — still exclude employees
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
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key,
           COALESCE(bp.iscustomer,'N') as iscustomer,
           COALESCE(bp.isvendor,'N') as isvendor
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(u.email) = '${cleanEmail}'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      ${partnerTypeFilter(partnerType)}
    ORDER BY bp.created DESC
    LIMIT 5
  `;

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key', 'iscustomer', 'isvendor']);

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
  // USE-redirect targets: still filter employees — same rationale as
  // partnerTypeFilter (silent misattribution if a USE stub points to an
  // internal employee record).
  const sql = `
    SELECT c_bpartner_id, name, value as search_key,
           COALESCE(iscustomer,'N') as iscustomer,
           COALESCE(isvendor,'N') as isvendor
    FROM adempiere.c_bpartner
    WHERE c_bpartner_id = ${parseInt(bpId, 10)}
      AND isactive = 'Y'
      AND COALESCE(isemployee, 'N') != 'Y'
    LIMIT 1
  `;
  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key', 'iscustomer', 'isvendor']);
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
      SELECT bp.c_bpartner_id, bp.name, bp.value as search_key,
             COALESCE(bp.iscustomer,'N') as iscustomer,
             COALESCE(bp.isvendor,'N') as isvendor
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

    const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key', 'iscustomer', 'isvendor']);

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
  // Reject generic role words (sales, info, support, etc.) — these match too
  // many real BPs as substrings and produce false positives.
  const normalized = companyName.toLowerCase().trim().replace(/[^a-z]/g, '');
  if (GENERIC_ROLE_NAMES.has(normalized)) return null;
  const cleanName = companyName.replace(/'/g, "''").trim();

  const sql = `
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key,
           COALESCE(bp.iscustomer,'N') as iscustomer,
           COALESCE(bp.isvendor,'N') as isvendor
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

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key', 'iscustomer', 'isvendor']);
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

  // Get the domain stem (e.g., 'sanmina' from 'sanmina.com') so we can prefer
  // BPs whose name contains that stem when multiple BPs share the same email
  // domain. Without this, the tiebreaker fell to created DESC and could pick
  // an unrelated BP that happened to have one stray contact at the customer's
  // domain (e.g., a Sanmina employee added as a contact under NEURAL DSP
  // TECHNOLOGIES OY mismatched @sanmina.com to NEURAL DSP — even though
  // Sanmina Corporation had 860 contacts at the same domain).
  const domainStem = domain.split('.')[0].replace(/'/g, "''");

  const sql = `
    SELECT bp.c_bpartner_id, bp.name, bp.value as search_key,
           COALESCE(bp.iscustomer,'N') as iscustomer,
           COALESCE(bp.isvendor,'N') as isvendor,
           COUNT(u.ad_user_id) AS user_count
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(u.email) LIKE '%@${cleanDomain}'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND bp.name NOT ILIKE 'USE %'
      ${partnerTypeFilter(partnerType)}
    GROUP BY bp.c_bpartner_id, bp.name, bp.value, bp.iscustomer, bp.isvendor
    ORDER BY
      -- 1. Prefer BPs whose name contains the domain stem (e.g., 'sanmina')
      CASE WHEN LOWER(bp.name) LIKE '%${domainStem}%' THEN 0 ELSE 1 END,
      -- 2. Prefer BPs with the most contacts at this domain (Sanmina has
      --    860 sanmina.com contacts; NEURAL DSP has 1 — clear winner)
      COUNT(u.ad_user_id) DESC,
      -- 3. Final tiebreaker: most recent
      MAX(bp.created) DESC
    LIMIT 3
  `;

  const results = parseResults(psqlQuery(sql), ['c_bpartner_id', 'name', 'search_key', 'iscustomer', 'isvendor']);

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

// ─── ASTUTE EMPLOYEE LOOKUP (forwarder-vs-owner resolution) ─────────────────

/**
 * Resolve an Astute employee's AD_User_ID from an email address.
 *
 * Primary use: the "internal-forward-chain" rule in the email-driven loaders.
 * When a support staffer forwards on behalf of a buyer/seller — e.g.,
 * Gopal → Stephanie → loader, both @astutegroup.com — the loader resolves the
 * DEEPER @astutegroup.com sender (the operator on record) into an AD_User_ID
 * so RFQ.SalesRep_ID / VQ.chuboe_buyer_id can be stamped correctly instead
 * of defaulting to the outer forwarder or to Jake.
 *
 * Filters: active user, active BP, IsEmployee='Y' (defends against the
 * 2026-05-07 employee-BP misattribution incident the opposite way — here we
 * REQUIRE employee, since the goal is Astute-internal ownership).
 *
 * @param {string} email - e.g. "stephanie.hill@astutegroup.com"
 * @returns {object|null} { userId, name, email } or null
 */
function resolveAstuteUserByEmail(email) {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim().replace(/'/g, "''");

  const sql = `
    SELECT u.ad_user_id, u.name, u.email
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(u.email) = '${cleanEmail}'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND bp.isemployee = 'Y'
    ORDER BY u.created DESC
    LIMIT 1
  `;
  const rows = parseResults(psqlQuery(sql), ['userId', 'name', 'email']);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { userId: Number(r.userId), name: r.name, email: r.email };
}

/**
 * Resolve an Astute employee's AD_User_ID from a name string.
 *
 * Secondary path for the forwarder-vs-owner pattern: used when the email
 * chain doesn't reveal the owner internally (e.g., support staff forwards
 * from a personal account, or the body contains an explicit hint like
 * "on behalf of Stephanie Hill" / "sourced by Gopal"). Fuzzy-matches on
 * ad_user.name with the same active+IsEmployee guard as
 * resolveAstuteUserByEmail.
 *
 * Returns null on no match. Returns ALL candidates if ambiguous (caller
 * decides: the agent should escalate to needs_review rather than pick
 * one). Returns a single result with `.unambiguous: true` when only one
 * candidate matches — that's the case the loaders can act on
 * autonomously.
 *
 * @param {string} name - e.g. "Stephanie Hill", "Gopal", "Tracy"
 * @returns {object|null} { userId, name, email, unambiguous } or
 *                       { candidates: [...], ambiguous: true } or null
 */
function resolveAstuteUserByName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 2) return null;
  const clean = trimmed.replace(/'/g, "''");

  const sql = `
    SELECT u.ad_user_id, u.name, u.email
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE u.name ILIKE '%${clean}%'
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND bp.isemployee = 'Y'
    ORDER BY u.created DESC
    LIMIT 5
  `;
  const rows = parseResults(psqlQuery(sql), ['userId', 'name', 'email']);
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const r = rows[0];
    return { userId: Number(r.userId), name: r.name, email: r.email, unambiguous: true };
  }
  return {
    ambiguous: true,
    candidates: rows.map(r => ({ userId: Number(r.userId), name: r.name, email: r.email })),
  };
}

/**
 * Resolve an Astute employee's email + name from their AD_User_ID.
 *
 * The reverse of resolveAstuteUserByEmail — used when a workflow already holds
 * a resolved buyer/owner ad_user_id (e.g. chuboe_buyer_id) and needs the email
 * to loop that person in. Same active + IsEmployee guard as the email/name
 * resolvers so it never returns an external contact.
 *
 * @param {number|string} userId - ad_user_id
 * @returns {object|null} { userId, name, email } or null
 */
function resolveAstuteUserById(userId) {
  if (userId == null || userId === '') return null;
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;

  const sql = `
    SELECT u.ad_user_id, u.name, u.email
    FROM adempiere.ad_user u
    JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
    WHERE u.ad_user_id = ${id}
      AND u.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND bp.isemployee = 'Y'
    LIMIT 1
  `;
  const rows = parseResults(psqlQuery(sql), ['userId', 'name', 'email']);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { userId: Number(r.userId), name: r.name, email: r.email };
}

// ─── USER ROLE REGISTRY ─────────────────────────────────────────────────────
//
// Operator-maintained list of confirmed buyers + support. Drives the buyer-
// resolution ladder for VQ loading (and any downstream consumer that needs
// the buyer vs sourcer/support distinction). See:
//   shared/data/user-role-registry.json — source of truth
//   deferred-work.md — implementation flow + escalation policy

const fs = require('fs');
const path = require('path');

let _roleRegistryCache = null;
let _roleRegistryLoadedAt = 0;
const ROLE_REGISTRY_TTL_MS = 5 * 60 * 1000; // 5 min cache; edits become visible quickly

function loadUserRoleRegistry() {
  const now = Date.now();
  if (_roleRegistryCache && (now - _roleRegistryLoadedAt) < ROLE_REGISTRY_TTL_MS) {
    return _roleRegistryCache;
  }
  const file = path.join(__dirname, 'data', 'user-role-registry.json');
  if (!fs.existsSync(file)) {
    // Fail open with empty lists rather than crashing — operator gets escalated for everyone
    _roleRegistryCache = { buyers: [], support: [], _missing: true };
    _roleRegistryLoadedAt = now;
    return _roleRegistryCache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    _roleRegistryCache = {
      buyers: Array.isArray(raw.buyers) ? raw.buyers : [],
      support: Array.isArray(raw.support) ? raw.support : [],
    };
    _roleRegistryLoadedAt = now;
    return _roleRegistryCache;
  } catch (e) {
    _roleRegistryCache = { buyers: [], support: [], _parseError: e.message };
    _roleRegistryLoadedAt = now;
    return _roleRegistryCache;
  }
}

function isKnownBuyer(adUserId) {
  if (adUserId == null) return false;
  const reg = loadUserRoleRegistry();
  return reg.buyers.some(b => Number(b.id) === Number(adUserId));
}

function isKnownSupport(adUserId) {
  if (adUserId == null) return false;
  const reg = loadUserRoleRegistry();
  return reg.support.some(s => Number(s.id) === Number(adUserId));
}

/**
 * Apply the registry-based buyer-resolution ladder (v1):
 *
 *   1. If `candidateUserId` is in the buyers registry → use it.
 *   2. Else → escalate to operator (push to Jake).
 *
 * NOTE on dropped RFQ-owner fallback: chuboe_rfq.chuboe_user_id is the
 * CUSTOMER's contact (Haley Neumann at Emerson, etc.), not the Astute-side
 * buyer — so falling back to it would mis-assign external contacts. A future
 * v2 could use `most-recent chuboe_buyer_id across existing VQs on the same
 * RFQ` as a smarter fallback if escalation volume warrants it. For now we
 * escalate cleanly.
 *
 * @param {object} opts
 * @param {number|null} opts.candidateUserId - Tier-A walk result (forwarder/sender after unwrap)
 * @param {string|null} opts.citedRfq - RFQ search key from email subject/body (informational only in v1)
 * @returns {{ buyer: number|null, source: string|null, reason: string, escalate: boolean }}
 */
function resolveBuyerFromRegistry({ candidateUserId, citedRfq } = {}) {
  if (candidateUserId && isKnownBuyer(candidateUserId)) {
    return {
      buyer: Number(candidateUserId),
      source: 'tier_a_known_buyer',
      reason: 'Tier-A unwrap candidate is in the buyer registry',
      escalate: false,
    };
  }

  // Escalation reason needs to be descriptive so the operator can act
  let reason;
  if (!candidateUserId) {
    reason = `No buyer candidate from chain walk${citedRfq ? ` (cited RFQ: ${citedRfq})` : ''}`;
  } else if (isKnownSupport(candidateUserId)) {
    reason = `Tier-A candidate ${candidateUserId} is in support registry, not a buyer${citedRfq ? ` (cited RFQ: ${citedRfq})` : ''}`;
  } else {
    reason = `Tier-A candidate ${candidateUserId} not in buyer or support registry${citedRfq ? ` (cited RFQ: ${citedRfq})` : ''}`;
  }

  return { buyer: null, source: null, reason, escalate: true };
}

// ─── HISTORICAL BP FALLBACK ─────────────────────────────────────────────────
//
// When a name-only resolveBP fails for a short broker label ("Yuexunfa" vs
// "YUE XUN FA INTERNATIONAL LIMITED"), this fallback queries recent VQ
// history for vendor names whose normalized form contains the input label,
// weighting by recent write frequency. Returns a match only when it's
// UNAMBIGUOUS (exactly one matching BP in the lookback window) — otherwise
// the caller's existing not-found path runs.
//
// Why this works: every vendor we've ever loaded a VQ for has a row in
// chuboe_vq_line with the BP_ID and the BP's name. If "Yuexunfa" maps to BP
// 1009165 ("YUE XUN FA INTERNATIONAL LIMITED"), there are 25+ recent rows
// proving the association. The resolver doesn't need a static alias table —
// the operational history IS the table.
//
// Confidence guardrails:
//   - Reject labels shorter than 4 normalized chars (too generic)
//   - Reject labels that look like common English words
//   - Require ≥3 recent VQ writes under the candidate BP
//   - Return null on ambiguity (≥2 candidate BPs) — caller can still
//     escalate via needs_vendor / needs_review
//
// @param {string} vendorLabel - the agent-extracted broker label
// @param {object} [opts]
// @param {number} [opts.lookbackDays=90]
// @param {number} [opts.minVqCount=3]
// @returns {{ id:number, name:string, searchKey:string, source:'historical-vq',
//             vqCount:number, lookbackDays:number } | null}
function resolveBPHistorical(vendorLabel, opts = {}) {
  if (!vendorLabel || typeof vendorLabel !== 'string') return null;
  const lookbackDays = opts.lookbackDays != null ? opts.lookbackDays : 90;
  const minVqCount = opts.minVqCount != null ? opts.minVqCount : 3;

  const norm = vendorLabel.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm.length < 4) return null;

  // Generic words that would match too many BPs — reject outright.
  const GENERIC = new Set([
    'electronics', 'electronic', 'company', 'corp', 'inc', 'ltd', 'limited',
    'group', 'international', 'trading', 'tech', 'technology', 'global',
    'industries', 'industrial', 'enterprise',
  ]);
  if (GENERIC.has(norm)) return null;

  // Find active vendor BPs with a recent VQ write whose normalized name
  // contains the label. REGEXP_REPLACE drops all non-alphanumerics; LOWER
  // normalizes case. The same shape as the JS norm above.
  const sql = `
    SELECT
      bp.c_bpartner_id        AS id,
      bp.name                 AS name,
      bp.value                AS search_key,
      COUNT(v.chuboe_vq_line_id) AS vq_count
    FROM adempiere.c_bpartner bp
    JOIN adempiere.chuboe_vq_line v ON v.c_bpartner_id = bp.c_bpartner_id
    WHERE v.isactive = 'Y'
      AND bp.isactive = 'Y'
      AND v.created >= NOW() - INTERVAL '${lookbackDays} days'
      AND REGEXP_REPLACE(LOWER(bp.name), '[^a-z0-9]', '', 'g') LIKE '%${norm}%'
    GROUP BY bp.c_bpartner_id, bp.name, bp.value
    HAVING COUNT(v.chuboe_vq_line_id) >= ${minVqCount}
    ORDER BY vq_count DESC, MAX(v.created) DESC
    LIMIT 5
  `;

  let result;
  try {
    result = psqlQuery(sql);
  } catch (_) {
    return null;
  }
  const rows = parseResults(result, ['id', 'name', 'search_key', 'vq_count']);
  if (rows.length === 0) return null;
  // Ambiguity guard: if the second-best candidate has ≥50% of the top
  // candidate's vq_count, refuse to guess. The caller's not-found path can
  // still escalate.
  if (rows.length >= 2) {
    const top = Number(rows[0].vq_count);
    const second = Number(rows[1].vq_count);
    if (top > 0 && (second / top) >= 0.5) return null;
  }
  const top = rows[0];
  return {
    id: Number(top.id),
    name: top.name,
    searchKey: top.search_key,
    source: 'historical-vq',
    vqCount: Number(top.vq_count),
    lookbackDays,
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

  // Historical BP fallback (recent-VQ-history match for short broker labels)
  resolveBPHistorical,

  // Astute-employee resolution (forwarder-vs-owner pattern)
  resolveAstuteUserByEmail,
  resolveAstuteUserByName,
  resolveAstuteUserById,

  // User role registry (buyer/support classification + ladder)
  loadUserRoleRegistry,
  isKnownBuyer,
  isKnownSupport,
  resolveBuyerFromRegistry,

  // Utilities
  extractDomainHints,
  GENERIC_DOMAINS,
};
