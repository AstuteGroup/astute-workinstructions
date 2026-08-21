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

- **2026-08-21 (CLAUDE.md Context Optimization + Handoff Skill)**: **Built the `handoff` skill and cut auto-loaded session context.** (1) **Skill** — `.claude/skills/handoff/SKILL.md` (local to Justin's workspace, not this repo) writes a token-budgeted briefing to `~/workspace/handoffs/` so a fresh session resumes mid-task without re-deriving. Skills register at session start only. (2) **W111 correctness fix** — Justin's local CLAUDE.md warehouse list was wrong: claimed 14 groups (actual 12), invented `MAIN`/`W105`, and omitted that **W111/LAM_3PL is `OT Write: No`, internal-only**. Corrected against `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`. (3) **Duplication removed** — Quick Quote and Inventory File Cleanup sections collapsed to source-of-truth pointers per CLAUDE.md's own "point, don't duplicate" rule; the duplication is what let W111 drift. (4) **Greeting rebuilt** — leads with the 8 Business Ops workflows, Trading Analysis compressed to a path index, open handoffs surfaced first. (5) **Path checker** — `~/workspace/scripts/check-workflow-paths.js` validates every backtick path in CLAUDE.md; caught 3 dead links the prose had masked (`saved-queries/` prefix missing; `Market Offer Analysis/` and `LAM Kitting Reorder/` don't exist). Now 31 OK / 2 unverified / 0 broken. (6) **Result** — CLAUDE.md 27,994 → 23,247 bytes (~7,000 → ~5,812 tokens). **Open for Jake:** was `Market Offer Analysis` renamed to `Market Offer Loading`? For LAM Kitting Reorder, is the entry point `LAM 3PL/lam-kitting-spec.md` or `lam-kitting-agent.md`? Handoff: `~/workspace/handoffs/2026-08-21-claude-md-context-optimization.md`.

- **2026-08-17 (Brownsville Inspection Validation Daily Report)**: **Created daily cron report for W111 inspection validations.** (1) **Script** — `Business Ops/tsk-validated-inspections/brownsville-inspection-report.js` queries `chuboe_insp_mpnlotqueue_v` for validated inspections at Brownsville (W111, warehouse ID 1000015). (2) **Inspection form data** — Pulls MPN Received, MFR Received, Qty Received from inspection form attributes via `chuboe_insprecordasimap` → `m_attributeinstance` join (not VQ line). (3) **Columns** — OTIN, POV#, Line, MPN Received, MFR Received, Qty Received, Inspector, Validated At. (4) **Email** — HTML with summary (total validations/qty/inspectors), by-inspector breakdown, and detail listing. Sends to justin.oberhofer@astutegroup.com. (5) **Cron schedule** — Mon-Fri 8am ET (12:00 UTC), weekend gate built-in. (6) **Documentation** — `Business Ops/tsk-validated-inspections/brownsville-inspection-validation-daily.md`. **Commit:** `211dfa8`.

- **2026-08-14 (Tariff Tracker Extraction Run)**: **Processed bizops@ inbox for tariff-tracker workflow.** (1) **Skipped 3 emails** — uid 58/59 were Astute Purchase Order PDFs (POV0060812, POV0069128), not customs invoices; uid 71 was a bounce with no attachments. (2) **Processed uid 88** ("Fw: Freight over $500", 12 PDFs) — extracted 34 shipment rows across 10 FedEx customs invoices + 2 transportation-only invoices. Found one merge case (customs entry 1FX11591220 + oversized transportation charge $1,807.65, same tracking, combined to $8,170.92) and one standalone oversized-only row (Aerolux Ltd, $3,326.83, no matching customs invoice in batch). (3) **OT lookups** — 3 direct POV, 2 direct COV, 11 resolved via tracking-number search against `c_orderline.chuboe_trackingnumbers`; 14 tracking searches failed (mostly inbound/vendor-to-Astute shipments with no tracking recorded on the PO) and were flagged `[REVIEW: ...]` in SOURCE per the doc's rules — 17 rows flagged total. (4) **Output** — built `tariff_tracker_claude_2026-08-14.xlsx` via a data-specific builder script (`Business Ops/tsk-tariff-tracker-extraction/tariff-tracker-builder-2026-08-14.js`, following the pattern of the existing example script, not a generic runner) and routed uid 88 as `process`, emailing the tracker to justin.oberhofer@astutegroup.com.

- **2026-08-14 (Weekly Project Report)**: **Created weekly project report cron job.** (1) **Script** — `Business Ops/cron-reports/cron-weekly/weekly-project-report.js` generates weekly summary of git commits grouped by project. (2) **Features** — Filters by author (Justin Oberhofer only), groups commits by project with folder locations (e.g., `Business Ops/tsk-inspection-queue-maintenance/`), extracts key highlights (deduplicated, max 6 per project), bold formatting with colored separators. (3) **Email delivery** — Uses inline HTML (no attachment — .html attachments blocked by email security). Sends via nodemailer directly to bypass notifier attachment handling. (4) **Cron schedule** — Mondays 9am CT (14:00 UTC), sentinel-gated weekly cadence. (5) **Documentation** — `weekly-project-report-task.md` conforms to `Business Ops/WORK_INSTRUCTIONS.md` (purpose statement, tags, DRY). (6) **Manual usage** — `node "Business Ops/cron-reports/cron-weekly/weekly-project-report.js"` (console) or `--send` (email). **Commit:** `0e5bea4`.

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
