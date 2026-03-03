# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Roadmap Consolidation)**: Created unified `/ROADMAP.md` merging RFQ Sourcing and VQ Parser roadmaps. Added new RFQ Deduplication feature (MPN+Supplier cooldown window). Cleaned up stale files: removed `vq_parser/` folder (separate repo), old analysis CSVs, `1129840/` experiment folder. Renamed `LAM review/` → `LAM New Parts Pricing/`.
- **2026-03-03 (RFQ Matching Fix)**: Implemented 14-day date window for RFQ matching. New logic: exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]`. Output uses RFQ's MPN with differences noted.
- **2026-03-03 (Vendor ID Correction)**: Fixed output to use `search_key` instead of `c_bpartner_id`. Corrected parser-failure-tracker.json vendor identification.
- **2026-03-03 (VQ Parser Batch Extraction)**: 244 ready records, 46 partials, 18 RFQs, 88 vendors. Top failures: ECOMAL (12), J2 Sourcing (10).
