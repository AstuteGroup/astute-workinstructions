/**
 * iDempiere REST API Client — writes data to iDempiere via REST API
 *
 * Replaces direct SQL INSERT to ai_writeback schema. Sits alongside db-helpers.js
 * (which continues to handle read queries via psql).
 *
 * USAGE:
 *   const { apiPost, apiGet, apiPut, apiDelete, apiBatch, login, logout } = require('../shared/api-client');
 *
 *   // Create a record (auto-authenticates on first call)
 *   const rfq = await apiPost('chuboe_rfq', { C_BPartner_ID: 1000190, ... });
 *   console.log(rfq.id); // server-assigned ID
 *
 *   // Read records
 *   const partners = await apiGet('c_bpartner', { filter: "Name eq 'Acme'" });
 *
 *   // Update a record
 *   await apiPut('chuboe_offer', 1000500, { IsActive: false });
 *
 *   // Batch independent writes
 *   await apiBatch([
 *     { method: 'POST', resource: '/models/chuboe_offer_line', body: { ... } },
 *     { method: 'POST', resource: '/models/chuboe_offer_line', body: { ... } },
 *   ]);
 *
 * AUTHENTICATION:
 *   Lazy login on first API call. Token cached in-memory, auto-refreshed
 *   5 minutes before expiry. Uses credentials from ~/workspace/.env.
 *
 * CONSUMERS:
 *   - rfq-writer.js (Stock RFQ Loading)
 *   - offer-writeback.js (Market Offer Loading, Inventory File Cleanup)
 *   - api-result-writer.js (Franchise API pricing results)
 *
 * DOCUMENTATION: See shared/api-writeback.md for full API details and payload structures.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const logger = require('./logger').createLogger('APIClient');
const breadcrumbs = require('./breadcrumbs');

// Production iDempiere uses a self-signed cert. Node's built-in fetch (undici)
// rejects self-signed certs by default with an opaque "fetch failed" error.
// Install a permissive Undici dispatcher when targeting HTTPS.
const { Agent, setGlobalDispatcher } = require('undici');
if ((process.env.IDEMPIERE_BASE_URL || '').startsWith('https://')) {
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const BASE_URL = process.env.IDEMPIERE_BASE_URL;
const USERNAME = process.env.IDEMPIERE_USERNAME;
const PASSWORD = process.env.IDEMPIERE_PASSWORD;

// Server auto-populates standard fields (AD_Client_ID, AD_Org_ID, IsActive,
// CreatedBy, UpdatedBy, Created, Updated) from the authenticated session.
// See: https://bxservice.github.io/idempiere-rest-docs/docs/api-guides/crud-operations/creating-data
const IDEMPIERE_DEFAULTS = {};

// Token refresh buffer: refresh when less than this many ms remain
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ─── AUTH PARAMETERS (from .env) ────────────────────────────────────────────

const AUTH_CLIENT_ID = parseInt(process.env.IDEMPIERE_CLIENT_ID, 10) || 1000000;
const AUTH_ROLE_ID = parseInt(process.env.IDEMPIERE_ROLE_ID, 10) || 1000004; // Tsunami User
const AUTH_ORG_ID = parseInt(process.env.IDEMPIERE_ORG_ID, 10) || 1000000;

// ─── TOKEN STATE ────────────────────────────────────────────────────────────

let _token = null;
let _refreshToken = null;
let _userId = null;
let _tokenExpiresAt = 0; // epoch ms

// ─── VALIDATION ─────────────────────────────────────────────────────────────

function assertConfigured() {
  if (!BASE_URL) throw new Error('api-client: IDEMPIERE_BASE_URL not set in .env');
  if (!USERNAME) throw new Error('api-client: IDEMPIERE_USERNAME not set in .env');
  if (!PASSWORD) throw new Error('api-client: IDEMPIERE_PASSWORD not set in .env');
}

// ─── AUTHENTICATION ─────────────────────────────────────────────────────────

/**
 * Login to iDempiere REST API using one-step authentication.
 * POST /auth/tokens with credentials + parameters (clientId/roleId/orgId).
 * Called automatically on first API request.
 * @returns {Promise<{token: string, refreshToken: string}>}
 */
