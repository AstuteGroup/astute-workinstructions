# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-12 (VQ Loading CSV Column Fix)**: Fixed ERP import failures caused by inconsistent column counts (16-18 instead of 17). **Root cause:** Manual CSV generation with incorrect comma counts. **Fix:** Created `fix-erp-csv.js` script to auto-correct column counts and `verify-csv.js` to validate. Fixed 14 rows in 03-10, 46 rows in 03-11. All three ERP-ready files now have exactly 17 columns. **Scripts added:** `rfq_sourcing/vq_loading/fix-erp-csv.js`, `verify-csv.js`. Commits: c8698ad, f1143f5.
- **2026-03-12 (VQ Loading Cleanup + Format Fix)**: Verification caught major discrepancy in email 7816 (wrong vendor/qty/price). **Format issue found:** vq-parser outputs simplified tracking format, not ERP template. Regenerated 03/10 and 03/12 outputs in correct VQ Mass Upload Template format (`RFQ Search Key,Buyer,Business Partner Search Key,...`). **Cleanup:** Deleted stale `Trading Analysis/VQ Loading/` folder and 10 orphaned VQ_UPLOAD_*.csv files. **Canonical location:** `rfq_sourcing/vq_loading/` with `output/` subfolder for ERP-ready files. Commits: a78577c.
- **2026-03-11 (Atlantic Semi Template)**: Created `atlantic-semi.js` template for high-volume vendor Atlantic Semiconductor (8 quotes in 2 sessions). Format: `mpn:`, `qty: N @ $N.NN`, `NNNN dc/ Rohs`, `quote#: NNNNNN`. Updated `template-candidates.md` to move vendor to Existing Templates. Commits: vq-parser (fd78697), astute-workinstructions (a0fccde).
- **2026-03-11 (Market Offer Uploading - New Workflow)**: Created new workflow for processing customer excess inventory emails. Set up `excess@orangetsunami.com` Himalaya account. Created folder `Trading Analysis/Market Offer Uploading/` with workflow doc, ERP template, and MFR alias file (80+ mappings). Test extraction: Honeywell (7 lines → 15 after MPN split). **Key rules:** Col C = exact MFR name (not code), Cols L&M unused, Col N = customer PN, split multi-MPNs, only populate explicit data. Created Processed email folder.

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
