# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (RFQ Sourcing Folder Consolidation)**: Consolidated `netcomponents_rfq/` into `rfq_sourcing/netcomponents/` to create logical hierarchy. RFQ Sourcing workflow now has two sibling folders: `franchise_check/` (Step 1: Franchise screening) and `netcomponents/` (Step 2: Broker sourcing). Updated CLAUDE.md workflow reference to new path.
- **2026-03-03 (VQ Parser Complete Workflow & Batch Extraction)**: Processed full VQ batch with 13 rounds of manual extraction. **Results:** 249 ready records (84.4%), 46 partials (15.6%), 18 RFQs covered, 88 unique vendors, 96% vendor match rate. **Process improvements:** Documented complete 9-step workflow in CLAUDE.md. Added parser failure tracking (`data/parser-failure-tracker.json`) to prioritize vendor template development. Split output into READY vs PARTIALS_REVIEW files. Top failure vendors: Xiamen Zhixinhe (12), J2 Sourcing (10) - both generate garbage MPNs. Renamed `README.md` → `vq-loading-workflow.md` per conventions. ~45 min total processing time, 4.5 records/min extraction rate.
- **2026-03-03 (Documentation Audit & Naming Convention)**: Audited workflow documentation and established new naming convention. Renamed generic `README.md` files to descriptive names: `inventory-file-cleanup.md`, `market-offer-matching.md`, `franchise-screening.md`, `rfq-sourcing-netcomponents.md`. Added Inventory File Cleanup as Workflow #8 in CLAUDE.md with comprehensive documentation. Updated CONVENTIONS.md with new standard: use descriptive `kebab-case.md` names, never generic README.md.
- **2026-03-02 (Flag Validation Bug Fixed)**: Identified and fixed root cause of "148 partials" issue. Parser was setting [PARTIAL] flags during initial parse when data missing, but flags never stripped after manual population. All 131 flagged records actually had qty+cost populated. **Solution**: Integrated automatic flag-stripping into consolidate workflow. Created flag-stripper.js utility. Currency validation removed (blank = USD default per requirement). **Final result**: 245 complete records, 100% ready to load.
