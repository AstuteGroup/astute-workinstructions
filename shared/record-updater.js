/**
 * Record Updater — generalized PATCH/PUT pattern for iDempiere REST API writes
 *
 * Sits alongside the INSERT-only writers (rfq-writer, vq-writer, offer-writeback,
 * api-result-writer, cq-writer) and handles the *update* shape that backfills,
 * enrichments, and corrections all share.
 *
 * Why this exists:
 *   Every backfill workflow (HTS/ECCN, alt-MPN linkage, dormant column populations,
 *   data quality flags, etc.) wants the same recipe:
 *     1. GET current row state
 *     2. Skip columns that are already populated (idempotent re-runs)
 *     3. Validate new values against a regex/format
 *     4. PUT only the columns we're actually changing
 *     5. Log every decision (patched, skipped, validation-failed, error)
 *
 *   Without this module each backfill reinvents the loop. With it, a backfill
 *   becomes ~20 lines of consumer code.
 *
 * USAGE — single record:
 *
 *   const { patchRecord } = require('../shared/record-updater');
 *
 *   const result = await patchRecord('chuboe_vq_line', 2002199, {
 *     Chuboe_HTS: '8542.31.0001',
 *     Chuboe_ECCN: 'EAR99',
 *   }, {
 *     skipIfNotNull: ['Chuboe_HTS', 'Chuboe_ECCN'],
 *     validate: { Chuboe_ECCN: /^(EAR99|[0-9][A-E][0-9]{3}([.][a-z][0-9]?)*)$/ },
 *     source: 'hts-eccn-backfill',
 *   });
 *   // → { status: 'patched' | 'skipped' | 'validation-failed' | 'no-op' | 'error',
 *   //     id, table, patched: { fields }, skipped: { fields }, error?, ... }
 *
 * USAGE — batch:
 *
 *   const { patchBatch } = require('../shared/record-updater');
 *
 *   const updates = [
 *     { id: 2002199, payload: { Chuboe_HTS: '...', Chuboe_ECCN: '...' } },
 *     { id: 2002200, payload: { Chuboe_HTS: '...' } },
 *     // ...
 *   ];
 *
 *   const summary = await patchBatch('chuboe_vq_line', updates, {
 *     skipIfNotNull: ['Chuboe_HTS', 'Chuboe_ECCN'],
 *     validate: { Chuboe_ECCN: ECCN_REGEX },
 *     concurrency: 5,
 *     source: 'hts-eccn-backfill',
 *     auditDir: '/path/to/run/logs',  // optional — writes patch-log.json + skip-log.json
 *   });
 *   // → { total, patched, skipped, validationFailed, errors, results: [...] }
 *
 * AUDIT TRAIL:
 *   Every run can dump three files to opts.auditDir (if provided):
 *     - patch-log.json   — every successful PATCH (id, fields changed, before/after)
 *     - skip-log.json    — every row skipped (id, reason, which fields were already set)
 *     - error-log.json   — every failure (id, error message, payload)
 *
 *   Filename convention: {source}-{YYYY-MM-DDTHH-mm-ss}-{kind}.json
 *
 * DESIGN NOTES:
 *   - PUT in iDempiere REST is partial update — only fields you send are touched.
 *     We never send fields the consumer didn't ask to change.
 *   - skipIfNotNull is the key idempotency guarantee. Without it, re-running a
 *     backfill would clobber any manual corrections an operator made between runs.
 *   - validate runs BEFORE the GET, so we don't waste an API call on garbage input.
 *   - concurrency is throttled because iDempiere's REST tier doesn't love
 *     unbounded parallelism. Default 5 is conservative; tune per workload.
 */

const fs = require('fs');
const path = require('path');
const { apiGet, apiPut } = require('./api-client');
const logger = require('./logger').createLogger('RecordUpdater');

// ─── DEFAULTS ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

// ─── VALIDATION ──────────────────────────────────────────────────────────────

/**
 * Run validators against a payload. Returns { valid: bool, failures: [{field, value, reason}] }.
 */
