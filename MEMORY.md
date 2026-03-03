# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Vendor ID Correction)**: Fixed critical issue - output files were using `c_bpartner_id` (internal DB key) instead of `search_key` (business identifier). Updated output CSVs to use `vendor_search_key` column. Corrected parser-failure-tracker.json: vendor 1002981 is ECOMAL (not Xiamen Zhixinhe) - failures due to image CID references ([cid:XXXXXXXX]) in emails with quotes in PDF attachments.
- **2026-03-03 (Documentation Cleanup & Consolidation)**: Major cleanup of repo structure. Consolidated `netcomponents_rfq/` → `rfq_sourcing/netcomponents/`. Removed stale `vq_parser/` folder. Renamed `LAM review/` → `LAM New Parts Pricing/`. Fixed stale references in README.md, CONVENTIONS.md.
- **2026-03-03 (VQ Parser Batch Extraction)**: Processed full VQ batch with 13 rounds of manual extraction. **Results:** 244 ready records, 46 partials, 18 RFQs covered, 88 unique vendors. Top failure vendors: ECOMAL (12), J2 Sourcing (10).
- **2026-03-03 (Documentation Naming Convention)**: Established naming convention: descriptive `kebab-case.md` (never README.md). Renamed workflow docs. Added Inventory File Cleanup as Workflow #8.
