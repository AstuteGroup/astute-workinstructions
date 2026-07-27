#!/usr/bin/env node
/**
 * Inventory Parser — Pure Infor xlsx parsing
 *
 * Parses AST Item Lots Report from Infor ERP into structured data.
 * Single source, single purpose — no OT writes, no carryover merging,
 * no side effects.
 *
 * Usage:
 *   const { parseInventoryFile } = require('./inventory-parser');
 *   const result = parseInventoryFile('/path/to/ASTItemLotsReport.xlsx');
 *
 *   // result.metadata = { sourceFile, parsedAt, totalRows, uniqueRows, duplicatesRemoved }
 *   // result.byWarehouse = { 'W102': [...], 'W104': [...], ... }
 *   // result.duplicates = [...] (for audit)
 *
 * @module shared/inventory-parser
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// =============================================================================
// CONFIGURATION
// =============================================================================

// Rows to skip at start of file (Infor report header)
const HEADER_ROWS_TO_SKIP = 7;

// Footer patterns to detect and remove
const FOOTER_PATTERNS = ['Page ', 'USS,'];

// Composite key fields for deduplication (case-insensitive)
const DEDUPE_FIELDS = ['Item', 'Lot', 'Location', 'Warehouse Name', 'Site', 'Date Lot'];

// Column mappings: Infor column name → normalized output field
const COLUMN_MAP = {
    'Item':             'mpn',
    'ItemDescription':  'description',
    'Name':             'mfr',
    'Lot':              'lot',
    'Lot Quantity':     'qty',
    'Lot Unit Cost':    'unitCost',
    'Date Code':        'dateCode',
    'Location':         'location',
    'Warehouse':        'warehouse',
    'Warehouse Name':   'warehouseName',
    'Site':             'site',
    'Date Lot':         'dateLot',
    'Currency':         'currency',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Clean numeric value — remove quotes and commas
 */
function cleanNumeric(value) {
    if (value == null) return null;
    const cleaned = String(value).replace(/"/g, '').replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

/**
 * Check if row is a footer row (contains "Page " or "USS,")
 */
function isFooterRow(row) {
    const rowText = Object.values(row).join(',');
    return FOOTER_PATTERNS.some(pattern => rowText.includes(pattern));
}

/**
 * Check if row is blank (all cells empty)
 */
function isBlankRow(row) {
    return Object.values(row).every(cell => !String(cell || '').trim());
}

/**
 * Generate deduplication key from row
 */
function getDedupeKey(row) {
    return DEDUPE_FIELDS.map(field => String(row[field] || '').trim().toLowerCase()).join('|');
}

/**
 * Normalize a single row from Infor format to output format
 */
function normalizeRow(rawRow) {
    const normalized = {};

    for (const [inforCol, outputField] of Object.entries(COLUMN_MAP)) {
        let value = rawRow[inforCol];

        // Clean numeric fields
        if (outputField === 'qty' || outputField === 'unitCost') {
            normalized[outputField] = cleanNumeric(value);
        } else {
            // String fields — trim and preserve
            normalized[outputField] = value != null ? String(value).trim() : '';
        }
    }

    // Preserve any extra columns not in COLUMN_MAP (pass-through)
    for (const [col, value] of Object.entries(rawRow)) {
        if (!COLUMN_MAP[col]) {
            normalized[`_${col}`] = value;
        }
    }

    return normalized;
}

// =============================================================================
// MAIN PARSER
// =============================================================================

/**
 * Parse an Infor AST Item Lots Report xlsx file
 *
 * @param {string} filePath - Path to the xlsx file
 * @param {object} [options] - Optional configuration
 * @param {boolean} [options.includeDuplicates=true] - Include duplicates array in result
 * @param {boolean} [options.normalizeColumns=true] - Map Infor columns to standard names
 * @returns {object} Parsed inventory data
 */
function parseInventoryFile(filePath, options = {}) {
    const { includeDuplicates = true, normalizeColumns = true } = options;

    if (!fs.existsSync(filePath)) {
        throw new Error(`Input file not found: ${filePath}`);
    }

    const startTime = Date.now();

    // -------------------------------------------------------------------------
    // STEP 1: Read xlsx file
    // -------------------------------------------------------------------------
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to array of arrays
    const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (rawData.length <= HEADER_ROWS_TO_SKIP) {
        throw new Error(`File has insufficient rows: expected header at row ${HEADER_ROWS_TO_SKIP + 1}, got ${rawData.length} rows`);
    }

    // Row 8 (index 7) is the header row
    const headers = rawData[HEADER_ROWS_TO_SKIP].map(h => String(h).trim());

    if (headers.length === 0 || headers.every(h => !h)) {
        throw new Error(`No headers found at row ${HEADER_ROWS_TO_SKIP + 1}`);
    }

    // -------------------------------------------------------------------------
    // STEP 2: Process data rows (skip blank, stop at footer)
    // -------------------------------------------------------------------------
    const allRows = [];

    for (let i = HEADER_ROWS_TO_SKIP + 1; i < rawData.length; i++) {
        const rawRow = rawData[i];

        // Convert array to object with headers
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = rawRow[idx] !== undefined ? rawRow[idx] : '';
        });

        // Skip blank rows
        if (isBlankRow(row)) continue;

        // Stop at footer
        if (isFooterRow(row)) break;

        allRows.push(row);
    }

    // -------------------------------------------------------------------------
    // STEP 3: Deduplicate
    // -------------------------------------------------------------------------
    const seenKeys = new Set();
    const uniqueRows = [];
    const duplicateRows = [];

    for (const row of allRows) {
        const key = getDedupeKey(row);
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueRows.push(row);
        } else {
            duplicateRows.push(row);
        }
    }

    // -------------------------------------------------------------------------
    // STEP 4: Split by warehouse and normalize
    // -------------------------------------------------------------------------
    const byWarehouse = {};

    for (const row of uniqueRows) {
        const warehouseCode = String(row['Warehouse'] || '').trim().toUpperCase();

        if (!warehouseCode) {
            // Rows without warehouse go to '_UNKNOWN'
            if (!byWarehouse['_UNKNOWN']) byWarehouse['_UNKNOWN'] = [];
            byWarehouse['_UNKNOWN'].push(normalizeColumns ? normalizeRow(row) : row);
            continue;
        }

        if (!byWarehouse[warehouseCode]) {
            byWarehouse[warehouseCode] = [];
        }

        byWarehouse[warehouseCode].push(normalizeColumns ? normalizeRow(row) : row);
    }

    // -------------------------------------------------------------------------
    // Build result
    // -------------------------------------------------------------------------
    const result = {
        metadata: {
            sourceFile: path.basename(filePath),
            sourcePath: filePath,
            parsedAt: new Date().toISOString(),
            parseTimeMs: Date.now() - startTime,
            totalRows: allRows.length,
            uniqueRows: uniqueRows.length,
            duplicatesRemoved: duplicateRows.length,
            warehouseCount: Object.keys(byWarehouse).length,
            warehouseSummary: {},
        },
        byWarehouse,
    };

    // Add per-warehouse counts to metadata
    for (const [wh, rows] of Object.entries(byWarehouse)) {
        result.metadata.warehouseSummary[wh] = rows.length;
    }

    // Include duplicates for audit if requested
    if (includeDuplicates && duplicateRows.length > 0) {
        result.duplicates = duplicateRows.map(row =>
            normalizeColumns ? normalizeRow(row) : row
        );
    }

    return result;
}

