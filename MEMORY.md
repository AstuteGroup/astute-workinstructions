# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Documentation Cleanup & Consolidation)**: Major cleanup of repo structure. Consolidated `netcomponents_rfq/` → `rfq_sourcing/netcomponents/` (RFQ sourcing now has franchise_check + netcomponents as siblings). Removed stale `vq_parser/` folder (VQ Parser lives in separate repo: AstuteGroup/vq-parser). Renamed `LAM review/` → `LAM New Parts Pricing/`. Fixed all stale references in README.md, CONVENTIONS.md. Added Franchise Screening to README workflows.
- **2026-03-03 (VQ Parser Batch Extraction)**: Processed full VQ batch with 13 rounds of manual extraction. **Results:** 249 ready records (84.4%), 46 partials (15.6%), 18 RFQs covered, 88 unique vendors, 96% vendor match rate. Top failure vendors: Xiamen Zhixinhe (12), J2 Sourcing (10).
- **2026-03-03 (Documentation Naming Convention)**: Established naming convention: descriptive `kebab-case.md` (never README.md). Renamed workflow docs: `inventory-file-cleanup.md`, `market-offer-matching.md`, `franchise-screening.md`, `rfq-sourcing-netcomponents.md`. Added Inventory File Cleanup as Workflow #8.
- **2026-03-02 (Flag Validation Bug Fixed)**: Fixed "148 partials" issue - flags never stripped after manual population. Integrated automatic flag-stripping into consolidate workflow. **Final result**: 245 complete records ready to load.
