# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-11 (Market Offer Uploading - New Workflow)**: Created new workflow for processing customer excess inventory emails. Set up `excess@orangetsunami.com` Himalaya account. Created folder `Trading Analysis/Market Offer Uploading/` with workflow doc, ERP template, and MFR alias file (80+ mappings). Test extraction: Honeywell (7 lines → 15 after MPN split). **Key rules:** Col C = exact MFR name (not code), Cols L&M unused, Col N = customer PN, split multi-MPNs, only populate explicit data. Created Processed email folder.
- **2026-03-11 (VQ Loading + Dual-Phase Enforcement)**: Processed 85 emails → 61 quotes. **Key fix:** Updated `vq-loading.md` with mandatory Dual-Phase Extraction: Phase 1 (extraction), Phase 2 (verification - DO NOT SKIP), Phase 3 (reconciliation). Added agent count thresholds by email volume. Added checkpoint message: "Running verification agents now." Verification caught 10 discrepancies including 8 missing extractions in batch 4. Output: `vq_loading/2026-03-11-erp-ready.csv`.
- **2026-03-11 (VQ Parser Pagination Fix)**: Fixed bug where scheduled VQ fetches only saw 50 emails. Root cause: `listEnvelopes()` in `fetcher.js` had default pageSize=50. Changed to 500. Committed to vq-parser repo (ead90c9).
- **2026-03-11 (LAM Billings Review Cleanup)**: Reorganized CM Billings and Stale Inventory folders with Source (by year: 2024/2025/2026) and Final subfolders. Extended Stale analysis (COV0020665): confirmed seller used markup (×1.18) instead of margin (÷0.82), underbilling $5,965. Created GP by buyer breakdown. Merged Daniel/DM into Edgar Santana.

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