async function login() {
  assertConfigured();

  const url = `${BASE_URL}/auth/tokens`;
  const body = {
    userName: USERNAME,
    password: PASSWORD,
    parameters: {
      clientId: AUTH_CLIENT_ID,
      roleId: AUTH_ROLE_ID,
      organizationId: AUTH_ORG_ID,
    },
  };

  logger.info(`Authenticating to ${BASE_URL} (clientId=${AUTH_CLIENT_ID}, roleId=${AUTH_ROLE_ID}, orgId=${AUTH_ORG_ID})...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api-client login failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _token = data.token;
  _refreshToken = data.refresh_token;
  _userId = data.userId;
  // Default 1 hour expiry, minus buffer
  _tokenExpiresAt = Date.now() + (60 * 60 * 1000) - REFRESH_BUFFER_MS;

  if (!_token) {
    throw new Error('api-client login: no token in response');
  }

  logger.info('Authenticated successfully');
  return { token: _token, refreshToken: _refreshToken };
}

/**
 * Refresh the access token using the refresh token.
 * Endpoint: POST /auth/refresh
 * Refresh tokens are single-use — reusing triggers a security breach.
 */
async function refreshTokenFn() {
  assertConfigured();

  if (!_refreshToken) {
    logger.info('No refresh token available, performing full login');
    return login();
  }

  const url = `${BASE_URL}/auth/refresh`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: _refreshToken,
      clientId: AUTH_CLIENT_ID,
      userId: _userId,
    }),
  });

  if (!res.ok) {
    logger.warn(`Token refresh failed (${res.status}), performing full login`);
    return login();
  }

  const data = await res.json();
  _token = data.token;
  _refreshToken = data.refresh_token;
  _tokenExpiresAt = Date.now() + (60 * 60 * 1000) - REFRESH_BUFFER_MS;

  logger.debug('Token refreshed');
  return { token: _token, refreshToken: _refreshToken };
}

/**
 * Get a valid access token. Logs in if needed, refreshes if expiring.
 * Called automatically before every API request.
 * @returns {Promise<string>} Valid JWT token
 */
async function getToken() {
  if (!_token) {
    await login();
  } else if (Date.now() >= _tokenExpiresAt) {
    await refreshTokenFn();
  }
  return _token;
}

/**
 * Logout and invalidate the current token.
 */
async function logout() {
  if (!_token || !BASE_URL) return;

  try {
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: _token }),
    });
    logger.info('Logged out');
  } catch (e) {
    logger.warn(`Logout failed: ${e.message}`);
  } finally {
    _token = null;
    _refreshToken = null;
    _userId = null;
    _tokenExpiresAt = 0;
  }
}

// ─── HTTP HELPERS ───────────────────────────────────────────────────────────

/**
 * Make an authenticated HTTP request.
 *
 * Auto-retry policy (POST is intentionally excluded — see apiPost):
 *   - GET / PUT-with-ID / DELETE-with-ID: auto-retry on 5xx and network errors.
 *     These verbs are idempotent — re-issuing them does not create duplicate rows.
 *   - POST: NEVER auto-retried here. iDempiere can return 5xx *after* committing
 *     a row (e.g., when a server-side bean callout throws post-commit), so a
 *     blind POST retry doubles data. apiPost() handles POST retry on its own
 *     with check-before-retry via a caller-supplied natural key.
 *   - 401 token-refresh-and-retry is safe for all verbs (a 401 means the
 *     request was rejected, not processed) and is preserved.
 *
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path relative to BASE_URL
 * @param {object|null} body - Request body
 * @param {object} [opts]
 * @param {number} [opts.attempt=1] - Current retry attempt (internal)
 * @returns {Promise<object>} Parsed JSON response
 */
async function request(method, urlPath, body = null, opts = {}) {
  const { attempt = 1 } = opts;
  const token = await getToken();
  const url = `${BASE_URL}${urlPath}`;

  const fetchOptions = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    fetchOptions.body = JSON.stringify(body);
  }

  // POST is never auto-retried inside request() — see apiPost for the
  // safe-retry path. All other verbs are idempotent and can be auto-retried.
  const isUnsafeForRetry = method === 'POST';

  let res;
  try {
    res = await fetch(url, fetchOptions);
  } catch (networkError) {
    if (!isUnsafeForRetry && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`Network error on ${method} ${urlPath}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}): ${networkError.message}`);
      await sleep(delay);
      return request(method, urlPath, body, { attempt: attempt + 1 });
    }
    const wrapped = new Error(`api-client ${method} ${urlPath} network error: ${networkError.message}`);
    wrapped.cause = networkError;
    wrapped.isNetworkError = true;
    throw wrapped;
  }

  // Handle 401 — token expired, refresh and retry once (safe for all verbs)
  if (res.status === 401 && attempt === 1) {
    logger.debug('Got 401, refreshing token and retrying');
    await refreshTokenFn();
    return request(method, urlPath, body, { attempt: attempt + 1 });
  }

  // Handle 5xx — auto-retry only for idempotent verbs
  if (res.status >= 500 && !isUnsafeForRetry && attempt < MAX_RETRIES) {
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    logger.warn(`Server error ${res.status} on ${method} ${urlPath}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
    await sleep(delay);
    return request(method, urlPath, body, { attempt: attempt + 1 });
  }

  // Handle other errors
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`api-client ${method} ${urlPath} failed (${res.status}): ${text}`);
    error.statusCode = res.status;
    error.responseBody = text;
    throw error;
  }

  // Parse response — handle empty bodies (204, etc.)
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  }
  return { status: res.status };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── CRUD OPERATIONS ────────────────────────────────────────────────────────

