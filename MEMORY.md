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

## Weekly Market Pulse Email Delivery

**ALWAYS send Weekly Market Pulse as an HTML attachment with explanatory email body.**

**Why:** HTML attachment (not inline) enables links and interactive features to function properly when opened in browser.

**Email Format:**
- **From:** salesanalytics@orangetsunami.com (Sales Analytics)
- **To:** melissa.bojar@astutegroup.com, josh.pucci@astutegroup.com (expandable to full leadership)
- **Subject:** `Market Pulse — Week [N] ([Date])`
- **Attachment:** `market-pulse-option-a-week[N]-YYYY-MM-DD.html`
- **Body:** Plain text with sections:
  - ✅ **What's New This Week** — List of updates/fixes/changes in this week's report
  - 📊 **Purpose of External Sources** — Explains constraint category links and market intelligence validation
  - 📢 **Manufacturer Price Increases** — This week's effective price increases with manufacturers listed
  - 🎯 **Week [N] Key Insights** — Market temperature, WoW changes, top part families/manufacturers, key signals

**Script Location:** `Sales Pulse Daily/scripts/send-market-pulse-week[N].js` (create new script for each week based on previous week's template)

**Template Reference:** See `send-market-pulse-week26.js` for email body structure.

## Recent Sessions

- **2026-07-27 (Inventory Cleanup Decoupled Cache-Based Architecture)**: **Refactored monolithic inventory_cleanup.js into decoupled cache-based architecture.** (1) **New architecture** — Single foundational job (`inventory-fetch-and-parse.js`) fetches Infor xlsx from email, parses ALL warehouses, caches to `~/.inventory-storage/parsed_YYYY-MM-DD.json`. Subordinate workflows pull only what they need: `lam-inventory.js` (W111, W115, W118), `free-stock-inventory.js` (W102, W104, W108, W109, W112, W113, W114), `consignment-inventory.js` (W103, W106, W107, W117). (2) **Key principle** — Parser is "dumb" (caches everything), workflows are "smart consumers" (each pulls only its warehouses). (3) **Cache format** — `{ metadata: {...}, byWarehouse: { 'W102': [{mpn, mfr, qty, dateCode, lot, location}, ...], ... }}`. Consumer functions: `loadCachedInventory({ allowStale: true })`, `getCacheStatus()`. (4) **Cron schedule (Mondays)** — 10:00 UTC: fetch-and-parse; 11:15 UTC: lam-inventory; 11:30 UTC: free-stock-inventory; 11:45 UTC: consignment-inventory. (5) **LAM wrong warehouse check** — Updated `lam-wrong-warehouse-check.js` to use cache as default, scans ALL 18 warehouses to find LAM roster parts in wrong locations. Integrated as Step 4 in `lam-inventory.js`. (6) **LAM scripts updated** — `lam-kitting-runner.js` and `lam-kitting-reorder.js` now use cache as default inventory source, removed fallback to deprecated inventory_cleanup.js. (7) **nc-listing.js updated** — NetComponents portal CSV generation now uses cache instead of parsing xlsx directly. (8) **Documentation updated** — Rewrote `inventory-file-cleanup.md`, updated `crontab.md` Active jobs table, marked deferred-work.md validation item as resolved. **Files created:** `shared/inventory-fetch-and-parse.js` (foundational parser + cache), `shared/inventory-parser.js` (pure xlsx parser), `workflows/lam-inventory.js`, `workflows/free-stock-inventory.js`, `workflows/consignment-inventory.js`. **Files modified:** `cron-jobs.js` (4 new entries), `Trading Analysis/LAM 3PL/lam-wrong-warehouse-check.js` (cache mode), `Trading Analysis/LAM 3PL/lam-kitting-runner.js` (cache default), `Trading Analysis/LAM 3PL/lam-kitting-reorder.js` (cache default), `Trading Analysis/Inventory File Cleanup/nc-listing.js` (cache mode), `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` (full rewrite), `crontab.md`, `deferred-work.md`. **Status:** Architecture complete and crons installed. Git push pending (token expired — run `gh auth login -h github.com`).

- **2026-07-24 (LAM Reorder Accuracy Investigation — Recency Filter Fix & Inventory Parsing Discovery)**: **Investigated LAM reorder report accuracy issues, fixed POV recency filter bug, and discovered inventory-cleanup cron has been paused 46 days.** (1) **Initial issue** — User reported MPN 5-104363-2 showed "Last Promise Date" of 04/13/26 but no "Open PO" or "On Order Qty", yet POV0075572 existed in OT. (2) **Root cause: recency filter too aggressive** — The `loadRecentPOVs()` SQL in `lam-kitting-reorder.js` filtered out POs when: created >90 days ago AND promise date passed. POV0075572 (created April 13, promise April 13) failed both tests as of July 24 (102 days old). (3) **Fix applied** — Two changes: (a) POV-stamped orders (`chuboe_po_string LIKE 'POV%'`) now ALWAYS show regardless of age — a POV stamp means committed vendor order. (b) Extended recency window from 90 to 120 days for non-stamped activity. Updated both PO and VQ_TICKED branches. (4) **Stuck order found** — POV0075573 / PO809636 (MPN 503398-1892, 100 pcs from Waldom) was 100+ days past promise with no tracking. Created R_Request 1169280 to request cancellation. (5) **Added `postGeneralRequest()`** — Extended `shared/r-request-writer.js` with function for non-approval requests (cancellations, queries, general messages). (6) **S25FL512SAGBHIA10 discrepancy** — User said this MPN should have dropped off report because it's in W115 (bin LAMTY2.9, 100 pcs). Investigation showed all inventory files (xlsx and parsed CSVs) had it in MAIN, not W115. (7) **CRITICAL DISCOVERY: inventory-cleanup PAUSED 46 days** — The `inventory-cleanup` cron has been paused since June 21 due to "partial writes (1038/4988)" in OT API offer step. Sentinel shows nextDue: 2099 (disabled). The xlsx files arrive weekly, but parsing into per-warehouse CSVs blocked because OT writes failed. (8) **Added inventory traceability** — Updated `lam-kitting-runner.js` to include full inventory folder path + W111/W115 file timestamps in email body. (9) **Architecture issue identified** — Current inventory_cleanup.js bundles parsing (critical) with OT offer writes (secondary). When writes fail, parsing is blocked, starving LAM reorder of fresh data. **Next session:** Restructure into `inventory-parse` (standalone, must run weekly) and `inventory-offers` (secondary, can fail independently). **Files modified:** `Trading Analysis/LAM 3PL/lam-kitting-reorder.js` (recency filter fix: POV always shows + 120-day window), `Trading Analysis/LAM 3PL/lam-kitting-runner.js` (inventory source traceability in email), `Trading Analysis/LAM 3PL/lam-3pl.md` (updated recency filter docs), `shared/r-request-writer.js` (added postGeneralRequest function). **Status:** Recency filter fixed. Inventory parsing restructure deferred to next session.

- **2026-07-16 (Account Review - CSV Parsing Bug Fix & Final UI/UX Polish)**: **Fixed critical CSV parsing bug causing inflated activity counts, verified all metrics accurate, and completed final UI/UX improvements.** (1) **CSV parsing bug discovered** — User reported Aaron showing 2,635 activities in Q2 when he shouldn't have that many. Investigation revealed S&B Industry showing 2,026 activities when it should be 4. (2) **Root cause identified** — PostgreSQL query was outputting CSV without proper quoting using `psql -F ","`. Company names containing commas like "S&B Industry, Inc." were split across multiple columns. The raw line `1011262,S&B Industry, Inc.,1,7,2025-12-05,2026-01-07,4,0,0,0,` was being parsed as: parts[1]="S&B Industry", parts[2]=" Inc.", causing all subsequent fields to shift right. The date "2026-01-07" ended up in the activities column (parts[6]), and `parseInt("2026-01-07")` returned 2026. (3) **Fix applied** — Changed from `psql -F ","` to `psql --csv` which properly quotes fields containing commas. Result: `1011262,"S&B Industry, Inc.",1,7,2025-12-05,2026-01-07,4,0,0,0,` now parses correctly with parts[1]="S&B Industry, Inc." and parts[6]=4. (4) **Metrics verified** — Ran database cross-checks to verify all counts: RFQ Lines: DB=190, Report ASSIGNED=146 + NOT ASSIGNED=44 = 190 ✓. CQ Lines: DB=91, Report ASSIGNED=70 + NOT ASSIGNED=21 = 91 ✓. CQ Lines Won: DB=34, Report ASSIGNED=28 + NOT ASSIGNED=6 = 34 ✓. S&B Industry: Activities=4 (not 2,026!), RFQ=0, CQ=0, CQ Won=0 ✓. ASSIGNED total activities: 2,635 (broken) → 613 (correct). (5) **UI/UX improvements round 1** — Moved Report Generated Date to top (row 1). Added Report Title row 3 (centered, merged A-R): "Seller Name - Account Review - Quarter Year". Moved How to Use section from top to bottom (after Delta to Goal). Updated freeze panes from row 10 to row 5. Fixed title showing "Undefined" instead of seller name (was using data.sellerName, should be data.seller). (6) **UI/UX improvements round 2** — Merged instruction rows across columns A-F for wider text area (no wrapping needed). Increased instruction font size from 9pt to 11pt. Changed alignment to left-aligned (hugs left edge). Removed wrapText property. Yellow highlighting on "HOW TO USE:" matches Q3 column headers. (7) **Final report structure** — Row 1: Report Generated Date. Row 2: Blank. Row 3: Title (merged A-R, centered): "Aaron Mendoza - Account Review - Q3 2026". Row 4: Blank. Row 5: Column Headers ← Frozen here. Row 6+: Data (scrollable). After Delta to Goal: How to Use section (yellow highlight, merged cells, 11pt font). (8) **Verification complete** — All metrics accurate, CSV parsing handles commas correctly, report layout polished and production-ready. User confirmed all adjustments visible in Excel. **Files modified:** `Sales Operations/Account Review/generate-account-review.js` (CSV parsing fix: changed psql command to use --csv mode, title fix: use data.seller not data.sellerName, UI improvements: report layout restructure, How to Use formatting), `Sales Operations/Account Review/account-review-roadmap.md` (marked CSV parsing bug fix, UI/UX enhancements, and filename change as complete). **Status:** Complete. Account Review automation is production-ready. Critical CSV parsing bug fixed, all metrics verified accurate, final UI/UX polish applied.

- **2026-07-15 (Account Review - Account Context Columns Implementation)**: **Completed Account Context Columns feature (Roadmap Item #2) with three critical bug fixes.** (1) **Initial implementation** — Added three account context columns: Months Assigned, First Assigned Date, Last Sale Date. Used database CTEs to calculate from c_bpartner_location, c_contactactivity, chuboe_rfq, c_order, c_invoice. (2) **Bug #1: First Assigned showing pre-employment dates** — User reported Aaron showed 2019 assignment dates despite joining company later. Root cause: Using c_bpartner_location.created (location creation date) instead of when Aaron was assigned. Fix: Changed to LEAST of activity startdate, RFQ created, order dateordered as proxy for first interaction date. (3) **Bug #2: Months Assigned calculation wrong** — User reported Alstom showed 8 months instead of expected 20 months (from 2024-11-12 to 2026-07-15). Root cause: `EXTRACT(MONTH FROM AGE(...))` only extracts the "months" portion of interval (8 months), not total months. Fix: Changed to `(EXTRACT(YEAR) * 12 + EXTRACT(MONTH))` to calculate total months across years. (4) **Bug #3: Last Sale Date mostly blank** — User reported 5 accounts booked in Q2 but only 1 showed Last Sale Date. Root cause: Query filtered for completed/closed orders only (`docstatus IN ('CO', 'CL')`), but Aaron's Q2 orders were "IP" (In Progress) or "DR" (Draft). Also used dateordered instead of creation date. Fix: Changed to use `o.created::date` (SO creation date) and included all non-voided orders (`docstatus != 'VO'`). Also added salesrep_id filter to show seller-specific activity. (5) **Verification query** — Ran database check showing Aaron's Q2 2026 orders: Alstom (9 orders, latest 2026-05-26), Eastman Kodak (5 orders, latest 2026-05-26), GE Healthcare (3 orders, latest 2026-06-24), Advanced Manufacturing (2026-06-04), Advanced Technology (2026-04-06), Bearings Distributors (2026-06-29). All statuses: IP, DR, VO. (6) **Final report generation** — Report generated successfully with all fixes: 21 assigned accounts, 24 not-assigned accounts, $50,177 Scheduled GP Q3 ✓, $120,000 GP Goal Q3 ✓, $45,493 Booked GP Q2 ✓, $52,411 Invoiced GP Q2 ✓. User confirmed "Much better" after reviewing Last Sale Date population. (7) **Updated roadmap** — Marked Roadmap Item #2 (Account Context Columns) as completed (2026-07-15). Three columns working: Months Assigned (total months from first interaction), First Assigned Date (earliest activity/RFQ/order), Last Sale Date (latest SO creation by seller). **Files modified:** `Sales Operations/Account Review/generate-account-review.js` (3 CTE fixes: assignment_dates months calculation, last_sales docstatus filter and date source), `Sales Operations/Account Review/account-review-roadmap.md` (marked Item #2 complete). **Status:** Complete. Account Context Columns feature operational with accurate date calculations and seller-filtered activity tracking.

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
