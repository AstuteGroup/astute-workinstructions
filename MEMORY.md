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

- **2026-08-14 (Weekly Project Report)**: **Created weekly project report cron job.** (1) **Script** — `Business Ops/cron-reports/cron-weekly/weekly-project-report.js` generates weekly summary of git commits grouped by project. (2) **Features** — Filters by author (Justin Oberhofer only), groups commits by project with folder locations (e.g., `Business Ops/tsk-inspection-queue-maintenance/`), extracts key highlights (deduplicated, max 6 per project), bold formatting with colored separators. (3) **Email delivery** — Uses inline HTML (no attachment — .html attachments blocked by email security). Sends via nodemailer directly to bypass notifier attachment handling. (4) **Cron schedule** — Mondays 9am CT (14:00 UTC), sentinel-gated weekly cadence. (5) **Documentation** — `weekly-project-report-task.md` conforms to `Business Ops/WORK_INSTRUCTIONS.md` (purpose statement, tags, DRY). (6) **Manual usage** — `node "Business Ops/cron-reports/cron-weekly/weekly-project-report.js"` (console) or `--send` (email). **Commit:** `0e5bea4`.

- **2026-08-10 (Inspection Queue Maintenance Enhancements)**: **Added skip list, notifications, and CLI handoff for inspection queue maintenance.** (1) **Skip list** — Added Skip List section to task doc (`Business Ops/tsk-inspection-queue-maintenance/inspection-queue-maintenance-task.md`) with three categories: test house returns (White Horse Laboratories), consignment programs (Lam/Flock), spec buys. (2) **Test house detection** — Script now queries vendor from VQ line and skips lots from test houses (BP ID 1002731 = White Horse Laboratories Ltd). (3) **Email notifications** — Added notifications to justin.oberhofer@astutegroup.com via bizops@orangetsunami.com. Sends for auto-fixes, escalations, AND skip-only runs. (4) **Cron schedule** — Changed from 8 UTC (3am CT) to 20 UTC (3pm CT). (5) **CLI handoff** — Created `scripts/add-link-alloc-so-to-cli.js` installer and `Business Ops/tsk-inspection-queue-maintenance/HANDOFF-analytics-user.md`. (6) **Notifier update** — Added `plantos.co` to allowed email domains for Tyler handoffs. **Commits:** `8980e0e`, `1cf8dec`, `2d68328`, `42e4ebd`, `aac4393`, `3424ddf`.

- **2026-08-05 (Excess Inspection File Buildout Automation)**: **Built email-triggered workflow for processing excess inspection files.** (1) **Workflow handler** — Created `shared/workflow-actions/excess-inspection.js` with actions: `process`, `need_info`, `needs_review`, `skip`. Inbox: `bizops@orangetsunami.com`. (2) **Core processor** — Created `Business Ops/tsk-excess-file-buildout/excess-processor.js` with: PDF/xlsx parsing via pdfjs-dist, PO number auto-detection, partner/site auto-detection from PDF text, MFR code resolution via pattern matching, product code classification. (3) **Registry entry** — Added `excess-inspection` to `shared/workflow-registry.js` (cron: null — manual invocation only). **Commit:** `89b08da`.

- **2026-08-05 (Business Ops Folder Reorganization + Cron Fixes)**: **Reorganized Business Ops workflows and fixed broken cron jobs.** (1) **Folder structure** — Created `Business Ops/` folder with subfolders: `tsk-currency-conversion-upload/`, `tsk-new-mfr-screening/`, `tsk-tariff-tracker-extraction/`, `cron-reports/cron-daily/`, `cron-reports/cron-monthly/`. (2) **cron-jobs.js fixes** — Updated paths for moved tsk folders. Added `owner: 'justin.oberhofer'` to `rfq-creation-digest`. Fixed `bos-metrics-report`: changed `cadence: 'monthly'` to `cadence: 'fixed'`. **Commits:** `58b6e94`, `9968dc4`, `ae82f2c`.

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
