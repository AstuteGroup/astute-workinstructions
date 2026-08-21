#!/usr/bin/env node
/**
 * Carryover Reconciler
 *
 * Reconciles carryover-registry files (expected/incoming inventory that was
 * slow to arrive, manually tracked so it still shows on the NC portal even
 * before Infor sees it) against the live inventory cache.
 *
 * Each carryover line represents an EXPECTED qty for an MPN that, at the time
 * it was added, had not yet shown up in the Infor warehouse feed for its
 * group. Every run, we check whether it has arrived since:
 *
 *   - FULL:    live qty >= expected qty  -> arrived, drop the line entirely
 *              from the registry (permanent, one-way — safe to repeat)
 *   - PARTIAL: 0 < live qty < expected   -> the registry's `qty` (the
 *              ORIGINAL expected amount) is left UNCHANGED. Only the
 *              CSV-output line (linesForOutput) gets the reduced
 *              (expected - live) qty, so the NC portal doesn't double-count
 *              the arrived portion. The registry itself never shrinks except
 *              by a full drop.
 *   - NONE:    live qty == 0             -> still not received, keep as-is
 *
 * IMPORTANT — idempotency: earlier versions of this module wrote the reduced
 * (expected - live) qty back into the registry file itself. That's WRONG —
 * live qty is a snapshot of what's currently on hand, not a delta of what
 * newly arrived since the last check. Persisting the reduction meant every
 * subsequent run against the same (or overlapping) cache subtracted the same
 * arrived quantity again, silently corrupting the registry further each run.
 * Caught and fixed 2026-08-21 before any corrupted data made it into a
 * committed file — the registry's `qty` must always mean "original total
 * expected," and only a FULL arrival (dropping the line) is ever persisted.
 *
 * This was previously a manual, ad-hoc weekly task. It rotted for ~10 weeks
 * while nc-listing.js's cron was paused (2026-06-18 to 2026-08-21), causing
 * 3 of 4 carryover-registry files to drift into heavy duplication with the
 * live cache (429/560 lines were stale duplicates as of 2026-08-21). This
 * module makes the check automatic so it can run every time nc-listing.js
 * runs, live or dry-run, without depending on someone remembering to do it.
 *
 * Usage:
 *   const { reconcileCarryoverFile } = require('./carryover-reconciler');
 *   const result = reconcileCarryoverFile(filePath, ['W118'], cache, { write: true });
 *   // result.linesForOutput -> use THESE lines for CSV/portal emission
 *   //                          (reduced qty on partials). Never re-derive
 *   //                          output qty from the registry file itself
 *   //                          across multiple runs.
 *
 * @module shared/carryover-reconciler
 */

'use strict';

const fs = require('fs');

/**
 * Build a live qty-by-MPN map from the cache for a set of warehouses.
 */
function buildLiveQtyMap(cache, warehouses) {
    const map = {};
    for (const wh of warehouses) {
        const rows = (cache.byWarehouse && cache.byWarehouse[wh]) || [];
        for (const row of rows) {
            const mpn = (row.mpn || '').toUpperCase().trim();
            if (!mpn) continue;
            map[mpn] = (map[mpn] || 0) + (Number(row.qty) || 0);
        }
    }
    return map;
}

/**
 * Reconcile one carryover file against the live cache for its warehouse(s).
 *
 * @param {string} filePath - Path to the carryover-registry JSON file
 * @param {string[]} warehouses - Warehouse codes to check arrival against
 * @param {object} cache - Loaded inventory cache (from loadCachedInventory)
 * @param {object} [opts]
 * @param {boolean} [opts.write=false] - If true, writes the reconciled file
 *   back to disk (dropping FULL lines only — original `qty` on kept lines is
 *   never altered). If false, this is a preview only — nothing is written.
 * @returns {object} {
 *   label, file, totalBefore, totalAfter,
 *   dropped: [{mpn, expected, live}],                  // FULL — removed entirely
 *   reduced: [{mpn, expectedOriginal, live, remaining}],// PARTIAL — for reporting only
 *   stillPending: [{mpn, mfr, expected, status}],       // PARTIAL (remaining) + NEVER_ARRIVED
 *   linesForOutput: [...],   // registry-shaped lines with qty adjusted for
 *                            // CSV/portal emission (reduced on partials) —
 *                            // use these for output, not the raw registry lines
 * }
 */
function reconcileCarryoverFile(filePath, warehouses, cache, opts = {}) {
    const { write = false } = opts;

    if (!fs.existsSync(filePath)) {
        return null;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const liveQty = buildLiveQtyMap(cache, warehouses);

    const keptLines = [];       // persisted back to the registry — original qty untouched
    const linesForOutput = [];  // for CSV/portal emission — reduced qty on partials
    const dropped = [];
    const reduced = [];
    const stillPending = [];

    for (const line of (data.lines || [])) {
        const mpn = (line.mpn || '').toUpperCase().trim();
        const expected = Number(line.qty) || 0;
        const live = liveQty[mpn] || 0;

        if (live >= expected && live > 0) {
            // FULL — arrived, drop from the registry entirely (one-way, safe to repeat)
            dropped.push({ mpn: line.mpn, mfr: line.mfr, expected, live });
            continue;
        }

        // Registry always keeps the line with its ORIGINAL qty — never mutated.
        keptLines.push(line);

        if (live > 0) {
            // PARTIAL — remaining is a DERIVED value, for reporting + output
            // only. The registry's qty stays at `expected` (original).
            const remaining = expected - live;
            reduced.push({ mpn: line.mpn, mfr: line.mfr, expectedOriginal: expected, live, remaining });
            linesForOutput.push({ ...line, qty: remaining });
            stillPending.push({ mpn: line.mpn, mfr: line.mfr, expected: remaining, status: 'PARTIAL' });
        } else {
            // NONE — still fully outstanding
            linesForOutput.push(line);
            stillPending.push({ mpn: line.mpn, mfr: line.mfr, expected, status: 'NEVER_ARRIVED' });
        }
    }

    const result = {
        label: data.label || null,
        file: filePath,
        totalBefore: (data.lines || []).length,
        totalAfter: keptLines.length,
        dropped,
        reduced,
        stillPending,
        linesForOutput,
    };

    if (write) {
        // Only ever drops fully-arrived lines. Kept lines' qty is identical
        // to what was already on disk, so re-running against the same cache
        // is a true no-op (idempotent) beyond dropping newly-arrived lines.
        const updated = {
            ...data,
            lineCount: keptLines.length,
            lastReconciled: new Date().toISOString(),
            lines: keptLines,
        };
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    }

    return result;
}

module.exports = {
    reconcileCarryoverFile,
    buildLiveQtyMap,
};
