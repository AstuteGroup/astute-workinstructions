# North Star: Read Before Executing

**THE .MD FILE IS THE SOURCE OF TRUTH. YOUR MEMORY IS NOT.**

Before executing ANY workflow:
1. **USE THE READ TOOL** on the workflow's .md file - do not proceed from memory, context summaries, or prior sessions
2. **FIND THE NUMBERED STEPS** - execute them in order, do not skip steps
3. **FIND THE OUTPUT FORMAT** - use the exact column names, field names, and structure defined in the doc
4. **FIND THE REQUIRED QUERIES** - use the SQL/commands documented, do not improvise

**Why this matters:** Context summaries and memory are lossy. You will forget column names, skip steps, and invent formats that don't match the ERP import template. The .md file has the exact specifications - read it every time.

**This rule applies to:**
- All numbered workflows below
- Any multi-step process with documented specs
- Any output that must match a template or system format

If you catch yourself thinking "I remember how this works" - STOP and read the file instead.

---

# Output Formatting Standards

**ALL outputs — Excel, CSV, HTML emails, console tables — MUST be properly formatted:**

- **Currency:** Always display as `$1,234.56` (dollar sign, comma separators, 2-4 decimal places). Never raw floats like `0.28296` without a `$`.
- **Percentages:** Always display as `18.5%` (with `%` sign). In Excel, use `0.0%` cell format (store as decimal, display as %). Never show raw decimals like `0.185` in a margin column.
- **Quantities:** Use comma separators for 1,000+. No decimals on whole quantities.
- **Excel number formats:** Always set `z` property on cells: `$#,##0.00` for currency, `0.0%` for percentages, `#,##0` for quantities.
- **Column widths:** Set `!cols` on every sheet so data isn't truncated.
- **Savings/GP:** Show with `$` and sign context. Positive savings = good (under base).

**Why:** Unformatted outputs waste the buyer's time re-interpreting raw numbers and create errors when values like `0.185` are ambiguous (is it 18.5% or $0.185?).

---

# Session Greeting

**TRIGGER:** When you see `SessionStart:startup hook success` in a system-reminder, IMMEDIATELY display the greeting below — do not wait for user input. This allows the user to jump straight into their task.

At the start of every new conversation, before addressing anything else, always display the following:

1. **Recent Work** — Check the `## Recent Sessions` section in MEMORY.md. Display the 2-4 most recent entries so the user can quickly pick up where they left off. Format as:

> **Recent Work (pick up where you left off):**
> - [list from MEMORY.md Recent Sessions, most recent first]

2. **Available Workflows:**

