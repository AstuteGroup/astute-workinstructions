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

- **2026-08-05 (Excess Inspection File Buildout Automation)**: **Built email-triggered workflow for processing excess inspection files.** (1) **Workflow handler** — Created `shared/workflow-actions/excess-inspection.js` with actions: `process`, `need_info`, `needs_review`, `skip`. Inbox: `bizops@orangetsunami.com`. (2) **Core processor** — Created `Business Ops/tsk-excess-file-buildout/excess-processor.js` with: PDF/xlsx parsing via pdfjs-dist, PO number auto-detection (subject/filename/body/sheet content), partner/site auto-detection from PDF text (GE Aviation, Grand Rapids, etc.), MFR code resolution via pattern matching (no DB lookups for speed), product code classification (PA/SC/CO/EM/LED/BTP), internal P/N detection (GE numeric formats get BTP + M99999). (3) **CLI usage** — `node "Business Ops/tsk-excess-file-buildout/excess-processor.js" --file /path/to/file.pdf`. (4) **Testing** — Processed POV0060812 (704 lines, GE Aviation/Grand Rapids) and POV0069128 (187 lines). Output files in `~/workspace/excess-inspection-output/`. (5) **Registry entry** — Added `excess-inspection` to `shared/workflow-registry.js` (cron: null — manual invocation only). (6) **DB lookups disabled** — MFR and description lookups via psql disabled for performance; uses pattern matching only. Can re-enable with caching later if needed. **Commit:** `89b08da`.

- **2026-08-05 (Business Ops Folder Reorganization + Cron Fixes)**: **Reorganized Business Ops workflows and fixed broken cron jobs.** (1) **Folder structure** — Created `Business Ops/` folder with subfolders: `tsk-currency-conversion-upload/`, `tsk-new-mfr-screening/`, `tsk-tariff-tracker-extraction/`, `cron-reports/cron-daily/`, `cron-reports/cron-monthly/`. (2) **Files moved** — Moved both `tsk-*` folders from repo root into `Business Ops/`. Moved tariff-tracker files from `Justin's WIP/` into new `tsk-tariff-tracker-extraction/`. Moved `rfq-creation-daily-digest.md` to `cron-reports/cron-daily/`, `bos-metrics-automation.md` to `cron-reports/cron-monthly/`. (3) **Duplicates removed** — Deleted `currency-conversion-upload.md` and `ot-new-mfr-check.md` from `Justin's WIP/` (superseded by docs in tsk folders). (4) **cron-jobs.js fixes** — Updated paths for moved tsk folders. Added `owner: 'justin.oberhofer'` to `rfq-creation-digest` (was missing, caused job to drop from crontab on reinstall). Fixed `bos-metrics-report`: changed `cadence: 'monthly'` to `cadence: 'fixed'` (runner didn't support 'monthly'). (5) **Manual catch-up** — Ran `rfq-creation-digest` (104 RFQs, 351 lines, 427 MPNs for Aug 5). Ran `bos-metrics-report` (July 2026 report sent to justin@ and leah.griffin@). (6) **Crontab verified** — 3 jobs installed for justin.oberhofer: `rfq-creation-digest` (Mon-Fri 12:00 UTC), `bos-metrics-report` (1st of month 17:00 UTC), `currency-conversion-poller` (every 30m at :10/:40). **Commits:** `58b6e94` (folder reorg), `9968dc4` (cron path fixes + rfq-creation owner), `ae82f2c` (bos-metrics cadence fix).

- **2026-08-04 (Currency Conversion Upload Workflow)**: **Built end-to-end currency conversion workflow with OT writeback.** (1) **Two-step workflow** — Email with Exchange Rate Matrix xlsx arrives at `bizops@orangetsunami.com` → Poller extracts and processes → Replies with CSV for review → User replies "add" → Rates pushed to `C_Conversion_Rate` table → Confirmation email sent. (2) **Files created** — `Business Ops/tsk-currency-conversion-upload/`: `currency-processor.js` (xlsx→CSV, 21 currency pairs), `currency-poller.py` (email poller + reply handler), `currency-conversion-upload.md` (workflow docs), `HANDOFF-analytics-user.md` (CLI install instructions). `shared/currency-rate-writer.js` (POSTs to C_Conversion_Rate). `scripts/add-currency-rates-to-cli.js` (CLI installer). (3) **Cron job** — `currency-conversion-poller` (every 30m at :10/:40, owner: justin.oberhofer). (4) **Target currencies** — EUR, USD, GBP, CAD, INR, JPY, SGD (21 unique pairs). (5) **Date convention** — 4th of month to 3rd of next month (e.g., Aug 4 → Sep 3). (6) **Pending handoff** — analytics_user needs to run `scripts/add-currency-rates-to-cli.js --apply` to add `currency-rates` subcommand to `/opt/writeback/cli.js`. Email sent to tyler.dennis@plantos.co. (7) **August 2026 rates** — Loaded manually by user; workflow ready for September onwards. **Status:** Deployed and running on cron. Awaiting CLI update for full "add" reply flow.

- **2026-08-04 (New Manufacturer Screening Workflow)**: **Built and deployed automated MFR screening workflow.** (1) **Workflow** — Scrapes `bizops@orangetsunami.com` inbox for "New MFR Request" emails, extracts MFR name + URL, runs fuzzy matching against OT database, verifies website is manufacturer (not distributor) via Playwright, emails results to reviewer (justin.oberhofer@astutegroup.com), processes add/skip replies to create MFRs in OT. (2) **Files created** — `Business Ops/tsk-new-mfr-screening/`: `mfr-reply-handler.py` (inbox scraper + reply handler), `mfr-batch-check.py` (fuzzy matching + email results), `mfr-fuzzy-check.js` (Playwright website verification), `fuzzy_mfr_match.js` (OT database lookup), `new-mfr-screening.md` (workflow documentation), `HANDOFF.md` (CLI update instructions for analytics_user). (3) **Cron jobs added** — `mfr-screening-requests` (every 30m at :00/:30 — scrape and check), `mfr-screening-replies` (every 30m at :15/:45 — process decisions). (4) **Email flow** — Request email to bizops@ → agent runs checks → results email to reviewer → reviewer replies add/skip → agent processes reply → M-code request email (until CLI is updated for direct write). (5) **Pending handoff** — analytics_user needs to add `mfr` and `mfr-alias` subcommands to `/opt/writeback/cli.js` per `HANDOFF.md`. Until then, "add" action emails M-code request instead of writing to OT. **Status:** Deployed and running on cron.

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
