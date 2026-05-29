# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere
- **CPC (Customer Part Code)** — Customer's internal part number. Also called Customer Part Number. "LAM CPC" = LAM's part code (redundant but common usage)

## Recent Sessions

- **2026-05-29 (Sales Pulse Daily - Email Setup READY)**: Completed comprehensive Sales Pulse Daily report with all 6 sections and email delivery setup.

  **Report Sections:**
  1. Global Snapshot (Pipeline Input, Quoting Activity, Wins, System Discipline)
  2. By Region (USA, MEX, 3 APAC subregions)
  3. Yesterday's Wins (grouped by region with MPN details)
  4. Needs Attention (5 alert types: High-value quotes, High-probability customers, New customers, Pricing benchmarks, Sourcing stuck)
  5. Week-to-Date (Monday-yesterday metrics by region)
  6. Market Pulse (Top 10 trending manufacturers & parts)

  **Key Fixes:**
  - Sourcing Stuck: Updated to V5 format (3-5 day window, grouped by region with buyer/seller/routed date)
  - Quote Age: Filtered to auto-close windows (30 days short-cycle, 64 days long-cycle)
  - Testing Summary: Added yellow-highlighted explanation section (removed in production)

  **Email Setup:**
  - Recipients: melissa.bojar@astutegroup.com, josh.pucci@astutegroup.com
  - Sender: analytics@orangetsunami.com
  - Schedule: Business days only (Mon-Fri) at 6:00 AM EST
  - Delivery: Ready for Jake to test (instructions provided in instructions-for-jake.md)

  **Files Committed (5 essential files):**
  - `sales-pulse-comprehensive.js` - Main report generator
  - `send-email.js` - Email sender
  - `instructions-for-jake.md` - Setup guide for automated daily sends
  - `README.md` - Workflow documentation
  - `.gitkeep` - Folder tracking

  **Next Steps:** Jake needs to send test email and optionally set up cron for daily automation.

- **2026-05-28 (MI KPI Dashboard - May 2026 Update - COMPLETE)**: Built MI KPI Performance Dashboard for May 2026 with all 5 planned enhancements.

  **Data Summary (May 1-28):**
  - Team: 163 OTINs, 443.3 KPI (82.1% of 540 target)
  - Top performers: Daisy Mendoza (136.0 KPI, 151%), Ofelio Martinez (107.5 KPI, 119%)
  - Tier distribution: T1=85 (16.5% of KPI), T2=44 (42.4% of KPI), T3=21 (25.7%), T4=13 (15.3%)

  **Enhancements Implemented:**
  1. **T2+ Mix column** (weekly summary) — Week 3: 28% T2+ = 17.8 KPI/day (red); Week 4: 64% T2+ = 39.0 KPI/day (green)
  2. **KPI/OTIN column** (inspector table) — Daisy 4.25 (green), Sharanya 1.48 (red - T1-heavy workload)
  3. **Pace Required banner** — Red warning: 32.2 KPI/day needed to hit 540 target
  4. **Enhanced tier cards** — Each shows KPI score and % contribution
  5. **Insight callout** — Yellow box correlating T2+ mix with daily KPI output

  **Key Insight:** T2 drives 42% of team KPI with only 27% of OTINs. Tier mix is the strongest predictor of daily KPI output.

  **Technical Note:** Pencil `get_screenshot` had rendering issues; used `export_nodes` to PNG instead.

  **Files:**
  - `~/workspace/MI KPIs/MI_KPI_Dashboard_May2026_Enhanced.png` — Final version with all enhancements
  - `~/workspace/MI KPIs/SESSION_NOTES_2026-05-28.md` — Full session documentation

