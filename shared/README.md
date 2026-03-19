# Shared Modules

**CHECK HERE BEFORE BUILDING NEW FUNCTIONALITY.** If a module exists, use it. If what you need is close but not exact, extend the existing module — don't create a parallel one.

**Rule:** If it's used by 2+ workflows, it lives in `shared/` and is registered here.

---

## Module Registry

| Module | Purpose | Use When | Consumers |
|--------|---------|----------|-----------|
| `franchise-api.js` | All 7 franchise distributor APIs (DigiKey, Arrow, Rutronik, Future, Newark, TTI, Master) | Need franchise stock/pricing for ANY workflow | Franchise Screening, Suggested Resale, VQ Loading, Quick Quote |
| `market-data.js` | DB queries: VQ history, sales history (broker vs customer), market offers, RFQ demand | Need pricing intelligence from the system | Suggested Resale, Quick Quote, Vortex Matches, Market Offer Analysis |
| `mfr-lookup.js` | Resolve manufacturer names → canonical `chuboe_mfr.name`. Aliases (165+) → DB → cache. | Normalizing MFR names from any source | VQ Loading, Market Offer Uploading, Stock RFQ Loading |
| `partner-lookup.js` | Resolve email/name → iDempiere business partner | Matching sender to BP in any inbound email workflow | VQ Loading, Market Offer Uploading, Stock RFQ Loading |
| `csv-utils.js` | CSV parsing with proper quoting | Any CSV read/write (**NEVER** use `line.split(',')`) | All workflows |

---

## franchise-api.js

Centralized access to all active franchise distributor APIs. Returns standardized results per distributor plus VQ-ready data for ERP import.

**Key distinction:**
- **API data = confirmed pricing** → captured as VQ lines (this module)
- **FindChips scraped data = availability reference only** → NOT captured as VQ (see `Trading Analysis/RFQ Sourcing/franchise_check/main.js`)

### Active Distributors

| Distributor | BP Value | Script | Notes |
|-------------|----------|--------|-------|
| DigiKey | 1002331 | `digikey.js` | OAuth2, broadest catalog |
| Arrow | 1002390 | `arrow.js` | Filters out Verical marketplace |
| Rutronik | 1004668 | `rutronik.js` | European, may not stock all US parts |
| Future Electronics | 1002332 | `future.js` | Orbweaver API |
| Newark/Farnell | 1002394 | `newark.js` | Queries both US + UK stores |
| TTI | 1002330 | `tti.js` | Strong on passives/connectors |
| Master Electronics | 1002409 | `master.js` | Activated 2026-03-17 |

### Usage

```javascript
const { searchAllDistributors, searchPart, writeVQCapture } = require('../shared/franchise-api');

// Search ALL distributors (parallel by default)
const results = await searchAllDistributors('ADS1115IDGST', 700);

console.log(results.summary);
// { totalStock: 4521, distributorsWithStock: 3, lowestPrice: 3.12,
//   coverage: 'FULL', coveragePct: 646 }

console.log(results.distributors);  // All 7 results (found or not)
console.log(results.found);         // Only distributors with stock
console.log(results.vqLines);       // VQ-ready rows for ERP import

// Write VQ capture file
writeVQCapture('/path/to/output_VQ.csv', results.vqLines);

// Search single distributor
const dk = await searchPart('digikey', 'ADS1115IDGST', 700);
```

### Output: `results.summary`

| Field | Description |
|-------|-------------|
| `totalStock` | Combined stock across all distributors |
| `distributorsWithStock` | How many distributors have it |
| `lowestPrice` | Best bulk price across all distributors |
| `coverage` | `FULL` / `PARTIAL` / `NONE` (vs requested qty) |
| `coveragePct` | Total stock as % of requested qty |

### Workflow-Specific Usage

