/**
 * OT Health Probe — cheap pre-flight check before any cron job that writes to OT.
 *
 * Purpose: distinguish "OT is down" from "the job logic itself failed" so the
 * cron-runner can exit cleanly without advancing the sentinel during a 503.
 *
 * Usage:
 *   const { probeOT } = require('../shared/ot-health');
 *   const health = await probeOT();
 *   if (!health.up) { ... skip the run, sentinel stays put ... }
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { Agent } = require('undici');

const PROBE_TIMEOUT_MS = 5000;

/**
 * GET the OT API root and inspect the response. We treat 5xx, network errors,
 * and timeouts as "down". Anything else (including 401/404) is "up" — auth
 * errors mean the server is responding, which is what the runner cares about.
 *
 * @returns {Promise<{up: boolean, statusCode: number|null, ms: number, reason: string}>}
 */
async function probeOT() {
  const baseUrl = process.env.IDEMPIERE_BASE_URL;
  if (!baseUrl) {
    return { up: false, statusCode: null, ms: 0, reason: 'IDEMPIERE_BASE_URL not set' };
  }

  // Self-signed cert on prod — same trick as api-client.js but scoped to this probe.
  const dispatcher = baseUrl.startsWith('https://')
    ? new Agent({ connect: { rejectUnauthorized: false }, headersTimeout: PROBE_TIMEOUT_MS, bodyTimeout: PROBE_TIMEOUT_MS })
    : undefined;

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      dispatcher,
    });
    const ms = Date.now() - start;

    if (res.status >= 500) {
      return { up: false, statusCode: res.status, ms, reason: `HTTP ${res.status} from OT` };
    }
    return { up: true, statusCode: res.status, ms, reason: 'OK' };
  } catch (err) {
    const ms = Date.now() - start;
    const reason = err.name === 'TimeoutError' || err.code === 'UND_ERR_HEADERS_TIMEOUT'
      ? `timeout after ${ms}ms`
      : `${err.code || err.name}: ${err.message}`;
    return { up: false, statusCode: null, ms, reason };
  }
}

module.exports = { probeOT };

// CLI: `node shared/ot-health.js` for ad-hoc checks
if (require.main === module) {
  probeOT().then((h) => {
    console.log(JSON.stringify(h, null, 2));
    process.exit(h.up ? 0 : 1);
  });
}