- **2026-05-21 (ISE/FSE Steward Reassignment Report)**: Built comprehensive report identifying customer locations assigned to inactive ISE/FSE stewards for Sales Leadership and Customer Service to reassign.

  **Key Discovery:** The `chuboe_ise_steward_id` and `chuboe_fse_steward_id` fields reference `ad_user.ad_user_id`, NOT `c_bpartner.c_bpartner_id`. Initial queries joined to the wrong table, causing incorrect results (e.g., showing John Pauls when Thomas Haynes was actually assigned).

  **Final Report (1,343 locations):**
  - ISE Steward: 1,207 locations across 52 inactive stewards
  - FSE Steward: 136 locations
  - Top stewards needing reassignment: Madison Fischl (113), Elena Wilfong (94), JeanPaul Chevrier (78), Erin Lee (77), Edyna Lee (76), Hugo Ogalde (114 total)
  - 226 locations have another active rep currently working the account

  **V8 Account Status (location-level):**
  - DECLINING: 18 ($28.4M lifetime)
  - AT RISK: 60 ($21.7M lifetime)
  - LAPSED: 106 ($8.4M lifetime)
  - TRUE NEGLECT: 6 ($1.2M lifetime)
  - NEVER ENGAGED: 963 locations

  **Deliverables:**
  - `~/workspace/Account Reassignment/ISE-FSE-Steward-Reassignment.xlsx` (5 sheets)
  - `~/workspace/Account Reassignment/ise-fse-steward-reassignment.js` (final script)
  - Screenshots: `RTX Example OT - Thomas.png`, `Change Log RTX Example.png`

  **Column Order (Sales Leadership sheet):**
  1. Former ISE/FSE (Inactive), Assignment Type, Termination Date, Last Activity (Former ISE/FSE), Last Steward Change, Changed By
  2. Account Name, Account Location
  3. Location-level metrics: CQ Lines YTD, CQ Sold YTD, Sold YTD/2025/Lifetime
  4. Account-level: RFQ Lines YTD (RFQs don't have location field)
  5. Last Activity Date/By, Other Rep Working, Action Note
  6. Account Status, Reassign To, Notes

- **2026-05-19 (Sales Funnel Report - In Progress)**: Building comprehensive sales funnel report by customer showing engagement metrics for OEM/EMS accounts (excluding brokers).

  **Status:** Threshold revision needed before finalizing

  **Completed:**
  - Built SQL query with all metrics (activities, RFQs by type, CQs, sold values)
  - Mapped regions (USA/MEX/APAC/OTHER) from country codes
  - Identified seller assignments (ISE Steward = inside, FSE Steward/salesrep_id = outside)
  - Discovered activities link via `ad_user.c_bpartner_id` (contacts), not directly to BP
  - Created account status classification: Neglect, Underperformance, Low ROI, Growing, Defend, Active, Dormant
  - Generated initial CSV with 4,886 non-broker customers

  **Key Finding:** Neglect + Underperformance = $212.8M lifetime value being under-served

  **Next Session - First Thing:** Revise account status thresholds (see questions in doc)

  **Files:**
  - `Trading Analysis/Sales Funnel Report/sales-funnel-report.md` — Full documentation with threshold questions
  - `~/workspace/sales_funnel_report_v2.sql` — Current SQL query
  - `~/workspace/sales_funnel_results.csv` — Current output (4,886 rows)

- **2026-05-19 (Serena Zhang Buyer Analysis)**: Created comprehensive analysis of buyer Serena Zhang's VQ coverage for Sales-Purchasing Leadership discussion. Justin Goodwin and Aaron Mendoza reported challenges getting VQ responses from Serena.

  **Key Findings:**
  - Serena's activity declined 72% from Q2 2025 peak (2,279 lines → 643 lines)
  - Justin Goodwin receives 0.10% VQ coverage (61 lines of 61,042 non-Import lines)
  - Alex Partida receives 51x more coverage than Justin (3,139 vs 62 lines)
  - Justin has worst response time among sellers (122.7 hrs median)
  - Serena enters 0% of VQs directly — 100% via Data Entry (Ivy Song 60%, Gopalakrishnan 35%, Lathis 5%)
  - Buyer queue assignment system completely unused (0 of 35,900 entries have assignments)
  - Stephanie Hill benchmark: self-enters 31% of her VQs, responds to queue

  **MFR Prioritization:** TI/Texas Instruments 11-22% response, Passives <2%
  **Customer Prioritization:** East West Mfg 37.83%, Sanmina 1.67%

  **Deliverables:**
  - `Serena_Zhang_Buyer_Analysis_Sales_Leadership_2026-05-19_v3.docx` — Final Word document
  - `Serena_VQs_for_Justin_Goodwin_Detail.csv` — 170 VQ lines with full detail
  - `Serena_Zhang_Buyer_Analysis_2025-Present.md` — Markdown reference

  **Files:** `~/workspace/2026 Sales Funnel/`

- **2026-05-18 (Broker vs Franchise Sales Analysis)**: Analyzed sales breakdown between Broker and Franchise order types for 2025 & 2026 YTD to establish a company benchmark.

  **Key Finding: 98% Broker / 2% Franchise**

  **Methodology:**
  - Traced sales order lines → RFQ lines → RFQ → RFQ Type in Orange Tsunami
  - "Astute Franchised" RFQ type = Franchise; all other types = Broker
  - Data: All SO in IP/CO/CL status, 2025-2026 YTD

  **Results:**
  | Year | Franchise | Broker |
  |------|-----------|--------|
  | 2025 | 0.3% ($247K) | 99.7% ($81.9M) |
  | 2026 YTD | 3.2% ($2.35M) | 96.8% ($72.2M) |
  | Combined | 1.7% ($2.6M) | 98.3% ($154.1M) |

  **Franchise Growth Driver:** Flock Safety accounts for ~80% of franchise revenue ($2.1M of $2.6M)

  **Invoice Matching Attempted:** Tried matching Infor invoices (COV numbers) to OT orders by Customer+MPN+Qty. Achieved 72% match rate but cross-system matching introduced inaccuracies. Order-based analysis is more reliable.

  **Deliverables:**
  - `broker-vs-franchise.md` — Full analysis with queries
  - `Sales Executive Summary - Franchise vs Broker.docx` — One-page exec summary
  - `Invoiced Sales - Classified.xlsx` — Invoice data with RFQ type classification

  **Files:** `~/workspace/Broker vs Franchise/`

- **2026-05-18 (Lots Shipped & Received - REVISED + Bug Fix)**: Regenerated all deliverables using VP-approved headcount (23 employees) and 2024-2025 data only. Fixed OTIN counting bug and regenerated Excel with Friday's tab structure.

  **Bug Fix (Slide 7 OTIN Count):**
  - **Problem:** Slide 7 showed 19,572 OTINs total but Executive Summary showed ~11K
  - **Root Cause:** OTINs touching multiple tiers were counted multiple times (63% touch 2+ tiers)
  - **Fix:** Redesigned slide 7 to show true distinct OTINs (11,029) with separate tier coverage breakdown
  - **Note:** Percentages in tier coverage add to >100% because one OTIN can go through multiple tier types

  **Excel Regeneration (Friday's Structure):**
  - Regenerated with same 10-tab structure as Friday's version
  - Tab 2 "OTIN Receiving Data" now has row per distinct OTIN (11,029 rows) with: OTIN, Lot Number, MPN, Manufacturer, Quantity, Received Date, Year, Quarter, Month, Warehouse Group, Created By User, User ID
  - Filtered to 23 VP-approved employees, 2024-2025 only

  **Key Metrics (unchanged from original revision):**
  - Inbound Lots: 4,036 → 7,112 (+76%)
  - Outbound Lines: 3,105 → 6,517 (+110%)
  - Productivity: 22.7 → 27.2 lots/FTE/month (+20%)

  **Final Deliverables:**
  - `Lots-Shipped-Received-Presentation-FINAL.pptx` (12 slides)
  - `Lots-Shipped-Received-Data-FINAL.xlsx` (10 tabs, 24 MB)
  - `Executive-Summary-One-Pager-REVISED.docx`

  **Files:** `~/workspace/lots-shipped-received/output/`

- **2026-05-15 (Lots Shipped & Received - Warehouse Efficiency Analysis)**: Expanded productivity analysis with detailed breakdowns by warehouse, inspection tier, and time periods. Investigated shipping touchpoints.

  **Key Clarifications:**
  - OTIN = Lot Number (nearly 1:1, differ by 2 edge cases)
  - "Event" = inspection record in `chuboe_insp_lot_lnk` (one lot can have multiple events)
  - Warehouse "HONG KONG" was originally named "APAC" (renamed 2023-06-26) — no "China" warehouse ever existed

  **Inspection Tier Definitions (from MI KPI project):**
  - T1: MFR direct / AD / Traceable (Passive, Active, Standard, Master)
  - T2: Non-MFR / Non-AD / Non-destructive testing
  - T3: Destructive / customer profile requirement testing
  - T4: AS6171 aerospace standard testing (growing: 0→22 lots/qtr)

  **Austin vs Hong Kong Efficiency:**
  - HK has 25% fewer picks/lot (3.8 vs 6.0) = more efficient handling
  - HK lots/operator higher (25-35 vs Austin 13-19)
  - HK volume now 2x Austin (409 vs 213 in Mar 2026)

  **Shipping Touchpoint Investigation:**
  - No intermediate step before tracking number has better coverage
  - `chuboe_packaging_id`: 0% coverage (not used)
  - `m_shipper_id`: 4-9% coverage (very partial)
  - `chuboe_trackingnumbers`: 62-84% coverage (best available)
  - **Recommendation:** Use Infor Invoiced for outbound (invoice = shipped), OT for inbound + efficiency

  **Infor Data Gap:** Invoice file has no ship-from warehouse field. Need OT warehouse data or different Infor report.

  **Files:** `~/workspace/lots-shipped-received/notes/session-summary-2026-05-15.md`

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
