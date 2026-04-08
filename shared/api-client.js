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
 * Make an authenticated HTTP request with retry logic.
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path relative to BASE_URL (e.g., '/models/c_bpartner')
 * @param {object|null} body - Request body (for POST/PUT)
 * @param {number} attempt - Current retry attempt
 * @returns {Promise<object>} Parsed JSON response
 */
async function request(method, urlPath, body = null, attempt = 1) {
  const token = await getToken();
  const url = `${BASE_URL}${urlPath}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (networkError) {
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`Network error on ${method} ${urlPath}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}): ${networkError.message}`);
      await sleep(delay);
      return request(method, urlPath, body, attempt + 1);
    }
    throw new Error(`api-client network error after ${MAX_RETRIES} attempts: ${networkError.message}`);
  }

  // Handle 401 — token expired, refresh and retry once
  if (res.status === 401 && attempt === 1) {
    logger.debug('Got 401, refreshing token and retrying');
    await refreshTokenFn();
    return request(method, urlPath, body, attempt + 1);
  }

  // Handle 5xx — retry with backoff
  if (res.status >= 500 && attempt < MAX_RETRIES) {
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    logger.warn(`Server error ${res.status} on ${method} ${urlPath}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
    await sleep(delay);
    return request(method, urlPath, body, attempt + 1);
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
 * Create a record via POST.
 * Automatically includes IDEMPIERE_DEFAULTS fields.
 *
 * @param {string} table - Table name (e.g., 'chuboe_rfq', 'c_bpartner')
 * @param {object} payload - Record fields (without standard iDempiere fields)
 * @param {object} [options]
 * @param {boolean} [options.includeDefaults=true] - Include IDEMPIERE_DEFAULTS in payload
 * @returns {Promise<object>} Created record with server-assigned ID
 */
async function apiPost(table, payload, options = {}) {
  const { includeDefaults = true } = options;

  const body = includeDefaults
    ? { ...IDEMPIERE_DEFAULTS, ...payload }
    : { ...payload };

  const result = await request('POST', `/models/${table}`, body);
  logger.debug(`Created ${table} record: id=${result.id || 'unknown'}`);
  return result;
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
 * @returns {Promise<object>} Updated record
 */
async function apiPut(table, id, payload) {
  const body = { ...payload };
  const result = await request('PUT', `/models/${table}/${id}`, body);
  logger.debug(`Updated ${table}/${id}`);
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
 * @returns {Promise<object>} Batch response
 */
async function apiBatch(operations) {
  const result = await request('POST', '/batch', operations);
  logger.debug(`Batch executed: ${operations.length} operations`);
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
 * Resolve a Business Partner. Tries search key first, then name.
 * Cached for the session — one API call per unique lookup.
 *
 * @param {string} [searchKey] - BP search key (Value field)
 * @param {string} [vendorName] - Vendor name for fallback lookup
 * @returns {{ id: number, name: string, searchKey: string } | null}
 */
async function resolveBP(searchKey, vendorName) {
  // 1. Try search key (exact match)
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

  // 2. Try name (contains match)
  if (vendorName) {
    const cacheKey = 'name:' + vendorName;
    if (_bpCache.has(cacheKey)) return _bpCache.get(cacheKey);

    const escaped = vendorName.replace(/'/g, "''").toUpperCase();

    // Try startswith first (more precise than contains)
    let result = await apiGet('C_BPartner', { filter: `startswith(toupper(Name),'${escaped}')`, top: 5 });

    // If no startswith match, fall back to contains
    if (!result.records || result.records.length === 0) {
      result = await apiGet('C_BPartner', { filter: `contains(toupper(Name),'${escaped}')`, top: 5 });
    }

    // For short names (< 4 chars), also try with space/hyphen variants
    if ((!result.records || result.records.length === 0) && vendorName.length <= 6) {
      // Try with spaces (e.g., "DD" -> "D D", or just accept it won't match)
      // Short names are inherently ambiguous — flag for manual review
    }

    if (result.records && result.records.length > 0) {
      // Prefer: exact name match > startswith > shortest name
      const upper = vendorName.toUpperCase();
      const exact = result.records.find(r => r.Name.toUpperCase() === upper);
      const starts = result.records.find(r => r.Name.toUpperCase().startsWith(upper));
      const best = exact || starts || result.records.sort((a, b) => a.Name.length - b.Name.length)[0];
      const bp = { id: best.id, name: best.Name, searchKey: best.Value };
      _bpCache.set(cacheKey, bp);
      _bpCache.set(best.Value, bp);
      return bp;
    }
    _bpCache.set(cacheKey, null);
  }

  return null;
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
