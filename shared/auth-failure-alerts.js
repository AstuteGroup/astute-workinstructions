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
// Flap-suppression window: if a "recovery" lands within this window of the
// alert email, treat the cycle as a flap — suppress the recovery email AND
// preserve lastAlertAt so the next failure stays debounced. Without this, a
// disty that auth-flaps 12× during a burst run sends 24 emails (alert + recovery
// each cycle). Observed 2026-05-05 with Mouser at concurrency=4.
const FLAP_WINDOW_MS = 15 * 60 * 1000;  // 15 min
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

/**
 * Mark a distributor as successful. If we previously had an open failure
 * state (an alert had been sent and not yet cleared), record the recovery,
 * fire ONE recovery email, and remove the state entry.
 *
 * Why this exists: pre-2026-05-05 the alerter only mutated state on failure
 * detection. `firstFailureAt` was reset on each successful alert send, but
 * never cleared on disty recovery. Result: an alert at T0 on day 1 would
 * leave `firstFailureAt = T0`. If the disty recovered, ran clean for 4 days,
 * then auth-failed again on day 5, the day-5 alert email body still showed
 * "First detected: <T0 four days ago>" because `if (!entry.firstFailureAt)`
 * never re-armed. Operator reads "failing for 4 days" when really it's
 * "failed briefly twice with a 4-day gap."
 *
 * Recognized recovery: state[disty] exists AND has either an alerted failure
 * (lastAlertAt set) OR a recent failure (lastFailureAt within 24h). On any
 * other state, this is a no-op (don't spam recovery emails for distys that
 * never alerted).
 *
 * Never throws. Email send failures are swallowed; the state is cleared
 * regardless so the next failure cycle starts clean.
 *
 * @param {object} opts
 * @param {string} opts.distributor - 'digikey' | 'mouser' | ...
 * @returns {Promise<boolean>} - true if a recovery was processed, false if no-op
 */
async function noteAuthSuccess({ distributor }) {
  if (!distributor) return false;
  const state = readState();
  const entry = state[distributor];
  if (!entry) return false;

  // Only treat as a recovery if we'd previously alerted, OR if the failure
  // is recent enough that the operator was actively watching for it.
  const now = Date.now();
  const wasAlerted = !!entry.lastAlertAt;
  const recentFailure = entry.lastFailureAt && (now - entry.lastFailureAt) < 24 * 60 * 60 * 1000;
  if (!wasAlerted && !recentFailure) {
    // Stale entry that never alerted and is >24h old — clear silently
    delete state[distributor];
    writeState(state);
    return false;
  }

  // Flap-suppression: if the alert was sent very recently (within FLAP_WINDOW_MS),
  // this is likely a transient flap rather than a sustained recovery. Suppress the
  // recovery email AND preserve `lastAlertAt` so the next failure stays debounced
  // (alertIfAuthFailure gates on entry.lastAlertAt). Without this, alert+recovery
  // pairs fire on every flap cycle — observed 2026-05-05 with Mouser flapping
  // ~12× during a burst run, generating ~24 emails.
  if (wasAlerted && (now - entry.lastAlertAt) < FLAP_WINDOW_MS) {
    entry.lastSilentRecoveryAt = now;
    entry.flapCount = (entry.flapCount || 0) + 1;
    writeState(state);
    return true;
  }

  // Snapshot for the email body before we wipe the entry
  const summary = {
    firstFailureAt: entry.firstFailureAt,
    lastFailureAt: entry.lastFailureAt,
    failureCount: entry.count,
    lastError: entry.lastError,
    lastAlertAt: entry.lastAlertAt,
    flapCount: entry.flapCount || 0,
  };

  // Always clear state — recovery is "starting clean"
  delete state[distributor];
  writeState(state);

  // Only email if we'd previously alerted (otherwise nothing to "recover from")
  if (!wasAlerted) return true;

  // Skip the recovery email for stale state (>48h since last failure). The
  // entry is more likely "Waldom hasn't been called in a week" than "Waldom
  // recovered" and the email would mislead. State is still cleared above so
  // the next genuine outage cycle starts fresh.
  if (summary.lastFailureAt && (now - summary.lastFailureAt) > 48 * 60 * 60 * 1000) {
    return true;
  }

  const notifier = getNotifier();
  if (!notifier) return true;

  const durationMin = summary.firstFailureAt && summary.lastFailureAt
    ? Math.max(0, Math.round((summary.lastFailureAt - summary.firstFailureAt) / 60000))
    : 0;
  const recoveredAfterMin = summary.lastFailureAt
    ? Math.round((now - summary.lastFailureAt) / 60000)
    : 0;
  const subject = `Franchise API auth recovered: ${distributor.toUpperCase()}`;
  const body = [
    `${distributor.toUpperCase()} API is responding successfully again.`,
    '',
    `Recovered at:    ${new Date(now).toISOString()}`,
    `Last failure:    ${summary.lastFailureAt ? new Date(summary.lastFailureAt).toISOString() : '(unknown)'}`,
    `Quiet for:       ${recoveredAfterMin} min before this success`,
    `First detected:  ${summary.firstFailureAt ? new Date(summary.firstFailureAt).toISOString() : '(unknown)'}`,
    `Failure span:    ${durationMin} min from first to last detection`,
    `Failures during outage: ${summary.failureCount || 0}`,
    `Silent flap cycles suppressed: ${summary.flapCount}`,
    `Last error:      ${summary.lastError || '(none)'}`,
    '',
    'State has been cleared — the next auth failure on ' + distributor + ' will alert immediately.',
    '',
    'Source: shared/auth-failure-alerts.js noteAuthSuccess()',
  ].join('\n');

  try {
    await notifier.sendEmail(OPERATOR_EMAIL, subject, body);
  } catch { /* best effort */ }
  return true;
}

module.exports = {
  looksLikeAuthFailure,
  alertIfAuthFailure,
  noteAuthSuccess,
  _STATE_FILE: STATE_FILE,
  _OPERATOR_EMAIL: OPERATOR_EMAIL,
  _AUTH_PATTERNS: AUTH_PATTERNS,
};
