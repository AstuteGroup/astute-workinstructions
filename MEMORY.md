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

- **2026-07-01 (USA Daily Brief - Updated to Match VP Improvements)**: **Updated USA Daily Brief to match VP Daily Brief feature improvements while maintaining USA-specific focus.** (1) **Section 1.1 - Top 15 Orders** — Changed from top 5 to top 15 orders with collapsible section (5 visible with medals 🥇🥈🥉 + 10 hidden in expandable section). Updated SQL query `LIMIT 5` → `LIMIT 15`, updated JavaScript parsing and HTML generation with `<details>` tag for collapsible section. (2) **Section 1.4 - Location-Level Reactivation Tracking** — Replaced simple 180-day c_bpartner_id tracking with hybrid Customer Name + City tracking (30-day minimum gap). Added significance scoring, gap multiplier calculations, statistical anomaly detection. Excludes brokers/distributors/traders. Updated SQL with full VP logic (filtered to USA), updated JavaScript column parsing (17 new columns including facility_location, gap_multiplier, reactivation_type, significance_score), updated HTML table structure. (3) **Section 2.2B - NEW Backlog View** — Added "Top 5 Scheduled to Ship This Month (by GP)" showing unshipped lines with promise date in current month. Color-coded by urgency: Red (past due), Yellow (due this week 0-7 days), Green (future 8+ days). Shows +/- days from promise date. USA region filtered, top 5 by GP. Created new SQL query section, new `getTop5LateLines()` JavaScript function with 14 columns, new HTML generation with color coding. (4) **Email Format Update** — Changed from inline HTML to attachment format matching VP Daily Brief. Created simple email body with viewing instructions, "How to View" info box, section outline, professional footer. Changed from `sendEmail()` to `sendWithAttachment()` with HTML file. (5) **Documentation** — Updated `usa-daily-brief-workflow.md` with all section changes, added comprehensive changelog entry (2026-07-01), updated Features list, updated comparison table with VP Daily Brief, updated Key Differences. **Testing** — Ran script successfully: 3 top orders, 0 reactivations, 10 late lines, 5 scheduled to ship, 2 ISE alerts. Sent test email to melissa.bojar@astutegroup.com with attachment format. **Files modified:** `queries/usa-daily-queries.sql` (+287 lines), `scripts/sales-pulse-usa-daily.js` (+194 lines), `scripts/email-usa-daily-brief.js` (+81 lines), `docs/usa-daily-brief-workflow.md` (+68 lines). **Status:** Complete, tested, committed (7de7acf), pushed to GitHub. USA Daily Brief now has feature parity with VP Daily Brief while maintaining regional focus.

- **2026-07-01 (VP Daily Brief - Email Attachment Format & Distribution Update)**: **Fixed collapsible section compatibility issues by switching from embedded HTML to HTML attachment format, simplified email body to professional greeting with instructions, and added Aran Coker to distribution list.** (1) **Issue identified** — User reported that collapsible sections (2 sections: "Show Next 10 Orders" and "Show Next 10 Lines") from June 30 updates were not working when emails were delivered. Investigation revealed CSS checkbox toggle technique (`<input type="checkbox" id="toggle">` + `:checked` pseudo-selector) works perfectly in browsers but **fails in most email clients** — Gmail strips `<style>` blocks entirely (only allows inline styles), Outlook doesn't support `:checked` pseudo-selector, mobile clients have inconsistent support. Embedded HTML approach fundamentally incompatible with interactive features. (2) **Solution decided** — Switched to **HTML attachment** approach instead of embedded HTML email. **Benefits:** All interactive features work perfectly when attachment opened in browser, user can save/bookmark report, full styling preserved, only requires one extra click. **Trade-off:** No longer readable directly in email preview, but VP-level report justifies the click. (3) **Email body redesigned** — Created simple, professional email body with: "Good morning" greeting, clear purpose ("quick 60-second review of Astute Inc.'s sales performance from yesterday"), info box with viewing instructions (open HTML attachment in web browser), bulleted outline of 3 main sections (Section 1: Yesterday's Top Wins, Section 2: Needs Attention, Section 3: Yesterday's Activity by Region) with brief descriptions, professional footer. **Original plan:** Include executive summary with metrics (top order, total revenue, ISE alerts). **User feedback:** "Remove the email body. Keep it simple. Just greeting, instructions, section outline, and why (60-second review)." Simplified to remove all metrics/alerts from email body. (4) **Footer contact update** — Email footer originally said "Questions or feedback? Reply to this email." **User question:** "Where does that message go?" **Answer:** Replies go to `salesanalytics@orangetsunami.com` (AWS WorkMail inbox). **User decision:** Changed to **"Questions or feedback? Contact Melissa Bojar at melissa.bojar@astutegroup.com"** to ensure questions go to actively monitored inbox instead of shared mailbox. (5) **Distribution list updated** — Added **Aran Coker (aran.coker@astutegroup.com)** to recipient list per user request. **Full distribution now:** Josh Pucci (VP Sales), Melissa Bojar (Sales Productivity Analyst), Aran Coker. Email script header comment updated from "Josh Pucci and Melissa Bojar" to "Josh Pucci, Melissa Bojar, Aran Coker". **Files modified:** `Sales Pulse Daily/scripts/email-vp-daily-brief.js` (switched to attachment format, added Aran to recipients, new email body), `Sales Pulse Daily/docs/vp-daily-brief-workflow.md` (updated recipients, delivery format, changelog). **Status:** Email attachment format working perfectly, all three recipients now receiving daily reports, collapsible sections work when attachment opened in browser.

