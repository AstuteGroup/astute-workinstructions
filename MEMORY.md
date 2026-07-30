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

- **2026-07-30 (Inventory Decoupling Audit — Email Routing + Consumer Updates)**: **Fixed email routing issue and updated all downstream consumers to use inventory cache.** (1) **Root cause identified** — Offer-poller on `excess@` was routing inventory emails (`Task finished: [success] * AST Item Lots Report`) to `NotOffer` BEFORE `inventory-fetch-and-parse.js` could grab them. Evidence: 6 inventory emails (June 8, 22, 29; July 6, 20, 27) all in `NotOffer` folder. (2) **Routing fix** — Added "Step 0" to `customer-excess-analysis.md` and `agent-prompt.txt` to SKIP inventory emails entirely (leave unseen in INBOX for other workflow). Added Step 1b to `inventory-fetch-and-parse.js` to recover misrouted emails from `NotOffer`. (3) **Consumer updates** — Multiple files still referenced old `/tmp/Inventory YYYY-MM-DD/` folder paths instead of the cache. Updated: `shared/workflow-actions/lam-kitting.js`, `shared/lam-status-lookup.js`, `shared/lam-delivery-alerts.js`, `Trading Analysis/Request to Ship/rts-lookup.js`. All now use `loadCachedInventory()` with CSV fallback. (4) **Email reporting improved** — `lam-kitting-runner.js` now shows `Inventory source: cache (week of 2026-07-27, 0 days old)` instead of wrong folder path. (5) **Carryover Reconciler DEFERRED** — The `reconcileCarryover()` function (compares static carryovers against Infor to retire arrived parts) was part of deprecated `inventory_cleanup.js` and was NOT extracted. Added clear entry to `deferred-work.md` with full context and reference code locations. **Files modified:** `customer-excess-analysis.md` (skip inventory emails), `agent-prompt.txt` (skip instruction), `inventory-fetch-and-parse.js` (recover from NotOffer), `lam-kitting-runner.js` (cache date in email), `lam-kitting.js` (use cache), `lam-status-lookup.js` (use cache), `lam-delivery-alerts.js` (use cache), `rts-lookup.js` (use cache), `deferred-work.md` (carryover reconciler entry).

- **2026-07-29 (HANDOFF — Inventory Decoupling Not Working)**: **PRIORITY 1 for next session.** The decoupled inventory architecture built 2026-07-27 is not functioning correctly. (1) **Symptom** — LAM reorder report used stale June 15 inventory data instead of July 27 (Monday) data. Part 5-104363-2 appeared on reorder when it should be in stock. (2) **Email misrouted** — Task 4956804 (July 27 Monday inventory email) was found in `NotOffer` folder on `excess@` mailbox. User says it should be in `Inventory Processed` folder, unread. Either the folder names are confused or something is routing incorrectly. (3) **Offer-poller conflict?** — The offer-poller on `excess@` may be processing inventory emails before `inventory-fetch-and-parse.js` can get them. Need to verify if inventory emails should be excluded from offer-poller. (4) **Folder confusion** — There are two folders: `Inventory Processed` (space) and `Inventory-Processed` (hyphen). The July 27 email was in neither — it was in `NotOffer`. (5) **Cache manually fixed this session** — Downloaded attachment from NotOffer, saved to `~/.inventory-storage/inventory_2026-07-27.xlsx`, re-parsed. Cache now has correct July 27 data (6,089 rows, W111=272 rows). But this was a patch, not a fix. (6) **NEXT SESSION MUST** — Audit the decoupled workflow end-to-end: verify cron timing, email routing exclusions, folder destinations, and ensure `inventory-fetch-and-parse.js` runs BEFORE offer-poller touches inventory emails. Read 2026-07-27 session entry below for the full architecture. **Key files:** `shared/inventory-fetch-and-parse.js` (foundational), `shared/offer-poller.js` (may need exclusion), `shared/junk-classifier.js` (may be catching inventory emails), `cron-jobs.js` (timing), `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` (architecture doc).

