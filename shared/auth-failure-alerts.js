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
// Option A — outage-bracketed alerting (introduced 2026-05-06):
//
// MIN_OUTAGE_MS_FOR_RECOVERY_EMAIL — only send the "Auth recovered" email if
//   the failure-to-recovery span was at least this long. Shorter outages clear
//   state silently (no email). Default 30 min suppresses flap noise where
//   Mouser-style transient 401s clear within minutes.
//
// MIN_CLEAN_MS_BEFORE_STATE_CLEAR — after a failure event, the alerter waits
//   this long of sustained successful responses before considering the disty
//   recovered. The first clean response after a failure sets `firstCleanAt`;
//   subsequent successes within the window are no-ops; a new failure clears
//   `firstCleanAt` and restarts the observation window. Default 4h matches
//   typical quota windows + flap cycles we've seen.
//
// The legacy FLAP_WINDOW_MS (15 min) was a single-knob version of this and
// only caught very tight bursts. Yesterday's 6h-apart Mouser flaps slipped
// straight through it, generating alert/recovery email pairs.
const MIN_OUTAGE_MS_FOR_RECOVERY_EMAIL = 30 * 60 * 1000;   // 30 min
const MIN_CLEAN_MS_BEFORE_STATE_CLEAR  = 4 * 60 * 60 * 1000; // 4 h
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

// Advisory file lock around the read-decide-write critical section. Without
// this, two concurrent processes can both read empty state, both pass the
// debounce check, both send emails, both write state — observed twice now
// (2026-05-05 and 2026-05-06) when enrich-poller hit Mouser's per-minute
// rate limit on parallel calls. The lock holds only during the state mutation;
// email send happens after release so the lock is short-lived.
const LOCK_FILE = STATE_FILE + '.lock';
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 40; // ~1s total wait

