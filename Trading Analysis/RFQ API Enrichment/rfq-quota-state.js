/**
 * DigiKey Quota State — tracks X-RateLimit-Remaining across cron ticks.
 *
 * Written by digikey.js on every API response.
 * Read by enrich-poller.js to decide whether to drain Tier 4 backlog.
 *
 * State file: ~/workspace/.digikey-quota-state.json
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.digikey-quota-state.json');
const STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours

function readQuotaState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeQuotaState(patch) {
  try {
    const current = readQuotaState() || {};
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // best effort — never crash the caller
  }
}

/**
 * Is DigiKey currently blocked by a 429 Retry-After?
 */
function isQuotaBlocked() {
  const state = readQuotaState();
  if (!state || !state.retryAfter) return false;
  return new Date(state.retryAfter) > new Date();
}

/**
 * Do we have enough daily quota to justify draining Tier 4 backlog?
 * Returns true if remaining > minRequired, OR if state is unknown/stale
 * (let it try — DigiKey will 429 if needed, and that's handled by Bucket A).
 */
function hasAdequateQuota(minRequired = 50) {
  const state = readQuotaState();
  if (!state) return true; // unknown → optimistic
  // Stale state (>2h old) → treat as unknown
  if (state.updatedAt && (Date.now() - new Date(state.updatedAt).getTime() > STALENESS_MS)) {
    return true;
  }
  if (state.remainingCalls == null) return true;
  return state.remainingCalls > minRequired;
}

module.exports = { readQuotaState, writeQuotaState, isQuotaBlocked, hasAdequateQuota, STATE_FILE };
