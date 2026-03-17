# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere
- **CPC (Customer Part Code)** — Customer's internal part number. Also called Customer Part Number. "LAM CPC" = LAM's part code (redundant but common usage)

## Recent Sessions

- **2026-03-17 (Market Offer Uploading)**: Processed 12 emails from excess@orangetsunami.com. Extracted **3,404 offer lines** across 5 partners: Celestica CMY2 (20), Celestica PSMN (1), GE Healthcare (100 Altera FPGAs), Benchmark Romania (1,114 from Excel), OSI Electronics (2,169 from Excel). Created `extract-market-offers.js` with MFR abbreviation→canonical name mapping. Used two-agent validation for Celestica files. All emails moved to Processed folder. **Email automation added:** Created `send-offer-email.js` — sends CSVs to jake.harris@astutegroup.com with subject `[Partner]/[SearchKey], Market Offer Upload Ready`. Supports single file and batch mode (`--batch offers.json`). Updated workflow with Step 7 (Email Output Files). **Partner search_keys:** Celestica (1001118), GE Healthcare (1002736), Benchmark (1001020), OSI (1002718). Commits: 6b5bc8b, 3cb5001, e035199.
- **2026-03-17 (LAM EPG VQ Loading) — RESOLVED**: CalcuQuote franchise VQ loading for LAM EPG Award (RFQ 1131217). **Root cause:** `lam-vq-ohq-errors-corrected.csv` had RoHS values as `Y`/`N` instead of `Yes`/`No` — created through manual edit, not calcuquote-to-vq.js (which produces valid output). Fixed 31 RoHS values. **Updated vq-loading.md:** Added Step 5 "Validate Lookup Fields" requiring `validate-vq-upload.js` before output. Documents normalization rules (Y→Yes, TUBE→F-TUBE, etc.). If vendor didn't provide value, leave blank — don't infer. **Files ready for upload:** `lam-vq-ohq-UPLOAD-READY.csv` (103), `lam-vq-bpa-UPLOAD-READY.csv` (186). Commits: c7d50ec, 8186041.
- **2026-03-17 (Master Electronics API)**: Activated Master Electronics franchise API. **Root cause:** Initial 401 was endpoint typo (`cpriceavailability` → `cgpriceavailability`), not IP whitelist. Created `master.js` module following Arrow/Future pattern. Integrated into `main.js` screening flow as 6th API (after Future). Updates VQ export with Master quotes. **API:** `https://api.masterelectronics.com/wapi/v2/cgpriceavailability/{query}/{inStockOnly}/{exactMatch}/{resultsCount}/{apiKey}`. **Key:** `1640d818-0b10-4162-a2ad-34750e79e346`. **BP:** 1000405 / 1002409. Updated `api-integration-roadmap.md` with corrected endpoint, marked Active. **6 active franchise APIs:** DigiKey, Arrow, Rutronik, Future, Master.
- **2026-03-16 (Inventory Cleanup + LAM Kitting Reorder)**: **Inventory Cleanup Automation:** Fully automated — fetches from excess@orangetsunami.com, cron runs Monday 6 AM EST, emails "Netcomponents Upload" (CSV) and "OT Inventory Upload" (zipped Chuboe files) to jake.harris@astutegroup.com. File naming: `{WarehouseCode}_{GroupName}.csv` (e.g., W103_GE_Consignment.csv). Renamed MAIN→Allocated_Warehouse, W105→HK_Allocated_Warehouse. **LAM Kitting Reorder:** Created new workflow folder and docs. Added Stock Market Analysis (B1-B3) and LAM Kitting Reorder (C1) to trading-analysis-roadmap.md. Analyzed `Lam_Kitting_DB_03132026.xlsx` — has 5 sheets: INVENTORY (946 rows), RE_ORDER REQUESTS (46), CM Orders (1631), MIN (1020 thresholds), Lam_DB (empty). **Source of truth:** Inventory Cleanup output (W111/W115 files), not the Excel INVENTORY sheet. **PENDING QUESTIONS — resume here.** Commits: f4c8566 → c833717.

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