- **2026-06-30 (VP Daily Brief - Customer Name + City Reactivations Tracking)**: **Implemented simplified Customer Name + City reactivations tracking to replace complex OEM/fuzzy matching, added broker/seller exclusions, relaxed significance filters for better visibility, and fixed collapsible sections for email compatibility.** (1) **Initial issue discovered** — VP Daily Brief query was filtering out ALL component sales because it checked `m_product.value NOT IN ('GenSalesProd')`, but in iDempiere's workflow ALL sales orders use Generic Sales Product as placeholder with actual MPN details in linked `chuboe_cq_line` table. **Fix:** Changed filter to `EXISTS (SELECT 1 FROM c_orderline WHERE chuboe_cq_line_id IS NOT NULL)` which correctly identifies component sales (CQ-linked) vs service fees/adjustments. (2) **Customer Name + City implementation** — Replaced complex hybrid tracking (OEM facility-level via location_id + non-OEM fuzzy name matching with regex) with simple concatenation: `bp.name || ' | ' || COALESCE(loc.city, 'Unknown City')` as tracking_key. **Benefits:** 35x more visibility (106 reactivations in 30 days vs 3 with old method), simpler maintenance (no OEM lists to update), consistent granularity (city-level for everyone), human-readable keys like "KLA | Singapore". Removed `oem_accounts` and `customer_normalized` CTEs entirely. **Test results (30-day):** Found meaningful reactivations like Ontic|Chatsworth (440 days, 11.6x typical cycle), Flock Safety|Austin (69 days, 62 lifetime orders), Wistron (71 days, $1.56M). (3) **Exclusions added per user request** — Added to `excluded_customers` CTE: `UPPER(name) LIKE '%A2 GLOBAL%'` (A2 Global Electronics - broker), `UPPER(name) LIKE '%SOURCEABILITY%'` (broker). Added seller exclusion: `AND u.ad_user_id != 1000004` (Jake Harris - different role, 13 orders in last 30 days excluded). (4) **Significance filter adjustment** — Initial query had VERY strict filters. **User feedback:** "There should be more from what you told me." **Fix:** Removed strict significance filters, now shows all with 30+ day gap sorted by gap length (`WHERE CURRENT_DATE - lopk.last_order_date >= 30 ORDER BY days_gap DESC LIMIT 5`). (5) **Collapsible sections fixed** — Two sections using `<details>` tags didn't work in email clients (most strip them for security). **Replaced with email-safe checkbox toggles:** `<input type="checkbox" id="toggle-orders">` + CSS `:checked` pseudo-class. **Files modified:** `Sales Pulse Daily/queries/vp-daily-queries-v2.sql` Section 1.4, `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`. **Status:** All improvements implemented and delivered.

- **2026-06-29 (Market Pulse Week 26 - Executive Brief & Final Fixes)**: **Generated Week 26 Market Pulse with updated external market data, redesigned Executive Brief, and fixed all calculation/color issues. Option A Dashboard format is now the STANDARD.** (1) **External market research** — Researched current semiconductor market conditions from industry sources (Sourceability, Avnet, J2 Sourcing, IDC, FindChips) for Week 26. **Key changes from Week 25:** 🆕 MLCCs (Passives) added as ALLOCATED (26-40w, +65% price YoY, AI servers need 40K-440K MLCCs each), 🟢 Logic ICs improved to NORMAL (TI inventory 222 days, commodity plentiful), 🔴 Memory worsening (26-40+w, HBM sold out through 2026, +95% Q1 prices). (2) **Executive Brief redesign** — Replaced "Market Lifecycle Signals" count box with comprehensive "Week 26 Executive Brief" spanning full width with 3 columns: **Performance vs Last Week** (Bookings/Billings GP/GM with WoW deltas, B/B ratio, alert for margin swings >10pts), **Market Shifts WoW** (color-coded changes: 🆕 new constraints, 🟢 improvements, 🔴 worsening), **Top 3 Actions This Week** (expandable action details with internal/external signals and specific next steps). (3) **GM% calculation fixes** — Fixed "multiplying by 100" issue in both Hot Part Families and Trending Manufacturers tables. Changed from `(GP/Revenue)*100` (stored as percentage) to `GP/Revenue` (stored as decimal 0.33 = 33%), then multiply by 100 at display time. (4) **CQ Sold % fixes** — Renamed "Win %" to "CQ Sold %" and fixed calculation from `SO/VQ` to `SO/CQ`. (5) **Color scheme cleanup** — Removed ALL green highlighting from table data following principle "only highlight problems, not successes". **Files:** `market-pulse-week25.js`, `market-pulse-option-a.js`, `output/market-pulse/market-pulse-option-a-week26-2026-06-29.html`. **Status:** Week 26 delivered, Option A is now STANDARD format.

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