/**
 * Get rows for specific warehouse codes
 *
 * @param {object} parsedResult - Result from parseInventoryFile
 * @param {string[]} warehouseCodes - List of warehouse codes (e.g., ['W102', 'W104'])
 * @returns {object[]} Combined rows from the specified warehouses
 */
function getWarehouseRows(parsedResult, warehouseCodes) {
    const rows = [];
    for (const code of warehouseCodes) {
        const upperCode = code.toUpperCase();
        if (parsedResult.byWarehouse[upperCode]) {
            rows.push(...parsedResult.byWarehouse[upperCode]);
        }
    }
    return rows;
}

/**
 * Filter rows by manufacturer (case-insensitive partial match)
 *
 * @param {object[]} rows - Rows to filter
 * @param {string} mfrPattern - Manufacturer pattern to match
 * @param {boolean} [exclude=false] - If true, exclude matching rows instead
 * @returns {object[]} Filtered rows
 */
function filterByMfr(rows, mfrPattern, exclude = false) {
    const pattern = mfrPattern.toLowerCase();
    return rows.filter(row => {
        const mfr = (row.mfr || row['Name'] || '').toLowerCase();
        const matches = mfr.includes(pattern);
        return exclude ? !matches : matches;
    });
}

// =============================================================================
// CLI (for testing)
// =============================================================================

if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node inventory-parser.js <file.xlsx> [--json]');
        console.log('');
        console.log('Parses Infor AST Item Lots Report and outputs summary.');
        console.log('Use --json to output full result as JSON.');
        process.exit(1);
    }

    const filePath = args[0];
    const jsonOutput = args.includes('--json');

    try {
        const result = parseInventoryFile(filePath);

        if (jsonOutput) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log('Inventory Parser Result');
            console.log('='.repeat(60));
            console.log(`Source: ${result.metadata.sourceFile}`);
            console.log(`Parsed: ${result.metadata.parsedAt}`);
            console.log(`Parse time: ${result.metadata.parseTimeMs}ms`);
            console.log('');
            console.log(`Total rows: ${result.metadata.totalRows}`);
            console.log(`Unique rows: ${result.metadata.uniqueRows}`);
            console.log(`Duplicates removed: ${result.metadata.duplicatesRemoved}`);
            console.log('');
            console.log('Warehouse breakdown:');
            const sortedWarehouses = Object.entries(result.metadata.warehouseSummary)
                .sort((a, b) => a[0].localeCompare(b[0]));
            for (const [wh, count] of sortedWarehouses) {
                console.log(`  ${wh}: ${count.toLocaleString()} rows`);
            }
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    parseInventoryFile,
    getWarehouseRows,
    filterByMfr,
    // Export constants for consumers that need them
    HEADER_ROWS_TO_SKIP,
    FOOTER_PATTERNS,
    DEDUPE_FIELDS,
    COLUMN_MAP,
};
