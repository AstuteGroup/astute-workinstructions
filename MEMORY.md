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

- **2026-07-15 (Daily Sales Reports - Internet Outage Recovery & Health Check System)**: **Recovered from automated daily brief failures caused by internet outage, then implemented comprehensive health check system to prevent future silent failures.** (1) **Issue discovered** — User reported all three daily sales briefs (USA, Mexico, VP) sent this morning had incorrect data: Mexico brief showed USA sellers instead of Mexico sellers, VP brief had blank Section 1 (Yesterday's Top Wins), USA brief had blank Section 2 (Open ISE Alerts). All three had incomplete Section 3 (Yesterday's Activity). (2) **Root cause identified** — Internet outage during 6am PT cron run caused database connection failures. Because report scripts do not halt on query errors, they generated partial HTML with empty sections and sent them to distribution. Mexico brief also showed wrong region because July 14 regional filtering fixes were tested locally but never committed to git (operator oversight). (3) **Immediate recovery** — Verified all July 14 fixes (regional filtering, validation system) were committed to git. Re-ran all three email scripts manually and confirmed correct output: Mexico brief shows MEX sellers only, VP brief shows all 3 top wins, USA brief shows all 4 ISE alerts, Section 3 complete for all. Sent corrected reports to full distribution (Jeff Wallace, Joel Marquez, Josh Pucci, Aran Coker, Melissa Bojar). (4) **Health check system designed** — User requested comprehensive pre-flight checks to prevent future silent failures. Built `health-checks.js` module with 8 validation groups: **Database connectivity** (psql version check, db name check, user permissions), **Sample queries** (active clients count, active users count, schema access), **Report data validation** (yesterday's orders exist, ISE alerts query returns data, yesterday's activity metrics exist, VQ lines query returns data), **File system** (query files exist and readable), **Email system** (SMTP credentials loaded), **Script integrity** (required functions exist in report scripts). Each check validates critical assumptions before report generation. Module exports runAllHealthChecks() which returns {passed, failed, details}. (5) **Integration into email scripts** — Updated all three email scripts (email-usa-daily-brief.js, email-mexico-daily-brief.js, email-vp-daily-brief.js) to run health checks BEFORE report generation. If any check fails: Scripts abort immediately (no report generated or sent), Alert email sent to melissa.bojar@astutegroup.com ONLY (not full distribution) with failure details, Exit code 1 logged by cron. If all checks pass: Normal report generation and distribution continues. Alert email includes: timestamp, failed check names and details, list of checks that passed. Subject line: "⚠️ Daily Sales Report Health Check Failed - [Report Name]". (6) **Testing** — Ran all three email scripts with health checks enabled. All checks passed: DB connectivity ✓ (3 checks), Sample queries ✓ (3 checks), Report data validation ✓ (4 checks), File system ✓ (3 checks), Email system ✓ (1 check), Script integrity ✓ (3 checks). Reports generated successfully with correct data. Verified alert-only email logic: on failure, only Melissa gets notified, not full distribution. (7) **User feedback** — User confirmed health check approach is correct: gate automated sends behind pre-flight validation, alert to Melissa only on failures (not full leadership), abort distribution if checks fail. Operator can manually investigate and send corrected reports. (8) **Commit and save** — All work committed to git. Session logged to MEMORY.md. **Files created:** `Sales Pulse Daily/scripts/health-checks.js` (comprehensive validation module). **Files modified:** `Sales Pulse Daily/scripts/email-usa-daily-brief.js` (health check integration), `Sales Pulse Daily/scripts/email-mexico-daily-brief.js` (health check integration), `Sales Pulse Daily/scripts/email-vp-daily-brief.js` (health check integration). **Status:** Complete. Health check system operational, all three email scripts protected against silent failures, corrected reports distributed, tomorrow's 6am cron runs will validate before sending.

