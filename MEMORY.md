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

- **2026-08-14 (RFQ 1141182 Market Availability Analysis - Complete)**: **Completed market availability analysis with tier-based supply position classification.** (1) **Final output** — `rfq-1141182-market-availability.xlsx` sent to jake.harris@astutegroup.com (v2). Script: `build-market-analysis-final.js`. (2) **Results** — 2,113 clean parts after filtering 13 garbled MPNs. T1-ONLY SOURCE: 589, T2-MARKET CONTROL: 220, T3-BROKER COMP: 611, T4-FRANCHISE: 693, EOL-OBSOLETE: 1. (3) **Garbled MPN filter** — Added `isGarbled()` function to detect concatenated MPNs (>25 chars without hyphens, contains descriptive words, multiple MPN prefixes). Filtered examples: `CRCW0805680RFKEARC0805FR07680RL`, `WR12X43R0FTLRC1206FR0743RL`. (4) **User feedback incorporated** — Market availability is primary driver (not demand). Demand signals (OEM RFQs, US/EMEA Broker, China) as context columns only. A0765928 is valid (Nortel legacy product). (5) **Top T1** — A0765928 (212K), CRCW0402HP100100K1 (130K), MCP79412TSN (119K). **Top T2** — MC6A702T2BK100 (100%, 300K), LD39100PURY (100%, 114K). (6) **Handoff** — See `tasks/rfq-1141182-market-analysis-handoff.md`. Awaiting Jake's feedback.

- **2026-08-13 (RFQ 1141182 NC Profiler VQ Loading + BP Resolution Improvements)**: **Loaded 40,916 broker availability VQs and improved BP resolution to 91% coverage.** (1) **NC profiler load** — Loaded scrape results from `Results_2026-08-10_153907.xlsx` (39,792 scraped rows → 39,625 unique VQs after dedup). Split into known vendors (26,281 VQs with BP) and unknown vendors (13,344 VQs with null BP, vendor name in notes). (2) **BP resolution patching** — Fixed `_normalizeBPName` in `api-client.js` to strip corporate suffixes (Inc, LLC, Ltd, S.L., S.r.l., GmbH, Corp, etc.). Added `normStartReverse` check for bidirectional prefix matching. Fixed `normalizeKey` in `vendor-aliases.js` to normalize curly apostrophes (U+2019) to straight. (3) **Vendor aliases added** — 20+ entries: Cyclops Group (UK/BE), GC Components, Timeless Electronix, SIE Connect-GreenChips, Elecdif Int'l, CVC Components, TCX Micro, FCC, PHD Electronics, ABC Electronics, etc. (4) **Results** — BP coverage: 67.4% → 91.0%. VQs patched: 9,673. Remaining null-BP: 3,671 (331 vendors with parentheses causing API 500 or not in OT). (5) **Documentation** — Updated `data-model.md` with null BP handling pattern (C_BPartner_ID nullable, vendor name in Chuboe_Note_User). Fixed `availability-vq-loader.js` to use null BP instead of placeholder. (6) **Key insight** — VQ loader workflow uses robust `resolveBP` from `api-client.js`; profiling scripts should use the same, not weaker alternatives.

- **2026-08-05 (Excess Inspection File Buildout Automation)**: **Built email-triggered workflow for processing excess inspection files.** (1) **Workflow handler** — Created `shared/workflow-actions/excess-inspection.js` with actions: `process`, `need_info`, `needs_review`, `skip`. Inbox: `bizops@orangetsunami.com`. (2) **Core processor** — Created `Business Ops/tsk-excess-file-buildout/excess-processor.js` with: PDF/xlsx parsing via pdfjs-dist, PO number auto-detection (subject/filename/body/sheet content), partner/site auto-detection from PDF text (GE Aviation, Grand Rapids, etc.), MFR code resolution via pattern matching (no DB lookups for speed), product code classification (PA/SC/CO/EM/LED/BTP), internal P/N detection (GE numeric formats get BTP + M99999). (3) **CLI usage** — `node "Business Ops/tsk-excess-file-buildout/excess-processor.js" --file /path/to/file.pdf`. (4) **Testing** — Processed POV0060812 (704 lines, GE Aviation/Grand Rapids) and POV0069128 (187 lines). Output files in `~/workspace/excess-inspection-output/`. (5) **Registry entry** — Added `excess-inspection` to `shared/workflow-registry.js` (cron: null — manual invocation only). (6) **DB lookups disabled** — MFR and description lookups via psql disabled for performance; uses pattern matching only. Can re-enable with caching later if needed. **Commit:** `89b08da`.

- **2026-08-05 (Business Ops Folder Reorganization + Cron Fixes)**: **Reorganized Business Ops workflows and fixed broken cron jobs.** (1) **Folder structure** — Created `Business Ops/` folder with subfolders: `tsk-currency-conversion-upload/`, `tsk-new-mfr-screening/`, `tsk-tariff-tracker-extraction/`, `cron-reports/cron-daily/`, `cron-reports/cron-monthly/`. (2) **Files moved** — Moved both `tsk-*` folders from repo root into `Business Ops/`. Moved tariff-tracker files from `Justin's WIP/` into new `tsk-tariff-tracker-extraction/`. Moved `rfq-creation-daily-digest.md` to `cron-reports/cron-daily/`, `bos-metrics-automation.md` to `cron-reports/cron-monthly/`. (3) **Duplicates removed** — Deleted `currency-conversion-upload.md` and `ot-new-mfr-check.md` from `Justin's WIP/` (superseded by docs in tsk folders). (4) **cron-jobs.js fixes** — Updated paths for moved tsk folders. Added `owner: 'justin.oberhofer'` to `rfq-creation-digest` (was missing, caused job to drop from crontab on reinstall). Fixed `bos-metrics-report`: changed `cadence: 'monthly'` to `cadence: 'fixed'` (runner didn't support 'monthly'). (5) **Manual catch-up** — Ran `rfq-creation-digest` (104 RFQs, 351 lines, 427 MPNs for Aug 5). Ran `bos-metrics-report` (July 2026 report sent to justin@ and leah.griffin@). (6) **Crontab verified** — 3 jobs installed for justin.oberhofer: `rfq-creation-digest` (Mon-Fri 12:00 UTC), `bos-metrics-report` (1st of month 17:00 UTC), `currency-conversion-poller` (every 30m at :10/:40). **Commits:** `58b6e94` (folder reorg), `9968dc4` (cron path fixes + rfq-creation owner), `ae82f2c` (bos-metrics cadence fix).

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