/**
 * Build an OData $filter expression from a list of payload field names.
 * Used by apiPost's check-before-retry path. Returns null if any required
 * field is missing/null/empty — in that case the verify path is skipped
 * (we can't safely identify the row, so we don't claim to have found it).
 *
 * @param {string[]} fields - Field names to include in the filter
 * @param {object} body - Payload object
 * @param {string} [sinceTimestamp] - ISO timestamp; if provided, adds Created ge <ts>
 * @returns {string|null}
 */
function buildNaturalKeyFilter(fields, body, sinceTimestamp) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const clauses = [];
  for (const field of fields) {
    const value = body[field];
    if (value === null || value === undefined || value === '') {
      // Can't safely build a verify filter if any key field is missing.
      return null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      clauses.push(`${field} eq ${value}`);
    } else {
      const escaped = String(value).replace(/'/g, "''");
      clauses.push(`${field} eq '${escaped}'`);
    }
  }
  if (sinceTimestamp) {
    clauses.push(`Created ge '${sinceTimestamp}'`);
  }
  return clauses.join(' and ');
}

/**
 * Create a record via POST. Includes a generic check-before-retry facility:
 * if the caller supplies `naturalKeyFields`, then on a 5xx or network error
 * after a POST, apiPost issues a GET filtered by those fields (plus a
 * pre-POST timestamp guard) to check whether the row was actually committed
 * server-side. If so, it returns the existing row instead of retrying — which
 * prevents the duplicate-row trap when iDempiere returns 5xx after a
 * successful commit (e.g., from a post-commit bean-callout exception).
 *
 * Without `naturalKeyFields`, apiPost does NOT auto-retry on 5xx/network
 * errors — that's the safer default given the dup risk. Callers wanting
 * resilient writes should pass naturalKeyFields.
 *
 * Automatically includes IDEMPIERE_DEFAULTS fields.
 *
 * @param {string} table - Table name (e.g., 'chuboe_rfq', 'c_bpartner')
 * @param {object} payload - Record fields (without standard iDempiere fields)
 * @param {object} [options]
 * @param {boolean} [options.includeDefaults=true] - Include IDEMPIERE_DEFAULTS in payload
 * @param {string[]} [options.naturalKeyFields] - Payload field names that
 *   uniquely identify this row. Enables safe retry via check-before-retry.
 *   Example: ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN_Clean', 'Chuboe_MFR_ID']
 * @param {number} [options.maxRetries] - Max attempts when naturalKeyFields
 *   is set. Defaults to MAX_RETRIES. Ignored when naturalKeyFields is absent.
 * @param {string} [options.context] - Workflow context for audit trail (e.g.,
 *   'vq-loading', 'stockrfq', 'excess'). Writes without context are flagged
 *   as 'ad-hoc' in the Ops Digest.
 * @returns {Promise<object>} Created record with server-assigned ID
 */