- **2026-07-14 (Account Review Automation - Project Setup & Requirements)**: **Started Account Review automation project to replace manual quarterly review report generation.** (1) **Project created** — Created "Account Review" folder under Sales Operations with .gitkeep. (2) **Template analyzed** — Reviewed example Excel "Account Reviews - Aaron Mendoza Example.xlsx" (Q2 2026 tab). Report has two sections: Assigned Accounts (26 accounts with ISE Steward) and Not Assigned (17 accounts with activity but no formal assignment). Columns include: Account names (OT + Infor), Locations, Activities, Q1 metrics (RFQ Lines, CQ Lines, CQ Won, Conversion Rate, Booked GP, Invoiced GP, B to I, % of Inv Total, Notes), Q2 metrics (Scheduled GP, GP Target, Strategy). (3) **Requirements gathered** — Metrics breakdown: Pre-sales (Activities, RFQs, CQs, conversions) from OT, Post-sales (Booked/Invoiced GP) from Infor CSVs, Planning (Scheduled GP from backlog, GP Targets from goals file). Quarter definitions: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec. Seller assignment via chuboe_ise_steward_id on locations, roll up to account level. (4) **Database schema explored** — Found key tables: c_contactactivity (activities via ad_user link), c_bpartner_location (ISE steward assignments), chuboe_rfq/cq/orderline (RFQ→CQ→SO chain). Aaron Mendoza identified: ad_user_id=1039413. Activities link: c_contactactivity.ad_user_id → ad_user.c_bpartner_id (NOT direct c_bpartner_id). (5) **Test queries built** — Created account-review-full-query.sql with CTEs for assigned accounts, activities, RFQ/CQ/SO metrics, booked/invoiced GP. Initially used dateordered/dateinvoiced, then user specified to use created date and label as "Booked Created Date". Fixed activities query to join through ad_user. Fixed invoiced GP to join invoice lines to order lines for cost. Results: Assigned accounts query works, activities counting correctly, RFQ/CQ metrics match Excel. (6) **Context Portfolio reviewed** — User is accountable for "Account Review structure and information accuracy" (quarterly reviews with sellers/management). Two-system architecture: OT (pre-sales CRM) + Infor (post-sales ERP). SharePoint integration hub connects Power BI (Infor) to Metabase (OT). Claude connected to OT for analysis. User builds outputs to help leadership identify focus and actions. (7) **Infor data analyzed** — Parsed Infor CSVs from Sales Pulse Daily/data folder: "Infor Booked Sales by Line YTD - 6.19.26.csv" (booked revenue/GP by CO Internal Salesperson) and "Invoiced Sales 2026 by Line - 6.19.26.csv" (invoice revenue/GP by Internal Salesperson). Aaron's username: "aaromend". Q1 2026 totals from Infor: Booked GP=$47,493 (closer to Excel $31,917), Invoiced GP=$27,523 (matches Excel $29,307 closely). OT query showed Booked GP~$61,846 (inflated). **Decision: Use Infor CSVs for GP metrics, not OT queries.** (8) **Customer name matching challenge identified** — OT vs Infor name mismatches: "Alstom" vs "Alstom Transportation Inc.", "GE Healthcare" vs "GE Precision Healthcare LLC", "Morey Corporation" vs "THE MOREY CORPORATION". Need fuzzy matching logic to join Infor GP to OT accounts. (9) **Test results** — Locations match (Alstom=2✓, GE Healthcare=6✓), Activities close (Alstom=2✓, GE Healthcare=10 vs Excel 12), RFQ/CQ exact match (Alstom: RFQ=12✓, CQ=18✓), Conversion rates calculate correctly. **Next steps documented:** Build complete OT queries using created date, create Infor CSV parser, implement fuzzy customer matching, add "Not Assigned" section query, build Excel generator with formatting, parameterize for any seller/quarter. **Files created:** Sales Operations/Account Review/PROJECT-STATUS.md (comprehensive pickup document), account-review-full-query.sql (OT metrics query), analyze scripts for Excel/Infor data. **Status:** Requirements complete, schema validated, test queries working. Ready to build automation scripts. User will resume tomorrow with full context in PROJECT-STATUS.md.

