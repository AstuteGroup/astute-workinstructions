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

- **2026-06-22 (VP Daily Brief V2 - Final Polish & Production Launch)**: **Completed final refinements to VP Daily Brief and sent first production version to Josh Pucci with Friday's data.** Made three rounds of updates per user feedback: (1) **Regional & Structural Changes** — Added APAC-Lavanya region for India team (Lavanya Manohar, Manikandan, Meenakshi) instead of "Other"; reordered Reactivated Customers columns (SO Date, Seller, Region, Customer, Location, BP ID, SO#s, Revenue, Gap, Last Order, Previous Rep); added MPNs to High Value and Top 5 Late sections. (2) **Visual Polish** — Color-coded Strategic Accounts activity in dark green (#1b5e20) for wins; enhanced ISE Alert color coding with background colors + bold text for visibility (3-6 days yellow, 7+ red); added revenue total at bottom of Reactivated Customers section. (3) **Final Cleanup** — Fixed "Unshipped Line Revenue" calculation to show only proportional value for unshipped quantity; removed redundant "Late Shipments" section; removed redundant ISE alert text above chart; attempted collapsible section for Top 5 Late Lines but removed due to email client JavaScript/HTML5 limitations (made always visible instead). **Production Send:** Successfully emailed to Josh Pucci and Melissa Bojar with subject "VP Daily Brief - Sales Pulse (Friday, June 19, 2026) - Final Friday version - (READ THIS ONE)". **Status:** Production-ready, all refinements complete. **Files:** `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`, `queries/vp-daily-queries-v2.sql`, `send-vp-brief-josh-melissa-final.js`.

- **2026-06-21 (Inventory Cleanup Burst Limit Fix)**: **Diagnosed and fixed runaway inventory cleanup creating 407 partial offers over 70 hourly retries.** Root cause: Burst limit (600/5min) was aborting chunked writes mid-way instead of waiting for the burst window to clear. Each hourly retry created NEW offer headers with only ~150 lines each. **Investigation:** Found sentinel stuck at June 15 `nextDue`, with 70 failures and API budget exhausted every hour. LAM Kitting showed same pattern (4 failures before success). **Fix applied:** Changed `offer-writeback.js` chunked mode to WAIT for burst window to clear (poll every 30s, max 30 min total) instead of returning `partialWrite: true` immediately. Large batch jobs (~5000 lines) will now complete over ~45 minutes by waiting through multiple burst windows. **Cleanup:** Deactivated 407 partial offers from June 15-21, reactivated June 1 complete set (11 warehouses, 4,991 lines), paused job until Monday validation. **Files:** `shared/offer-writeback.js` (lines 385-451). **Status:** Fix applied, validation scheduled for Monday 2026-06-22. Priority reminder added to `deferred-work.md`.

- **2026-06-19 (VP Daily Brief - Business Day Logic Fix)**: **Fixed VP Daily Brief to use previous business day instead of literal yesterday — Monday reports now show Friday's data, not Sunday's.** Problem: SQL queries correctly used business day logic (3 days back on Monday), but JavaScript code generating the report header and email subject used literal "yesterday" (1 day back). On Monday, this showed Sunday's date even though the data was from Friday. **Solution:** (1) **Updated `sales-pulse-vp-daily-v2.js`** — Added business day calculation to `collectData()` function: if Monday (day 1), go back 3 days to Friday; else go back 1 day. (2) **Updated `email-vp-daily-brief.js`** — Added same business day logic for email subject line to match report content. (3) **Updated workflow documentation** — Added "Business Day Logic" section to `docs/vp-daily-brief-workflow.md` explaining the Monday → Friday (3 days) vs other days → yesterday (1 day) logic with code examples. Updated script names to V2, fixed cron schedule, added changelog. **Testing:** Verified Thursday shows Wednesday (correct), simulated Monday showing Friday (correct). **Status:** Fix complete and documented. Ready for git commit when push access available. **Files:** `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`, `email-vp-daily-brief.js`, `docs/vp-daily-brief-workflow.md`.

- **2026-06-19 (Market Pulse Weekly - CSV Implementation & KLA Filtering)**: **Completed CSV implementation for Performance Snapshot with proper KLA outlier filtering.** Problem: Script was trying to use XLSX.readFile on "Invoiced Sales 2026 by Line - 6.19.26.csv" which would fail. Billings needed line-item detail (with customer names) to filter out KLA customer. **Solution:** (1) **CSV parsing with quote handling** — implemented proper CSV parsing for quoted fields containing commas (like check-invoiced-sales-kla.js pattern). (2) **Currency parsing** — added .replace(/[$,]/g, '') for Invoice Revenue/GP fields formatted as "$307200.00". (3) **KLA filtering** — filters "KLA - Tencor ( Singapore ) Pte. Ltd" customer when excludeKLA=true. (4) **Salesperson mapping** — uses Internal Salesperson field with SALES_TEAM_MAP for consistency with bookings. (5) **Distinct counting** — tracks unique CO Numbers and Customer Names using Sets (CSV has line items, not pre-aggregated counts). **Results verified:** Core Business (Ex-KLA) shows healthy 1.49x B/B ratio ($2.74M bookings / $1.84M billings), Total Business 0.47x ratio due to $4.02M KLA shipment (13 line items, all APAC-Laurel). Three-section layout working correctly: green Core Business box, Regional Breakdown with "* APAC includes KLA: $0 bookings / $4.0M billings" footnote, yellow Total Business box with KLA note. **Files:** `Sales Pulse Daily/scripts/market-pulse-weekly-v2.js`, `output/market-pulse-weekly-2026-06-19.html`. **Status:** Production-ready for weekly/monthly distribution.
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