async function apiPost(table, payload, options = {}) {
  const {
    includeDefaults = true,
    naturalKeyFields = null,
    maxRetries = MAX_RETRIES,
    context = null,
  } = options;

  const body = includeDefaults
    ? { ...IDEMPIERE_DEFAULTS, ...payload }
    : { ...payload };

  // No natural key → single attempt, no retry. This is the safer default
  // because the previous behavior (blind 5xx retry) silently double-wrote
  // rows when iDempiere committed and then returned 5xx from a post-commit
  // bean callout. Callers that need resilience should pass naturalKeyFields.
  if (!naturalKeyFields) {
    const result = await request('POST', `/models/${table}`, body);
    logger.debug(`Created ${table} record: id=${result.id || 'unknown'}`);
    // Audit breadcrumb for API write tracking
    breadcrumbs.write({
      cog: 'api-client',
      event: 'write',
      operation: 'POST',
      table,
      recordId: result.id,
      searchKey: result.Value || null,
      context: context || 'ad-hoc',
    });
    return result;
  }

  // With natural key: capture pre-POST timestamp and run up to maxRetries
  // attempts, verifying after each failure whether the row actually committed.
  // The timestamp guard ensures the verify GET only matches rows we may have
  // just created — never an unrelated older row.
  const preTimestamp = new Date().toISOString();
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await request('POST', `/models/${table}`, body);
      logger.debug(`Created ${table} record: id=${result.id || 'unknown'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      // Audit breadcrumb for API write tracking
      breadcrumbs.write({
        cog: 'api-client',
        event: 'write',
        operation: 'POST',
        table,
        recordId: result.id,
        searchKey: result.Value || null,
        context: context || 'ad-hoc',
      });
      return result;
    } catch (e) {
      lastError = e;

      // Only retry on transient failures: 5xx or network errors. Don't retry
      // on 4xx (those are client errors — payload validation, auth, etc.,
      // and won't fix themselves on retry).
      const isTransient = e.isNetworkError || (e.statusCode >= 500 && e.statusCode < 600);
      if (!isTransient) throw e;

      // Check whether the failed POST actually committed despite the error.
      // SAFETY RULE: we only retry when verification CONFIRMS the row was not
      // committed. Any uncertainty (can't build filter, verify itself errored)
      // → throw and let the caller investigate. Blind retry is how the
      // duplicate-row trap happened in the first place.
      const filter = buildNaturalKeyFilter(naturalKeyFields, body, preTimestamp);
      if (!filter) {
        logger.warn(`POST ${table} failed (${e.statusCode || 'network error'}) and natural key has missing/null fields — cannot verify, not retrying to avoid dup risk`);
        throw e;
      }

      let verify;
      try {
        verify = await apiGet(table, { filter, top: 1, orderby: 'Created desc' });
      } catch (verifyErr) {
        logger.warn(`Verify-after-error for ${table} failed: ${verifyErr.message} — not retrying to avoid dup risk`);
        throw e;
      }

      const found = verify.records && verify.records[0];
      if (found) {
        logger.warn(`POST ${table} returned ${e.statusCode || 'network error'} but row was committed: id=${found.id} (attempt ${attempt}) — treating as success`);
        // Audit breadcrumb for API write tracking (verified-after-error)
        breadcrumbs.write({
          cog: 'api-client',
          event: 'write',
          operation: 'POST',
          table,
          recordId: found.id,
          searchKey: found.Value || null,
          context: context || 'ad-hoc',
          note: 'verified-after-error',
        });
        return found;
      }

      // Verified that the row was NOT committed → safe to retry with backoff.
      if (attempt < maxRetries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`POST ${table} failed (${e.statusCode || 'network error'}) and row not committed — retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Read records via GET.
 *
 * @param {string} table - Table name
 * @param {object} [options]
 * @param {number} [options.id] - Specific record ID (GET /models/{table}/{id})
 * @param {string} [options.filter] - OData $filter expression
 * @param {string} [options.select] - OData $select columns
 * @param {string} [options.orderby] - OData $orderby expression
 * @param {number} [options.top] - Limit results
 * @param {number} [options.skip] - Skip results (pagination)
 * @param {string} [options.expand] - OData $expand for related records
 * @returns {Promise<object>} Single record or { records: [...] }
 */
async function apiGet(table, options = {}) {
  if (options.id) {
    return request('GET', `/models/${table}/${options.id}`);
  }

  const params = new URLSearchParams();
  if (options.filter) params.set('$filter', options.filter);
  if (options.select) params.set('$select', options.select);
  if (options.orderby) params.set('$orderby', options.orderby);
  if (options.top) params.set('$top', String(options.top));
  if (options.skip) params.set('$skip', String(options.skip));
  if (options.expand) params.set('$expand', options.expand);

  const qs = params.toString();
  const urlPath = `/models/${table}${qs ? '?' + qs : ''}`;
  return request('GET', urlPath);
}

/**
 * Update a record via PUT.
 *
 * @param {string} table - Table name
 * @param {number} id - Record ID
 * @param {object} payload - Fields to update
 * @param {object} [options]
 * @param {string} [options.context] - Workflow context for audit trail
 * @returns {Promise<object>} Updated record
 */
async function apiPut(table, id, payload, options = {}) {
  const { context = null } = options;
  const body = { ...payload };
  const result = await request('PUT', `/models/${table}/${id}`, body);
  logger.debug(`Updated ${table}/${id}`);
  // Audit breadcrumb for API write tracking
  breadcrumbs.write({
    cog: 'api-client',
    event: 'write',
    operation: 'PUT',
    table,
    recordId: id,
    context: context || 'ad-hoc',
  });
  return result;
}

/**
 * Delete a record via DELETE.
 *
 * @param {string} table - Table name
 * @param {number} id - Record ID
 * @returns {Promise<object>} Response
 */
async function apiDelete(table, id) {
  const result = await request('DELETE', `/models/${table}/${id}`);
  logger.debug(`Deleted ${table}/${id}`);
  return result;
}

/**
 * Execute multiple operations in a single batch request.
 * Use for independent, sibling-level writes only — NOT parent-child.
 *
 * @param {Array<{method: string, resource: string, body?: object}>} operations
 * @param {object} [options]
 * @param {string} [options.context] - Workflow context for audit trail
 * @returns {Promise<object>} Batch response
 */
async function apiBatch(operations, options = {}) {
  const { context = null } = options;
  const result = await request('POST', '/batch', operations);
  logger.debug(`Batch executed: ${operations.length} operations`);
  // Audit breadcrumb for API write tracking (batch)
  // Extract table names from operations for the audit
  const tables = [...new Set(operations.map(op => {
    const match = op.resource && op.resource.match(/\/models\/([^/]+)/);
    return match ? match[1] : 'unknown';
  }))];
  breadcrumbs.write({
    cog: 'api-client',
    event: 'write',
    operation: 'BATCH',
    tables,
    operationCount: operations.length,
    context: context || 'ad-hoc',
  });
  return result;
}

// ─── CONNECTIVITY CHECK ─────────────────────────────────────────────────────

/**
 * Check if the iDempiere REST API is reachable and credentials are valid.
 * Memoized for the process lifetime after first successful check.
 *
 * @returns {Promise<boolean>} true if API is available
 */
let _apiAvailable = null;
async function isApiAvailable() {
  if (_apiAvailable !== null) return _apiAvailable;

  if (!BASE_URL || !USERNAME || !PASSWORD) {
    logger.info('iDempiere API not configured (missing .env vars) — using fallback');
    _apiAvailable = false;
    return false;
  }

  try {
    await getToken();
    _apiAvailable = true;
    return true;
  } catch (e) {
    logger.warn(`iDempiere API not available: ${e.message}`);
    _apiAvailable = false;
    return false;
  }
}

/**
 * Reset the API availability cache. Call if you want to re-check connectivity.
 */
function resetAvailabilityCache() {
  _apiAvailable = null;
}

// ─── LOOKUP HELPERS ──────────────────────────────────────────────────────────

const _bpCache = new Map(); // searchKey -> { id, name }

/**
 * Normalise a vendor-name string for fuzzy matching: uppercase, strip
 * whitespace + punctuation. Lets "Samwooele" match "SAMWOO ELECO CO..LTD"
 * via prefix comparison: "SAMWOOELE" is a prefix of "SAMWOOELECOCOLTD".
 * Common suffixes (CO/LTD/INC/LIMITED) are NOT stripped because they
 * appear after the discriminating tokens.
 */
function _normalizeBPName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Levenshtein distance with early-exit when the running minimum exceeds a
 * threshold. Used by resolveBP's Phase 2 typo-tolerance tier — keeps the
 * scoring cheap for the "Did the operator just transpose two letters?" case.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [maxDist=3] - early-exit if best possible distance exceeds this
 * @returns {number} edit distance (or maxDist+1 if early-exited)
 */
function _levenshtein(a, b, maxDist = 3) {
  a = a || '';
  b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1; // early exit
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Resolve a Business Partner. Tries search key first, then name.
 * Cached for the session — one API call per unique lookup.
 *
 * Name-based fuzzy matching (post-2026-05-20 hardening per the
 * resolveBP-too-loose defect identified during Betty's batch):
 *
 *   1. Require `IsVendor='Y'` AND `Chuboe_VendorType_ID IS NOT NULL` on the
 *      candidate set. Dormant/non-vendor BPs (e.g., "Echo Navigation") and
 *      BPs that would 500 at POST (VendorType null) are dropped pre-pick.
 *
 *   2. Try exact-name match first, then `startswith` only — NEVER `contains`.
 *      Substring contamination ("roson" → "Lectrosonics") is the failure
 *      mode `contains` introduced; stricter matching closes it.
 *
 *   3. Normalised prefix match catches typos with extra whitespace/punct
 *      ("Samwooele" → "SAMWOO ELECO" since normalised "SAMWOOELE" is a
 *      prefix of "SAMWOOELECO..."). Levenshtein-tolerant matching for
 *      character-level typos ("Dethchy"→"Detechy") is a Phase 2 follow-up.
 *
 *   4. When multiple candidates pass, tie-break by recent activity: pick
 *      the BP with the most active VQs in the last 90 days. Uses psql
 *      (lighter than REST $expand). Falls back to shortest-name if no
 *      activity signal.
 *
 *   5. If no candidate passes after filters, return `null` (do NOT silently
 *      mis-pick). The caller routes to `clarify_vendor` / `needs_review`.
 *
 * @param {string} [searchKey] - BP search key (Value field) — preferred path
 * @param {string} [vendorName] - Vendor name for fuzzy fallback
 * @returns {{ id: number, name: string, searchKey: string } | null}
 */
async function resolveBP(searchKey, vendorName) {
  // 0. Curated vendor-alias rewrite — handles acronyms / initialisms that
  //    neither strict normalize nor Levenshtein nor historical-VQ can catch
  //    (e.g., "XJH" → BP 1001909 "Xin Jun Hong (HK) Industry Co., Ltd").
  //    When ONLY a name is supplied (no explicit search-key), check the
  //    curated alias file first; if matched, promote the alias's searchKey
  //    so the search-key path below resolves it exactly. We do NOT rewrite
  //    vendorName to the canonical because canonical names often contain
  //    special chars (parens / commas / periods) that 500 the iDempiere
  //    REST `contains(toupper(Name), '...')` filter.
  //
  //    Skip when searchKey is provided — the caller's explicit-ID path is
  //    the operator's hard override and should never be second-guessed.
  if (!searchKey && vendorName) {
    try {
      const { lookupVendorAlias } = require('./vendor-aliases');
      const alias = lookupVendorAlias(vendorName);
      if (alias && alias.searchKey) {
        searchKey = alias.searchKey;
      }
    } catch (_) { /* alias file unreadable — fall through to normal path */ }
  }

  // 1. Try search key (exact match) — unchanged, preserves the operator-
  //    overridable explicit-ID path used by recovery scripts.
  if (searchKey) {
    if (_bpCache.has(searchKey)) return _bpCache.get(searchKey);

    const result = await apiGet('C_BPartner', { filter: `Value eq '${searchKey}'`, top: 1 });
    if (result.records && result.records.length > 0) {
      const bp = { id: result.records[0].id, name: result.records[0].Name, searchKey };
      _bpCache.set(searchKey, bp);
      if (vendorName) _bpCache.set('name:' + vendorName, bp);
      return bp;
    }
  }

  // 2. Name-based fuzzy with vendor filtering + normalised prefix match
  if (vendorName) {
    const cacheKey = 'name:' + vendorName;
    if (_bpCache.has(cacheKey)) return _bpCache.get(cacheKey);

    const inputUpper = vendorName.toUpperCase();
    const inputNorm = _normalizeBPName(vendorName);
    if (inputNorm.length < 2) {
      // 0 or 1 char of signal — bail.
      _bpCache.set(cacheKey, null);
      return null;
    }
    const escaped = vendorName.replace(/'/g, "''").toUpperCase();

    // Pull candidates via the iDempiere REST API.
    //
    // Two-pass strategy:
    //   Pass 1: Prefer BPs with Chuboe_VendorType_ID set (properly configured vendors)
    //   Pass 2: Fall back to ANY BP if pass 1 misses (VQs can be written against
    //           BPs without vendor type — empirically confirmed June 2026 with
    //           Jabil, TI, Lam Research, eBay all receiving VQs despite null type)
    //
    // Within each pass, use strict client-side scoring so substring contamination
    // ("roson" → "Lectrosonics") can't slip through.
    const vendorFilter = `Chuboe_VendorType_ID gt 0`;
    const anyBpFilter = `IsActive eq 'Y'`;  // fallback: any active BP

    // Pass 1: Try with vendor-type filter (properly configured vendors)
    let result = await apiGet('C_BPartner', {
      filter: `${vendorFilter} and contains(toupper(Name),'${escaped}')`,
      top: 50,
    });
    let candidates = (result.records || []).slice();

    // If the full-string `contains` missed (e.g., "Samwooele" doesn't substring-
    // match "SAMWOO ELECO" because of the space), fall back to a broader query
    // using the input's first 4 alphanumeric chars as the server-side anchor.
    // Client-side scoring (token-prefix / normalised-prefix) still ensures we
    // don't pick a wrong candidate from the broader set.
    if (candidates.length === 0 && inputNorm.length >= 4) {
      const sig = inputNorm.slice(0, 4);
      const result2 = await apiGet('C_BPartner', {
        filter: `${vendorFilter} and contains(toupper(Name),'${sig}')`,
        top: 50,
      });
      candidates = (result2.records || []).slice();
    }

    // Pass 2: If vendor-type filter missed entirely, try ANY active BP.
    // VQs can be written against BPs without vendor type (Jabil, TI, eBay, etc.).
    if (candidates.length === 0) {
      const result3 = await apiGet('C_BPartner', {
        filter: `${anyBpFilter} and contains(toupper(Name),'${escaped}')`,
        top: 50,
      });
      candidates = (result3.records || []).slice();
    }

    // Don't bail yet when candidates is empty — Phase 2 typo-tolerance below
    // runs its own broader server query (`startswith(first 4)`) which can
    // find typo'd candidates the earlier contains-based queries missed (e.g.,
    // "HK Dethchy" → "HK Detechy" where the space breaks the contiguous
    // contains match but startswith picks it up). Phase 2 still gates by
    // levenshtein ≤ 2 so false positives stay out.

    // Score in priority order: exact normalised > literal startswith >
    // token-prefix (input is a prefix of any whitespace-delimited token in
    // the candidate name) > normalised prefix (handles "Samwooele"→"SAMWOO
    // ELECO" via _normalizeBPName-stripped prefix match).
    //
    // Token-prefix specifically excludes substring contamination: "roson" is
    // NOT a token-prefix of "Lectrosonics" (its only token is "Lectrosonics"
    // which doesn't start with "roson"), but IS a token-prefix of "Shenzhen
    // Troson Technology" (the "Troson" token starts with "Troson"). It also
    // handles short queries like "HM" that fail the exact/normalised prefix
    // check against multi-token candidates like "HM Tech Electronic Limited".
    function tokenizeBP(name) {
      return String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    }

    const exactNorm = candidates.find(r => _normalizeBPName(r.Name) === inputNorm);
    if (exactNorm) {
      const bp = { id: exactNorm.id, name: exactNorm.Name, searchKey: exactNorm.Value };
      _bpCache.set(cacheKey, bp);
      _bpCache.set(exactNorm.Value, bp);
      return bp;
    }

    const literalStart = candidates.filter(r => r.Name.toUpperCase().startsWith(inputUpper));
    const tokenStart = candidates.filter(r => tokenizeBP(r.Name).some(t => t.startsWith(inputUpper.replace(/[^A-Z0-9]+/g, ''))));
    const normStart = candidates.filter(r => _normalizeBPName(r.Name).startsWith(inputNorm));

    // Build pool in priority order, dedup by id.
    const seen = new Set();
    const pool = [];
    for (const tier of [literalStart, tokenStart, normStart]) {
      for (const r of tier) {
        if (!seen.has(r.id)) { seen.add(r.id); pool.push(r); }
      }
    }

    // Phase 2 — typo-tolerant fallback (levenshtein on first-token prefix).
    // Handles single-character typos that the strict tiers miss:
    //   • "HK Dethchy" → "HK Detechy CO., LIMITED" (single te→th swap)
    //   • "Louise yen" → "Louis Yen Singapore Pte., Ltd" (extra 'e' on Louis)
    // The strict tiers won't catch these because the normalised input is
    // neither a prefix of the normalised candidate nor a token-prefix.
    //
    // Gate by input length (>=5 alphanumeric chars) to avoid false positives
    // on short inputs where a 2-char edit could swing to any vendor. Server
    // query is `startswith(first 4 of input)` — broad enough to recover both
    // "HK D…" and "LOUI…" patterns, narrow enough to bound cost.
    if (pool.length === 0 && inputNorm.length >= 5) {
      const prefix = inputUpper.replace(/'/g, "''").slice(0, 4);
      try {
        const result3 = await apiGet('C_BPartner', {
          filter: `${anyBpFilter} and startswith(toupper(Name),'${prefix}')`,
          top: 100,
        });
        const candidates3 = (result3.records || []).slice();
        const scored = [];
        for (const r of candidates3) {
          const normCand = _normalizeBPName(r.Name);
          // Compare input against the candidate's normalised name truncated
          // to input length — typos at the START matter, suffix doesn't.
          const truncated = normCand.slice(0, inputNorm.length);
          const d = _levenshtein(inputNorm, truncated, 2);
          if (d <= 2) scored.push({ record: r, distance: d });
        }
        if (scored.length > 0) {
          scored.sort((a, b) => a.distance - b.distance);
          const minDist = scored[0].distance;
          for (const s of scored) {
            if (s.distance === minDist && !seen.has(s.record.id)) {
              seen.add(s.record.id);
              pool.push(s.record);
            }
          }
        }
      } catch (_) { /* server error → fall through, will return null */ }
    }

    if (pool.length === 0) {
      _bpCache.set(cacheKey, null);
      return null;
    }

    // Activity tie-break: prefer the BP with most active VQs in last 90d.
    const best = pool.length === 1 ? pool[0] : _pickByActivity(pool);
    const bp = { id: best.id, name: best.Name, searchKey: best.Value };
    _bpCache.set(cacheKey, bp);
    _bpCache.set(best.Value, bp);
    return bp;
  }

  return null;
}

// Tie-break candidates by recent VQ activity (last 90d active rows). Falls
// back to shortest-name when psql is unavailable or no activity signal.
function _pickByActivity(candidates) {
  try {
    const { execSync } = require('child_process');
    const ids = candidates.map(c => c.id).filter(Boolean);
    if (ids.length === 0) return candidates[0];
    const sql =
      `SELECT c_bpartner_id, COUNT(*) AS vq_count ` +
      `FROM adempiere.chuboe_vq_line ` +
      `WHERE c_bpartner_id IN (${ids.join(',')}) ` +
      `AND created >= (CURRENT_DATE - INTERVAL '90 days') AND isactive='Y' ` +
      `GROUP BY c_bpartner_id ORDER BY vq_count DESC LIMIT 1;`;
    const out = execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
    const line = out.trim().split('\n').filter(Boolean)[0];
    if (line) {
      const [bestId] = line.split('|');
      const match = candidates.find(c => Number(c.id) === Number(bestId));
      if (match) return match;
    }
  } catch (_) { /* fall through */ }
  // No psql / no activity → shortest name (closest to a bare brand)
  return candidates.slice().sort((a, b) => a.Name.length - b.Name.length)[0];
}

/**
 * Batch pre-warm the BP cache. Accepts search keys, vendor names, or both.
 * @param {Array<{searchKey?: string, name?: string}>} vendors
 */
async function resolveBPBatch(vendors) {
  for (const v of vendors) {
    const sk = typeof v === 'string' ? v : v.searchKey;
    const name = typeof v === 'string' ? null : v.name;
    if (sk && _bpCache.has(sk)) continue;
    if (name && _bpCache.has('name:' + name)) continue;
    await resolveBP(sk, name);
  }
  return _bpCache;
}

// ─── MFR LOOKUP ─────────────────────────────────────────────────────────────

const _mfrCache = new Map(); // name -> { id, name }

/**
 * Resolve a Manufacturer ID by name against the target system.
 * Tries exact match first, then contains. Cached for the session.
 */
async function resolveMFR(mfrName) {
  if (!mfrName) return null;
  const cacheKey = mfrName.toUpperCase();
  if (_mfrCache.has(cacheKey)) return _mfrCache.get(cacheKey);

  const escaped = mfrName.replace(/'/g, "''");

  // Try exact match first
  let result = await apiGet('Chuboe_MFR', { filter: `Name eq '${escaped}'`, top: 1 });
  if (result.records && result.records.length > 0) {
    const rec = result.records[0];
    const isSystem = rec.AD_Client_ID?.id === 0;
    const mfr = { id: rec.id, name: rec.Name, isSystem };
    _mfrCache.set(cacheKey, mfr);
    return mfr;
  }

  // Try case-insensitive contains
  const upper = escaped.toUpperCase();
  result = await apiGet('Chuboe_MFR', { filter: `contains(toupper(Name),'${upper}')`, top: 5 });
  if (result.records && result.records.length > 0) {
    const exact = result.records.find(r => r.Name.toUpperCase() === upper);
    const best = exact || result.records.sort((a, b) => a.Name.length - b.Name.length)[0];
    const isSystem = best.AD_Client_ID?.id === 0;
    const mfr = { id: best.id, name: best.Name, isSystem };
    _mfrCache.set(cacheKey, mfr);
    return mfr;
  }

  _mfrCache.set(cacheKey, null);
  return null;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  // Auth
  login,
  logout,
  getToken,

  // CRUD
  apiPost,
  apiGet,
  apiPut,
  apiDelete,
  apiBatch,
  buildNaturalKeyFilter,

  // Lookups
  resolveBP,
  resolveBPBatch,
  resolveMFR,

  // Connectivity
  isApiAvailable,
  resetAvailabilityCache,

  // Constants
  IDEMPIERE_DEFAULTS,
};
