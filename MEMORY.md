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

- **2026-07-13 (Weekly Market Pulse Week 28 - Complete Refresh with External Research & Price Increases)**: **Generated Week 28 Market Pulse Report with comprehensive external market research and detailed manufacturer price increase tracking.** (1) **Initial request** — User updated Power BI Data file and requested fresh external research for Weekly Market Pulse Report to cross-check. (2) **Week determination** — Confirmed today is July 13, 2026 (Week 29 Sunday). Report should cover Week 28 (July 6-12, complete week), NOT Week 29 (partial - only 4 bookings, 31 billings vs typical 111/118). (3) **External research conducted** — Comprehensive web search across semiconductor market intelligence sources (July 13, 2026): **Memory (DRAM/HBM):** CRITICAL ESCALATION - HBM consuming 23% of DRAM wafer capacity (up from 3-5x), prices +10-20% PER MONTH through end of 2026 (accelerating from +30-40% annual), Micron $9.3B fab groundbreaking July 8 (production Q3 2028), Intel CEO "no relief until 2028". **MLCCs:** STRUCTURAL SHORTAGE confirmed (June 2026 buyer data) - lead times 20-26w (from 8w), high-cap +15-20%, AI-grade +50-60%, utilization 90-95%. **MCUs:** CRITICAL - STM32 30-55w lead times, Renesas 20-45w, early July Renesas factory voltage drop (lightning) = 2 weeks production lost. **Power ICs:** UPGRADED to ALLOCATED - lead times 35-40w (from 20-30w), uPI Semi forecasts shortage throughout 2026, Samsung 8" fab shutdown. **Connectors/Discretes:** CONSTRAINED - Molex +5-30%, TE +4-6%, NXP +8-12%. **Logic ICs:** NORMAL - TI inventory 222 days. Sources: FindChips, 773 GROUP, J2 Sourcing, TrendForce, Sourceability, Tech Insider, VersaLogic, Astute Group, GlobX, EE News Europe, Microchip USA, Aetrix Electronics, ChargerLab. (4) **Week 25 references removed** — Initial report incorrectly showed "Week 25" in title and had note "may not include complete Week 25 activity". Fixed all references to "Week 28" and removed incomplete week note since Week 28 is COMPLETE (111 bookings, 118 billings). (5) **Manufacturer Price Increases section added** — User identified missing detailed price increase section. Added comprehensive breakdown with 7 manufacturers: **Infineon** (+5-8% Jul 1, 2nd increase of 2026, power ICs/automotive/SiC), **Texas Instruments** (selective increases Jul 1-6, PMICs/MOSFETs/logic), **Molex** (+5-30% Jul 1, connectors), **TE Connectivity** (+4-6% Jul 1-6, industrial connectors), **STMicroelectronics** (+6-10% Jun 28, STM32 MCUs), **NXP** (+8-12% Jun 1, automotive MCUs), **SiSEMI** (Jul 1, select lines). Each entry includes effective date, percentage, product categories, strategic context, and clickable source link. Added trend analysis: "Multiple manufacturers on 2nd price increase of 2026 = structural shortage signal, not temporary cost pass-through." (6) **Critical Market Events links added** — User requested source links for Critical Market Events section. Added clickable links for all 6 events: Micron fab (VersaLogic), Renesas disruption (773 GROUP), Intel CEO (Tech Insider), HBM sold out (Tech Insider), MLCC shift (FindChips), Price increases (TrendForce). (7) **Final Week 28 metrics** — Bookings GP: $774,485 (33.8% GM), Billings GP: $849,410 (27.5% GM), B/B Ratio: 0.91x. Market State: ALLOCATED (25 signals: 12 allocated, 3 constrained, 10 shortage). OT Constraint Indicators: 10 hot part families, 15 franchise lead time signals, 10 trending manufacturers. (8) **Distribution** — Email sent to melissa.bojar@astutegroup.com (To) and josh.pucci@astutegroup.com (CC) with HTML attachment. Email body includes Week 28 performance summary, critical market events, manufacturer price increases, key constraints, and note that all data sources include clickable verification links. User will request feedback from Josh. **Files created:** `market-pulse-week29-research.js` (external research data for Week 28 analysis), `Sales Pulse Daily/scripts/market-pulse-week28.js` (report generator), `send-market-pulse-week28-final.js` (email sender). **Files modified:** Week 28 HTML report includes Critical Market Events section (6 events with links), Manufacturer Price Increases section (7 manufacturers with detailed breakdowns), External Data Sources section (Memory, MLCCs, MCUs, Power ICs, Connectors, Discretes, Logic ICs with article links). **Status:** Complete. Week 28 report delivered with comprehensive external research and source verification. Awaiting Josh's feedback.