function validatePayload(payload, validators) {
  const failures = [];
  if (!validators) return { valid: true, failures };

  for (const [field, validator] of Object.entries(validators)) {
    const value = payload[field];
    // Don't validate fields that aren't being patched
    if (value === undefined || value === null) continue;

    if (validator instanceof RegExp) {
      if (!validator.test(String(value))) {
        failures.push({ field, value, reason: `does not match ${validator}` });
      }
    } else if (typeof validator === 'function') {
      const result = validator(value);
      if (result !== true) {
        failures.push({ field, value, reason: typeof result === 'string' ? result : 'validator returned false' });
      }
    }
  }

  return { valid: failures.length === 0, failures };
}

// ─── GET-THEN-PATCH ──────────────────────────────────────────────────────────

/**
 * Filter the payload to only fields where the current row value is null/empty.
 * Used to enforce skipIfNotNull idempotency.
 *
 * @param {object} currentRow - The result of apiGet for this id
 * @param {object} payload - The proposed update
 * @param {string[]} skipFields - Field names to gate on (only these are checked)
 * @returns {{ filtered: object, skipped: object }}
 *   filtered = fields that should still be PATCHed (current value was null/empty)
 *   skipped  = fields that were dropped (current value was already populated)
 */
function filterAlreadyPopulated(currentRow, payload, skipFields) {
  const filtered = {};
  const skipped = {};

  for (const [field, newValue] of Object.entries(payload)) {
    if (!skipFields.includes(field)) {
      // Field isn't gated — always patch
      filtered[field] = newValue;
      continue;
    }

    const currentValue = currentRow[field];
    const isEmpty = currentValue === null || currentValue === undefined || currentValue === '';

    if (isEmpty) {
      filtered[field] = newValue;
    } else {
      skipped[field] = { current: currentValue, proposed: newValue };
    }
  }

  return { filtered, skipped };
}

// ─── PUBLIC: SINGLE RECORD ───────────────────────────────────────────────────

/**
 * Patch a single record idempotently.
 *
 * @param {string} table - Table name (e.g., 'chuboe_vq_line')
 * @param {number} id - Record ID
 * @param {object} payload - Fields to update (column names exactly as in ad_column)
 * @param {object} [opts]
 * @param {string[]} [opts.skipIfNotNull] - Field names that should NOT overwrite existing values
 * @param {object} [opts.validate] - { fieldName: RegExp | (value) => true | string }
 * @param {string} [opts.source] - Audit tag — who/what is doing this update
 * @returns {Promise<object>} Result object
 */
async function patchRecord(table, id, payload, opts = {}) {
  const { skipIfNotNull = [], validate = null, source = 'unknown' } = opts;
  const startedAt = new Date().toISOString();

  // Step 1: validate before any API call
  const validation = validatePayload(payload, validate);
  if (!validation.valid) {
    return {
      status: 'validation-failed',
      table, id, source, startedAt,
      payload,
      failures: validation.failures,
    };
  }

  // Step 2: GET current row only if we have skipIfNotNull fields to gate on
  let filtered = payload;
  let skipped = {};
  let currentRow = null;

  if (skipIfNotNull.length > 0) {
    try {
      currentRow = await apiGet(table, { id });
    } catch (err) {
      return {
        status: 'error',
        table, id, source, startedAt,
        phase: 'get',
        error: err.message,
        statusCode: err.statusCode,
      };
    }

    const result = filterAlreadyPopulated(currentRow, payload, skipIfNotNull);
    filtered = result.filtered;
    skipped = result.skipped;
  }

  // Step 3: if every field was skipped, no-op
  if (Object.keys(filtered).length === 0) {
    return {
      status: 'skipped',
      table, id, source, startedAt,
      patched: {},
      skipped,
      reason: 'all gated fields already populated',
    };
  }

  // Step 4: PUT
  try {
    const updated = await apiPut(table, id, filtered);
    return {
      status: 'patched',
      table, id, source, startedAt,
      patched: filtered,
      skipped,
      // Capture before/after for audit — only for fields actually changed
      before: currentRow ? Object.fromEntries(Object.keys(filtered).map(f => [f, currentRow[f] ?? null])) : null,
      after: Object.fromEntries(Object.keys(filtered).map(f => [f, updated[f] ?? null])),
    };
  } catch (err) {
    return {
      status: 'error',
      table, id, source, startedAt,
      phase: 'put',
      payload: filtered,
      error: err.message,
      statusCode: err.statusCode,
    };
  }
}

