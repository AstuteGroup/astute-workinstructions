# Shared Modules

**CHECK HERE BEFORE BUILDING NEW FUNCTIONALITY.** If a module exists, use it. If what you need is close but not exact, extend the existing module — don't create a parallel one.

**Rule:** If it's used by 2+ workflows, it lives in `shared/` and is registered here.

---

## Module Registry

| Module | Purpose | Use When | Consumers |
|--------|---------|----------|-----------|
| `franchise-api.js` | All 10 franchise distributor APIs (DigiKey, Arrow, Rutronik, Future, Newark, TTI, Mouser, Master, Waldom, Sager) | Need franchise stock/pricing for ANY workflow | Franchise Screening, Suggested Resale, VQ Loading, Quick Quote |
| `market-data.js` | DB queries: VQ history, sales history (broker vs customer), market offers, RFQ demand | Need pricing intelligence from the system | Suggested Resale, Quick Quote, Vortex Matches, Market Offer Analysis |
| `mfr-lookup.js` | Resolve manufacturer names → canonical `chuboe_mfr.name`. Aliases (165+) → DB → cache. | Normalizing MFR names from any source | VQ Loading, Market Offer Uploading, Stock RFQ Loading |
| `partner-lookup.js` | Resolve email/name → iDempiere business partner | Matching sender to BP in any inbound email workflow | VQ Loading, Market Offer Uploading, Stock RFQ Loading |
| `csv-utils.js` | CSV parsing with proper quoting | Any CSV read/write (**NEVER** use `line.split(',')`) | All workflows |
| `logger.js` | Timestamped logging with optional prefix | Any module needing structured logs | All workflows, all shared cogs |
| `himalaya-cli.js` | Low-level himalaya binary wrapper (JSON output) | Any email operation | email-fetcher.js |
| `email-fetcher.js` | Email operations: list, read, move, folders. Factory: `createFetcher(account)` | Fetching/routing emails from any inbox | VQ Loading, Stock RFQ Loading |
| `email-tracker.js` | Processed email dedup, stats, retry queue. Factory: `createTracker(dataDir)` | Tracking processed emails in any workflow | VQ Loading, Stock RFQ Loading |
| `notifier.js` | Email notifications via AWS WorkMail SMTP. Factory: `createNotifier({fromEmail, fromName})` | Sending notifications/attachments from any workflow | VQ Loading, Stock RFQ Loading |
| `rfq-writer.js` | Write RFQs to `ai_writeback` schema (header + line + line_mpn). Auto IDs, MPN description enrichment, MFR ID lookup. | Writing any RFQ type to the ERP writeback | Stock RFQ Loading, (future) other RFQ workflows |
| `offer-writeback.js` | Write market offers to `ai_writeback` schema (header + line + optional line_mpn). Auto IDs, batch write, deactivation of prior offers. | Writing any offer type to the ERP writeback | Market Offer Uploading, Inventory File Cleanup, (future) VQ Loading |
| `api-result-writer.js` | Capture full franchise API responses (all price breaks, stock, lead time) to cache + DB. Extract qty-relevant prices for downstream consumers. | After any `searchAllDistributors()` call (write), or when Vortex/Quick Quote needs franchise pricing (read) | Franchise Screening, Suggested Resale, LAM Kitting (write); Vortex Matches, Quick Quote (read) |
| `db-helpers.js` | Shared DB utilities: `psqlQuery`, `psqlExec`, `getNextId`, `sqlStr`, `sqlNum`, `cleanMpn`, `tableExists` | Any module writing to `ai_writeback` | offer-writeback.js, rfq-writer.js, api-result-writer.js |

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
| Waldom Electronics | 1002648 | `waldom.js` | Activated 2026-03-25, key in URL path |

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

---

## logger.js

Timestamped console logging with optional prefix. Supports `VERBOSE`/`DEBUG` env vars for debug output.

```javascript
const logger = require('../shared/logger');                     // default (no prefix)
const log = require('../shared/logger').createLogger('StockRFQ'); // prefixed: [StockRFQ]

log.info('Processing email 133');   // [2026-03-20T13:21:07Z] [StockRFQ] INFO: Processing email 133
log.debug('Details...');            // Only shown when VERBOSE=1 or DEBUG=1
```

**Extracted from:** `vq-parser/src/utils/logger.js`

---

## himalaya-cli.js

Low-level wrapper around the himalaya binary. Runs commands with `--output json` and parses results. Used internally by `email-fetcher.js`.

