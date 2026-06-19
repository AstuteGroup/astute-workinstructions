# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere
- **CPC (Customer Part Code)** — Customer's internal part number. Also called Customer Part Number. "LAM CPC" = LAM's part code (redundant but common usage)

## How to Send Emails

**NEVER use the `mail` command directly.** The basic `mail` command sends from `analytics_user@<hostname>` which doesn't work properly for external recipients.

**ALWAYS use the shared notifier system:**

```javascript
const { createNotifier } = require('./astute-workinstructions/shared/notifier');

const notifier = createNotifier({
  fromEmail: 'stockrfq@orangetsunami.com',  // or other OT email
  fromName: 'Descriptive Name'
});

// Simple email
await notifier.sendEmail('jake.harris@astutegroup.com', 'Subject', 'Body text');

// With attachment
await notifier.sendWithAttachment(
  'jake.harris@astutegroup.com',
  'Subject',
  'Body text',
  [{ filename: 'report.txt', path: '/path/to/file.txt' }]
);
```

**Common sender addresses:**
- `stockrfq@orangetsunami.com` - Stock RFQ operations, reports, general automation
- `excess@orangetsunami.com` - Customer excess analysis
- `vortex@orangetsunami.com` - Vortex matches, sourcing recap

The notifier uses AWS WorkMail SMTP with credentials from `~/workspace/.env`. Works from `analytics_user` - other users route through writeback proxy (see `shared/writeback-proxy.md`).

## Recent Sessions

- **2026-06-19 (VP Daily Brief - Cron Scheduling Fix)**: **Fixed missing cron job for VP Daily Brief — report was documented but never scheduled.** Root cause: email script existed at `Sales Pulse Daily/scripts/email-vp-daily-brief.js` but no cron entry in `cron-jobs.js`. Latest output files were from June 18 (yesterday), nothing generated today. **Fix:** (1) Manually ran script to send today's report immediately to Josh Pucci and Melissa Bojar. (2) Added cron entry to `cron-jobs.js`: Mon-Fri at 13:00 UTC (6 AM PDT / 5 AM PST). (3) Ran `node scripts/install-crons.js --apply` to activate. Verified with `crontab -l`. **Status:** Production issue resolved, automated delivery now active. Report will run automatically tomorrow morning. Commit: `f779e98`.

- **2026-06-18 (VP Daily Brief V2 - Refinements, Automation & Detailed Report)**: **Fixed data aggregation issues, set up automated email distribution, and created on-demand detailed report.** (1) **Reactivated Customers fix:** Changed from showing 18 individual orders to 10 unique customers by grouping on `c_bpartner_id`. Added fields: `c_bpartner_id` (customer ID), `order_count` (orders placed yesterday), `order_numbers` (comma-separated SO list), `customer_location` (full address). Revealed customers like Applied Materials (4 orders, $6.4K total) and Sanmina (2 orders, $135K total) legitimately had 180+ day gaps. (2) **Section 3 Regional Activity rollup:** Fixed duplicate rows (25+ salespeople) by aggregating to 4 regions (APAC-Laurel, APAC-Silvia, MEX, USA). Used CTE with regional_users to sum metrics across all salespeople in each region. (3) **Email automation:** Created `email-vp-daily-brief.js` script that generates report and emails HTML to Josh Pucci and Melissa Bojar. Sent from salesanalytics@orangetsunami.com. Successfully sent test email covering June 17 data. Created cron job instructions (weekdays 8am). (4) **Performance exploration:** Tested multiple optimization approaches (LATERAL JOIN, CTE with ROW_NUMBER, hybrid top-3 approach) to add part details back. All approaches timed out (12-14 minutes) or failed with "No space left on device" errors. Confirmed `c_orderline` has indexes but joining to orderlines for part aggregation is inherently too slow for automated daily email. (5) **On-demand detailed report:** Created `generate-detailed-report.js` for manual use when part details needed. Discovered `c_orderline.chuboe_mpn` column stores MPNs directly (no complex joins needed). Detailed report includes part numbers for Top 5 Orders and Reactivated Customers, runs in 30-60 seconds (acceptable for on-demand). Successfully tested with real part data ("K4AAG165WA-BCWE", "88E1510-A0-NNB2I000, 88E6390-A0-TLA2I000"). **Key learning:** Daily email should stay fast (<1s, no parts); detailed drill-down available on-demand with `--email` flag. **Status:** Production-ready with dual-mode reporting (fast automated + detailed on-demand). **Files:** `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`, `email-vp-daily-brief.js`, `generate-detailed-report.js`, `queries/vp-daily-queries-v2.sql`, `queries/vp-daily-queries-detailed.sql`, `AUTOMATION-SETUP.md`, `PERFORMANCE-OPTIMIZATION.md`, `PART-DETAILS-FINDINGS.md`, `DETAILED-REPORT-USAGE.md`.