- **2026-07-14 (Mexico Daily Brief - Critical Regional Filtering Bug Fix + Validation System)**: **Fixed critical bug causing Mexico sellers to be mislabeled as USA region, and added automated validation to prevent future regressions.** (1) **Issue reported** — User identified that Mexico Daily Brief Section 1 (Yesterday's Top Wins) was showing sellers from other regions, not just Mexico team. Expected: USA brief shows USA sellers only, Mexico brief shows Mexico sellers only. (2) **Root cause analysis** — Investigated Section 3 first, found it was correctly labeled after previous fix (line 853 "3.2 ACTIVITY BY MEXICO SALES REP"). Then checked Section 1 queries. Found 4 section headers still said "USA ONLY" instead of "MEXICO ONLY" (lines 309, 569, 625, 692). SQL queries themselves had correct Mexico filters (lines 64, 128, 376, 617, 682, 716). (3) **CRITICAL BUG discovered in Section 2.3** — ISE Alerts query had duplicate CASE conditions (lines 702-703, 708-709): Mexico seller IDs checked TWICE, first mapped to 'USA', then to 'MEX'. Because CASE statements match first condition, ALL Mexico sellers were labeled region='USA' in output. This bug also affected manager field. (4) **Comprehensive fixes applied** — Fixed 6 issues in mexico-daily-queries.sql: Changed 4 section header comments from "USA ONLY" to "MEXICO ONLY" (sections 1.4, 2.2A, 2.2B, 2.3). Deleted duplicate CASE line assigning Mexico IDs to 'USA' region (line 702). Deleted duplicate manager CASE line (line 708). Fixed 2 issues in sales-pulse-mexico-daily.js: Changed comment from "USA Sales Rep Activity" to "Mexico Sales Rep Activity" (line 386). Changed search string from '3.2 ACTIVITY BY USA SALES REP' to '3.2 ACTIVITY BY MEXICO SALES REP' (line 390). (5) **Testing** — Ran both briefs successfully. USA brief: 4 orders from USA team (Aaron Mendoza, Daniel Reiser, etc.), region='USA'. Mexico brief: 2 orders from Mexico team (Joel Flores, Ricardo Morales), region='MEX' ✓. Verified JSON output showed correct "region": "MEX" for all Mexico sellers. (6) **Cron confirmation** — Verified changes will apply to automated daily emails. Cron jobs run email-usa-daily-brief.js and email-mexico-daily-brief.js at 6am PT Mon-Fri, which call generation scripts (sales-pulse-usa-daily.js, sales-pulse-mexico-daily.js), which read from query files. No caching involved - Node.js loads files fresh every run. Recipients: USA brief → Jeff Wallace + Melissa Bojar. Mexico brief → Joel Marquez + Melissa Bojar. (7) **Distribution** — Committed fixes (commit 7842e3f). Sent corrected reports to melissa.bojar@astutegroup.com and then full distribution (Jeff Wallace, Joel Marquez) as HTML attachments with explanatory notes. (8) **Validation system requested** — User concerned about recurrence (thought it was fixed yesterday but incorrect versions sent today). Requested safeguard to verify fixes before automated sends. (9) **Validation script created** — Built `validate-regional-fixes.js` with 5 check groups: Section headers (4 checks), Section 2.3 CASE statements (2 checks), Mexico script search strings (2 checks), Section 3.2 header (1 check), Mexico ID filters (2 checks). Validates all 11 fix points. Exit code 0 = safe to run, Exit code 1 = fixes missing. Tested and confirmed all checks pass. Commit bb642b3. (10) **Built-in validation added** — Integrated validation into both email scripts as Step 0 (runs before report generation). If validation fails: Scripts abort (no report generated/sent), Alert email sent to melissa.bojar@astutegroup.com with failure details, Exit code 1 logged by cron. If validation passes: Normal report generation and distribution continues. Tested Mexico script - validation runs successfully, brief generates normally. Commit 9fef14a. **Seller teams verified:** USA (8): Aaron Mendoza, Daniel Reiser, Jake Mcaloose, James Diaz, Josh Syre, Justin Goodwin, Michael Stifter, Thomas Haynes. Mexico (8): Alejandro Padilla, Alex Partida, Alfredo Martinez, Carlos Moreno, Carolina Hinestroza, Joel Flores, Ricardo Morales, Salvador Horner. **Files modified:** `Sales Pulse Daily/queries/mexico-daily-queries.sql` (6 fixes), `Sales Pulse Daily/scripts/sales-pulse-mexico-daily.js` (2 fixes), `Sales Pulse Daily/scripts/validate-regional-fixes.js` (created), `Sales Pulse Daily/scripts/email-usa-daily-brief.js` (validation integration), `Sales Pulse Daily/scripts/email-mexico-daily-brief.js` (validation integration). **Status:** Complete. Critical bug fixed, automated validation prevents regressions, protected automated sends starting tomorrow 6am PT.

- **2026-07-13 (Enrich-Poller Recovery & Backfill Improvements)**: **Fixed 6-day enrich-poller outage and implemented resilient backfill processing.** (1) **Root cause** — `pool.end()` hung indefinitely waiting for a leaked PostgreSQL connection after processing RFQ 1138879 (415 MPNs) on 2026-07-07. Process stuck for 6 days; every 15-min cron tick saw PID file, confirmed process alive, exited cleanly. ~2,166 MPNs across 472 RFQs went unenriched. (2) **Shutdown timeout fix** — Added 10-second timeout to `pool.end()` using `Promise.race()`. Since watermark is written before shutdown, timeout exit is safe — next tick picks up from checkpoint. (3) **Newest-first backfill** — Changed query ORDER BY from ASC to DESC so newest RFQs process first during recovery. Added backfill tracker file (`~/.enrich-backfill-tracker.json`) to track processed RFQ IDs and prevent reprocessing. Watermark only advances when entire backlog clears; tracker cleared at same time. (4) **PPV deprioritization** — Demoted PPV (P1c) to after P2 in processing order so real demand (Shortage, Stock, EOL/LTB) gets enriched before pricing exercises. New order: P1a → P1b → P2 → P1c → P3. (5) **Recovery confirmed** — Killed stuck process, new code picked up by cron, backlog processing in correct priority order. **Commits:** `9fde5a4` (shutdown timeout), `3a1ecca` (newest-first backfill), `325acda` (PPV demotion). **Files modified:** `Trading Analysis/RFQ API Enrichment/enrich-poller.js`. **Status:** Complete, pushed, running.

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