- **2026-07-27 (Inventory Cleanup Decoupled Cache-Based Architecture)**: **Refactored monolithic inventory_cleanup.js into decoupled cache-based architecture.** (1) **New architecture** — Single foundational job (`inventory-fetch-and-parse.js`) fetches Infor xlsx from email, parses ALL warehouses, caches to `~/.inventory-storage/parsed_YYYY-MM-DD.json`. Subordinate workflows pull only what they need: `lam-inventory.js` (W111, W115, W118), `free-stock-inventory.js` (W102, W104, W108, W109, W112, W113, W114), `consignment-inventory.js` (W103, W106, W107, W117). (2) **Key principle** — Parser is "dumb" (caches everything), workflows are "smart consumers" (each pulls only its warehouses). (3) **Cache format** — `{ metadata: {...}, byWarehouse: { 'W102': [{mpn, mfr, qty, dateCode, lot, location}, ...], ... }}`. Consumer functions: `loadCachedInventory({ allowStale: true })`, `getCacheStatus()`. (4) **Cron schedule (Mondays)** — 10:00 UTC: fetch-and-parse; 11:15 UTC: lam-inventory; 11:30 UTC: free-stock-inventory; 11:45 UTC: consignment-inventory. (5) **LAM wrong warehouse check** — Updated `lam-wrong-warehouse-check.js` to use cache as default, scans ALL 18 warehouses to find LAM roster parts in wrong locations. Integrated as Step 4 in `lam-inventory.js`. (6) **LAM scripts updated** — `lam-kitting-runner.js` and `lam-kitting-reorder.js` now use cache as default inventory source, removed fallback to deprecated inventory_cleanup.js. (7) **nc-listing.js updated** — NetComponents portal CSV generation now uses cache instead of parsing xlsx directly. (8) **Documentation updated** — Rewrote `inventory-file-cleanup.md`, updated `crontab.md` Active jobs table, marked deferred-work.md validation item as resolved. **Files created:** `shared/inventory-fetch-and-parse.js` (foundational parser + cache), `shared/inventory-parser.js` (pure xlsx parser), `workflows/lam-inventory.js`, `workflows/free-stock-inventory.js`, `workflows/consignment-inventory.js`. **Files modified:** `cron-jobs.js` (4 new entries), `Trading Analysis/LAM 3PL/lam-wrong-warehouse-check.js` (cache mode), `Trading Analysis/LAM 3PL/lam-kitting-runner.js` (cache default), `Trading Analysis/LAM 3PL/lam-kitting-reorder.js` (cache default), `Trading Analysis/Inventory File Cleanup/nc-listing.js` (cache mode), `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` (full rewrite), `crontab.md`, `deferred-work.md`. **Status:** Architecture complete and crons installed. Git push pending (token expired — run `gh auth login -h github.com`).

- **2026-07-24 (LAM Reorder Accuracy Investigation — Recency Filter Fix & Inventory Parsing Discovery)**: **Investigated LAM reorder report accuracy issues, fixed POV recency filter bug, and discovered inventory-cleanup cron has been paused 46 days.** (1) **Initial issue** — User reported MPN 5-104363-2 showed "Last Promise Date" of 04/13/26 but no "Open PO" or "On Order Qty", yet POV0075572 existed in OT. (2) **Root cause: recency filter too aggressive** — The `loadRecentPOVs()` SQL in `lam-kitting-reorder.js` filtered out POs when: created >90 days ago AND promise date passed. POV0075572 (created April 13, promise April 13) failed both tests as of July 24 (102 days old). (3) **Fix applied** — Two changes: (a) POV-stamped orders (`chuboe_po_string LIKE 'POV%'`) now ALWAYS show regardless of age — a POV stamp means committed vendor order. (b) Extended recency window from 90 to 120 days for non-stamped activity. Updated both PO and VQ_TICKED branches. (4) **Stuck order found** — POV0075573 / PO809636 (MPN 503398-1892, 100 pcs from Waldom) was 100+ days past promise with no tracking. Created R_Request 1169280 to request cancellation. (5) **Added `postGeneralRequest()`** — Extended `shared/r-request-writer.js` with function for non-approval requests (cancellations, queries, general messages). (6) **S25FL512SAGBHIA10 discrepancy** — User said this MPN should have dropped off report because it's in W115 (bin LAMTY2.9, 100 pcs). Investigation showed all inventory files (xlsx and parsed CSVs) had it in MAIN, not W115. (7) **CRITICAL DISCOVERY: inventory-cleanup PAUSED 46 days** — The `inventory-cleanup` cron has been paused since June 21 due to "partial writes (1038/4988)" in OT API offer step. Sentinel shows nextDue: 2099 (disabled). The xlsx files arrive weekly, but parsing into per-warehouse CSVs blocked because OT writes failed. (8) **Added inventory traceability** — Updated `lam-kitting-runner.js` to include full inventory folder path + W111/W115 file timestamps in email body. (9) **Architecture issue identified** — Current inventory_cleanup.js bundles parsing (critical) with OT offer writes (secondary). When writes fail, parsing is blocked, starving LAM reorder of fresh data. **Next session:** Restructure into `inventory-parse` (standalone, must run weekly) and `inventory-offers` (secondary, can fail independently). **Files modified:** `Trading Analysis/LAM 3PL/lam-kitting-reorder.js` (recency filter fix: POV always shows + 120-day window), `Trading Analysis/LAM 3PL/lam-kitting-runner.js` (inventory source traceability in email), `Trading Analysis/LAM 3PL/lam-3pl.md` (updated recency filter docs), `shared/r-request-writer.js` (added postGeneralRequest function). **Status:** Recency filter fixed. Inventory parsing restructure deferred to next session.

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