- **2026-07-13 (Sales Pulse Daily Reports - Regional Filtering & Section 3 Red Zeros Fix)**: **Fixed critical regional filtering bug in Mexico Daily Brief and added red zero formatting to Section 3 across all reports.** (1) **Issue reported** — User identified that "Yesterday's Top Wins" (Section 1) was only showing one region each day across all three reports. Expected: USA Daily Brief shows USA sellers only, Mexico Daily Brief shows Mexico sellers only, VP Daily Brief shows USA + MEX + APAC teams. (2) **Root cause discovered** — Mexico queries file had critical CASE statement bug: Mexico seller IDs (1047106, 1026393, etc.) were mapped to 'USA' in the first WHEN clause, so the 'MEX' branch was never reached. This caused Mexico sellers to always display as 'USA' region. Found bug replicated across 9 locations in mexico-daily-queries.sql. VP queries had no regional filtering at all (showed all sellers including 'Other'). (3) **Fix #1: Mexico region mapping** — Corrected all CASE statements in mexico-daily-queries.sql to properly map USA IDs to 'USA' branch and Mexico IDs to 'MEX' branch. Updated 9 occurrences using replace_all. Fixed comments from "USA ONLY" to "MEXICO ONLY" in sections 1.1 and 1.2. Also fixed typo in VP queries: 'APAC-Kris' → 'APAC-Silvia'. (4) **Fix #2: VP regional filtering** — Initially added WHERE clause filters to VP queries for USA + MEX + APAC teams (excluding 'Other'). User then requested revert to show ALL regions including 'Other'. Removed the three regional filters from vp-daily-queries-v2.sql sections 1.1, 1.2, and 1.4. Final state: VP shows all regions, USA shows USA only, Mexico shows MEX only. (5) **Fix #3: Section 3 red zeros** — User requested all zeros in Section 3 (Yesterday's Activity) display in RED font (#d32f2f) for better visibility. Updated generateSection3() functions in all three report scripts (sales-pulse-usa-daily.js, sales-pulse-mexico-daily.js, sales-pulse-vp-daily-v2.js). Added conditional styling to check if values are zero/null/empty and apply red color to: RFQ Lines, CQ Lines, CQ Sold, SO Lines, Revenue, GP. Applied to both individual rep/region rows AND total rows. (6) **Distribution** — Regenerated all three reports and sent to full distribution lists with 'UPDATED' in subject line and explanatory notes: USA Daily Brief → Jeff Wallace, Melissa Bojar (fix: Section 3 red zeros). Mexico Daily Brief → Joel Marquez, Melissa Bojar (fixes: correct MEX region labels + Section 3 red zeros). VP Daily Brief → Josh Pucci, Melissa Bojar, Aran Coker (fix: Section 3 red zeros, shows all regions). (7) **Email format** — Added yellow update notice boxes to all email bodies explaining the fixes applied. Maintained standard report section descriptions with updated notes about red zero formatting. **Files modified:** `Sales Pulse Daily/queries/mexico-daily-queries.sql` (9 CASE statement fixes + 2 comment fixes), `Sales Pulse Daily/queries/vp-daily-queries-v2.sql` (3 filter additions then 3 filter removals + 1 typo fix), `Sales Pulse Daily/scripts/sales-pulse-usa-daily.js` (Section 3 red zeros), `Sales Pulse Daily/scripts/sales-pulse-mexico-daily.js` (Section 3 red zeros), `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js` (Section 3 red zeros). **Status:** Complete. All three reports now filtering correctly by region, zeros display in red for visibility, full distribution sent with explanatory emails.

