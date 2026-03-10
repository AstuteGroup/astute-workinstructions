# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-10 (VQ Loading Session)**: Processed 52 vendor quote emails from `vq@orangetsunami.com` inbox. Extracted 43 QUOTES, 5 SKIPs (target price requests), 2 PDFs needing manual review, 2 duplicates, 1 needs-review. Output: `vq-parser/data/sessions/2026-03-10T21-24-51-extracted.csv`. Implemented two-agent validation workflow with automatic mismatch resolution. Updated CLAUDE.md with sync rule for .md file updates.
- **2026-03-10 (Quick Quote Workflow Consistency)**: Added Quick Quote workflow instructions to CLAUDE.md to ensure consistent prompting. Now always: (1) read quick-quote.md, (2) state defaults (15% margin, $250 min GP, 30% fallback), (3) ask about customer overrides/rebates, (4) execute, (5) summarize.
- **2026-03-10 (RFQ History Tracking - B1)**: Implemented B1 from sourcing roadmap - 60-day cooldown for same supplier+MPN combinations. Created `rfq_history.py` module with `check_cooldown()`, `record_rfq()`, `update_response()`.
- **2026-03-10 (RFQ 1130350 Broker Sourcing)**: Completed full broker RFQ sourcing for excess inventory valuation (101 line items). Sent ~168 RFQs across 7 batches to 80+ suppliers.

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