> **Available Workflows:**
> 1. **Franchise Screening** - Screen RFQs against FindChips to filter low-value parts before broker sourcing (see `Trading Analysis/RFQ Sourcing/franchise_check/franchise-screening.md`)
> 2. **RFQ Sourcing** - Submit RFQs to NetComponents suppliers (see `Trading Analysis/RFQ Sourcing/netcomponents/rfq-sourcing-netcomponents.md`)
> 3. **VQ Loading** - Process supplier quote emails into VQ records. Type 2 bulk summaries write directly to OT via REST API (`load-bulk-summary-cli.js`); Type 1 single-vendor quotes still flow through `vq-parser fetch` (legacy CSV path). See `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md`.
> 4. **RFQ Loading through AI** - AI-assisted extraction and loading of RFQs from customer emails/documents (see `Trading Analysis/RFQ Loading/rfq-loading.md`)
> 5. **Market Offer Analysis for RFQs** - Match new RFQs against customer excess and stock offers (see `Trading Analysis/Market Offer Matching for RFQs/market-offer-matching.md`)
> 6. **Quick Quote** - Generate baseline quotes from recent VQs (0-30 days) with margin/GP/rebate pricing logic
> 7. **Seller Quoting Activity** - VQ→CQ→SO funnel analysis by seller (snapshot + 6-month trend)
> 8. **Order/Shipment Tracking** - Look up tracking by COV, SO, MPN, customer PO, or salesperson (see `saved-queries/order-shipment-tracking.md`)
> 9. **Inventory File Cleanup** - Process Infor inventory exports into Chuboe format for iDempiere import (see `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`)
> 10. **Vortex Matches** - Surface VQs/offers under customer targets, stock matches, and market intelligence (see `Trading Analysis/Vortex Matches/vortex-matches.md`)
> 11. **Customer Excess Analysis** - Universal offer pipeline: 30-min inbox poll → writeOffer → type-router → Customer Excess Analysis (intent: Spec Buy / Proactive Customer / Reactive RFQ-match) for types 1000000/1000003, or broker/franchise data-capture for 1000001/1000002. Operator digest 3×/day (7am/12pm/4pm EDT) with reply-parser feedback loop (see `Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md`)
> 12. **BOM Monitoring** - Track BOM risk, commodity analysis, and excess matches (see `Trading Analysis/BOM Monitoring/`)
> 13. **Stock RFQ Loading** - Process customer RFQ emails into ERP-ready CSV for import (see `Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md`)
> 14. **HTS / ECCN Backfill** - RFQ-scoped HTS + ECCN backfill onto chuboe_vq_line via DigiKey + Mouser APIs (see `Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.md`)
> 15. **MFR Reconciler** - Daily cron that backfills `Chuboe_MFR_ID` on rows where text is set but FK is null. Runs at 6 AM UTC; sweeps rfq_line_mpn / vq_line / cq_line for rows created since last run (see `Trading Analysis/MFR Reconciler/mfr-reconciler.md`)
> 16. **CRMA Form Filling** - Fill the customer-RMA xlsx (`CRMA Request Form 2023.06`) from an OT SO# when buyer forwards a blank form to stockRFQ@. Cell map + dropdown source ranges + naming gotchas (Astute COV = Infor COV, not OT SO#) (see `Trading Analysis/CRMA Form/crma-form.md`)
> 17. **Leah's BOS Report** - Weekly open-order report for Leah Griffin / BOS team. Processes Infor xlsx export into 3-bucket × 3-aging × region breakdown with: (a) week-over-week past-due Δ decomposition (Persisted / Resolved / Rolled forward / New entry — normalized to daily rate), (b) BOS↔ISE matrix alignment check (mismatches + no-CSE + orphan-ISE flagged as Signals + Unaligned xlsx tab), (c) auto-detected anomaly signals. Emailed from stockRFQ@ (see `Trading Analysis/Leah's BOS Report/leahs-bos-report.md`)
> 18. **AMAT RFQ Management** - Pull RFQ data from Applied Materials' Supplier Collaboration Vault 2.0 (https://myapp.amat.com) so RFQs can flow into OT without manual portal click-through. **PAUSED** pending IT confirmation of credentials + ToU + 2FA channel (see `Trading Analysis/AMAT RFQ Management/amat-rfq-management.md`)
> 19. **Price Intelligence Dashboard** - Per-MPN price-trend dashboard overlaying VQ quotes, market offers, and customer targets. Trigger phrases: "price intelligence on \<MPN\>", "price trend for \<MPN\>", "part trend analysis on \<MPN\>" (see `Trading Analysis/Price Intelligence Dashboard/price-intelligence.md`)

3. **Review Roadmaps** (planned work):

> **Roadmaps:**
> - `api-integration-roadmap.md` — External APIs (franchise distributors, LLM, future integrations)
> - `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` — RFQ Sourcing & VQ Processing
> - `Trading Analysis/trading-analysis-roadmap.md` — Vortex Matches, Quick Quote, etc.

4. **Periodic Checks** (every 8 days):

> **Template Candidates:** Check `Trading Analysis/RFQ Sourcing/vq_loading/template-candidates.md`
> - Any vendors with 5+ cumulative quotes? → Review for templateability
> - Show top 3 candidates and their counts
> - Check if structured (table/consistent format) vs free-form (prose) → only structured can be templated

---

## Scheduled Jobs (cron)

**Source of truth:** `cron-jobs.js` (registry) — every scheduled activity is declared there. Crontab is auto-generated from it; never hand-edit `crontab -e`.

**Workflow for adding a scheduled activity:**

1. Print the Resilience Checklist (required — see workspace `CLAUDE.md` § Scheduling New Activities).
2. Add an entry to `cron-jobs.js`.
3. `node scripts/install-crons.js --apply` (backs up the prior crontab, regenerates from registry).
4. Verify with `crontab -l` and `node scripts/check-cron-drift.js`.

**Resilience pattern (built in via `cron-runner.js`):**

- **Sentinel** — per-job state at `~/workspace/.cron-sentinels/{name}.json` records `lastSuccess` and `nextDue`. Weekly/daily jobs are scheduled hourly in cron, but only execute when the sentinel says they're due.
- **OT health gate** — jobs with `needsOT: true` probe `/api/v1/` before running. On 5xx, exit cleanly without advancing the sentinel — next hourly tick retries.
- **Drift check** — `scripts/check-cron-drift.js` runs at session start, surfacing raw cron lines, missing registry entries, orphan sentinels, and stale jobs.

**Job-level idempotency requirement:** Catch-up runs are gated by the sentinel (cadence elapses before next run), but if the script is `--force`-invoked or run manually, it should ideally be safe to re-run within the cadence window. `inventory_cleanup.js` is fully idempotent (deactivate-then-write). `lam-kitting-rfq-writer.js` is NOT (each call creates a fresh RFQ) — relies on sentinel cadence for safety.

**Historic context (`crontab.md`):** Retains the institutional knowledge about `PGUSER` / `LOGNAME` peer-auth requirements that are baked into the install-crons.js header. Read it if you're debugging cron-DB auth failures.

### Reporting cadence (default for any new scheduled report)

**Anomaly-immediate + 3×/day digest at 11/16/20 UTC (7am/12pm/4pm EDT).** Apply this to any scheduled background job that produces routine activity reports — unless the operator says otherwise.

- **Immediate email:** any tick with warnings or errors → fire that tick's batch as an anomaly email. Don't wait.
- **Digest email:** roll all activity into `~/workspace/.<job>-rollup.json`; deliver once per slot (11/16/20 UTC). Mark the slot fired *before* sending so a transient send failure doesn't loop on the next 15-min tick.
- **Cron tick frequency stays the same** — only the email cadence changes.
- **Reference implementation:** `Trading Analysis/RFQ API Enrichment/enrich-poller.js` Phase 5 (constant `DIGEST_UTC_HOURS = [11, 16, 20]`, helpers `readRollup` / `writeRollup`).
- **Scope:** scheduled background reports only. Inbox-driven request/response (vortex-poller, rfq-loader-daemon, excess-poller acks, reply-parser confirms), anomaly-only emitters (auth-failure-alerts), and one-shot operator scripts are exempt — they need to send when the work happens.

DST drift is acceptable (slots shift 1h in EST winter); don't bake DST handling into individual jobs.

---

## Shared Utilities

**Location:** `shared/`

### Data Model (REQUIRED — READ BEFORE ANY DB QUERY)

**`shared/data-model.md`** is the single source of truth for:
- Table hierarchies (RFQ → RFQ Line → RFQ Line MPN; Offer → Offer Line → Offer Line MPN)
- **Where fields live** (MPN/MFR on `chuboe_rfq_line_mpn`, NOT `chuboe_rfq_line`; VQ has no CPC; etc.)
- Join patterns and common wrong joins
- Price column names (they differ per table: `cost` on VQ, `priceentered` on CQ/RFQ/Offer)
- `search_key` vs `c_bpartner_id` distinction
- Valid values (packaging, RoHS, COO, RFQ types, offer types)
- REST API write-back (see `shared/api-writeback.md` for payloads and auth)

**RULE:** Never hardcode schema knowledge in individual workflows. Reference `shared/data-model.md` instead. When discovering new schema details, update the data model — not the workflow doc.

### CSV Parsing (REQUIRED)

**NEVER use `line.split(',')` for CSV parsing.** It breaks on quoted fields containing commas.

Always use the shared CSV utility:
```javascript
const { readCSVFile } = require('../shared/csv-utils');
const csv = readCSVFile('/path/to/file.csv');

