# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-16 (Inventory Cleanup Automation)**: Fully automated the inventory file cleanup workflow. **Email integration:** Fetches from excess@orangetsunami.com, filters by subject "Task finished: [success] * AST Item Lots Report Inputs". **Cron:** Runs every Monday 6 AM EST (11:00 UTC). **Outputs:** Two emails sent to jake.harris@astutegroup.com — "Netcomponents Upload" (consolidated CSV) and "OT Inventory Upload" (zipped Chuboe files). **Fixes:** Used `himalaya message export` instead of `attachment download` (more reliable), handled .aaf→.xlsx conversion, created "Sent" folder in excess inbox. **Test run:** 5,694 rows processed, 14 warehouse groups, emails sent successfully. **Action needed:** Set up Outlook auto-forward rule for Infor emails. Commits: f4c8566, 3dee1eb, ff306ad.
- **2026-03-16 (VQ Email Types + MPN Fuzzy Matching)**: Added workflow support for two VQ email types. **Type 1 (Direct):** Single vendor quote forwarded by buyer — buyer is the forwarder, vendor lookup by email domain. **Type 2 (Buyer Consolidated):** Buyer compiles multiple broker quotes into one email (e.g., "Broker :Poplar : MPN 1000pcs 14usd 25+") — buyer is the person who compiled the list (not the forwarder), vendor lookup by name search. **Key distinction:** Type 2 has multiple vendor names in quick succession with informal notation (moq, usd, ex hk). No rigid template — pattern recognition. **MPN fuzzy matching:** When vendor quoted MPN differs from RFQ MPN (e.g., drops `-TR` suffix), auto-apply: use RFQ MPN in MPN field, add "Quoted MPN: [vendor's MPN]" to Vendor Notes. Processed 3 direct quotes (Component Sense, X-Press Micro). Commit: 451447a.
- **2026-03-13 (VQ Duplicate Audit)**: Audited RFQ 1130350 VQs after multiple file uploads. **Duplicates:** 243 total VQ lines, 89 unique, **154 duplicate extras** (same vendor+MPN+cost+qty loaded multiple times). Worst offenders: SST38VF6401/Flip Electronics 7x, 39-29-5243/Nexus 7x. **Coverage:** 36 of 76 CPCs have VQs, 47 unique MPNs. **MPN mismatches:** Created `mpn-mismatch-fix.csv` with 6 correctable rows (mapped vendor quoted MPNs to RFQ MPNs). **Unfixable (2):** LT3973IMSE vs LT3973EMSE (I=Industrial, E=Extended temp), AFBR-709DMZ vs AFBR-709SMZ (different transceiver types). Commit: eacb8ab.
- **2026-03-13 (VQ Upload Field Fixes)**: Fixed iDempiere lookup field formats for RFQ 1130350. **COO:** ISO codes → full names (CN→China, TW→Taiwan, etc.) - `C_Country_ID[Name]` expects country names. **RoHS:** Y/N → Yes/No/blank - `Chuboe_RoHS[Name]` lookup field. **MPN rule:** Must use RFQ MPN for linking; vendor quoted MPN goes FIRST in Vendor Notes as "Quoted MPN: XXX". **Subset files** to avoid duplicates: `coo-only-fixed.csv` (16 rows), `rohs-only-fixed.csv` (35 rows). Updated `vq-loading.md` with lookup field formats, COO reference table, COO vs shipping terms guidance. Added C8 MFR Text Validation to `sourcing-roadmap.md`. Commits: 7cf6471, 36f0ed4, 3ab7c98, 8e61cdc, 3c20a26, 906bb61, 9921903.

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
