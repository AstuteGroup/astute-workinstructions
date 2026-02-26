# Claude Code Session Memory

This file tracks recent work sessions and provides quick context for continuing work.

## Recent Sessions

1. **Franchise Screening Workflow** (2026-02-26)
   - Built FindChips scraper to screen RFQs before broker sourcing
   - Filters low-value opportunities (OV < threshold) where franchise has stock
   - Fixed MPN matching (normalize dashes, handle suffixes like -TR500)
   - Fixed session state issues (fresh browser context per search)
   - Tested on RFQ 1130410 and 11 single-line RFQs
   - Location: `rfq_sourcing/franchise_check/`

2. **RFQ Sourcing - Lock File & Supplier Tracking** (2026-02-25)
   - Added lock file to prevent duplicate batch runs (`.lock` in RFQ folder)
   - Added qualifying supplier tracking columns (Qualifying, Qual Amer/Eur, Selected)
   - Added supplier distribution summary at end of batch
   - RFQ subfolders now organize all output files per RFQ number
   - Location: `netcomponents_rfq/`

3. **RFQ Sourcing - CPC Analysis & Stability Fixes** (2026-02-25)
   - Added CPC column to batch results for line-level tracking
   - Created `analyze_no_suppliers.py` - standalone tool to identify CPCs needing manual work
   - Fixed timeout crashes with proper `wait_for_selector` calls
   - Ran RFQ 1130292: 400 RFQs sent, 29 CPCs need attention
   - Location: `netcomponents_rfq/`

4. **RFQ Sourcing - Parallel Processing** (2026-02-25)
   - Added 3 parallel browser workers for batch RFQs
   - Added timing jitter (±40%) to appear natural
   - 138-part batch runs in ~49 min vs 140 min sequential
   - Location: `netcomponents_rfq/`

---

## Workflow Index

### Active Workflows

| Workflow | Location | Description |
|----------|----------|-------------|
| **Franchise Screening** | `rfq_sourcing/franchise_check/` | Pre-screen RFQs via FindChips before broker sourcing |
| **RFQ Sourcing** | `netcomponents_rfq/` | Automated supplier RFQ submission via NetComponents |
| **VQ Loading** | `Trading Analysis/VQ Loading/` | Process supplier quotes into VQ template |
| **Market Offer Matching** | `Trading Analysis/Market Offer Matching for RFQs/` | Match RFQs to customer excess/stock |
| **Quick Quote** | `Trading Analysis/Quick Quote/` | Generate baseline quotes from recent VQs |
| **Order/Shipment Tracking** | `Trading Analysis/saved-queries/` | Look up tracking by various identifiers |

### Analysis & Reporting

| Workflow | Location | Description |
|----------|----------|-------------|
| **LAM Billings Review** | `Trading Analysis/LAM Billings Review/` | LAM revenue and margin analysis |
| **Seller Quoting Activity** | (ad-hoc queries) | VQ→CQ→SO funnel analysis by seller |
| **Inventory File Cleanup** | `Trading Analysis/Inventory File Cleanup/` | Clean customer inventory uploads |

---

## Key Files

### Franchise Screening (`rfq_sourcing/franchise_check/`)
- `main.js` - Entry point: screen parts from RFQ, file, or single part
- `search.js` - FindChips scraper with MPN validation
- `config.js` - Settings: threshold, delays, data source

**Usage:**
```bash
# Screen from iDempiere RFQ
node main.js --rfq 1130410 --threshold 100

# Single part check
node main.js -p "LM358N" -q 100

# From Excel file
node main.js -f parts.xlsx --threshold 50
```

**Key Settings (config.js):**
- `OPPORTUNITY_THRESHOLD = 50` - Skip broker if OV below this
- `DATA_SOURCE = 'findchips'` - Data source (findchips or trustedparts)
- `SEARCH_DELAY = 1500` - Delay between searches (ms)

**Decision Logic:**
- Skip broker if: franchise_qty >= customer_qty AND opportunity_value < threshold
- OV = lowest_franchise_price × customer_qty

---

### RFQ Sourcing (`netcomponents_rfq/`)
- `python/submit_rfqs.py` - Single part RFQ submission
- `python/batch_rfqs_from_system.py` - Batch RFQ with 3 parallel workers
- `python/analyze_no_suppliers.py` - Analyze results for CPCs needing manual work
- `python/list_suppliers.py` - Preview suppliers without submitting
- `python/config.py` - Settings: workers, jitter, DC window, max suppliers
- `python/RFQ_<number>/` - Output subfolders created per RFQ batch
- `node/.env` - NetComponents credentials (shared)

**Key Settings (config.py):**
- `NUM_WORKERS = 3` - Parallel browser instances
- `JITTER_RANGE = 0.4` - ±40% timing variation
- `MAX_SUPPLIERS_PER_REGION = 3` - Suppliers per region
- `DC_PREFERRED_WINDOW_YEARS = 2` - Date code freshness (2024+)

**Safety Features:**
- Lock file (`.lock`) prevents duplicate batch runs
- Stale lock detection (auto-removes if process crashed)

### Database Access
- Connection: `psql` (no password needed)
- Schemas: `adempiere`, `intermediate`, `mart`
