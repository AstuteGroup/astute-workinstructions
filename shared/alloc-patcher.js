/**
 * Allocation Patcher — enforced wrapper for allocation PATCH with validation.
 *
 * Parallels shared/vq-patcher.js and shared/cq-patcher.js. Callers DO NOT call
 * `patchRecord('chuboe_alloc_order_lot', id, { C_OrderLine_ID: ... })` directly —
 * they call `linkAllocSOLine()` which:
 *   1. Validates the allocation exists and is active
 *   2. Validates the SO Line exists and is active
 *   3. Validates the SO Line has sufficient remaining qty (unless skip flag set)
 *   4. PATCHes C_OrderLine_ID in a single atomic call
 *
 * USAGE:
 *   const { linkAllocSOLine, validateAllocForSOLink } = require('../shared/alloc-patcher');
 *
 *   // Validate before linking (dry-run check)
 *   const check = await validateAllocForSOLink(allocId, soLineId);
 *   if (check.ok) {
 *     await linkAllocSOLine(allocId, soLineId);
 *   }
 *
 *   // Or link directly (throws on validation failure)
 *   await linkAllocSOLine(allocId, soLineId, { skipQtyCheck: false });
 *
 * WHY THIS EXISTS:
 *   The inspection queue shows records with missing Weighted Priority when the
 *   allocation (chuboe_alloc_order_lot) lacks a C_OrderLine_ID (SO Line link).
 *   This module provides a safe, validated path to fix those allocations.
 *
 *   The automation script (inspection-queue-maintenance.js) uses this module to
 *   auto-fix straightforward cases (exact qty match, single candidate) and
 *   report escalations for ambiguous cases.
 */

const { patchRecord } = require('./record-updater');
const { execSync } = require('child_process');
const breadcrumbs = require('./breadcrumbs');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Run a SQL query and return parsed rows.
 */
function runQuery(sql) {
  const result = execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  return result.trim().split('\n').filter(line => line && line !== '(0 rows)');
}

/**
 * Parse a query result row into an object given column names.
 */
function parseRow(row, columns) {
  const values = row.split('|');
  const obj = {};
  columns.forEach((col, i) => {
    let val = values[i];
    // Convert to proper types
    if (val === '' || val === undefined) val = null;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
    obj[col] = val;
  });
  return obj;
}

// ─── VALIDATION ──────────────────────────────────────────────────────────────

/**
 * Pre-flight validation for linking an allocation to an SO Line.
 *
 * @param {number} allocId    chuboe_alloc_order_lot_id
 * @param {number} soLineId   c_orderline_id to link
 * @param {object} [opts]
 * @param {boolean} [opts.skipQtyCheck=false]  Skip qty validation
 * @returns {Promise<object>} { ok: boolean, violations: string[], alloc, soLine }
 */
