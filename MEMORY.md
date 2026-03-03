# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-03 (Documentation Audit & Naming Convention)**: Audited workflow documentation and established new naming convention. Renamed generic `README.md` files to descriptive names: `inventory-file-cleanup.md`, `market-offer-matching.md`, `franchise-screening.md`, `rfq-sourcing-netcomponents.md`. Added Inventory File Cleanup as Workflow #8 in CLAUDE.md with comprehensive documentation. Updated CONVENTIONS.md with new standard: use descriptive `kebab-case.md` names, never generic README.md. Added Documentation Standards section to CLAUDE.md referencing CONVENTIONS.md (so conventions are discoverable). Skipped VQ Loading README (active work in separate terminal).
- **2026-03-02 (Flag Validation Bug Fixed)**: Identified and fixed root cause of "148 partials" issue. Parser was setting [PARTIAL] flags during initial parse when data missing, but flags never stripped after manual population. All 131 flagged records actually had qty+cost populated. **Solution**: Integrated automatic flag-stripping into consolidate workflow. Created flag-stripper.js utility. Currency validation removed (blank = USD default per requirement). **Final result**: 245 complete records, 100% ready to load.
- **2026-02-28**: Fixed VQ Parser batch reprocess and vendor matching. Key fixes: (1) batch-reprocess.js now uses current folder IDs instead of stored IDs (IMAP IDs change when emails move), (2) added domain-based vendor lookup (e.g., velocityelec.com → Velocity Electronics), (3) added name-based fallback. Results: 88% email read success, 79% vendor match rate (up from 54%). 266 records in final upload.
- **2026-02-27 (PM)**: Completed VQ Loading enhancements. Added: Himalaya email integration, multi-source extraction (PDF/Excel/hyperlinks), RFQ resolution by MPN database lookup, fuzzy MPN matching with progressive trimming, partial data flagging, MPN mismatch notes.
