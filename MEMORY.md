# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (RFQ Matching Fix)**: Implemented 14-day date window for RFQ matching. Old RFQs with thousands of parts were catching unrelated quotes. New logic: exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]` for manual review. Output now uses RFQ's MPN (not vendor's quoted MPN) with differences noted in `chuboe_note_public`.
- **2026-03-03 (Vendor ID Correction)**: Fixed output files to use `search_key` instead of `c_bpartner_id`. Corrected parser-failure-tracker.json: vendor 1002981 is ECOMAL (not Xiamen Zhixinhe) - failures due to image CID references in emails.
- **2026-03-03 (VQ Parser Batch Extraction)**: Processed full VQ batch with 13 rounds of manual extraction. **Results:** 244 ready records, 46 partials, 18 RFQs covered, 88 unique vendors. Top failure vendors: ECOMAL (12), J2 Sourcing (10).
- **2026-03-03 (Documentation Cleanup & Consolidation)**: Major cleanup of repo structure. Consolidated `netcomponents_rfq/` → `rfq_sourcing/netcomponents/`. Fixed stale references. Established `kebab-case.md` naming convention.
