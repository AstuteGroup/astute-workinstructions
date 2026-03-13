# Shared Utilities

Reusable utilities for all Astute workflows. **Always use these instead of ad-hoc implementations.**

## csv-utils.js

Proper CSV parsing that handles:
- Quoted fields containing commas (e.g., `"RELAY, 24V DC"`)
- Escaped quotes within fields
- Clean API for filtering and aggregation

### Why This Matters

**NEVER use `line.split(',')` for CSV parsing.** It breaks on:
```csv
Item,Description,Cost
ABC123,"Relay, 24V DC with bracket",15.00
```

A naive split gives you: `["ABC123", "\"Relay", " 24V DC with bracket\"", "15.00"]` - wrong!

### Usage

```javascript
const { readCSVFile } = require('../shared/csv-utils');

// Read and parse
const csv = readCSVFile('/path/to/file.csv');

// Access data
console.log(csv.headers);        // ['Item', 'Description', 'Cost']
console.log(csv.rowCount);       // Number of data rows
console.log(csv.rows[0]);        // First row as array

// Get column index
const costIdx = csv.colIndex('Cost');

// Filter rows
const highCost = csv.filterByColumn('Cost', val => parseFloat(val) > 100);

// Sum a column (with optional filter)
const total = csv.sumColumn('Cost');
const w111Total = csv.sumColumn('Lot Cost', row => row[warehouseIdx] === 'W111');
```

### API Reference

| Function | Description |
|----------|-------------|
| `parseCSVLine(line)` | Parse single CSV line → array |
| `parseCSV(content, options)` | Parse CSV string → `{headers, rows}` |
| `readCSVFile(path, options)` | Read file → object with helper methods |
| `writeCSVFile(path, headers, rows)` | Write CSV with proper quoting |

### Options

```javascript
readCSVFile(path, {
  hasHeader: true,  // First row is header (default: true)
  skipRows: 0       // Skip N rows at start (default: 0)
});
```