async function validateAllocForSOLink(allocId, soLineId, opts = {}) {
  const { skipQtyCheck = false } = opts;
  const violations = [];
  let alloc = null;
  let soLine = null;

  // 1. Fetch allocation record
  const allocRows = runQuery(`
    SELECT aol.chuboe_alloc_order_lot_id, aol.chuboe_insp_lot_id, aol.qty,
           aol.c_orderline_id AS current_so_line_id, aol.isactive
    FROM adempiere.chuboe_alloc_order_lot aol
    WHERE aol.chuboe_alloc_order_lot_id = ${allocId}
  `);

  if (allocRows.length === 0) {
    violations.push(`Allocation ${allocId} not found`);
    return { ok: false, violations, alloc, soLine };
  }

  alloc = parseRow(allocRows[0], [
    'chuboe_alloc_order_lot_id', 'chuboe_insp_lot_id', 'qty',
    'current_so_line_id', 'isactive'
  ]);

  if (alloc.isactive !== 'Y') {
    violations.push(`Allocation ${allocId} is inactive`);
  }

  if (alloc.current_so_line_id !== null) {
    violations.push(`Allocation ${allocId} already linked to SO Line ${alloc.current_so_line_id}`);
  }

  // 2. Fetch SO Line record
  const soLineRows = runQuery(`
    SELECT sol.c_orderline_id, sol.qtyentered, sol.qtyordered,
           so.documentno AS so_documentno, so.isactive AS so_isactive,
           sol.isactive AS line_isactive, sol.line
    FROM adempiere.c_orderline sol
    JOIN adempiere.c_order so ON so.c_order_id = sol.c_order_id
    WHERE sol.c_orderline_id = ${soLineId}
  `);

  if (soLineRows.length === 0) {
    violations.push(`SO Line ${soLineId} not found`);
    return { ok: false, violations, alloc, soLine };
  }

  soLine = parseRow(soLineRows[0], [
    'c_orderline_id', 'qtyentered', 'qtyordered',
    'so_documentno', 'so_isactive', 'line_isactive', 'line'
  ]);

  if (soLine.line_isactive !== 'Y') {
    violations.push(`SO Line ${soLineId} is inactive`);
  }

  if (soLine.so_isactive !== 'Y') {
    violations.push(`SO ${soLine.so_documentno} is inactive`);
  }

  // 3. Qty check (optional)
  if (!skipQtyCheck && alloc && soLine) {
    // Calculate already-allocated qty for this SO Line
    const allocatedRows = runQuery(`
      SELECT COALESCE(SUM(qty), 0) AS allocated_qty
      FROM adempiere.chuboe_alloc_order_lot
      WHERE c_orderline_id = ${soLineId}
        AND isactive = 'Y'
    `);
    const alreadyAllocated = allocatedRows.length > 0 ? parseFloat(allocatedRows[0]) || 0 : 0;
    const availableQty = soLine.qtyentered - alreadyAllocated;

    if (alloc.qty > availableQty) {
      violations.push(
        `Qty mismatch: Lot qty ${alloc.qty} exceeds SO Line available qty ${availableQty} ` +
        `(qtyentered: ${soLine.qtyentered}, already allocated: ${alreadyAllocated})`
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    alloc,
    soLine
  };
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

/**
 * Link an allocation to an SO Line (PATCH C_OrderLine_ID).
 *
 * @param {number} allocId    chuboe_alloc_order_lot_id to update
 * @param {number} soLineId   c_orderline_id to link
 * @param {object} [opts]
 * @param {boolean} [opts.skipQtyCheck=false]    Skip qty validation
 * @param {boolean} [opts.dryRun=false]          Validate but don't PATCH
 * @returns {Promise<object>} { allocId, soLineId, linked: boolean, dryRun: boolean }
 * @throws {Error} with violations list if validation fails
 */
async function linkAllocSOLine(allocId, soLineId, opts = {}) {
  const { skipQtyCheck = false, dryRun = false } = opts;

  // Validate first
  const report = await validateAllocForSOLink(allocId, soLineId, { skipQtyCheck });

  if (!report.ok) {
    const err = new Error(
      `Allocation ${allocId} failed pre-link validation — aborting. ` +
      `Fix violations and retry:\n  - ${report.violations.join('\n  - ')}`
    );
    err.violations = report.violations;
    err.allocId = allocId;
    err.soLineId = soLineId;
    throw err;
  }

  if (dryRun) {
    return {
      allocId,
      soLineId,
      linked: false,
      dryRun: true,
      message: 'Validation passed (dry-run, no PATCH sent)'
    };
  }

  // Apply the PATCH
  const patchResult = await patchRecord('chuboe_alloc_order_lot', allocId, {
    C_OrderLine_ID: soLineId
  }, {
    source: 'alloc-patcher'
  });

  if (patchResult.status === 'error') {
    const err = new Error(`PATCH failed for allocation ${allocId}: ${patchResult.error}`);
    err.patchResult = patchResult;
    throw err;
  }

  // Log breadcrumb
  breadcrumbs.write({
    cog: 'alloc-patcher',
    event: 'alloc-linked',
    allocId,
    soLineId,
    soDocumentNo: report.soLine?.so_documentno,
    lotQty: report.alloc?.qty
  });

  return {
    allocId,
    soLineId,
    linked: true,
    dryRun: false,
    soDocumentNo: report.soLine?.so_documentno,
    lotQty: report.alloc?.qty
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  validateAllocForSOLink,
  linkAllocSOLine
};
