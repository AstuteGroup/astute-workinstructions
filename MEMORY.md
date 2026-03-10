# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-10 (RFQ History Tracking - B1)**: Implemented B1 from sourcing roadmap - 60-day cooldown for same supplier+MPN combinations. Created `rfq_history.py` module with `check_cooldown()`, `record_rfq()`, `update_response()`, `get_supplier_rankings()`. Dual purpose: (1) Prevent duplicate RFQs within cooldown window (60 days default, 14 for memory products, 90 after no-bid), (2) Track supplier RFQ volume for VQ parser template prioritization. Integrated into `submit_rfqs.py` via `--check-cooldown` flag. Backfilled 143 RFQs from session. Files: `rfq_history.py`, `rfq_history.json`, updated `sourcing-roadmap.md`.
- **2026-03-10 (RFQ 1130350 Broker Sourcing)**: Completed full broker RFQ sourcing for excess inventory valuation (101 line items). Sent ~168 RFQs across 7 batches to 80+ suppliers. Fixed workflow issues: (1) Strict MPN matching in franchise screening, (2) Min order value filtering with abundant/scarce multipliers (0.2/0.7), (3) Supplier fatigue tracking (max 2 RFQs per supplier per session), (4) Packaging variant deduplication (skip #TRPBF, -REEL, +T variants). Files: `submit_rfqs.py`, batch files `RFQ_1130350_Batch1-7.xlsx`, `RFQ_1130350_Sourcing_Summary.xlsx`.
- **2026-03-10 (Quick Quote for RFQ 1130263)**: Generated Quick Quote for Plexus RFQ. Created SQL template (`qq_1130263.sql`) with full pricing logic: floor price = MAX(cost/0.85, cost+$250/qty), suggested resale based on priority hierarchy (same-cust PPV/shortage, other-cust split, target margin, cost-based 30%). Found 8 VQ matches: 4 UNDER target (ready to quote), 4 OVER. Best opportunity: OPA2209AIDR with $1,528 GP at 75% demand coverage.
- **2026-03-10 (Vortex Matches Implementation)**: Implemented `vortex-matches.js` script. Takes RFQ number as input, queries both market offers (bi_market_offer_line_v) and vendor quotes (bi_vendor_quote_line_v) within 90-day window. Generates categorized Excel files: Stock, Good Prices/All Prices, No Prices. Uses ExcelJS for proper formatting (currency, percentages, dates). Usage: `node vortex-matches.js 1130263`

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