```javascript
const { runHimalaya } = require('../shared/himalaya-cli');
const result = await runHimalaya(['envelope', 'list', '--account', 'vq', '--folder', 'INBOX']);
```

**Extracted from:** `vq-parser/src/utils/himalaya-cli.js`

---

## email-fetcher.js

Factory that creates an email fetcher bound to a himalaya account. All email operations (list, read, move, folders) go through this.

```javascript
const { createFetcher } = require('../shared/email-fetcher');
const fetcher = createFetcher('stockrfq');

const envelopes = await fetcher.listEnvelopes('INBOX', 500);
const body = await fetcher.readMessage(envelopes[0].id);
await fetcher.moveMessage(envelopes[0].id, 'Processed');
await fetcher.createFolder('NeedsReview');
```

**API:** `listEnvelopes`, `readMessage`, `getRawMessage`, `moveMessage`, `verifyMessageGone`, `listFolders`, `createFolder`, `getMessageHeaders`, `markUnread`, `downloadAttachments`

**Extracted from:** `vq-parser/src/email/fetcher.js` — changed from env var `HIMALAYA_ACCOUNT` to factory parameter.

---

## email-tracker.js

Factory that creates a tracker bound to a workflow's data directory. Handles processed email dedup, run stats, and retry queue for failed moves.

```javascript
const { createTracker } = require('../shared/email-tracker');
const tracker = createTracker(path.join(__dirname, 'data'));

if (!tracker.isProcessed(emailId)) {
  // process email...
  tracker.markProcessed(emailId, { subject, from, recordsAdded: 3 });
}

tracker.updateStats({ emailsProcessed: 1, recordsGenerated: 5 });
const stats = tracker.getStats();
```

**Data files** (per workflow, in `dataDir`): `processed-ids.json`, `stats.json`, `retry-queue.json`

**Extracted from:** `vq-parser/src/email/tracker.js` — changed from hardcoded path to factory parameter.

---

## notifier.js

Factory that creates an email notifier with configurable sender identity. Uses nodemailer with AWS WorkMail SMTP.

```javascript
const { createNotifier } = require('../shared/notifier');
const notifier = createNotifier({
  fromEmail: 'stockRFQ@orangetsunami.com',
  fromName: 'Stock RFQ Loader'
});

await notifier.sendEmail('jake@example.com', 'Subject', 'Body text');
await notifier.sendWithAttachment('jake@example.com', 'Subject', 'Body', [
  { filename: 'output.csv', path: '/path/to/file.csv' }
]);
```

**SMTP password:** Set via `SMTP_PASS` env var or pass as `smtpPass` option.

**Extracted from:** `vq-parser/src/utils/notifier.js` — generic send moved to shared; VQ-specific `sendFetchSummary` stays in vq-parser.

---

## rfq-writer.js

Writes complete RFQ records (header + lines + line MPNs) to the `ai_writeback` schema for ERP import via FDW. Handles all RFQ types.

```javascript
const { writeRFQ, lookupMfrId } = require('../shared/rfq-writer');

const mfrId = lookupMfrId('Vishay');  // → 1019796

const result = await writeRFQ({
  bpartnerId: 1000190,           // AGS Devices
  type: 'Stock',                  // or 'Shortage', 'PPV', etc.
  description: 'RFQ #790665',    // customer reference (optional)
  // salesrepId: 1000004,         // defaults to Jake Harris
  lines: [
    { mpn: '561R10TCCT12', mfrId, qty: 200, targetPrice: 0 }
  ]
});
// → { rfqId: 9000000, linesWritten: 1, mpnsWritten: 1, errors: [] }
```

### Features

| Feature | Details |
|---------|---------|
| **Auto ID management** | IDs start at 9,000,000+, queries `ai_writeback` for current max |
| **MPN description enrichment** | Looks up existing description from system (past 120 days) |
| **API enrichment hook** | `enrichDescription(mpn, mpnClean)` callback for future API data |
| **MFR ID lookup** | `lookupMfrId(name)` resolves manufacturer name → `chuboe_mfr_id` |
| **MPN cleaning** | Strips non-alphanumeric, uppercases (matches iDempiere behavior) |
| **All mandatory fields** | iDempiere columns, flag defaults, salesrep, status |

### Schema Reference

> See [`shared/data-model.md`](data-model.md) for RFQ type IDs, table hierarchy (header → line → line_mpn), field definitions, and join patterns.

