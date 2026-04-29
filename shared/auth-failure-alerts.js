/**
 * Franchise API Auth-Failure Alerting
 *
 * Detects authentication-failure errors from any franchise distributor API
 * and emails the operator. 24h debounce per disty so a sustained outage
 * generates one alert — not a flood.
 *
 * Integrated once in shared/franchise-api.js::searchPart so ALL 10 distys
 * benefit. No per-cog changes needed.
 *
 * Why this exists: Mouser silently auth-failed for 3 days (Apr 14-17, 2026)
 * and nobody knew until a cache audit revealed it. The hardcoded fallback
 * key had been rotated by Mouser, but our cron kept calling it and writing
 * "Unauthorized" to the cache as if it were business-as-usual. That outage
 * alone wasted ~21K cache slots and cost us days of Mouser coverage.
 *
 * Recognized signals (case-insensitive):
 *   - "unauthorized"
 *   - "check api key"
 *   - "invalid_client" / "invalid_grant" / "access_denied" (OAuth)
 *   - "401" / "403" (HTTP status codes surfaced in messages)
 *   - "api key not configured" / "api key missing" / "api key invalid"
 *
 * Does NOT alert on:
 *   - 429 / rate limit (handled by retry queue)
 *   - 5xx upstream errors
 *   - Timeouts
 *   - Parse errors / our own code bugs
 *
 * Debounce state: shared/data/auth-failure-state.json
 *   {
 *     "digikey": { count: 0, lastAlertAt: 1776700000000,
 *                  lastFailureAt: ..., lastMpn: "...", lastError: "..." },
 *     "mouser": { ... },
 *     ...
 *   }
 *
 * After auth is restored, clear the state manually (or delete the file) so
 * the next failure event can re-alert.
 */

const path = require('path');
const fs = require('fs');

const STATE_FILE = path.resolve(__dirname, 'data/auth-failure-state.json');
const DEBOUNCE_MS = 24 * 60 * 60 * 1000;  // 24 hours
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';

// Sender: excess@ is unblocked (vortex@ has been bouncing since ~2026-04-18
// per project_vortex_sender_blocked.md). Auth alerts are low-volume so we
// don't need the verified-send fallback dance.
const ALERT_FROM = process.env.AUTH_ALERT_FROM || 'excess@orangetsunami.com';
const ALERT_FROM_NAME = 'Franchise API Auth Monitor';

// Detection patterns — kept deliberately broad. False positives generate
// one extra email per 24h per disty; false negatives = silent outage.
const AUTH_PATTERNS = [
  /unauthoriz/i,
  /check\s*API\s*key/i,
  /\binvalid_client\b/i,
  /\binvalid_grant\b/i,
  /\baccess_denied\b/i,
  /\bforbidden\b/i,
  /\b401\b/,
  /\b403\b/,
  /API[\s_-]?key\s+(not\s+configured|missing|empty|invalid|unset|required)/i,
];

function looksLikeAuthFailure(error) {
  if (!error) return false;
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  if (!msg) return false;
  return AUTH_PATTERNS.some(p => p.test(msg));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return {}; }
}

function writeState(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch { /* don't block the API call on persistence failure */ }
}

let _notifier = null;
function getNotifier() {
  if (_notifier) return _notifier;
  try {
    const { createNotifier } = require('./notifier');
    _notifier = createNotifier({ fromEmail: ALERT_FROM, fromName: ALERT_FROM_NAME });
  } catch {
    _notifier = false;  // mark unavailable
  }
  return _notifier;
}

/**
 * Check an error against auth patterns. If it looks like an auth failure:
 *   - Update the per-disty counter + lastFailure timestamps (always)
 *   - If outside the 24h debounce window, send an alert email
 *
 * Never throws. Never blocks. Email send failures are swallowed.
 *
 * @param {object} opts
 * @param {string} opts.distributor - 'digikey' | 'mouser' | ... (franchise-api.js key)
 * @param {Error|string} opts.error - The error thrown / set on result.error
 * @param {string} [opts.mpn] - Part being searched (for context in email)
 * @returns {Promise<boolean>} - true if alert was sent, false if debounced or non-auth
 */
async function alertIfAuthFailure({ distributor, error, mpn }) {
  if (!looksLikeAuthFailure(error)) return false;

  const now = Date.now();
  const msg = typeof error === 'string' ? error : (error?.message || String(error));
  const state = readState();
  const entry = state[distributor] = state[distributor] || { count: 0, firstFailureAt: now };

  // Always record the failure so we can count + audit
  entry.count = (entry.count || 0) + 1;
  entry.lastFailureAt = now;
  entry.lastMpn = mpn || null;
  entry.lastError = msg.slice(0, 300);
  if (!entry.firstFailureAt) entry.firstFailureAt = now;

  const last = entry.lastAlertAt || 0;
  if (now - last < DEBOUNCE_MS) {
    writeState(state);
    return false;
  }

  // Outside debounce — send alert
  const notifier = getNotifier();
  if (!notifier) { writeState(state); return false; }

  const subject = `Franchise API auth failure: ${distributor.toUpperCase()}`;
  const sinceFirst = entry.firstFailureAt
    ? Math.round((now - entry.firstFailureAt) / (60 * 1000))
    : 0;
  const body = [
    `${distributor.toUpperCase()} API returned an authentication-style error.`,
    '',
    `Error:            ${entry.lastError}`,
    `Sample MPN:       ${entry.lastMpn || '(none)'}`,
    `Failures counted: ${entry.count} (since first detection ${sinceFirst}min ago)`,
    `First detected:   ${new Date(entry.firstFailureAt).toISOString()}`,
    `Last detected:    ${new Date(now).toISOString()}`,
    '',
    'This alert is debounced — no further ' + distributor + ' alerts for 24h.',
    '',
    'Likely causes:',
    '  - Credential was rotated by the distributor',
    '  - .env variable was wiped or not populated in this environment',
    '  - Hardcoded fallback key expired',
    '',
    'After restoring auth, clear state to re-arm the alert:',
    `  rm ${STATE_FILE}`,
    '  (or edit out the "' + distributor + '" block)',
    '',
    'Detection logic lives in shared/auth-failure-alerts.js.',
  ].join('\n');

  try {
    await notifier.sendEmail(OPERATOR_EMAIL, subject, body);
    entry.lastAlertAt = now;
    entry.count = 0;  // reset counter after successful alert; next 24h starts clean
    entry.firstFailureAt = now;
    writeState(state);
    return true;
  } catch {
    writeState(state);
    return false;
  }
}

module.exports = {
  looksLikeAuthFailure,
  alertIfAuthFailure,
  _STATE_FILE: STATE_FILE,
  _OPERATOR_EMAIL: OPERATOR_EMAIL,
  _AUTH_PATTERNS: AUTH_PATTERNS,
};
