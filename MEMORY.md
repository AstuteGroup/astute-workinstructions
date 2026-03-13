# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-13 (Distributor API Research)**: Searched for franchise distributors with API access. **Confirmed pending:** TTI (developer.tti.com, pending key refresh), Newark/Farnell/element14 (partner.element14.com, pending key refresh). **New leads found (7):** Waldom (sandbox.waldom.com, BP 1000644), Analog Devices (analog.com/api-suites, BP 1000774), Wurth Electronics (we-online.com/api), LCSC (lcsc.com/docs, BP 1002898), Sourceability (BP 1000261), RS Components (BP 1000554), Electro Sonic (BP 1000404). **Previous leads:** Sager (developer.sager.com), Rochester (api.rocelec.com), Master Electronics, Allied. **Total tracked:** 22 distributor APIs (4 active, 2 pending key, 15 to investigate). Updated `api-integration-roadmap.md`. Commits: 1a4fc6a, e7f746b.
- **2026-03-13 (Future Electronics API)**: Added 4th franchise API - Future Electronics. **Auth:** `x-orbweaver-licensekey` header. **Docs:** Found working Postman docs at documenter.getpostman.com/view/18706946/UzBvFhcj. Created `future.js` module - picks highest-stock offer, captures price breaks, date code, lead time. Integrated into `main.js` alongside DigiKey/Arrow/Rutronik. VQ export now includes Future rows. **Active APIs now:** DigiKey, Arrow, Rutronik, Future (4 total). **Still pending:** TI (API subscription), Avnet (portal login), Venkel (no docs). Commit: 977fae2.
- **2026-03-12 (Franchise API Integration)**: Set up 3 working franchise distributor APIs for screening + VQ capture. **DigiKey:** OAuth2 2-leg, Product Info v4. **Arrow:** Query param auth, includes Verical marketplace. **Rutronik:** Query param auth, European distributor. Integrated all 3 into `main.js` - runs FindChips for screening + all APIs for VQ capture. VQ export creates separate lines per source. **Pending:** TI (need Inventory API subscription), Avnet/Future/Venkel (need endpoint docs), Mouser (blocked - distributor restriction). **Files:** `digikey.js`, `arrow.js`, `rutronik.js`, `api-integration-roadmap.md` updated with all credentials and BP IDs.
- **2026-03-12 (VQ Loading Full Cleanup)**: Fixed all three ERP-ready files. **03-10 & 03-12:** Fixed column count issues (16-18 → 17 columns) caused by manual CSV generation with inconsistent commas. **03-11:** Fully re-extracted from session file (`2026-03-11T17-58-53-inbox.json`) - original had corrupted column alignment and shifted data. Used 4 parallel extraction agents on 85 emails → 56 clean quotes. 5 vendors not in DB skipped (tectiva.com, exc.de, n-tronics.de, cyclops-group.com). **Scripts added:** `fix-erp-csv.js`, `verify-csv.js`. Commits: 01ee89c, c8698ad, f1143f5.

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