function acquireLock() {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_CREAT | O_EXCL — atomically create the lock file or fail
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      // Stale-lock check: if the holder process is gone, steal it
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 30 * 1000) {
          // Lock older than 30s → assume crashed holder, remove and retry
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch { /* lock disappeared while we were looking — race winner, retry */ }
      // Synchronous busy-wait so the function stays sync (callers may not await)
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* best effort */ }
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

  let shouldEmail = false;
  let snapshot = null;
  let oldLastAlertAt = null;

  // CRITICAL SECTION — lock around read-decide-write so concurrent callers
  // don't both pass the debounce check. We mark `lastAlertAt = now` BEFORE
  // releasing the lock so any process that arrives 1ms later sees it set
  // and stays debounced.
  if (!acquireLock()) {
    // Couldn't acquire — assume another process owns the alert path right
    // now. Skip cleanly; the failure is still logged via wrapper-level
    // diagnostics so we don't lose audit trail.
    return false;
  }
  try {
    const state = readState();

    // Manual mute: state[disty].suppressed = true silences both failure and
    // recovery alerts until the operator clears the flag.
    if (state[distributor]?.suppressed) {
      state[distributor].count = (state[distributor].count || 0) + 1;
      state[distributor].lastFailureAt = now;
      state[distributor].lastMpn = mpn || null;
      state[distributor].lastError = msg.slice(0, 300);
      writeState(state);
      return false;
    }

    const entry = state[distributor] = state[distributor] || { count: 0, firstFailureAt: now };
    entry.count = (entry.count || 0) + 1;
    entry.lastFailureAt = now;
    entry.lastMpn = mpn || null;
    entry.lastError = msg.slice(0, 300);
    if (!entry.firstFailureAt) entry.firstFailureAt = now;

    // Option A: a new failure during the post-failure observation window resets
    // the sustained-clean clock.
    if (entry.firstCleanAt) delete entry.firstCleanAt;

    const last = entry.lastAlertAt || 0;
    if (now - last < DEBOUNCE_MS) {
      writeState(state);
      return false;
    }

    // Claim the alert NOW (before email send) so concurrent callers see
    // lastAlertAt set and bail. If email send fails below, we'll roll this
    // back to keep the next failure able to alert.
    oldLastAlertAt = entry.lastAlertAt || null;
    entry.lastAlertAt = now;
    snapshot = { ...entry };
    writeState(state);
    shouldEmail = true;
  } finally {
    releaseLock();
  }

  if (!shouldEmail) return false;

  const notifier = getNotifier();
  if (!notifier) return false;

  const subject = `Franchise API auth failure: ${distributor.toUpperCase()}`;
  const sinceFirst = snapshot.firstFailureAt
    ? Math.round((now - snapshot.firstFailureAt) / (60 * 1000))
    : 0;
  const body = [
    `${distributor.toUpperCase()} API returned an authentication-style error.`,
    '',
    `Error:            ${snapshot.lastError}`,
    `Sample MPN:       ${snapshot.lastMpn || '(none)'}`,
    `Failures counted: ${snapshot.count} (since first detection ${sinceFirst}min ago)`,
    `First detected:   ${new Date(snapshot.firstFailureAt).toISOString()}`,
    `Last detected:    ${new Date(now).toISOString()}`,
    '',
    'This alert is debounced — no further ' + distributor + ' alerts for 24h.',
    '',
    'Likely causes:',
    '  - Credential was rotated by the distributor',
    '  - .env variable was wiped or not populated in this environment',
    '  - Hardcoded fallback key expired',
    '  - Per-minute / daily quota hit (see ~/workspace/.api-failures.ndjson for category)',
    '',
    'After restoring auth, clear state to re-arm the alert:',
    `  rm ${STATE_FILE}`,
    '  (or edit out the "' + distributor + '" block)',
    '',
    'Detection logic lives in shared/auth-failure-alerts.js.',
  ].join('\n');

  try {
    await notifier.sendEmail(OPERATOR_EMAIL, subject, body);
    // Email sent — under another brief lock, reset count for next 24h cycle
    if (acquireLock()) {
      try {
        const state = readState();
        if (state[distributor]) {
          state[distributor].count = 0;
          state[distributor].firstFailureAt = now;
        }
        writeState(state);
      } finally {
        releaseLock();
      }
    }
    return true;
  } catch {
    // Email send failed — roll back lastAlertAt so the next failure can re-alert
    if (acquireLock()) {
      try {
        const state = readState();
        if (state[distributor]) {
          state[distributor].lastAlertAt = oldLastAlertAt;
          writeState(state);
        }
      } finally {
        releaseLock();
      }
    }
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

  // Manual mute: leave state intact, no recovery email. Otherwise a transient
  // success during a known outage would wipe state, then the next failure
  // would re-fire the failure email — exactly the blast loop the mute exists
  // to prevent.
  if (entry.suppressed) return false;

  const now = Date.now();
  const wasAlerted = !!entry.lastAlertAt;
  const recentFailure = entry.lastFailureAt && (now - entry.lastFailureAt) < 24 * 60 * 60 * 1000;

  // Stale entry that never alerted and is >24h old — clear silently
  if (!wasAlerted && !recentFailure) {
    delete state[distributor];
    writeState(state);
    return false;
  }

  // Option A — sustained-clean observation window:
  //
  // The first clean response after a failure starts the observation window
  // (firstCleanAt). Subsequent successes within MIN_CLEAN_MS_BEFORE_STATE_CLEAR
  // are no-ops. A new failure clears firstCleanAt (handled in alertIfAuthFailure).
  //
  // Only when the window completes do we evaluate whether to send a recovery
  // email and clear state. This is what stops the alert/recovery email
  // ping-pong: a brief 5-min recovery doesn't immediately wipe the alert
  // state, so when the disty fails again 10 min later it's still inside the
  // 24h alert debounce.
  if (!entry.firstCleanAt) {
    entry.firstCleanAt = now;
    writeState(state);
    return false;  // observation window started
  }
  if (now - entry.firstCleanAt < MIN_CLEAN_MS_BEFORE_STATE_CLEAR) {
    return false;  // still in observation window — no state change, no email
  }

  // Sustained clean window achieved. Snapshot for email body before clearing.
  const summary = {
    firstFailureAt: entry.firstFailureAt,
    lastFailureAt: entry.lastFailureAt,
    failureCount: entry.count,
    lastError: entry.lastError,
    lastAlertAt: entry.lastAlertAt,
    firstCleanAt: entry.firstCleanAt,
  };

  delete state[distributor];
  writeState(state);

  // Only email if we'd previously alerted (otherwise nothing to "recover from")
  if (!wasAlerted) return true;

  // Skip recovery email for stale state (>48h since last failure)
  if (summary.lastFailureAt && (now - summary.lastFailureAt) > 48 * 60 * 60 * 1000) {
    return true;
  }

  // Option A — min outage duration gate. Outages shorter than this clear
  // state silently. Stops flap-recovery emails from filling the inbox.
  const outageDurationMs = (summary.lastFailureAt || now) - (summary.firstFailureAt || now);
  if (outageDurationMs < MIN_OUTAGE_MS_FOR_RECOVERY_EMAIL) {
    return true;
  }

  const notifier = getNotifier();
  if (!notifier) return true;

  const durationMin = Math.max(0, Math.round(outageDurationMs / 60000));
  const cleanForMin = Math.round((now - summary.firstCleanAt) / 60000);
  const subject = `Franchise API auth recovered: ${distributor.toUpperCase()}`;
  const body = [
    `${distributor.toUpperCase()} API has been responding successfully for ${cleanForMin}+ min.`,
    '',
    `Recovered at:           ${new Date(now).toISOString()}`,
    `First clean response:   ${new Date(summary.firstCleanAt).toISOString()}`,
    `Outage span:            ${durationMin} min (first failure → last failure)`,
    `Failures during outage: ${summary.failureCount || 0}`,
    `First failure detected: ${summary.firstFailureAt ? new Date(summary.firstFailureAt).toISOString() : '(unknown)'}`,
    `Last failure detected:  ${summary.lastFailureAt ? new Date(summary.lastFailureAt).toISOString() : '(unknown)'}`,
    `Last error:             ${summary.lastError || '(none)'}`,
    '',
    'State has been cleared — the next auth failure on ' + distributor + ' will alert immediately.',
    '',
    'Source: shared/auth-failure-alerts.js noteAuthSuccess() (Option A: outage-bracketed alerting)',
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
