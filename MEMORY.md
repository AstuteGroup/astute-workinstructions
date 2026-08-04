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

- **2026-08-04 (Currency Conversion Upload Workflow)**: **Built end-to-end currency conversion workflow with OT writeback.** (1) **Two-step workflow** — Email with Exchange Rate Matrix xlsx arrives at `bizops@orangetsunami.com` → Poller extracts and processes → Replies with CSV for review → User replies "add" → Rates pushed to `C_Conversion_Rate` table → Confirmation email sent. (2) **Files created** — `tsk-currency-conversion-upload/`: `currency-processor.js` (xlsx→CSV, 21 currency pairs), `currency-poller.py` (email poller + reply handler), `currency-conversion-upload.md` (workflow docs), `HANDOFF-analytics-user.md` (CLI install instructions). `shared/currency-rate-writer.js` (POSTs to C_Conversion_Rate). `scripts/add-currency-rates-to-cli.js` (CLI installer). (3) **Cron job** — `currency-conversion-poller` (every 30m at :10/:40, owner: justin.oberhofer). (4) **Target currencies** — EUR, USD, GBP, CAD, INR, JPY, SGD (21 unique pairs). (5) **Date convention** — 4th of month to 3rd of next month (e.g., Aug 4 → Sep 3). (6) **Pending handoff** — analytics_user needs to run `scripts/add-currency-rates-to-cli.js --apply` to add `currency-rates` subcommand to `/opt/writeback/cli.js`. Email sent to tyler.dennis@plantos.co. (7) **August 2026 rates** — Loaded manually by user; workflow ready for September onwards. **Files committed:** `tsk-currency-conversion-upload/` (4 files), `shared/currency-rate-writer.js`, `shared/writeback-proxy-client.js` (added writeCurrencyRates), `scripts/add-currency-rates-to-cli.js`, `cron-jobs.js` (1 new entry). **Status:** Deployed and running on cron. Awaiting CLI update for full "add" reply flow.

- **2026-08-04 (New Manufacturer Screening Workflow)**: **Built and deployed automated MFR screening workflow.** (1) **Workflow** — Scrapes `bizops@orangetsunami.com` inbox for "New MFR Request" emails, extracts MFR name + URL, runs fuzzy matching against OT database, verifies website is manufacturer (not distributor) via Playwright, emails results to reviewer (justin.oberhofer@astutegroup.com), processes add/skip replies to create MFRs in OT. (2) **Files created** — `tsk-new-mfr-screening/`: `mfr-reply-handler.py` (inbox scraper + reply handler), `mfr-batch-check.py` (fuzzy matching + email results), `mfr-fuzzy-check.js` (Playwright website verification), `fuzzy_mfr_match.js` (OT database lookup), `new-mfr-screening.md` (workflow documentation), `HANDOFF.md` (CLI update instructions for analytics_user). (3) **Cron jobs added** — `mfr-screening-requests` (every 30m at :00/:30 — scrape and check), `mfr-screening-replies` (every 30m at :15/:45 — process decisions). (4) **Email flow** — Request email to bizops@ → agent runs checks → results email to reviewer → reviewer replies add/skip → agent processes reply → M-code request email (until CLI is updated for direct write). (5) **Pending handoff** — analytics_user needs to add `mfr` and `mfr-alias` subcommands to `/opt/writeback/cli.js` per `HANDOFF.md`. Until then, "add" action emails M-code request instead of writing to OT. **Files committed:** 13 files to `astute-workinstructions/tsk-new-mfr-screening/`, `cron-jobs.js` (2 new entries). **Status:** Deployed and running on cron.

- **2026-07-30 (Inventory Decoupling Audit — Email Routing + Consumer Updates)**: **Fixed email routing issue and updated all downstream consumers to use inventory cache.** (1) **Root cause identified** — Offer-poller on `excess@` was routing inventory emails (`Task finished: [success] * AST Item Lots Report`) to `NotOffer` BEFORE `inventory-fetch-and-parse.js` could grab them. Evidence: 6 inventory emails (June 8, 22, 29; July 6, 20, 27) all in `NotOffer` folder. (2) **Routing fix** — Added "Step 0" to `customer-excess-analysis.md` and `agent-prompt.txt` to SKIP inventory emails entirely (leave unseen in INBOX for other workflow). Added Step 1b to `inventory-fetch-and-parse.js` to recover misrouted emails from `NotOffer`. (3) **Consumer updates** — Multiple files still referenced old `/tmp/Inventory YYYY-MM-DD/` folder paths instead of the cache. Updated: `shared/workflow-actions/lam-kitting.js`, `shared/lam-status-lookup.js`, `shared/lam-delivery-alerts.js`, `Trading Analysis/Request to Ship/rts-lookup.js`. All now use `loadCachedInventory()` with CSV fallback. (4) **Email reporting improved** — `lam-kitting-runner.js` now shows `Inventory source: cache (week of 2026-07-27, 0 days old)` instead of wrong folder path. (5) **Carryover Reconciler DEFERRED** — The `reconcileCarryover()` function (compares static carryovers against Infor to retire arrived parts) was part of deprecated `inventory_cleanup.js` and was NOT extracted. Added clear entry to `deferred-work.md` with full context and reference code locations. **Files modified:** `customer-excess-analysis.md` (skip inventory emails), `agent-prompt.txt` (skip instruction), `inventory-fetch-and-parse.js` (recover from NotOffer), `lam-kitting-runner.js` (cache date in email), `lam-kitting.js` (use cache), `lam-status-lookup.js` (use cache), `lam-delivery-alerts.js` (use cache), `rts-lookup.js` (use cache), `deferred-work.md` (carryover reconciler entry).

- **2026-07-29 (HANDOFF — Inventory Decoupling Not Working)**: **PRIORITY 1 for next session.** The decoupled inventory architecture built 2026-07-27 is not functioning correctly. (1) **Symptom** — LAM reorder report used stale June 15 inventory data instead of July 27 (Monday) data. Part 5-104363-2 appeared on reorder when it should be in stock. (2) **Email misrouted** — Task 4956804 (July 27 Monday inventory email) was found in `NotOffer` folder on `excess@` mailbox. User says it should be in `Inventory Processed` folder, unread. Either the folder names are confused or something is routing incorrectly. (3) **Offer-poller conflict?** — The offer-poller on `excess@` may be processing inventory emails before `inventory-fetch-and-parse.js` can get them. Need to verify if inventory emails should be excluded from offer-poller. (4) **Folder confusion** — There are two folders: `Inventory Processed` (space) and `Inventory-Processed` (hyphen). The July 27 email was in neither — it was in `NotOffer`. (5) **Cache manually fixed this session** — Downloaded attachment from NotOffer, saved to `~/.inventory-storage/inventory_2026-07-27.xlsx`, re-parsed. Cache now has correct July 27 data (6,089 rows, W111=272 rows). But this was a patch, not a fix. (6) **NEXT SESSION MUST** — Audit the decoupled workflow end-to-end: verify cron timing, email routing exclusions, folder destinations, and ensure `inventory-fetch-and-parse.js` runs BEFORE offer-poller touches inventory emails. Read 2026-07-27 session entry below for the full architecture. **Key files:** `shared/inventory-fetch-and-parse.js` (foundational), `shared/offer-poller.js` (may need exclusion), `shared/junk-classifier.js` (may be catching inventory emails), `cron-jobs.js` (timing), `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` (architecture doc).

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