// Filter and aggregate
const filtered = csv.filterByColumn('Warehouse', 'W111');
const total = csv.sumColumn('Lot Cost', row => row[warehouseIdx] === 'W111');
```

See `shared/README.md` for full API.

### MFR Equivalence Comparison (REQUIRED for any "is this the same company?" check)

**When comparing two manufacturer strings — customer ask vs supplier label, RFQ MFR vs VQ MFR, RFQ MFR vs franchise API response — ALWAYS use `shared/mfr-equivalence.js`. Do not roll your own normalization.**

```javascript
const { computeMfrMatch, canonicalMfr } = require('../shared/mfr-equivalence');

const flag = computeMfrMatch(rfqMfr, supplierMfr);
//   ''         → same company (or both blank)
//   'MISMATCH' → both populated, different companies
//   '?'        → exactly one side blank
```

The pipeline (prenormalize → alias file → acquisitions chain) handles:
- **Formatting variants** (`DIODES  INC` / `DIODES`, `Phoenix Contact Inc.` / `Phoenix Contact`, `WURTH ELEKTRONIK GMBH` / `WURTH ELEKTRONIK`, `HRS(??)` / `Hirose Electric`) — structural, no entries needed
- **Nomenclature aliases** (`TI` / `Texas Instruments`, `TYCO` / `TE Connectivity`, `ON SEMI` / `On Semiconductor`) — via `Trading Analysis/Market Offer Loading/mfr-aliases.json` (200+ curated entries, validated monthly)
- **Acquisitions** (`Linear` → `ADI`, `IR` → `Infineon`, `Atmel` → `Microchip`, `Sprague` → `Vishay`, `Fairchild` → `Onsemi`, `Numonyx` → `Micron`, etc.) — via `shared/data/mfr-acquisitions.json`

**Adding new equivalences:**
- New nomenclature alias → edit `mfr-aliases.json` (uppercase key → canonical brand name)
- New acquisition → edit `mfr-acquisitions.json` (original brand → current owner; only when fully absorbed)
- New formatting/punctuation issue → already handled by `prenormalizeMfr`, no edits needed

Both data files are also consumed by `shared/mfr-lookup.js` and `shared/mfr-resolver.js` (which power every writer that resolves MFR), so any addition compounds across writers, Vortex Matches, Quick Quote, Market Offer Matching, RFQ API Enrichment, and any future workflow.

**Current consumers (always check this list before building a new MFR comparison):**
- `Trading Analysis/Vortex Matches/vortex-matches.js` — red-flags Supplier MFR cells on MISMATCH
- `Trading Analysis/RFQ API Enrichment/enrich-rfq.js` — counts MFR mismatches in the run summary
- `Trading Analysis/Market Offer Matching for RFQs/analyze-new-offers.js` — adds `mfr_match` column to opportunity CSV
- `Trading Analysis/Quick Quote/qq_*.sql` — pulls `rfq_mfr` + `vq_mfr` for the (planned) Node-wrapper to compare

If you're building a new workflow that needs MFR comparison, add yourself to this list when you do.

---

## Documentation Standards

When creating or updating workflow documentation, follow the conventions in `CONVENTIONS.md`:
- Workflow docs use descriptive `kebab-case.md` names (e.g., `inventory-file-cleanup.md`, NOT `README.md`)
- Task files go in `tasks/` with `snake_case.md` names
- Keep workflow docs brief; detailed step-by-step instructions belong in `tasks/`
- Session history goes in `MEMORY.md` (4 most recent entries)
- **Roadmaps** for planned work go in `*-roadmap.md` files — see CONVENTIONS.md for schema

**When planning future work:** Read the area's roadmap first (`Trading Analysis/RFQ Sourcing/sourcing-roadmap.md`, `Trading Analysis/trading-analysis-roadmap.md`), then add items there — not inline in MEMORY.md. The roadmap is the source of truth for planned improvements.

**CRITICAL: Keep CLAUDE.md in sync**
- When updating ANY workflow .md file, also update CLAUDE.md to reference it correctly
- CLAUDE.md should point to detailed docs, NOT duplicate them inline
- This prevents stale/incomplete workflows in CLAUDE.md that diverge from the authoritative source
- The detailed .md file is the single source of truth; CLAUDE.md just references it

**CRITICAL: Explicit Numbered Steps Required**
All workflow documentation MUST include an "End-to-End Workflow" section with:
- **Numbered steps** (Step 1, Step 2, etc.) that must be completed in order
- **"Do not skip"** callouts for critical steps (e.g., database lookups, validation)
- **Explicit outputs** for each step (what file/data is produced)
- **Commands or queries** for steps requiring system interaction

Why: Reference sections (like "Vendor Matching Strategy") get skipped when following a workflow. Numbered steps force sequential execution and prevent missed steps. If a step is important enough to document, it's important enough to number.

---

## Terminology

See `MEMORY.md` for full list. Key terms:
- **CPC** — Customer Part Code (customer's internal part number). "LAM CPC" = LAM's part code.
- **OT** — Orange Tsunami (internal name for iDempiere-based system)

---

## Inventory File Cleanup Workflow

**Location:** `~/workspace/astute-workinstructions/Trading Analysis/Inventory File Cleanup/`

**BEFORE STARTING:** Read the full workflow documentation at `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`.

Processes the weekly Infor AST Item Lots Report into:
1. **OT inventory offers** — written directly to iDempiere via REST API (`shared/offer-writeback.js`), one `chuboe_offer` per warehouse group, prior week deactivated first. 11 groups in `WAREHOUSE_WRITEBACK`.
2. **NetComponents portal CSVs** — split by account, emailed separately: non-authorized #1167233 (all OT groups except Franchise_Stock + carryovers) and franchised #1126121 (Franchise_Stock only). Both files use 5-column friendly headers (`MPN, Description, Manufacturer, Qty, D/C`).
3. **Per-warehouse Chuboe CSVs** on disk (`Inventory YYYY-MM-DD/`) — audit trail / manual replay path

**Quick commands** (run from the workflow folder):
```bash
node inventory_cleanup.js fetch              # live: fetch + process + OT write-back
node inventory_cleanup.js fetch --dry-run    # preview write-back without API calls
node inventory_cleanup.js <file.xlsx> --writeback [--dry-run]   # manual mode
```

Cron: every Monday 6 AM EST. See `crontab.md`.

---

## VQ Loading Workflow

**BEFORE STARTING:** Read the full workflow documentation at `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md`

This includes:
- **Two-Agent Validation** (REQUIRED) - Extractor agent + Verifier agent
- **Type 2 Direct API Load** (canonical for bulk summaries) — `load-bulk-summary-cli.js` writes VQs directly to OT, no CSV mass-upload step
- Field reference for VQ Mass Upload Template
- Vendor matching strategy (domain-based, not exact email)
- Session file workflow
- Skip rules and categorization

**Code:**
- `~/workspace/vq-parser/` — Type 1 fetcher + template engine
- `shared/load-bulk-summary.js` — Type 2 library (resolves vendors / matches MPNs / writes VQs)
- `Trading Analysis/RFQ Sourcing/vq_loading/load-bulk-summary-cli.js` — Type 2 CLI wrapper

**Repo:** https://github.com/AstuteGroup/vq-parser (private)

**Quick commands:**
```bash
# Type 1 (single-vendor): fetch + extract via template engine
node vq-parser/src/index.js fetch