// ─── PUBLIC: BATCH ───────────────────────────────────────────────────────────

/**
 * Patch many records with throttled concurrency. Returns a summary + per-row results.
 *
 * @param {string} table - Table name
 * @param {Array<{id: number, payload: object}>} updates
 * @param {object} [opts]
 * @param {string[]} [opts.skipIfNotNull] - Applied to every row
 * @param {object} [opts.validate] - Applied to every row
 * @param {number} [opts.concurrency=5] - Parallel in-flight requests
 * @param {string} [opts.source] - Audit tag
 * @param {string} [opts.auditDir] - If set, writes patch-log / skip-log / error-log JSON files
 * @param {function} [opts.onProgress] - Called with (completedCount, totalCount, lastResult) after each row
 * @returns {Promise<object>} { total, patched, skipped, validationFailed, errors, results }
 */
async function patchBatch(table, updates, opts = {}) {
  const {
    skipIfNotNull,
    validate,
    concurrency = DEFAULT_CONCURRENCY,
    source = 'batch-update',
    auditDir = null,
    onProgress = null,
  } = opts;

  if (!Array.isArray(updates) || updates.length === 0) {
    return { total: 0, patched: 0, skipped: 0, validationFailed: 0, errors: 0, results: [] };
  }

  const results = new Array(updates.length);
  let completed = 0;

  // Throttled worker pool
  let cursor = 0;
  async function worker() {
    while (cursor < updates.length) {
      const myIndex = cursor++;
      const { id, payload } = updates[myIndex];
      const result = await patchRecord(table, id, payload, { skipIfNotNull, validate, source });
      results[myIndex] = result;
      completed++;
      if (onProgress) {
        try { onProgress(completed, updates.length, result); } catch (e) { /* never break the loop on progress errors */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, updates.length) }, () => worker());
  await Promise.all(workers);

  // Aggregate
  const summary = {
    total: results.length,
    patched: 0,
    skipped: 0,
    validationFailed: 0,
    errors: 0,
    results,
  };

  for (const r of results) {
    if (r.status === 'patched') summary.patched++;
    else if (r.status === 'skipped') summary.skipped++;
    else if (r.status === 'validation-failed') summary.validationFailed++;
    else if (r.status === 'error') summary.errors++;
  }

  // Audit dump
  if (auditDir) {
    writeAuditLogs(auditDir, source, results);
  }

  logger.info(`patchBatch ${table} [${source}]: ${summary.patched} patched, ${summary.skipped} skipped, ${summary.validationFailed} validation-failed, ${summary.errors} errors (${summary.total} total)`);

  return summary;
}

// ─── AUDIT LOGGING ───────────────────────────────────────────────────────────

function writeAuditLogs(auditDir, source, results) {
  try {
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const safeSource = source.replace(/[^A-Za-z0-9-_]/g, '_');
    const stem = `${safeSource}-${timestamp}`;

    const patched = results.filter(r => r.status === 'patched');
    const skipped = results.filter(r => r.status === 'skipped');
    const failed = results.filter(r => r.status === 'validation-failed' || r.status === 'error');

    if (patched.length > 0) {
      fs.writeFileSync(path.join(auditDir, `${stem}-patch-log.json`), JSON.stringify(patched, null, 2));
    }
    if (skipped.length > 0) {
      fs.writeFileSync(path.join(auditDir, `${stem}-skip-log.json`), JSON.stringify(skipped, null, 2));
    }
    if (failed.length > 0) {
      fs.writeFileSync(path.join(auditDir, `${stem}-error-log.json`), JSON.stringify(failed, null, 2));
    }

    logger.debug(`Audit logs written to ${auditDir} (stem: ${stem})`);
  } catch (err) {
    logger.error(`Failed to write audit logs: ${err.message}`);
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  patchRecord,
  patchBatch,
  // Exposed for unit testing
  validatePayload,
  filterAlreadyPopulated,
};
