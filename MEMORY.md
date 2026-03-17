# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-17 (Master Electronics API)**: Activated Master Electronics franchise API. **Root cause:** Initial 401 was endpoint typo (`cpriceavailability` → `cgpriceavailability`), not IP whitelist. Created `master.js` module following Arrow/Future pattern. Integrated into `main.js` screening flow as 6th API (after Future). Updates VQ export with Master quotes. **API:** `https://api.masterelectronics.com/wapi/v2/cgpriceavailability/{query}/{inStockOnly}/{exactMatch}/{resultsCount}/{apiKey}`. **Key:** `1640d818-0b10-4162-a2ad-34750e79e346`. **BP:** 1000405 / 1002409. Updated `api-integration-roadmap.md` with corrected endpoint, marked Active. **6 active franchise APIs:** DigiKey, Arrow, Rutronik, Future, Master.
- **2026-03-16 (Inventory Cleanup + LAM Kitting Reorder)**: **Inventory Cleanup Automation:** Fully automated — fetches from excess@orangetsunami.com, cron runs Monday 6 AM EST, emails "Netcomponents Upload" (CSV) and "OT Inventory Upload" (zipped Chuboe files) to jake.harris@astutegroup.com. File naming: `{WarehouseCode}_{GroupName}.csv` (e.g., W103_GE_Consignment.csv). Renamed MAIN→Allocated_Warehouse, W105→HK_Allocated_Warehouse. **LAM Kitting Reorder:** Created new workflow folder and docs. Added Stock Market Analysis (B1-B3) and LAM Kitting Reorder (C1) to trading-analysis-roadmap.md. Analyzed `Lam_Kitting_DB_03132026.xlsx` — has 5 sheets: INVENTORY (946 rows), RE_ORDER REQUESTS (46), CM Orders (1631), MIN (1020 thresholds), Lam_DB (empty). **Source of truth:** Inventory Cleanup output (W111/W115 files), not the Excel INVENTORY sheet. **PENDING QUESTIONS — resume here.** Commits: f4c8566 → c833717.
- **2026-03-16 (VQ Email Types + MPN Fuzzy Matching)**: Added workflow support for two VQ email types. **Type 1 (Direct):** Single vendor quote forwarded by buyer — buyer is the forwarder, vendor lookup by email domain. **Type 2 (Buyer Consolidated):** Buyer compiles multiple broker quotes into one email (e.g., "Broker :Poplar : MPN 1000pcs 14usd 25+") — buyer is the person who compiled the list (not the forwarder), vendor lookup by name search. **Key distinction:** Type 2 has multiple vendor names in quick succession with informal notation (moq, usd, ex hk). No rigid template — pattern recognition. **MPN fuzzy matching:** When vendor quoted MPN differs from RFQ MPN (e.g., drops `-TR` suffix), auto-apply: use RFQ MPN in MPN field, add "Quoted MPN: [vendor's MPN]" to Vendor Notes. Processed 3 direct quotes (Component Sense, X-Press Micro). Commit: 451447a.
- **2026-03-13 (VQ Duplicate Audit)**: Audited RFQ 1130350 VQs after multiple file uploads. **Duplicates:** 243 total VQ lines, 89 unique, **154 duplicate extras** (same vendor+MPN+cost+qty loaded multiple times). Worst offenders: SST38VF6401/Flip Electronics 7x, 39-29-5243/Nexus 7x. **Coverage:** 36 of 76 CPCs have VQs, 47 unique MPNs. **MPN mismatches:** Created `mpn-mismatch-fix.csv` with 6 correctable rows (mapped vendor quoted MPNs to RFQ MPNs). **Unfixable (2):** LT3973IMSE vs LT3973EMSE (I=Industrial, E=Extended temp), AFBR-709DMZ vs AFBR-709SMZ (different transceiver types). Commit: eacb8ab.

---

## Pending: LAM Kitting Reorder Questions

**Resume here next session.** Need answers before implementing:

1. **Join key** — Match Inventory Cleanup to Excel on **MPN**? (Inventory Cleanup has `Item`/MPN, Excel has `Lam P/N` + `MPN`)

2. **MIN thresholds** — Use from:
   - INVENTORY sheet (`MIN QTY` column), or
   - MIN sheet (`CPC` → `Min` mapping)?
   - Is `CPC` in MIN sheet the same as `Lam P/N`?

3. **Which warehouses?** — W111 (LAM 3PL) only, or also W115 (LAM Dead Inventory)?
   - Should dead stock trigger reorders?

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