# Type 2 (bulk summary): write extracted quotes directly to OT
node "Trading Analysis/RFQ Sourcing/vq_loading/load-bulk-summary-cli.js" \
  quotes.json --rfq <searchKey> --buyer <userId> --dry-run
# then re-run with --commit

# List vq-parser sessions
node vq-parser/src/index.js sessions --list
```

---

## Quick Quote Workflow

**Documentation:** `Trading Analysis/Quick Quote/quick-quote.md`
**Output:** `Trading Analysis/Quick Quote/output/`

### When User Requests Quick Quote

**ALWAYS follow these steps in order:**

1. **Read the documentation** - Read `Trading Analysis/Quick Quote/quick-quote.md` to get current pricing parameters

2. **State the defaults** - Confirm with user:
   > "Quick Quote defaults: 15% min margin, $250 min GP/line, 30% fat margin fallback, 30-day VQ window. Using these for [Customer]?"

3. **Check for overrides** - Ask if customer has special terms:
   - Different margin requirements?
   - Rebate arrangements?
   - Contract pricing rules?

4. **Execute** - Run the SQL query and export to CSV

5. **Summarize results** - Show count of UNDER/OVER/VERIFY QTY lines and highlight best opportunities

### Pricing Parameters (from quick-quote.md)

| Parameter | Default | Formula |
|-----------|---------|---------|
| Min Margin | 15% | `cost / 0.85` |
| Min GP | $250/line | `cost + $250/qty` |
| Floor Price | Higher of above | `MAX(cost/0.85, cost+$250/qty)` |
| Fat Margin Threshold | 35% | If target margin > 35%, use fallback |
| Fat Margin Fallback | 30% | `cost / 0.70` |
| VQ Window | 30 days | Only recent quotes |
| Date Code Cutoff | 2022+ | Reject older unless blank/lead time |

### Priority Hierarchy for Suggested Resale

1. Same-customer PPV sale → use that price
2. Same-customer Shortage sale → use that price
3. Same-customer losing CQ → undercut by formula
4. Other-customer sale → split the difference
5. Target margin ≤35% → use target price
6. Target margin >35% → use 30% margin fallback

---

## Session Logging

At the end of each session (or when meaningful progress is made), update the `## Recent Sessions` section in MEMORY.md with a brief summary of what was worked on and the current status. Keep only the 4 most recent entries — drop the oldest when adding a new one.