---

## offer-writeback.js

Writes complete market offers (header + lines + optional line MPNs) to the `ai_writeback` schema for ERP import via FDW. Handles all offer types.

```javascript
const { writeOffer, writeOffers, deactivatePriorOffers, lookupMfrId } = require('../shared/offer-writeback');

// Write a single offer
const result = await writeOffer({
  bpartnerId: 1000332,              // Astute Electronics Inc
  offerTypeId: 1000008,             // or 'Stock - Austin Warehouse'
  description: 'Weekly inventory 2026-03-23',
  lines: [
    { mpn: 'ADS1115IDGST', mfrText: 'Texas Instruments', qty: 500, price: 3.50, dateCode: '2024+' },
    { mpn: 'LM358DR', qty: 1000, price: 0.25 }
  ]
});
// → { offerId: 9000000, linesWritten: 2, mpnsWritten: 0, errors: [] }

// Batch: write multiple offers at once
const results = await writeOffers([offer1Opts, offer2Opts, offer3Opts]);

// Deactivate prior offers before refresh (e.g., weekly inventory)
deactivatePriorOffers(1000332, 1000008);  // BP + type
```

### Schema Reference

> See [`shared/data-model.md`](data-model.md) for offer type IDs, table hierarchy (header → line → line_mpn), field definitions (writeOffer options + line object fields), and join patterns.

---

## api-result-writer.js

Captures full franchise API responses (all price breaks, stock, lead time, MOQ) for market intelligence. Dual-write: local cache + DB (when available).

**Key distinction:**
- **VQ lines** get ONE price per distributor (at RFQ qty) — for active sourcing
- **API result cache/DB** gets ALL price breaks — for Vortex, Quick Quote, Hurricane

### Data Flow

```
searchAllDistributors() → writePricingResult()
    ├─► Cache: shared/data/api-pricing-cache/{MPN}_{date}.json (always)
    └─► DB: ai_writeback.chuboe_pricing_api_result (when table exists)

extractPriceAtQty() ← Vortex / Quick Quote / future workflows
    reads DB first → falls back to cache → filters by maxAgeDays
    returns one row per distributor with price at requested qty
```

### Write (after API calls)

```javascript
const { writePricingResult } = require('../shared/api-result-writer');

// Fire-and-forget — never blocks the sourcing workflow
writePricingResult({
  searchResult: franchise,      // from searchAllDistributors()
  mpn: 'ADS1115IDGST',
  qty: 700,
  rfqId: 1131217,               // optional — links to triggering RFQ
  source: 'franchise-screening' // consumer name for tracking
}).catch(err => console.error(err.message));
```

### Read (for market intelligence)

```javascript
const { extractPriceAtQty } = require('../shared/api-result-writer');

// Get price at qty 700 from data no older than 90 days
const rows = extractPriceAtQty('ADS1115IDGST', 700, { maxAgeDays: 90 });
// → [{ supplier: 'DigiKey', priceAtQty: 2.47, stock: 45000, ... }, ...]
```

### Freshness Rules (enforced by reader, not writer)

| Consumer | `maxAgeDays` | Rationale |
|----------|-------------|-----------|
| Vortex Matches | 90 | Matches 90-day offer/VQ window |
| Quick Quote | 30 | Matches 30-day VQ window |
| On-demand | 7 | Fresh data for active decisions |

### Utilities

| Function | Purpose |
|----------|---------|
| `flushCacheToDB()` | Bulk import cache → DB (run once when table ready) |
| `pruneCache(maxAgeDays)` | Delete cache files older than N days (default 90) |

---

## db-helpers.js

Shared database utilities extracted from offer-writeback.js. Used by all modules that write to `ai_writeback`.

```javascript
const { psqlQuery, psqlExec, getNextId, sqlStr, sqlNum, cleanMpn, tableExists } = require('../shared/db-helpers');
```

| Function | Purpose |
|----------|---------|
| `psqlQuery(sql)` | Run SELECT, return filtered output |
| `psqlExec(sql)` | Run INSERT/UPDATE, return true/false |
| `getNextId(table, column)` | Next safe ID (9000000+) |
| `sqlStr(val)` | Escape string for SQL (or NULL) |
| `sqlNum(val)` | Coerce to number for SQL (or NULL) |
| `cleanMpn(mpn)` | Strip non-alphanumeric, uppercase |
| `tableExists(name)` | Check if ai_writeback table exists |
