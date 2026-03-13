# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-13 (VQ Upload Field Fixes)**: Fixed iDempiere lookup field formats for RFQ 1130350. **COO:** ISO codes → full names (CN→China, TW→Taiwan, etc.) - `C_Country_ID[Name]` expects country names. **RoHS:** Y/N → Yes/No/blank - `Chuboe_RoHS[Name]` lookup field. **MPN rule:** Must use RFQ MPN for linking; vendor quoted MPN goes FIRST in Vendor Notes as "Quoted MPN: XXX". **Subset files** to avoid duplicates: `coo-only-fixed.csv` (16 rows), `rohs-only-fixed.csv` (35 rows). Updated `vq-loading.md` with lookup field formats, COO reference table, COO vs shipping terms guidance. Added C8 MFR Text Validation to `sourcing-roadmap.md`. Commits: 7cf6471, 36f0ed4, 3ab7c98, 8e61cdc, 3c20a26, 906bb61, 9921903.
- **2026-03-13 (PDF Extraction + Buyer Fix)**: Extracted 10 PDF quotes from NeedsReview folder using **Read tool** (no external libraries needed). Looked up 9 vendors in DB, matched 9/10 MPNs to RFQ 1130350. **Merged into erp-ready.csv:** Now 28 total records (18 email + 10 PDF). **Buyer field bug fixed:** Was pulling customer contacts from RFQ; now extracts Astute employee from forwarder email. Updated `generate-erp-output.js` with `getBuyerFromForwarder()`. **Template candidates:** Added 8 structured PDF vendors (Schukat, ComSIT, Charcroft, 4Source, etc.). **Doc update:** Added Step 8 to vq-loading.md for moving actioned emails to Processed. NeedsReview emails moved to Processed.
- **2026-03-13 (VQ Loading)**: Processed 31 emails from inbox. **Results:** 18 ERP-ready quotes, 2 need vendor setup (iget24.com, hesch.de), 1 no-bid, 3 need PDF review. Dual-phase extraction with 2 agents + verification. 1 discrepancy found (MPN suffix handling - Phase 1 correct per field reference). Top quotes: OPT3001DNPR $0.34 (Dan-Mar), ADS1115IDGSR $1.10 (Ozdisan). **RFQ matches:** 14/17 MPNs matched (3 no match in 30 days). All emails routed to folders. Updated template-candidates.md. Output: `2026-03-13-erp-ready.csv`.
- **2026-03-13 (Future Batch + Master Electronics)**: Added batch POST support to Future Electronics API - `searchPartsBatch()` uses POST `/api/v1/pim-future/batch/lookup` with body `{ parts: [...], lookup_type: 'exact' }`. `searchParts()` now auto-selects batch for >1 part. **Master Electronics:** Documented full endpoint structure `GET /wapi/v1/cgpriceavailability/{query}/{inStockOnly}/{exactMatch}/{resultsCount}/{apiKey}`. API key `1640d818-0b10-4162-a2ad-34750e79e346` returns 401 - **pending activation by Master Electronics**. Updated `api-integration-roadmap.md` with ME details. Commits: a0dc82a, ac49a3f.

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