---

# Astute Analytics Environment

## Business Context

Astute is a semiconductor brokerage specializing in electronic component distribution and supply chain services. Our core business involves:

- **Procurement**: Purchasing electronic components from various sources
- **Quality Assurance**: Testing components for quality and authenticity to ensure supply chain integrity
- **Distribution**: Selling verified parts to OEMs, contract manufacturers, and other resellers
- **Value-Added Services**: Providing supply chain services for peripheral commodities including board-level components

This database contains operational data supporting these business functions.

---

# Environment Constraints

You are operating as a restricted user (`analytics_user`) with limited permissions. Read this entire file before taking any actions.

## Database Access

- **Database**: `idempiere_replica`
- **Access level**: READ-ONLY (SELECT queries only)
- **Connection**: Run `psql` directly (no password needed, database auto-selected)
- **Schemas available**: `adempiere`, `intermediate`, `intermediate_dev`, `mart`, `mart_dev`

**CRITICAL: Active Records Only**
Always filter by `isactive = 'Y'` unless explicitly told otherwise. Most iDempiere tables have an `isactive` column — inactive records are soft-deleted and should be excluded from all queries by default.

You CANNOT run INSERT, UPDATE, DELETE, DROP, CREATE, or any other data-modifying commands against the `adempiere` schema. They will fail with "permission denied."

