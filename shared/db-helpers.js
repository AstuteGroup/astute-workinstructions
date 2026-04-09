/**
 * Shared Database Helpers for ai_writeback operations
 *
 * Extracted from offer-writeback.js for reuse across:
 *   - offer-writeback.js (market offers)
 *   - rfq-writer.js (RFQ records)
 *   - api-result-writer.js (franchise API pricing results)
 *
 * USAGE:
 *   const { psqlQuery, psqlExec, getNextId, sqlStr, sqlNum, cleanMpn } = require('../shared/db-helpers');
 */

const { execSync } = require('child_process');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const MIN_ID = 9000000;

const IDEMPIERE_DEFAULTS = {
  ad_client_id: 1000000,
  ad_org_id: 0,
  isactive: 'Y',
  createdby: 1000004,  // Jake Harris
  updatedby: 1000004,
};

// ─── INFRASTRUCTURE ERROR DETECTION ──────────────────────────────────────────

/**
 * Classify a thrown error from execSync('psql ...') as either:
 *   - INFRASTRUCTURE BROKEN (auth failed, connection refused, psql missing,
 *     permission denied, network error, etc.) → callers MUST re-throw or
 *     surface loudly. Returning null/empty would silently degrade upstream
 *     consumers (e.g., vq-writer's MFR resolution returning null, then the
 *     writer treating that as "no MFR found" instead of "lookup is broken").
 *   - DATA / NO-RESULT (empty result set, parse error on returned rows,
 *     SQL syntax error in caller's query, etc.) → safe for the caller to
 *     swallow and return null/empty.
 *
 * Discovered the hard way 2026-04-09: cron-launched enrich-poller had
 * shared/mfr-lookup.js calling psql under a no-PGUSER environment. psql
 * failed with "fe_sendauth: no password supplied", mfr-lookup caught it and
 * returned null, vq-writer treated null as "no MFR" and silently degraded.
 * The cron tick reported "0 errors" because no exception bubbled up. This
 * helper is the structural protection so the next infra failure can't hide
 * the same way — callers MUST distinguish "lookup ran cleanly, no match"
 * from "lookup couldn't run."
 *
 * @param {Error} e - Caught exception from execSync('psql ...')
 * @returns {boolean} true if the error indicates broken infrastructure
 */
function isInfrastructureError(e) {
  if (!e) return false;
  // execSync failures expose stderr on the error object
  const haystack = String(
    (e.stderr || '') + '\n' +
    (e.stdout || '') + '\n' +
    (e.message || '')
  );
  // Patterns that mean "the call couldn't reach a working DB":
  //   - libpq auth/connection failures
  //   - missing binary
  //   - filesystem permission issues on the unix socket
  //   - process termination from environment (timeout, killed)
  return /fe_sendauth|no password supplied|password authentication failed|connection (refused|to server.*failed|terminated)|could not connect|psql: command not found|permission denied|FATAL:|server closed the connection unexpectedly|SSL error|timeout/i.test(haystack);
}

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────

/**
 * Run a psql query and return raw output.
 * Filters out rbash noise lines.
 *
 * THROWS on infrastructure errors (auth/connection/etc.) so callers can't
 * confuse "lookup is broken" with "lookup returned no rows." Swallows data
 * errors (parse failures, SQL syntax) and returns whatever stdout was
 * captured — same legacy behavior for the not-our-problem cases.
 */
function psqlQuery(sql, timeout = 15000) {
  try {
    // -U analytics_user is required under cron (cron doesn't pass $USER)
    const result = execSync(`psql -U analytics_user -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout,
    });
    const lines = result.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') &&
             !t.includes('/dev/null') && !t.includes('restricted:') &&
             !t.includes('/tmp/claude');
    });
    return lines.join('\n').trim();
  } catch (e) {
    if (isInfrastructureError(e)) {
      // Re-throw with a clearly tagged error so callers see it as a broken-
      // infrastructure failure, not a no-result. Preserves the original
      // stderr in the message for diagnostics.
      const stderr = String(e.stderr || e.message || '').trim().split('\n').slice(0, 3).join(' ');
      const wrapped = new Error(`psql infrastructure failure: ${stderr}`);
      wrapped.code = 'PSQL_INFRA';
      wrapped.cause = e;
      throw wrapped;
    }
    const combined = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    const lines = combined.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('rbash') && !t.includes('bashrc') &&
             !t.includes('/dev/null') && !t.includes('restricted:') &&
             !t.includes('/tmp/claude') && !t.includes('ERROR:');
    });
    return lines.join('\n').trim();
  }
}

/**
 * Run an INSERT/UPDATE statement. Returns true on success.
 */
function psqlExec(sql, timeout = 15000) {
  try {
    // -U analytics_user is required under cron (cron doesn't pass $USER)
    const result = execSync(`psql -U analytics_user -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout,
    });
    return result.includes('INSERT') || result.includes('UPDATE') || result.includes('DELETE');
  } catch (e) {
    if (isInfrastructureError(e)) {
      // Don't silently report failure as "false" — that hides the broken
      // infrastructure. Re-throw so callers see the real problem.
      const stderr = String(e.stderr || e.message || '').trim().split('\n').slice(0, 3).join(' ');
      const wrapped = new Error(`psql infrastructure failure: ${stderr}`);
      wrapped.code = 'PSQL_INFRA';
      wrapped.cause = e;
      throw wrapped;
    }
    return false;
  }
}

// ─── ID MANAGEMENT ───────────────────────────────────────────────────────────

/**
 * Get the next safe ID for a given ai_writeback table/column.
 * Returns MAX(existing) + 1, or MIN_ID if table is empty.
 */
function getNextId(table, column) {
  const result = psqlQuery(`SELECT COALESCE(MAX(${column}), ${MIN_ID - 1}) FROM ai_writeback.${table}`);
  const maxId = parseInt(result, 10);
  if (isNaN(maxId) || maxId < MIN_ID) return MIN_ID;
  return maxId + 1;
}

// ─── SQL VALUE HELPERS ───────────────────────────────────────────────────────

function sqlStr(val) {
  if (val === null || val === undefined || val === '') return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sqlNum(val) {
  if (val === null || val === undefined || val === '') return 'NULL';
  const n = Number(val);
  return isNaN(n) ? 'NULL' : String(n);
}

// ─── MPN CLEANING ────────────────────────────────────────────────────────────

/**
 * Clean an MPN by removing non-alphanumeric characters (matching iDempiere behavior).
 */
function cleanMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Check if an ai_writeback table exists.
 * Returns true if the table exists, false otherwise.
 */
function tableExists(tableName) {
  const result = psqlQuery(
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'ai_writeback' AND table_name = '${tableName}'`
  );
  return result.trim() === '1';
}

module.exports = {
  MIN_ID,
  IDEMPIERE_DEFAULTS,
  psqlQuery,
  psqlExec,
  getNextId,
  sqlStr,
  sqlNum,
  cleanMpn,
  tableExists,
  isInfrastructureError,
};
