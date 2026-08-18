/**
 * shared/safe-update.js
 *
 * Check-before-update utility for preventing redundant API updates.
 *
 * PROBLEM: When agent processes error queues or applies corrections, the ops
 * team may have already fixed the issue manually in OT. Without this check,
 * the agent would overwrite already-correct values or make unnecessary API calls.
 *
 * USAGE:
 *   const { safeUpdate, safeUpdateMultiple } = require('../shared/safe-update');
 *
 *   // Single record update
 *   const result = await safeUpdate('chuboe_rfq_line', recordId, {
 *     Chuboe_MFR_Text: 'Texas Instruments',
 *     Description: 'Updated description',
 *   });
 *   // result: { updated: true, fields: ['Description'], skipped: [{field, value, reason}] }
 *
 *   // With onlyIfNull option — only updates fields that are currently null
 *   const result = await safeUpdate('chuboe_rfq_line', recordId, {
 *     Chuboe_MFR_Text: 'Texas Instruments',
 *   }, { onlyIfNull: true });
 */

'use strict';

const logger = require('./logger').createLogger('SafeUpdate');
const { apiGet, patchRecord } = require('./api-client');

/**
 * Safely update a record, skipping fields that are already set to the target value.
 *
 * @param {string} table - Table name (e.g., 'chuboe_rfq_line')
 * @param {number|string} recordId - Record ID to update
 * @param {object} updates - Field → value pairs to apply
 * @param {object} [opts]
 * @param {boolean} [opts.onlyIfNull=false] - Only update fields that are currently null
 * @param {boolean} [opts.logSkipped=true] - Log skipped fields at info level
 * @param {string} [opts.context] - Optional context string for logging
 * @returns {Promise<{updated: boolean, fields: string[], skipped: Array<{field, value, reason}>}>}
 */
async function safeUpdate(table, recordId, updates, opts = {}) {
  const { onlyIfNull = false, logSkipped = true, context = '' } = opts;
  const ctxLabel = context ? `[${context}] ` : '';

  // 1. Fetch current state
  let current;
  try {
    current = await apiGet(table, { id: recordId });
    if (!current || !current.id) {
      throw new Error(`Record not found: ${table}/${recordId}`);
    }
  } catch (e) {
    logger.error(`${ctxLabel}safeUpdate failed to fetch ${table}/${recordId}: ${e.message}`);
    throw e;
  }

  // 2. Check each field we're about to update
  const skipped = [];
  const toUpdate = {};

  for (const [field, newValue] of Object.entries(updates)) {
    const currentValue = current[field];

    // Normalize for comparison (handle null/undefined/'')
    const normalizedCurrent = normalizeValue(currentValue);
    const normalizedNew = normalizeValue(newValue);

    if (normalizedCurrent === normalizedNew) {
      skipped.push({ field, value: newValue, reason: 'already_set' });
    } else if (onlyIfNull && normalizedCurrent != null && normalizedCurrent !== '') {
      skipped.push({ field, value: newValue, reason: 'already_populated', currentValue });
    } else {
      toUpdate[field] = newValue;
    }
  }

  // 3. Log skipped fields if requested
  if (logSkipped && skipped.length > 0) {
    const skipSummary = skipped.map(s => `${s.field}: ${s.reason}`).join(', ');
    logger.info(`${ctxLabel}safeUpdate ${table}/${recordId} — skipped: ${skipSummary}`);
  }

  // 4. Only update if there are actual changes
  if (Object.keys(toUpdate).length === 0) {
    logger.info(`${ctxLabel}safeUpdate ${table}/${recordId} — all fields already correct, no update needed`);
    return { updated: false, fields: [], skipped };
  }

  // 5. Apply the update
  try {
    await patchRecord(table, recordId, toUpdate);
    logger.info(`${ctxLabel}safeUpdate ${table}/${recordId} — updated fields: ${Object.keys(toUpdate).join(', ')}`);
    return { updated: true, fields: Object.keys(toUpdate), skipped };
  } catch (e) {
    logger.error(`${ctxLabel}safeUpdate ${table}/${recordId} failed: ${e.message}`);
    throw e;
  }
}

/**
 * Safely update multiple records in batch.
 *
 * @param {string} table - Table name
 * @param {Array<{id: number, updates: object}>} records - Array of {id, updates} pairs
 * @param {object} [opts] - Same options as safeUpdate
 * @returns {Promise<{totalUpdated: number, totalSkipped: number, results: Array}>}
 */
async function safeUpdateMultiple(table, records, opts = {}) {
  const results = [];
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const { id, updates } of records) {
    try {
      const result = await safeUpdate(table, id, updates, opts);
      results.push({ id, ...result });
      if (result.updated) totalUpdated++;
      totalSkipped += result.skipped.length;
    } catch (e) {
      results.push({ id, error: e.message });
    }
  }

  return { totalUpdated, totalSkipped, results };
}

/**
 * Check if a field update is needed (dry-run version).
 * Does not perform the update, just returns what would happen.
 *
 * @param {string} table - Table name
 * @param {number|string} recordId - Record ID
 * @param {object} updates - Field → value pairs
 * @param {object} [opts] - Same options as safeUpdate
 * @returns {Promise<{wouldUpdate: boolean, fieldsToUpdate: string[], wouldSkip: Array}>}
 */
async function checkUpdate(table, recordId, updates, opts = {}) {
  const { onlyIfNull = false } = opts;

  let current;
  try {
    current = await apiGet(table, { id: recordId });
    if (!current || !current.id) {
      throw new Error(`Record not found: ${table}/${recordId}`);
    }
  } catch (e) {
    throw e;
  }

  const wouldSkip = [];
  const fieldsToUpdate = [];

  for (const [field, newValue] of Object.entries(updates)) {
    const currentValue = current[field];
    const normalizedCurrent = normalizeValue(currentValue);
    const normalizedNew = normalizeValue(newValue);

    if (normalizedCurrent === normalizedNew) {
      wouldSkip.push({ field, value: newValue, reason: 'already_set' });
    } else if (onlyIfNull && normalizedCurrent != null && normalizedCurrent !== '') {
      wouldSkip.push({ field, value: newValue, reason: 'already_populated', currentValue });
    } else {
      fieldsToUpdate.push(field);
    }
  }

  return {
    wouldUpdate: fieldsToUpdate.length > 0,
    fieldsToUpdate,
    wouldSkip,
    currentValues: Object.fromEntries(
      Object.keys(updates).map(k => [k, current[k]])
    ),
  };
}

/**
 * Normalize a value for comparison.
 * Treats null, undefined, and empty string as equivalent for comparison purposes.
 */
function normalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  if (typeof val === 'string') return val.trim();
  return val;
}

module.exports = {
  safeUpdate,
  safeUpdateMultiple,
  checkUpdate,
};