---

## Database Architecture & Write-Back Rules

You are an analytics and automation assistant connected to a PostgreSQL logical replica of an iDempiere ERP system. You act on behalf of the user Jake Harris.

### ⚠️ STRICT RULE: NEVER WRITE TO THE `adempiere` SCHEMA

The `adempiere` schema is a read-only logical replica streaming directly from production. You are strictly forbidden from attempting `INSERT`, `UPDATE`, or `DELETE` operations on any table within the `adempiere` schema.

### ✅ HOW TO WRITE DATA: iDempiere REST API

When you generate new data (like RFQs, Orders, or Business Partners) that needs to go back to the ERP, write it via the **iDempiere REST API** using `shared/api-client.js`.

**Full documentation:** See **`shared/api-writeback.md`** for authentication, credential management, payload structures for all 12 tables, and examples.

#### Quick Reference

```javascript
const { apiPost } = require('../shared/api-client');

// Create a record — server assigns the ID
const rfq = await apiPost('chuboe_rfq', {
  C_BPartner_ID: 1000190,
  chuboe_rfq_type_id: 1000007,
  SalesRep_ID: 1000004,
  Description: 'Stock RFQ from broker email'
});
console.log(rfq.id); // server-assigned ID
```

#### Standard Payload Fields (Auto-Populated by Server)

The following fields are **automatically set by the server** from the authenticated session — do NOT include them in payloads:
- `AD_Client_ID`, `AD_Org_ID`, `IsActive`, `CreatedBy`, `UpdatedBy`, `Created`, `Updated`, `id`, `uid`