- **2026-07-02 (Weekly Market Pulse Week 27 - Complete Data Quality Overhaul & Email Delivery Preference)**: **Generated Week 27 Market Pulse with comprehensive data accuracy fixes and established email delivery preference.** (1) **Initial generation** — Generated Week 27 report with latest external market intelligence from July 2 research (manufacturer price increases, market events, constraint updates). Included Microchip notification letter reference from data folder. (2) **Data accuracy issues discovered** — User identified multiple data quality problems: GP calculations inflated 13-53x due to Cartesian product (order with 11 MPNs counted 11 times), Bookings/Billings GP incorrect ($599K→$620K, $341K→$936K after Power BI refresh), Booked GP showing $0 for all part families, manufacturer name variants not consolidated ("Micron Technology Inc" vs "Micron Technology, Inc."), MT* parts incorrectly attributed to Fortinet instead of Micron. (3) **Comprehensive fixes applied** — Fixed GP calculation Cartesian product in part_family_sales and mfr_sales queries. Corrected Bookings/Billings to read from refreshed Power BI data file. Fixed Booked GP query to filter by order date not RFQ date. Added manufacturer normalization to consolidate variants. Added manufacturer override logic for part family prefixes (MT*→Micron). Added VQ Lines footer notes explaining (-X) notation for "No Quote" responses. Added KLA business footer note explaining consignment impact (3% bookings, 64% billings). Added date/time stamp with completeness note. Removed "(Option A: Dashboard)" from title. (4) **Booked GP filter clarification** — User identified $210K discrepancy for Intel ($611K in Power BI vs $401K in report). Cause: Report filters to Shortage RFQs only (market constraint focus) while Power BI shows all RFQ types. User chose to KEEP Shortage filter (Option B). Added footer notes to both Hot Part Families and By Manufacturer tables: "Booked GP Filter: Shortage RFQs only (30-day rolling). Does not include Stock, PPV, EOL, or other RFQ types. Totals will not match Power BI." (5) **Final Week 27 metrics** — Bookings GP: $620K (↓56% WoW), Billings GP: $936K (↑195% WoW, driven by KLA $596K consignment), B/B Ratio: 0.66x. Market State: ALLOCATED (25 signals). Top Part Family: MT* (Micron) $646K GP. Intel Booked GP: $401K (Shortage RFQs), $515K (all RFQ types), $611K (Power BI/Infor - includes system sync). (6) **EMAIL DELIVERY PREFERENCE ESTABLISHED** — User requested Weekly Market Pulse ALWAYS be sent as HTML attachment (not inline HTML) with explanatory email body. Format: Subject "Market Pulse — Week [N] (date)", Body includes "What's New" section (updates/fixes), "Purpose of External Sources" section (explains constraint category links), "Manufacturer Price Increases" section (this week's effective increases), "Week [N] Key Insights" section (temperature, WoW, top signals). Attachment enables links and interactive features to function properly when opened in browser. Recipients: melissa.bojar@astutegroup.com, josh.pucci@astutegroup.com (expandable to full leadership list). Sent from: salesanalytics@orangetsunami.com. (7) **External Data Sources link update** — User caught that External Data Sources section had old Week 26 links instead of fresh July 1-2 research links. Updated market-pulse-option-a.js to include 28 current source links from comprehensive research session: manufacturer announcements (TrendForce, WIN SOURCE, StockTitan, LinkedIn), this week's events (TradingKey, GlobeNewswire), constraint categories (Tech Insider, IDC, Tom's Hardware, Sourceability for Memory; Astute Group, 773 GROUP, EE News for MLCCs; 773 GROUP, FindChips for MCUs; plus new Power ICs and Mature-Node sections). Regenerated report and resent with "UPDATED LINKS" tag. **Files modified:** `Sales Pulse Daily/scripts/market-pulse-option-a.js` (External Data Sources update + 13 data quality fixes), `Sales Pulse Daily/scripts/market-pulse-week25.js` (query fixes). **Status:** Complete. All fixes verified, Week 27 delivered with current sources, email delivery preference saved.

- **2026-07-02 (Daily Briefs Execution & Wrapper Script Fix)**: **Successfully ran all three daily briefs and fixed wrapper script path issue for easier future execution.** (1) **Initial execution** — User requested to run `node ~/workspace/run-briefs.js`. Script didn't exist at workspace root, found correct location at `astute-workinstructions/Sales Pulse Daily/run-briefs.js`. Ran the target script `scripts/run-all-daily-briefs.js` directly with full path - all three briefs executed successfully: VP Daily Brief (27 top orders, 12 new customers, 6 strategic accounts → Josh Pucci, Melissa Bojar, Aran Coker), USA Daily Brief (10 top orders, 6 strategic accounts, 6 CQs sold → Jeff Wallace, Melissa Bojar), Mexico Daily Brief (2 orders, 2 CQs sold, 7 late lines → Joel Marquez, Melissa Bojar). All emails sent successfully. HTML reports saved to respective output directories. (2) **Recipient verification** — User flagged concern that VP brief should go to "Aran Coker not Aran Lyons". Verified script configuration shows correct recipient `aran.coker@astutegroup.com` on line 27 of `email-vp-daily-brief.js`. Checked actual execution output confirming email successfully sent to aran.coker@astutegroup.com. My summary error (said "Aran Lyons") but actual execution was correct. (3) **Wrapper script fix** — Identified path issue in `run-briefs.js` line 12: was using double-nested path `path.join(__dirname, 'astute-workinstructions/Sales Pulse Daily/scripts/run-all-daily-briefs.js')` when `__dirname` already pointed to that directory. Fixed to `path.join(__dirname, 'scripts/run-all-daily-briefs.js')`. Confirmed symlink already exists at `~/workspace/run-briefs.js` pointing to `astute-workinstructions/Sales Pulse Daily/run-briefs.js`. Tested fixed wrapper - works correctly. (4) **Usage** — Now user can run all three briefs with single command: `node ~/workspace/run-briefs.js`. **Files modified:** `astute-workinstructions/Sales Pulse Daily/run-briefs.js` (1 line fix). **Status:** Complete. All daily briefs operational, wrapper script fixed, single-command execution confirmed working.

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
