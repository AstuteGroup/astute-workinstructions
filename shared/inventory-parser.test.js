#!/usr/bin/env node
/**
 * Unit tests for inventory-parser.js
 *
 * Run: node shared/inventory-parser.test.js
 */

const assert = require('assert');
const path = require('path');
const {
    parseInventoryFile,
    getWarehouseRows,
    filterByMfr,
    HEADER_ROWS_TO_SKIP,
    DEDUPE_FIELDS,
} = require('./inventory-parser');

// Test file path (uses most recent inventory file in file-drop)
const TEST_FILE = '/home/analytics_user/workspace/file-drop/ASTItemLotsReportInputs_USS_4916434.xlsx';

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        testsPassed++;
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
        testsFailed++;
    }
}

console.log('');
console.log('inventory-parser.js tests');
console.log('='.repeat(60));

// =============================================================================
// Test parseInventoryFile
// =============================================================================
console.log('\nparseInventoryFile:');

let result;
test('parses xlsx file without error', () => {
    result = parseInventoryFile(TEST_FILE);
    assert(result, 'result should exist');
});

test('returns metadata object', () => {
    assert(result.metadata, 'metadata should exist');
    assert(result.metadata.sourceFile, 'sourceFile should exist');
    assert(result.metadata.parsedAt, 'parsedAt should exist');
    assert(typeof result.metadata.totalRows === 'number', 'totalRows should be number');
    assert(typeof result.metadata.uniqueRows === 'number', 'uniqueRows should be number');
    assert(typeof result.metadata.duplicatesRemoved === 'number', 'duplicatesRemoved should be number');
});

test('returns byWarehouse object', () => {
    assert(result.byWarehouse, 'byWarehouse should exist');
    assert(typeof result.byWarehouse === 'object', 'byWarehouse should be object');
    assert(Object.keys(result.byWarehouse).length > 0, 'byWarehouse should have entries');
});

test('warehouse codes are uppercase', () => {
    for (const code of Object.keys(result.byWarehouse)) {
        assert(code === code.toUpperCase(), `${code} should be uppercase`);
    }
});

test('each warehouse has array of rows', () => {
    for (const [code, rows] of Object.entries(result.byWarehouse)) {
        assert(Array.isArray(rows), `${code} should be array`);
        assert(rows.length > 0 || code === '_UNKNOWN', `${code} should have rows`);
    }
});

test('rows have normalized column names', () => {
    const sampleRow = result.byWarehouse['W111'][0];
    assert('mpn' in sampleRow, 'should have mpn');
    assert('mfr' in sampleRow, 'should have mfr');
    assert('qty' in sampleRow, 'should have qty');
    assert('unitCost' in sampleRow, 'should have unitCost');
    assert('warehouse' in sampleRow, 'should have warehouse');
});

test('qty is a number', () => {
    const sampleRow = result.byWarehouse['W111'][0];
    assert(typeof sampleRow.qty === 'number', `qty should be number, got ${typeof sampleRow.qty}`);
});

test('unitCost is a number or null', () => {
    const sampleRow = result.byWarehouse['W111'][0];
    assert(
        typeof sampleRow.unitCost === 'number' || sampleRow.unitCost === null,
        `unitCost should be number or null, got ${typeof sampleRow.unitCost}`
    );
});

test('warehouseSummary matches byWarehouse counts', () => {
    for (const [code, count] of Object.entries(result.metadata.warehouseSummary)) {
        const actualCount = result.byWarehouse[code].length;
        assert(count === actualCount, `${code}: summary=${count}, actual=${actualCount}`);
    }
});

test('totalRows >= uniqueRows', () => {
    assert(
        result.metadata.totalRows >= result.metadata.uniqueRows,
        `totalRows (${result.metadata.totalRows}) should be >= uniqueRows (${result.metadata.uniqueRows})`
    );
});

test('duplicatesRemoved = totalRows - uniqueRows', () => {
    const expected = result.metadata.totalRows - result.metadata.uniqueRows;
    assert(
        result.metadata.duplicatesRemoved === expected,
        `duplicatesRemoved should be ${expected}, got ${result.metadata.duplicatesRemoved}`
    );
});

// =============================================================================
// Test getWarehouseRows
// =============================================================================
console.log('\ngetWarehouseRows:');

test('returns combined rows for multiple warehouses', () => {
    const lamRows = getWarehouseRows(result, ['W111', 'W115', 'W118']);
    const expected = (result.byWarehouse['W111']?.length || 0) +
                     (result.byWarehouse['W115']?.length || 0) +
                     (result.byWarehouse['W118']?.length || 0);
    assert(lamRows.length === expected, `expected ${expected} rows, got ${lamRows.length}`);
});

test('handles single warehouse', () => {
    const rows = getWarehouseRows(result, ['W102']);
    assert(rows.length === result.byWarehouse['W102'].length, 'should match W102 count');
});

test('handles non-existent warehouse gracefully', () => {
    const rows = getWarehouseRows(result, ['W999']);
    assert(rows.length === 0, 'should return empty array for non-existent warehouse');
});

test('handles mixed existing and non-existing warehouses', () => {
    const rows = getWarehouseRows(result, ['W111', 'W999']);
    assert(rows.length === result.byWarehouse['W111'].length, 'should only include existing');
});

// =============================================================================
// Test filterByMfr
// =============================================================================
console.log('\nfilterByMfr:');

test('filters rows by manufacturer (case-insensitive)', () => {
    const allW104 = result.byWarehouse['W104'];
    const positronic = filterByMfr(allW104, 'positronic');
    const notPositronic = filterByMfr(allW104, 'positronic', true);
    assert(positronic.length + notPositronic.length === allW104.length, 'filter + exclude should equal total');
});

test('returns empty array when no matches', () => {
    const allW111 = result.byWarehouse['W111'];
    const noMatch = filterByMfr(allW111, 'XYZNONEXISTENT123');
    assert(noMatch.length === 0, 'should return empty for no matches');
});

// =============================================================================
// Test error handling
// =============================================================================
console.log('\nerror handling:');

test('throws on non-existent file', () => {
    try {
        parseInventoryFile('/nonexistent/file.xlsx');
        assert(false, 'should have thrown');
    } catch (err) {
        assert(err.message.includes('not found'), `error should mention file not found: ${err.message}`);
    }
});

// =============================================================================
// Summary
// =============================================================================
console.log('');
console.log('='.repeat(60));
console.log(`Tests: ${testsPassed} passed, ${testsFailed} failed`);

if (testsFailed > 0) {
    process.exit(1);
}
