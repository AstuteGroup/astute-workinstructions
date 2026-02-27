# Claude Code Session Memory

This file tracks recent work sessions and provides quick context for continuing work.

## Recent Sessions

1. **RFQ Sourcing - Complete & Roadmap** (2026-02-27) - **COMPLETE**
   - All scoring/detection fixes implemented and tested
   - MPN packaging normalization: strips -TR/-TRL suffixes, normalizes #TRPBF→#PBF
   - Created `rfq_sourcing/ROADMAP.md` with 5 planned enhancements:
     1. LLM description scanning (restrictions detection)
     2. Cross-region duplicate detection
     3. Supplier fatigue tracking
     4. Alternate packaging analysis
     5. Memory product handling
   - All code committed and pushed to GitHub

2. **RFQ Sourcing - Scoring & Detection Fixes** (2026-02-27) - **COMPLETE**
   - Fixed header row detection: use cell count (headers <5 cells, data 16+)
   - Fixed supplier link finding: search in table column 15, not page-wide
   - Fixed "24+" date codes: now score as fresh (Tier 6), not unknown
   - Fixed qty tiebreaker: suppliers meeting qty are equal within tier
   - Tested on RFQ 1130462: 4 parts sourced, 17 RFQs sent

3. **VQ Loading - Enhanced Parser** (2026-02-27) - **COMPLETE**
   - Added Himalaya email integration for direct inbox access (`vq@orangetsunami.com`)
   - Multi-source extraction: PDF (pdf.js-extract), Excel/CSV (xlsx), hyperlinks (Playwright)
   - RFQ resolution by MPN database lookup (not supplier ref numbers)
   - Fuzzy MPN matching with progressive character trimming
   - Location: `~/workspace/vq-parser/`, `Trading Analysis/VQ Loading/`

4. **RFQ Sourcing - Min Order Value Filter** (2026-02-27) - **IMPLEMENTED**
   - Franchise Screening captures bulk price (last column) from FindChips
   - Filter: `est_value = franchise_bulk_price × supplier_qty × multiplier`
   - Multiplier = 0.2 (abundant) or 0.7 (scarce)
   - Skip supplier if min_order_value > est_value

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
- `ROADMAP.md` - Future enhancements roadmap (in `rfq_sourcing/`)
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
