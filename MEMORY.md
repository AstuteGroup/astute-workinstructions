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

- **2026-08-21 (Tracking Loading — backlog clearance, poller fixes, buyer-attribution fix, compliance digest)**: **Cleared most of the tracking@ NeedsReview backlog and built ongoing compliance visibility.** (1) **Root-cause dead end, corrected**: initial theory blamed SF Express tracking numbers not being recognized by `tracking-parser.js`'s static regex — disproven by breadcrumb history showing 20+ successful automated SF Express loads; the live cron agent extracts via reading, not the static parser. True cause of the 36-item NeedsReview backlog (oldest from 2026-06-10) is unprovable — `breadcrumbs.jsonl` prunes >7 days — but PO existence at the time rules out a "PO not created yet" race (POs must exist before suppliers ship against them). (2) **Resolved 17 of 36 NeedsReview emails** via the sanctioned `route ... patch_tracking` action, writing 19 tracking numbers to production (verified against DB) — including Ivy Song's original 2026-06-10 request ("can AI upload the tracking no.") on PO810624. Remaining 19 are genuine (same-MPN multi-line ambiguity, no tracking number present, or a live "tracking not working" complaint with a bad pre-existing value already in `Chuboe_TrackingNumbers`). (3) **Found and fixed 2 real bugs in `shared/email-workflow-poller.js`**: `cmdRoute` silently ignored `--folder` (always locked hardcoded `INBOX` via `withInbox()` regardless of the message's actual folder — now folder-aware via `withFolder()`); and `cmdRoute` never checked `result.error` before filing a message to the action's success folder (a failed patch got silently marked Processed with no escalation — now redirects and warns instead). (4) **SF-prefix stripping** — added `stripCarrierPrefix()` to `shared/workflow-actions/tracking-loading.js` (strips leading `SF` before writing, since OT should hold the bare carrier number like other carriers); applied per operator request, historical values left as-is. (5) **New digest**: `Trading Analysis/Tracking Loading/tracking-loading-daily-digest.js` — mirrors RFQ/VQ digest structure but queries `c_orderline.Chuboe_TrackingNumbers` directly (not breadcrumb-scoped) so it captures tracking loaded by anyone, not just Claude; includes loader breakdown, detail table, activity-by-route (Processed/NeedsReview/NotTracking, in-window + live backlog), and a **Tracking Compliance by Buyer** section (open `docstatus='IP'` PO lines past `datepromised` with no tracking, grouped by `c_order.SalesRep_ID` — the PO's own buyer field, not the VQ's, per operator correction; 30-day rolling window; Claude/LAM Kitting autonomous purchasing split into its own monitored-not-scored bucket; explicitly a lead list not a violation list since OT doesn't track actual receipts). Scheduled daily 12:10 UTC, chained after VQ (12:00)/RFQ (12:05) digests. (6) **Found and fixed a real data-quality bug along the way**: 36 open LAM Research POs had `c_order.SalesRep_ID = Claude Harris` even where the underlying VQ's `chuboe_buyer_id` had already been correctly patched to a human — confirms `tickVQForPurchase()`'s "auto-corrects buyer" logic only ever touches `chuboe_vq_line.chuboe_buyer_id`, never `c_order.SalesRep_ID` on the PO document itself. Initially misattributed via `chuboe_rfq.salesrep_id` (operator caught this — that's the RFQ's seller/AE, a different role, not a buyer signal) before landing on the operator's explicit instruction: reassign all LAM-Claude PO buyers to Jake Harris directly. All 36 patched and verified against the DB. The Astute Group (1) and Holdelec (1) POs also showing Claude were left alone — Holdelec confirmed as legitimate (stock sales = Jake) by the operator. **Key lesson reinforced**: "PO is what matters" — the PO's own fields (`SalesRep_ID`, `datepromised`, `Chuboe_TrackingNumbers`) are the source of truth for buyer accountability, not the VQ's.

- **2026-08-21 (CLAUDE.md Context Optimization + Handoff Skill)**: **Built the `handoff` skill, cut auto-loaded session context, and fixed a greeting bug that made the skill useless.** Note: the `handoff` skill and the CLAUDE.md edited here are **local to Justin's workspace** (`~/workspace/.claude/`, `~/workspace/CLAUDE.md`) — not this repo, and not shared. (1) **Skill** — writes a token-budgeted briefing to `~/workspace/handoffs/` so a fresh session resumes mid-task without re-deriving. Skills register at session start only. (2) **W111 correctness fix** — Justin's local CLAUDE.md warehouse list was wrong: claimed 14 groups (actual 12), invented `MAIN`/`W105`, and omitted that **W111/LAM_3PL is `OT Write: No`, internal-only**. Corrected against `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`. (3) **Duplication removed** — Quick Quote and Inventory File Cleanup sections collapsed to source-of-truth pointers per the "point, don't duplicate" rule; that duplication is what let W111 drift. (4) **Greeting bug found and fixed** — "Open Handoffs" was numbered step 3 but its body said "surface first, above everything else"; following the numbered order meant the answer was written before the probe ran, so a real open handoff (an unpushed commit) went unmentioned. Handoffs are now **step 1**, and a second trigger was added for `/clear` + "what were we working on?", which does not fire the SessionStart hook. **Lesson: an instruction whose position contradicts its text loses to its position.** (5) **Handoff lifecycle** — added `~/workspace/handoffs/archive/`; finished handoffs are moved there, not deleted (`~/workspace` is not a git repo, so deletion is permanent and Established Facts are worth keeping). (6) **Path checker** — `~/workspace/scripts/check-workflow-paths.js` validates every backtick path in CLAUDE.md; caught 3 dead links the prose had masked. Now 31 OK / 2 unverified / 0 broken. (7) **Closed out same day** — `.gitignore` extended with `Business Ops/**/output/` and `__pycache__/`, mirroring the existing `Trading Analysis/**/output/` rule (dropped 12 untracked working files: 11 inspection-queue escalation CSVs + a pycache dir). All four commits pushed, `9103493..2091961`, clean fast-forward. (8) **Correction — Claude's own Bash tool CAN `git fetch` and `git push` this repo.** Justin's local CLAUDE.md asserted "you are **not authenticated to GitHub**, so `git push` and private-repo access fail" and told sessions to hand pushes back to Justin; that is false and cost round-trips. Both stale lines corrected locally, scoped to this repo (push to `vq-parser` remains untested), with an explicit *confirm with the user before pushing* guardrail kept in place. **Open for Jake:** was `Market Offer Analysis` renamed to `Market Offer Loading`? For LAM Kitting Reorder, is the entry point `LAM 3PL/lam-kitting-spec.md` or `lam-kitting-agent.md`? **Still open:** `~/workspace/CLAUDE.md` carries real operational rules but has no version control and no backup — it took three more edits this session with no history behind them. Handoff closed and archived: `~/workspace/handoffs/archive/2026-08-21-claude-md-context-optimization.md`.

- **2026-08-17 (Brownsville Inspection Validation Daily Report)**: **Created daily cron report for W111 inspection validations.** (1) **Script** — `Business Ops/tsk-validated-inspections/brownsville-inspection-report.js` queries `chuboe_insp_mpnlotqueue_v` for validated inspections at Brownsville (W111, warehouse ID 1000015). (2) **Inspection form data** — Pulls MPN Received, MFR Received, Qty Received from inspection form attributes via `chuboe_insprecordasimap` → `m_attributeinstance` join (not VQ line). (3) **Columns** — OTIN, POV#, Line, MPN Received, MFR Received, Qty Received, Inspector, Validated At. (4) **Email** — HTML with summary (total validations/qty/inspectors), by-inspector breakdown, and detail listing. Sends to justin.oberhofer@astutegroup.com. (5) **Cron schedule** — Mon-Fri 8am ET (12:00 UTC), weekend gate built-in. (6) **Documentation** — `Business Ops/tsk-validated-inspections/brownsville-inspection-validation-daily.md`. **Commit:** `211dfa8`.

- **2026-08-14 (Tariff Tracker Extraction Run)**: **Processed bizops@ inbox for tariff-tracker workflow.** (1) **Skipped 3 emails** — uid 58/59 were Astute Purchase Order PDFs (POV0060812, POV0069128), not customs invoices; uid 71 was a bounce with no attachments. (2) **Processed uid 88** ("Fw: Freight over $500", 12 PDFs) — extracted 34 shipment rows across 10 FedEx customs invoices + 2 transportation-only invoices. Found one merge case (customs entry 1FX11591220 + oversized transportation charge $1,807.65, same tracking, combined to $8,170.92) and one standalone oversized-only row (Aerolux Ltd, $3,326.83, no matching customs invoice in batch). (3) **OT lookups** — 3 direct POV, 2 direct COV, 11 resolved via tracking-number search against `c_orderline.chuboe_trackingnumbers`; 14 tracking searches failed (mostly inbound/vendor-to-Astute shipments with no tracking recorded on the PO) and were flagged `[REVIEW: ...]` in SOURCE per the doc's rules — 17 rows flagged total. (4) **Output** — built `tariff_tracker_claude_2026-08-14.xlsx` via a data-specific builder script (`Business Ops/tsk-tariff-tracker-extraction/tariff-tracker-builder-2026-08-14.js`, following the pattern of the existing example script, not a generic runner) and routed uid 88 as `process`, emailing the tracker to justin.oberhofer@astutegroup.com.

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