- **2026-06-17 (Inventory Profiler & Resale Assignment Architecture)**: **Built clean inventory profiler cog and diagnosed critical market profiling coverage gap.** Problem Identified: Market profiling coverage was ~0.03% (1,022 of 3.6M MPNs). The existing `market-profiler.js` was stuck — reusing exhausted RFQs and finding 0 parts to process. Root cause: profiler didn't handle weekly inventory refreshes or create new RFQs when current one was fully scraped. New Profiler Built: Created `inventory-profiler.js` with weekly RFQ naming, reconciliation across ALL profile RFQs, bucket support, rate control, and full run mode. Full Profile Run Started: 3,179 MPNs at 100/hour, ~32 hours to completion (RFQ 1137548 "Inventory Profile 2026-W25"). Resale Assignment Logic Designed for Active Sourcing batches using broker VQs as price driver and franchise data as strategy modifier. **Files Created:** `Trading Analysis/Market Profiling/inventory-profiler.js`, `Trading Analysis/Inventory Recommended Resale/test-resale-logic.js`.

- **2026-06-11 (Delisted Parts Pipeline)**: **Major overhaul of Active Sourcing to source from DELISTED parts instead of current inventory.** Changes: (1) `inventory_cleanup.js` now tracks delta (prior - current week offers), writes delisted MPNs to `~/.delisted-parts-queue.json`. (2) `selection-engine.js` reads from delisted queue instead of current inventory offers. (3) `active-sourcing-runner.js` marks MPNs as sourced after processing, sends batch digest email with queue progress %. (4) First pass completion notification when all delisted parts sourced. (5) Profile VQ deactivation when real priced VQs arrive (same MPN/vendor within 10 days). (6) Broker VQ consolidation (multiple rows same MPN/vendor → 1 VQ with total qty). (7) NC scraper skips franchised suppliers (ncauth CSS class) — franchise data comes via APIs. (8) Re-enabled inventory gate (waits for NC upload confirmation before sourcing). **Key distinction:** Profiled parts (current inventory) → NC scrape only, no API calls. Delisted parts → full treatment (API enrichment + NC RFQ). **Documentation:** Updated `market-profiling.md` with full pipeline docs. Commits: `614468e`, `898aac3`, `9192d5c`, `7e8a73f`.

- **2026-06-11 (Budget Exhaustion Handling Overhaul)**: **Fixed inconsistent budget handling across all loaders after 256k writes in one day triggered budget exhaustion.** Root cause: June 10 inventory cleanup wrote 118k×2 offer lines, hitting 30k daily limit. Loaders handled this inconsistently — some routed to NeedsReview with manual-retry email, others silently moved to Processed with `offerId: null`. **Fixes:** (1) **Raised daily limit** 30k → 300k (256k proven safe; burst limits are real protection). (2) **Chunked mode now respects daily limit** — was bypassing all budget checks; now checks daily before starting. (3) **Poller checks `rateLimited: true`** — if handler returns this, email stays UNSEEN for auto-retry on next cycle (no notification). (4) **All handlers propagate `rateLimited`** — broker-offers.js, excess.js, stockrfq-cq.js now check writer result and return rateLimited to poller. (5) **Recovery script** `scripts/recover-budget-stuck.js` — moves emails from NeedsReview or Processed back to INBOX. Supports `--folder` and `--uids` options. **Recovery performed:** 1 from broker-offers NeedsReview, 4 from stockrfq NeedsReview, 8 from vq-loading NeedsReview, 14 from broker-offers Processed = 27 emails total moved back to INBOX for reprocessing. **Writers updated:** offer-writeback.js, rfq-writer.js, cq-writer.js, vq-writer.js. Commits: `064d133`, `b0aa5ee`, `c6db717`, `765119b`, `663637c`.

<<<<<<< Updated upstream
=======
- **2026-06-04 (Stuck Email Detection + Auto-Recovery + Cleanup)**: **Fixed systemic gap where emails could get stuck in SEEN-but-not-processed state.** Root cause: when agent reads an email (marks SEEN) but crashes/pauses before routing, the email becomes invisible to the next `list` call. **Solution (3 parts):** (1) **Auto-recovery in poller** — `list` command now scans for SEEN emails >60 min old, clears their SEEN flag so they reappear. 24-hour cap prevents recovering ancient spam/test emails. (2) **Operations Digest detection** — new section shows stuck emails across all 4 workflows (vq-loading, excess, stockrfq, rfq-loading), separates auto-recoverable (60min-24h) from manual-review (>24h). (3) **New poller commands** — `check-stuck` (read-only monitoring) and `recover-stuck` (manual recovery with configurable threshold). **Also added:** Pause detection to digest (paused jobs now flagged). **Investigation origin:** Ivy's test emails (UID 8765/8768 to VQ inbox) didn't load AND didn't send failure notification because VQ loading agent was paused via `.vq-loading-agent-paused` file since June 2. **Cleanup (post-recovery):** Archived 37 old stuck emails across vq-loading/stockrfq/rfq-loading via new `scripts/archive-stuck-emails.js`. Excess inbox had 8 stuck from May 8-22 — reviewed individually: archived 8 junk (spam, RFQs-not-offers, partial forwards), recovered 3 legitimate offers (USI Mexico, Benchmark Romania, DFI) by clearing SEEN flag. **Root cause of May 8-22 excess stuck emails:** Agent WAS running (confirmed by offers created with "excessAgent" in description), but specific edge-case emails got stuck because agent read them, determined they weren't actionable, but failed to route them to a folder (NotOffer/NeedsReview). Not crashes — routing gaps. The auto-recovery and archive scripts now handle this. Scripts: `archive-stuck-emails.js`, `move-uids-to-archive.js`. Commit: `64d906e`.
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

>>>>>>> Stashed changes
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
