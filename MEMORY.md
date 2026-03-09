# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-09 (LAM Billings Reconciliation)**: Comprehensive reconciliation of LAM contract billings. Fixed signed quantity handling (credits subtract, not add). Built Buyer GP analysis across 5 COVs (932 lines, $173k GP, 19.5% margin). Applied COV0019122 NRE credit ($43,822.11) to 9 specific parts via subset-sum algorithm. Outputs: `LAM_Buyer_GP_Summary.csv`, `LAM_Line_Detail.csv`, `COV0019122_NRE_Adjustment.csv`. See adjustment reference below.
- **2026-03-09 (Vortex Matches Setup)**: Created new workflow for market offer analysis. Three reports: (1) Under Target Opportunities - VQs/offers below customer targets for quick quoting or sourcing, (2) Stock Matches - RFQs matching Astute inventory, (3) All Other Market Offers - customer excess, broker lists. Discussed background automation approaches (cron + Claude CLI). Folder created at `Trading Analysis/Vortex Matches/`.
- **2026-03-05 (VQ Automation & Notifications)**: Added email notifications after each cron fetch (via nodemailer to jake.harris@astutegroup.com). Fixed "folder already exists" error. Changed cron from 15 min to hourly. Clarified architecture: cron has full data access (DB, email, files) but can't do inference/interpretation—that requires Claude session or API. Templates run automatically; non-templated vendors need manual extraction.
- **2026-03-05 (MPN Fixes)**: Fixed RFQ matching for MPNs with commas/hyphens. Fixed CSV escaping. Added active vendor filter (`isactive='Y'`). Added vendor templates to workflow. Created template-candidates.csv. RFQ match: 248/267.

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