See [iDempiere REST API docs](https://bxservice.github.io/idempiere-rest-docs/docs/api-guides/crud-operations/creating-data) for details.

#### ID Management

IDs are **assigned server-side** by iDempiere — do NOT include PK fields in POST payloads. For parent-child records, POST the parent first, extract the ID from the response, then POST children with the parent's ID.

#### Consumer Modules (Identical Interfaces)

| Module | Function | What It Writes |
|--------|----------|----------------|
| `shared/rfq-writer.js` | `writeRFQ(opts)` | chuboe_rfq + lines + line_mpn |
| `shared/offer-writeback.js` | `writeOffer(opts)` | chuboe_offer + lines + line_mpn |
| `shared/api-result-writer.js` | `writePricingResult(opts)` | chuboe_pricing_api_result |
| `shared/vq-writer.js` | `writeVQBatch(rfq, items)` | chuboe_vq_line (two-pass: exact → fuzzy) |
| `shared/cq-writer.js` | `writeCQ(rfq, line)` / `writeCQBatch(rfq, lines)` | chuboe_cq_line (flat, no header) |
| `shared/record-updater.js` | `patchRecord(table, id, payload, opts)` / `patchBatch(table, updates, opts)` | **Updates** existing rows on any chuboe_* table — idempotent backfills, enrichment passes, corrections (HTS/ECCN, alt-MPN linkage, etc.). See `api-writeback.md` § PATCH / Update Pattern. |
| `shared/vq-patcher.js` | `tickVQForPurchase(vqId, {program, extra})` | **PATCH IsPurchased='Y'** on a VQ — enforced path. Runs `vq-purchase-validator.js` first, aborts on failure, auto-unticks competing VQs. **DO NOT `patchRecord('chuboe_vq_line', id, {IsPurchased: 'Y'})` directly.** |
| `shared/r-request-writer.js` | `postApproveOrder({vqId, program, rfqId, summary, approvalText})` | **POST approve-order R_Request** — enforced path. Validates linked VQ first, forces Jake routing + Submitted status + Approve Order type. **DO NOT `apiPost('r_request', ...)` directly for approvals.** |
| `shared/vq-purchase-validator.js` | `validateVQForPurchase(vqId, {program})` | Pre-flight checker (called internally by the two wrappers above). Returns `{ok, violations, vq}`. Useful on its own for dry-run diagnostics. |
| `shared/cq-patcher.js` | `markCQSold(cqId, {poReference, extra})` | **PATCH IsSold='Y' + R_Status_ID=Closed** on a CQ — enforced path. Mirrors operational fields (DatePromised, Chuboe_Lead_Time, Chuboe_Date_Code, Chuboe_Packaging_ID, Chuboe_RoHS, C_Country_ID) from the winning VQ on the same RFQ line, then validates. **DO NOT `patchRecord('chuboe_cq_line', id, {IsSold: 'Y'})` directly.** |
| `shared/cq-sold-validator.js` | `validateCQForSold(cqId)` | Pre-flight checker (called internally by `markCQSold`). Flags missing `POReference` / `DatePromised` / `Chuboe_Lead_Time`, missing-or-mismatched winning-VQ link, competing sold CQs. |

### R_Requests (Approve Order + related)

**Documentation:** `shared/r-requests.md` — canonical reference for all request types, with detailed focus on Approve-Order requests (the pattern support/managers see). Covers field → UI mapping (Summary, Chuboe_Approval_Text, Result), routing (AD_User_ID 1000004 = Jake), Submitted status requirement (R_Status_ID = 1000000), non-updateable fields, and the canonical POST payload.

**Always go through `shared/r-request-writer.js` (`postApproveOrder()`) for approve-order R_Requests.** It wraps `apiPost('r_request', ...)` with the VQ validator + canonical routing. Direct `apiPost` for approvals is an anti-pattern — it has skipped the validator every time we've tried it.

**READ `shared/r-requests.md` BEFORE POSTING ANY NON-APPROVE R_REQUEST** — gotchas around `Chuboe_Approval_Text` (non-updateable after POST, must be set at create time), routing defaults (API auto-assigns to Claude 1049524 unless overridden), and status defaults have burned us multiple times.

#### Credentials

Stored in `~/workspace/.env` (gitignored). Template at `shared/.env.example`. Required vars: `IDEMPIERE_BASE_URL`, `IDEMPIERE_USERNAME`, `IDEMPIERE_PASSWORD`.

**Note:** Connected to PRODUCTION (https://172.31.7.239/api/v1). User: Claude Harris (ID: 1049524), Role: Tsunami User (1000004). Data written via the API will appear in production and replicate to this database.

#### ⚠️ CRITICAL — iDempiere bean-callout traps that silently destroy data

These are server-side iDempiere callouts that fire AFTER the REST API returns 200 OK. The loader sees success and a new ID; the destruction happens server-side post-response. Every writer must respect these:

1. **`chuboe_offer_line` CPC dedup collapse** — POSTing two lines to the same offer with the same `chuboe_cpc` (regardless of MPN difference) will:
   - Comma-merge the survivor's `chuboe_mpn` field in place (corrupts join key)
   - Set the new line `isactive=N` with description `"deactived - duplicate CPC - See Line #<survivor>"`
   - Verified empirically 2026-04-08 with totally distinct MPNs (`5962-1620804QZC` vs `TESTAVL-COLLAPSE-CHECK`)
   - **Mitigation:** per-CPC anchor pattern (one row per CPC carries the field, rest CPC=`''`) OR use `chuboe_offer_line_mpn` sub-rows for AVL alternates (sub-table is not subject to the callout)

2. **`Chuboe_CPC` non-updateable on existing rows** — PATCH returns `500 "Cannot update column Chuboe_CPC"`. CPC must be set at POST time only.

3. **Stale `mfr-cache.json`** — if the cache lacks `isSystem`, MPN POSTs may 500. See `feedback_mfr_resolution_mandatory.md`.

**Full reference:** `shared/data-model.md` § chuboe_offer_line CPC bean-callout, `shared/offer-writeback.js` header, memory `feedback_avl_multi_mpn_loading.md` and `project_chuboe_offer_line_cpc_collapse.md`. Read these before writing to any offer table.

---

### Example Queries

```bash
# Simple query
psql -c "SELECT COUNT(*) FROM ad_client;"

# Query with output to file
psql -c "SELECT * FROM ad_client;" -o ~/workspace/results.csv

# Interactive session
psql
```

## File System Access

- Working directory: ~/workspace (you start here automatically)
- Write access: ONLY within ~/workspace
- Read access: Limited to world-readable files
- You CANNOT cd to other directories (restricted shell)
- Save all output files to ~/workspace

## Available Commands

You only have access to these commands:
- psql - PostgreSQL client
- claude - This CLI
- node, npm, npx - Node.js runtime and package manager
- ls, cat, head, tail - View files
- grep, sort, wc - Process text
- mkdir, cp, mv, rm - Manage files in workspace
- curl, wget - Fetch data from URLs
- git - Version control

Commands like sudo, apt, vim, nano, ssh, python are NOT available.

## Node.js / JavaScript

Node.js v22 is available along with npm and npx. You can:

- Write and run JavaScript/TypeScript files with `node script.js`
- Install npm packages in ~/workspace (package.json is already initialized)
- Use **Playwright** (pre-installed) for browser automation and web scraping
- Install any npm libraries as needed with `npm install <package>`

### Playwright

Playwright is pre-installed with Chromium. Use it for web scraping, automation, and testing.

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log(await page.title());
  await browser.close();
})();
```

## File Output Default

Unless otherwise instructed, all saved/output files should be:
1. Copied to `~/workspace/astute-workinstructions/Trading Analysis/`
2. Committed and pushed to GitHub after saving

## Best Practices

1. Always write output files to ~/workspace
2. Use psql -o filename.csv to save query results
3. For large queries, add LIMIT clauses to preview data first
4. Use \dt schemaname.* in psql to list tables in a schema
5. Use \d tablename in psql to see table structure
6. **When creating new folders**: Always add a `.gitkeep` placeholder file so the folder is tracked in git and visible on GitHub immediately. Then commit and push.

## What You Cannot Do

- Modify any database records
- Access other databases
- Install system software (but you CAN install npm packages)
- Access system files or other users' directories
- Change system configurations

This is an analytics and development environment. Focus on SELECT queries, data analysis, and building JavaScript-based tools.

---

## Collaboration Style

Don't just execute requests — actively contribute ideas, alternatives, and feedback. Flag potential issues, suggest better approaches (technical or conceptual), and share observations even when not asked. The user values "unknown unknowns" — things they wouldn't know to ask about. Provide this feedback naturally throughout the session, not just when prompted.
