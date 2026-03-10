# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-10 (Quick Quote Workflow Consistency)**: Added Quick Quote workflow instructions to CLAUDE.md to ensure consistent prompting. Now always: (1) read quick-quote.md, (2) state defaults (15% margin, $250 min GP, 30% fallback), (3) ask about customer overrides/rebates, (4) execute, (5) summarize. Fixed issue where Quick Quote was run without confirming parameters when invoked mid-session.
- **2026-03-10 (RFQ History Tracking - B1)**: Implemented B1 from sourcing roadmap - 60-day cooldown for same supplier+MPN combinations. Created `rfq_history.py` module with `check_cooldown()`, `record_rfq()`, `update_response()`. Dual purpose: prevent duplicate RFQs within cooldown window, track supplier volume for VQ parser template prioritization. Integrated into `submit_rfqs.py` via `--check-cooldown` flag.
- **2026-03-10 (RFQ 1130350 Broker Sourcing)**: Completed full broker RFQ sourcing for excess inventory valuation (101 line items). Sent ~168 RFQs across 7 batches to 80+ suppliers. Fixed: strict MPN matching, min order value filtering, supplier fatigue tracking, packaging variant deduplication.
- **2026-03-10 (Quick Quote for RFQ 1130263)**: Generated Quick Quote for Plexus RFQ. SQL template with full pricing logic. 8 VQ matches: 4 UNDER, 4 OVER. Best: OPA2209AIDR $1,528 GP at 75% demand.

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
