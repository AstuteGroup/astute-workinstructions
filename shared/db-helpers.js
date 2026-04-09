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

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────

/**
 * Run a psql query and return raw output.
 * Filters out rbash noise lines.
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
};
