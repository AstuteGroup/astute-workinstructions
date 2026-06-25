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

- **2026-06-25 (Email Escalation Fixes - UID 10064)**: **Fixed escalation emails showing `[object Object]` and missing investigation context across all email workflow loaders.** Root cause: VQ UID 10064 agent sent rich objects `{field, mpn, context}` in missing[] array but `missingLabel()` only handled string keys. Additionally, `investigation_summary` was captured in breadcrumbs but never displayed in emails. **Fixes applied to 5 workflow handlers (vq-loading.js, rfq-loading.js, broker-offers.js, excess.js, stockrfq.js):** (1) **Object-to-string handling** — `missingLabel()` and `missingLabelForSender()` now handle rich objects with `{field, mpn, context}` structure, not just string keys. (2) **Investigation summary display** — Added `investigationBlock` rendering to all escalation email templates showing agent reasoning. (3) **Email threading** — Added `In-Reply-To` and `References` headers so escalation emails appear in the same Gmail/Outlook thread as the original. **Files:** `shared/workflow-actions/vq-loading.js`, `shared/workflow-actions/rfq-loading.js`, `shared/workflow-actions/broker-offers.js`, `shared/workflow-actions/excess.js`, `shared/workflow-actions/stockrfq.js`. **Status:** Complete, committed (`118787d`), pushed.

- **2026-06-23 (VP Daily Brief - GP Columns Added to All Sections)**: **Added Gross Profit (GP) columns to all 7 sections of VP Daily Brief - Sales Pulse report.** User requested GP alongside Revenue for better margin visibility. **Implementation:** All GP values sourced from `bi_order_line_v.s_order_line_gp` (pre-calculated BI view). **Sections updated:** (1) **Top 5 Orders Won** — GP column after Revenue using order-level subquery. (2) **New Customers Sold** — GP column after Revenue. (3) **Strategic Accounts** — GP column after Revenue with green highlighting for positive values. (4) **Reactivated Customers** — Total GP column after Total Revenue with TOTAL row calculation. (5) **High Value Late SO Lines ($200K+)** — Unshipped Line GP prorated based on qty ratio. (6) **Top 5 Late SO Lines (Under $200K)** — Unshipped Line GP prorated. (7) **Regional Activity** — GP column in detail rows and TOTAL row. **Formatting fix:** Section 2 tables were extending past page width with 11 columns. Applied compact formatting: shortened headers ("Ln" vs "Line", "Rgn" vs "Region", "Promise" vs "Promise Date", "Late" vs "Days Late", "Qty" vs "Qty Unshipped"), reduced font sizes (9-11px), added "Unshipped amounts shown" clarification. **Data verification:** Report shows different Revenue vs GP values (e.g., Top Order: $468K revenue vs $180K GP = 38.5% margin), confirming accurate data retrieval. **Files:** `Sales Pulse Daily/queries/vp-daily-queries-v2.sql`, `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`. **Status:** Complete, tested, committed (3 commits), emailed to melissa.bojar@astutegroup.com.

- **2026-06-23 (Market Pulse Week 25 - Sections 1-2 Complete)**: **Built Week 25 Market Pulse Report with Performance Snapshot (Section 1) and Constraint Indicators (Section 2).** Created `market-pulse-week25.js` script to generate weekly reports from Power BI Data (Infor ERP) + OT database. **Section 1 - Performance Snapshot features:** (1) **GP-based metrics** — All values show Gross Profit instead of Revenue; B/B ratio calculated as Bookings GP / Billings GP. (2) **Week-over-week comparison** — Week 25 vs Week 24 with WoW change percentages. (3) **Three-part structure** — Inc Global Core Business (Ex-KLA), Regional Breakdown (APAC/USA/MEX/Other), KLA Business shown separately. (4) **Large return annotations** — Auto-detects returns >$50K GP and adds asterisks with notes (Week 24 had Marvell Asia -$847K GP return; Week 25 had KLA -$72K GP credit). (5) **Red color coding** — Negative WoW changes, GM% <18%, B/B <1.0. **Section 2 - Constraint Indicators (30-day rolling OT data):** (1) **Multi-Customer Parts** — 10 parts with 5+ customers (scarcity signal): MT47H128M16RT-25E:C (Micron, 23 customers), EPCS64SI16N (Altera, 13 customers), FT2232HL-REEL (FTDI, 11 customers). (2) **Conversion Drop-Off** — 2 manufacturers with >10pt win rate decline (supply tightening): APEM (−20pts), Hirose Electric (−17.1pts). (3) **Velocity Spike** — Top 3 manufacturers by RFQ volume increase (demand surge): Texas Instruments (+1,233 RFQs, +237.6%), Nexperia (+380, +105.3%), Vishay (+291, +253.0%). **Week 25 results:** Bookings GP $584K (26.3% GM), Billings GP $332K (22.3% GM), B/B 1.76x. **Files:** `Sales Pulse Daily/scripts/market-pulse-week25.js`, `output/market-pulse/market-pulse-week25-2026-06-23.html`. **Status:** Sections 1-2 complete. Ready for next section (Temperature Gauge to summarize constraint signals, or continue with Trending Manufacturers/Parts).

- **2026-06-22 (VP Daily Brief V2 - Final Polish & Production Launch)**: **Completed final refinements to VP Daily Brief and sent first production version to Josh Pucci with Friday's data.** Made three rounds of updates per user feedback: (1) **Regional & Structural Changes** — Added APAC-Lavanya region for India team (Lavanya Manohar, Manikandan, Meenakshi) instead of "Other"; reordered Reactivated Customers columns (SO Date, Seller, Region, Customer, Location, BP ID, SO#s, Revenue, Gap, Last Order, Previous Rep); added MPNs to High Value and Top 5 Late sections. (2) **Visual Polish** — Color-coded Strategic Accounts activity in dark green (#1b5e20) for wins; enhanced ISE Alert color coding with background colors + bold text for visibility (3-6 days yellow, 7+ red); added revenue total at bottom of Reactivated Customers section. (3) **Final Cleanup** — Fixed "Unshipped Line Revenue" calculation to show only proportional value for unshipped quantity; removed redundant "Late Shipments" section; removed redundant ISE alert text above chart; attempted collapsible section for Top 5 Late Lines but removed due to email client JavaScript/HTML5 limitations (made always visible instead). **Production Send:** Successfully emailed to Josh Pucci and Melissa Bojar with subject "VP Daily Brief - Sales Pulse (Friday, June 19, 2026) - Final Friday version - (READ THIS ONE)". **Status:** Production-ready, all refinements complete. **Files:** `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`, `queries/vp-daily-queries-v2.sql`, `send-vp-brief-josh-melissa-final.js`.

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
