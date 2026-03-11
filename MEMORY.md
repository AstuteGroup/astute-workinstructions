# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-11 (VQ Parser Pagination Fix)**: Fixed bug where scheduled VQ fetches only saw 50 emails. Root cause: `listEnvelopes()` in `fetcher.js` had default pageSize=50. Changed to 500. Committed to vq-parser repo (ead90c9). Cron job location still unknown (not in user crontab, systemd, or visible configs - likely admin-managed or cloud scheduler).
- **2026-03-11 (LAM Billings Review Cleanup)**: Reorganized CM Billings and Stale Inventory folders with Source (by year: 2024/2025/2026) and Final subfolders. Extended Stale analysis (COV0020665): confirmed seller used markup (×1.18) instead of margin (÷0.82), underbilling $5,965. Created GP by buyer breakdown using Contract Pricing column AF. Merged Daniel/DM into Edgar Santana across all files. Added 2026 tab with margins to GP_by_Buyer_Final.xlsx. Deleted working/intermediate files.
- **2026-03-11 (Inventory File Cleanup)**: Processed USS_4544132 (5,641 rows, 13 warehouse groups). Created Node.js script (`inventory_cleanup.js`) since Python unavailable. New folder structure: `Inventory YYYY-MM-DD/` (dated, replaces old `output/`). Added retention policy: delete input after approval, delete previous folder when new one created. Excluded warehouses W110/W116 intentionally.
- **2026-03-10 (Vortex Matches Refinements)**: Implemented and refined for RFQs 1130895, 1130899. Key fixes: stock no longer filtered by 90-day window, removed bad columns (RFQ Manufacturer, Vendor Grade), MO Type blank for VQs, % Under Target in column B, RFQ line deduplication, decimal precision for prices. Created `Trading Analysis/trading-analysis-roadmap.md` with planned items (A1: Opp Amount, A2: filter low % of Demand). Added roadmap conventions to CONVENTIONS.md and CLAUDE.md.

---

## Reconciliation Adjustments

### COV0019122 NRE Credit Adjustment (2026-03-09)

**Problem:** COV0019122 NRE was originally charged at $551,259.06 but was credited and reinvoiced at $504,184.94. The $43,822.11 difference needed to be applied to specific parts for accurate buyer GP.

**Solution:** Used subset-sum algorithm to find exact combination of 9 parts totaling $43,822.11:

| MPN | Contract Base | Buyer |
|-----|---------------|-------|
| K86X-BD-44S-BR | $10,430.65 | Jake Harris |
| ATQR15 | $4,835.88 | Jake Harris |
| LT8645SHV-2#PBF | $4,719.89 | Tracy Xie |
| RC0805FR-0768R1L | $4,670.64 | Jake Harris |
| ESQ-120-39-G-D-DP-TR | $4,625.79 | Jake Harris |
| ERJ-P06J103V | $4,580.58 | Jake Harris |
| SML-E12U8WT86 | $4,575.12 | Jake Harris |
| FT230XS-R | $2,808.42 | Jake Harris |
| RCS080510K0FKEA | $2,575.14 | Jake Harris |
| **TOTAL** | **$43,822.11** | |

**Buyer GP Impact:**
- Jake Harris: -$39,102.22
- Tracy Xie: -$4,719.89

**Files:**
- `Trading Analysis/LAM Billings Review/Stale Inventory/Final/LAM_Buyer_GP_Summary_2024-2025.csv` — Adjusted GP totals (includes this adjustment)
