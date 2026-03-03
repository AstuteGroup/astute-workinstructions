# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Documentation Cleanup & Folder Consolidation)**: Consolidated RFQ sourcing folders (`netcomponents_rfq/` → `rfq_sourcing/netcomponents/`). Fixed stale references in CONVENTIONS.md, README.md. Renamed `vq_parser/README.md` → `vq-loading.md`, `LAM review/` → `LAM New Parts Pricing/`. Updated README with franchise screening workflow and correct paths. All documentation now follows kebab-case naming convention.
- **2026-03-03 (VQ Parser Complete Workflow & Batch Extraction)**: Processed full VQ batch with 13 rounds of manual extraction. **Results:** 249 ready records (84.4%), 46 partials (15.6%), 18 RFQs covered, 88 unique vendors, 96% vendor match rate. Documented complete 9-step workflow in CLAUDE.md. Added parser failure tracking. Top failure vendors: Xiamen Zhixinhe (12), J2 Sourcing (10).
- **2026-03-03 (Documentation Audit & Naming Convention)**: Established naming convention: descriptive `kebab-case.md` (never README.md). Renamed workflow docs: `inventory-file-cleanup.md`, `market-offer-matching.md`, `franchise-screening.md`, `rfq-sourcing-netcomponents.md`. Added Inventory File Cleanup as Workflow #8. Updated CONVENTIONS.md.
- **2026-03-02 (Flag Validation Bug Fixed)**: Fixed "148 partials" issue - flags never stripped after manual population. Integrated automatic flag-stripping into consolidate workflow. **Final result**: 245 complete records ready to load.
