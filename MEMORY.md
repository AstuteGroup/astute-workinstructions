# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Roadmap Priority Update)**: Updated priority terminology from Q2/Q3/Q4 to Now/Next/Later/Backlog. Consolidated `netcomponents_rfq/` → `rfq_sourcing/netcomponents/`. Removed stale `vq_parser/` folder, old CSVs, `1129840/` experiment folder. Created unified `/ROADMAP.md` with Supplier Selection Deduplication feature (B1) and No-Bid Filtering (B2).
- **2026-03-03 (RFQ Matching Fix)**: Implemented 14-day date window for RFQ matching. New logic: exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]`. Output uses RFQ's MPN with differences noted.
- **2026-03-03 (Vendor ID Correction)**: Fixed output to use `search_key` instead of `c_bpartner_id`. Corrected parser-failure-tracker.json vendor identification.
- **2026-03-03 (VQ Parser Batch Extraction)**: 244 ready records, 46 partials, 18 RFQs, 88 vendors. Top failures: ECOMAL (12), J2 Sourcing (10).