| Workflow | What It Uses | Why |
|----------|-------------|-----|
| **Franchise Screening** | `summary.coverage`, `summary.totalStock` | Skip/proceed decision for broker sourcing |
| **Suggested Resale** | `summary.lowestPrice`, `summary.coverage` | Franchise price = market reference. If franchise has stock → price 20-30% below their best. If none → scarcity premium. |
| **VQ Loading** | `results.vqLines` | Generate VQ template rows from confirmed API pricing |
| **Quick Quote** | `summary.lowestPrice` | Franchise price as ceiling on suggested resale |

---

## partner-lookup.js

Resolves business partners (vendors or customers) from email addresses and company names against iDempiere. Used by VQ Loading, Market Offer Uploading, and Stock RFQ Loading.

See `partner-matching.md` for full documentation.

```javascript
const { resolvePartner } = require('../shared/partner-lookup.js');

const result = resolvePartner({
  email: 'bliss@hongdaelectronicsco.com.cn',
  companyName: 'Hongda Electronics Co.',
  partnerType: 'any'  // 'vendor', 'customer', or 'any'
});
// → { search_key: '1007848', name: 'Hongda electronics co., ltd', matched: true, tier: 2, tierName: 'domain_hint' }
```

**Matching tiers:** exact email → email domain → domain hint → name match

---

## market-data.js

Centralized DB queries for all pricing intelligence. Queries VQ history, sales history (distinguishing broker vs customer), market offers, and RFQ demand.

```javascript
const { getAllMarketData, getVQHistory, getSalesHistory } = require('../shared/market-data');

// Get everything for a part
const data = getAllMarketData('ADS1115IDGST');
console.log(data.vqSummary);        // { count, low, high, median, purchasedCost }
console.log(data.brokerSales);       // strongest price signal
console.log(data.demandStrength);    // HIGH/MEDIUM/LOW/NONE
console.log(data.offerPriceRange);   // { low, high }

// Or individual queries with options
const vqs = getVQHistory('ADS1115IDGST', { months: 6 });
const sales = getSalesHistory('ADS1115IDGST', { months: 12 });
```

**Includes:** `cleanMpn()`, `getBaseMpn()`, `mpnWhereClause()` for MPN normalization and packaging-variant matching (e.g., FT2232HL-REEL → also searches FT2232HL).

---

## mfr-lookup.js

Resolves manufacturer names to canonical `chuboe_mfr.name` values. Three-tier resolution:

1. **Alias file** (`mfr-aliases.json`, 165+ entries) — fast, covers common abbreviations
2. **DB lookup** (`chuboe_mfr` table) — strict matching, avoids false positives
3. **Cache** — previous results stored in `shared/data/mfr-cache.json`

```javascript
const { normalizeMfr, lookupMfr } = require('../shared/mfr-lookup');

normalizeMfr('TI');           // → 'Texas Instruments Incorporated'
normalizeMfr('MICRON');       // → 'Micron Technology, Inc.'

const detail = lookupMfr('NEXPERIA');
// → { canonical: 'Nexperia', source: 'alias', matched: true }
```

**Alias file location:** `Trading Analysis/Market Offer Uploading/mfr-aliases.json`

---

## csv-utils.js

Proper CSV parsing that handles quoted fields containing commas, escaped quotes, and provides clean filtering/aggregation API.

**NEVER use `line.split(',')` for CSV parsing.** It breaks on quoted fields.

```javascript
const { readCSVFile, writeCSVFile } = require('../shared/csv-utils');

const csv = readCSVFile('/path/to/file.csv');
console.log(csv.headers);
const filtered = csv.filterByColumn('Warehouse', 'W111');
const total = csv.sumColumn('Lot Cost');

writeCSVFile('/path/to/output.csv', headers, rows);
```

### API Reference

| Function | Description |
|----------|-------------|
| `parseCSVLine(line)` | Parse single CSV line → array |
| `parseCSV(content, options)` | Parse CSV string → `{headers, rows}` |
| `readCSVFile(path, options)` | Read file → object with helper methods |
| `writeCSVFile(path, headers, rows)` | Write CSV with proper quoting |
