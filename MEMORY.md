# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-10 (Vortex Matches Refinements)**: Implemented and refined for RFQs 1130895, 1130899. Key fixes: stock no longer filtered by 90-day window, removed bad columns (RFQ Manufacturer, Vendor Grade), MO Type blank for VQs, % Under Target in column B, RFQ line deduplication, decimal precision for prices. Created `Trading Analysis/trading-analysis-roadmap.md` with planned items (A1: Opp Amount, A2: filter low % of Demand). Added roadmap conventions to CONVENTIONS.md and CLAUDE.md.
- **2026-03-10 (VQ Loading + North Star Rule)**: Processed 52 emails → 43 quotes. Added "North Star" rule to CLAUDE.md: always Read the .md file before executing. Added "Explicit Numbered Steps Required" to documentation standards. Updated vq-loading.md with End-to-End Workflow (Steps 1-6).
- **2026-03-10 (Quick Quote Workflow Consistency)**: Added Quick Quote workflow instructions to CLAUDE.md to ensure consistent prompting.
- **2026-03-10 (RFQ History Tracking - B1)**: Implemented 60-day cooldown for same supplier+MPN combinations. Created `rfq_history.py` module.

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
- `Trading Analysis/LAM Billings Review/COV0019122_NRE_Adjustment.csv` — Full documentation
- `Trading Analysis/LAM Billings Review/LAM_Buyer_GP_Summary.csv` — Adjusted GP totals
- `Trading Analysis/LAM Billings Review/lam_reconciliation.js` — Reconciliation script
