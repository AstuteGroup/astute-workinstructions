# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere
- **CPC (Customer Part Code)** — Customer's internal part number. Also called Customer Part Number. "LAM CPC" = LAM's part code (redundant but common usage)

## Recent Sessions

- **2026-03-17 (Market Offer → RFQ Analysis Trigger)**: Added automatic RFQ matching to Market Offer Uploading workflow. **Created:** `analyze-new-offers.js` — reads offer CSV, matches MPNs against RFQs (90-day lookback), outputs tiered opportunities. **Step 9 added** to Market Offer Uploading workflow. No scheduler/database import needed — runs immediately on extracted CSV data. **Tested on:** Celestica CMY2 (20 lines), Honeywell (15 lines) — 0 matches because RFQs for those MPNs were from 2019 (outside 90-day window). **Output:** `RFQ_Matches_[Partner]_[date].csv`. Commit: 3dd52b4.
- **2026-03-17 (LAM Kitting Reorder Implementation)**: Built `lam-kitting-reorder.js` — compares W111+W115 inventory to Excel INVENTORY thresholds, generates reorder alerts. **Key decisions:** Join on MPN only (CPC not in Infor source), combined W111+W115 qty (dead stock counts), threshold from Excel Column I (MIN QTY). **Zero-stock detection:** Items in Excel but not in inventory files flagged as CRITICAL (100% shortfall). **Historical data from ERP (DB):** Previous Supplier, Buyer, Historical Purchase Price, Last Purchase Date (from `c_order.dateordered`). Note: ERP only has rebuys — initial buys tracked outside system. **Output:** 17 columns matching Excel A-L (minus STATUS) + historical + calculated. **First run:** 34 items need reorder (22 CRITICAL, 3 HIGH, 5 MEDIUM, 4 LOW). Compared to Excel RE_ORDER REQUESTS: 22 matched, 7 Excel items were restocked (stale data), 12 new finds. **Emailed to:** jake.harris@astutegroup.com. **Files:** `lam-kitting-reorder.js`, `output/LAM_Reorder_Alerts_2026-03-17.csv`. Commits: c599f07 → d0d58b8.
- **2026-03-17 (Market Offer Uploading)**: Processed 12 emails from excess@orangetsunami.com. Extracted **3,404 offer lines** across 5 partners: Celestica CMY2 (20), Celestica PSMN (1), GE Healthcare (99 Altera FPGAs), Benchmark Romania (1,114 from Excel), OSI Electronics (2,169 from Excel). Created `extract-market-offers.js` with MFR abbreviation→canonical name mapping. Used two-agent validation for Celestica files. All emails moved to Processed folder. **Email automation added:** Created `send-offer-email.js` — sends CSVs to jake.harris@astutegroup.com with subject `[Partner]/[SearchKey], Market Offer Upload Ready`. **Field fixes applied:** (1) Unmapped MFRs → `Chuboe_MFR_Text` column, not Description. (2) Description column cleared — should only contain part-specific notes, not source metadata. (3) GE Healthcare file regenerated due to malformed CSV structure. All 5 corrected files re-emailed. **Partner search_keys:** Celestica (CMY2/PSMN), GE Healthcare (GEH), Benchmark (1001020), OSI (1002718). Commits: 6b5bc8b → 420ab9d.
- **2026-03-17 (LAM EPG VQ Loading) — RESOLVED**: CalcuQuote franchise VQ loading for LAM EPG Award (RFQ 1131217). **Root cause:** Lookup field validation errors — RoHS had `Y`/`N` (not `Yes`/`No`), COO had ISO codes (CR, PT, VN) instead of full country names. **Fixes:** OHQ: 31 RoHS + 2 COO. BPA: 3 COO. **Updated vq-loading.md:** Added Step 5 "Validate Lookup Fields" — checks Packaging, RoHS, Currency, COO. **Updated validate-vq-upload.js:** Now validates COO against DB country names, flags ISO codes with suggested full names. If vendor didn't provide value, leave blank — don't infer. **Files ready:** `lam-vq-ohq-UPLOAD-READY.csv` (103), `lam-vq-bpa-UPLOAD-READY.csv` (186). Commits: c7d50ec → b89fb17.

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
