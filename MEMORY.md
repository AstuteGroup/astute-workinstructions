# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-04 (Roadmap Reorganization)**: Created MASTER-ROADMAP.md for high-level initiative tracking. Moved detailed sourcing roadmap to `rfq_sourcing/sourcing-roadmap.md`. Added PPV Analysis (Vortex Rebuild) as new initiative.
- **2026-03-03 (UUID Filter + RFQ Analysis)**: Added UUID exclusion filter to regex-parser.js - filters out email CID references (embedded image IDs) that were being extracted as garbage MPNs from J2 Sourcing emails. Analyzed MPN coverage: 60% of "unmatched" MPNs actually found correct RFQs in 14-day window (just different RFQs than 1130292). Confirmed fuzzy matching working correctly for packaging suffixes.
- **2026-03-03 (Roadmap Priority Update)**: Updated priority terminology from Q2/Q3/Q4 to Now/Next/Later/Backlog. Consolidated `netcomponents_rfq/` → `rfq_sourcing/netcomponents/`. Created unified `/ROADMAP.md` with Supplier Selection Deduplication feature (B1) and No-Bid Filtering (B2).
- **2026-03-03 (RFQ Matching Fix)**: Implemented 14-day date window for RFQ matching. New logic: exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]`. Output uses RFQ's MPN with differences noted.
