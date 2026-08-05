# North Star: Verify It Exists Before Acting

**NEVER assume something exists. ALWAYS verify first.**

Before doing ANYTHING non-trivial — executing a workflow, writing to a table, calling an API, using a shared module — verify:

1. **Does it exist?** Check that the file, table, endpoint, or module is real
2. **Is it wired up?** For workflows: handler + cron + registry entry. For writers: the module exists in `shared/`
3. **Have I read the docs?** Use the Read tool on the relevant `.md` file THIS session

**This applies to:**
- **Workflows** — verify in `shared/workflow-registry.js` and `docs/workflow-catalog.md`
- **Writers** — verify `shared/*-writer.js` exists before assuming you can write to a table
- **Lookup functions** — verify `shared/mfr-lookup.js`, `shared/partner-resolver.js` etc. exist
- **API endpoints** — verify in `shared/api-writeback.md` before POST/PATCH
- **Cron jobs** — verify in `cron-jobs.js` before referencing

**Anti-pattern (WRONG):**
```
"I'll run the Quick Quote workflow"
→ proceeds from memory without verifying it exists or reading its doc
```

**Correct pattern:**
```
1. Check docs/workflow-catalog.md — is Quick Quote listed?
2. Read Trading Analysis/Quick Quote/quick-quote.md
3. Follow the numbered steps in the doc
```

**Why:** On multiple occasions, actions were attempted on workflows/modules that didn't exist, or existed differently than remembered. Memory is unreliable. The filesystem is the source of truth.

---

# North Star: Read Before Executing

**THE .MD FILE IS THE SOURCE OF TRUTH. YOUR MEMORY IS NOT.**

Before executing ANY workflow:
1. **USE THE READ TOOL** on the workflow's .md file - do not proceed from memory, context summaries, or prior sessions
2. **FIND THE NUMBERED STEPS** - execute them in order, do not skip steps
3. **FIND THE OUTPUT FORMAT** - use the exact column names, field names, and structure defined in the doc
4. **FIND THE REQUIRED QUERIES** - use the SQL/commands documented, do not improvise

**Why this matters:** Context summaries and memory are lossy. You will forget column names, skip steps, and invent formats that don't match the ERP import template. The .md file has the exact specifications - read it every time.

If you catch yourself thinking "I remember how this works" - STOP and read the file instead.

---

# North Star: Check for Workflows Before Executing

**Before executing any non-trivial task:**

1. **Ask yourself: "Is there a documented workflow for this?"** Check `docs/workflow-catalog.md` or search for relevant `.md` files. Do not proceed from memory.
2. **If a workflow exists:** State which one, read it, then ask about any gaps in what the user provided before executing.

**The user should not have to invoke workflows by name.** You should recognize when a task maps to a documented workflow. "Load a VQ" → VQ Loading workflow. "Create an RFQ" → check if there's an RFQ workflow. "Process an approval" → VQ Purchase workflow.

**Why this exists:** On 2026-07-28, a manual VQ was created and ticked for approval without verifying required fields (warehouse, ship-to) because the workflow doc was read but not followed — gaps in user-provided information were filled with assumptions instead of questions.

**"I know how to do this" is not a substitute for reading the doc and confirming required inputs.**

---

# North Star: Run the Workflow Runner — No Custom Scripts

**If a workflow has a runner script, RUN IT. Do not write custom scripts to piece things together.**

Runners exist because they:
- Handle all the steps in the correct order
- Apply proper formatting (colors, column widths, tabs)
- Include all required output tabs (escalations, pending approval, etc.)
- Send to correct recipients
- Write proper sidecars and audit trails

**Anti-pattern (WRONG):**
```javascript
// "I'll just write a quick script to rebuild the Excel"
node -e "const XLSX = require('xlsx'); ..."

// "I'll manually call the exported function"
runner.rebuildExcelWithRfqLines(...)
```

**Correct pattern:**
```bash
# Just run the workflow
node lam-kitting-runner.js
```

**Why this exists:** On 2026-08-05, multiple attempts to "just send the LAM reorder file" resulted in missing tabs, missing color coding, wrong email recipients, and hours of wasted time — all because custom scripts were written instead of running `node lam-kitting-runner.js`.

**The runner is the workflow. Run it.**

---

# North Star: Email-Driven Workflows Use the Agent Pattern

**ALL email-driven workflows in this codebase use the same architecture:** thin CLI primitives (`shared/email-workflow-poller.js list / read / route`) + per-workflow handlers (`shared/workflow-actions/<name>.js`) + a workflow `.md` as the agent's instructions, executed via a `/schedule` routine. **Read [`email-workflow-architecture.md`](astute-workinstructions/email-workflow-architecture.md) before adding or modifying any email-driven workflow.**

**Do NOT:**
- Write a workflow-specific email parser. Use the generic poller.
- Add a cron entry that polls an inbox via a static node script. Use a `/schedule` routine.
- Add a cron entry that invokes `claude -p` directly. (See March 2026 stockrfq experiment — it failed continuously.)

The reference implementation is `shared/workflow-actions/rfq-loading.js` + `Trading Analysis/RFQ Loading/rfq-loading.md`.

---

# North Star: Truth Over Helpfulness

**Do not blindly agree. Do not optimize for sounding helpful. Optimize for being correct.**

- **Push back when something seems wrong** — even if the user asserts it confidently.
- **Verify before repeating.** Claims about schema, APIs, prices, dates, or external systems must be checked against a reputable source.
- **Cite the source.** When stating a fact that could be wrong, name where it came from.
- **Say "I don't know"** when you don't.
- **Distinguish observed from assumed.** "The query returned 7 rows" ≠ "there are 7 active records."
- **Disagreement is a feature.** Flag risks, missing assumptions, and alternative interpretations.

---

# North Star: Never Hardcode IDs — Always Look Them Up

**NEVER assume or hardcode database IDs (BP, MFR, Country, User, etc.). ALWAYS query the database first.**

**Anti-pattern (WRONG):**
```javascript
const LAM_BP_ID = 1000190;  // "I think this is Lam Research"
```

**Correct pattern:**
```sql
SELECT c_bpartner_id, name FROM c_bpartner
WHERE UPPER(name) LIKE '%LAM RESEARCH%'
  AND isactive = 'Y' AND iscustomer = 'Y';
```

**This applies to:**
- Business Partners (customers, vendors)
- Manufacturers (chuboe_mfr)
- Countries (c_country)
- Users (ad_user)
- Warehouses, Shippers, Packaging, etc.

**Why:** ID values differ between environments and can change. A comment saying "Lam Research" next to a hardcoded ID does NOT make it correct. The database is the source of truth.

**For MPN lookups:** Use web search or franchise APIs to identify the correct manufacturer — do not guess based on part number patterns.

---

# North Star: Writers Write, Lookups Lookup — Never Cross the Line

**The codebase structure defines what can be written vs. what must be looked up.**

| Pattern | Tables | Action |
|---------|--------|--------|
| `*-writer.js` modules | `chuboe_rfq`, `chuboe_vq_line`, `chuboe_cq_line`, `chuboe_offer`, etc. | **Write** — these are transactional tables, writing is expected |
| `lookup*` / `resolve*` functions | `chuboe_mfr`, `c_bpartner`, `ad_user`, `c_country`, etc. | **Lookup only** — these are reference/master data, never create |

**The critical rule: If a lookup fails, STOP — don't create.**

When a workflow needs to reference a record (manufacturer, business partner, user, etc.):
1. Use the standard lookup (`lookupMfr()`, `resolvePartner()`, etc.)
2. If no match → **report to the user and escalate** — do not create
3. Never use "find or create" patterns without explicit user approval

**Why:** On June 25, 2026, ad-hoc "find or create" logic created duplicate manufacturers (Analog Devices, Maxim, Grayhill, Yageo) that polluted 331 RFQ line MPN records.

**Ad-hoc one-off scripts:** If you need to write something outside the established `*-writer.js` modules, describe what will be written and get approval first.

---

# North Star: Never Create Manufacturers

**NEVER create new `chuboe_mfr` records unless the user explicitly requests it.**

When a workflow needs a manufacturer:
1. **Use `lookupMfr()`** from `shared/mfr-lookup.js` — it handles aliases, fuzzy matching, and caching
2. **If no match exists, STOP and report to the user** — do not create a new record
3. **Check for near-matches** — "Analog Devices" vs "Analog Devices Inc" are the same company

**Why:** Creating manufacturers without verification causes duplicates. On June 25, 2026, duplicate records were created for Analog Devices, Maxim Integrated, Grayhill, and Yageo — all of which already existed under slightly different names. This polluted 331 RFQ line MPN records.

**Anti-pattern (WRONG):**
```javascript
// "I couldn't find it, so I'll create it"
const newMfr = await apiPost('chuboe_mfr', { Name: 'Grayhill', IsActive: true });
```

**Correct pattern:**
```javascript
const mfrId = lookupMfr('Grayhill');
if (!mfrId) {
  console.log('MFR not found: Grayhill — please add manually or confirm creation');
  return;  // STOP, do not auto-create
}
```

**The only exception:** User explicitly says "create a new manufacturer for X" after confirming no existing match.

---

# North Star: Always Use Search Key, Never Internal PK

**When referring to ANY OT document (RFQ, Offer, Order, etc.), ALWAYS use the Search Key (`value` column), NEVER the internal database PK.**

| What User Sees | Internal PK | Search Key (`value`) |
|---------------|-------------|---------------------|
| "RFQ 1138194" | `chuboe_rfq_id = 1147609` | `value = '1138194'` |

**Rules:**
- **In conversation:** Use Search Key — "RFQ 1138194"
- **In reports/output:** Use Search Key
- **For API/code:** Store the internal PK but display the Search Key
- **In SQL:** Always SELECT `value` when showing document numbers to users

**Anti-pattern:** Saying "RFQ 1147609" when the user knows it as "RFQ 1138194" — this causes confusion.

**Full reference:** `shared/data-model.md` § Search Key (`value`) on Chuboe Tables

---

# North Star: Bug Fix Protocol (Test Before Processing)

**When the operator reports a bug using a specific stuck email/record as the example:**

1. **DO NOT manually process the stuck item first.** The stuck item is your test case.
2. **Diagnose and fix the underlying bug** in the code/workflow.
3. **Use the stuck item to verify the fix works** — clear its stuck state (SEEN flag, sentinel, etc.) and let the fixed code reprocess it.
4. **If multiple items are stuck from the same bug**, fix first, then batch-recover all of them as validation.

**Anti-pattern:** Process stuck item → fix bug → no way to verify. **Correct:** Fix bug → reprocess stuck item → verified.

---

# North Star: Always Test After Changes

**Changes without validation are incomplete. We do NOT make changes just for the sake of it.**

When modifying a workflow, script, or process:

1. **Identify the test case** — what input will exercise the change?
2. **Run the test** — reprocess using the original input that exposed the issue
3. **Verify the output** — confirm the change produces the expected result
4. **Only then is it done** — untested changes are not complete

**This is non-negotiable.** The effort spent fixing/enhancing a workflow is wasted if we don't verify it works. The original input that prompted the change IS the test case.

**Anti-pattern:** Make code changes → commit → assume it works → move on.
**Correct:** Make code changes → commit → rerun with original input → verify output → done.

---

# North Star: VQ Creation and Purchase Use Enforced Wrappers

**NEVER bypass the enforced wrappers when creating or approving VQs.**

## Manual VQ Creation

| Action | WRONG (direct API) | CORRECT (enforced wrapper) |
|--------|-------------------|---------------------------|
| Create manual VQ | `apiPost('chuboe_vq_line', {...})` | `createManualVQ(opts)` |

```javascript
const { createManualVQ } = require('../shared/vq-manual-writer');

const vq = await createManualVQ({
  program: 'LAM_KITTING',        // applies warehouse/shipper/incoterm defaults
  rfqValue: '1137922',
  rfqLineId: 3141430,
  mpn: 'DG406EUI+',
  mfrText: 'Maxim Integrated Products Inc',
  vendorBpId: 1000634,
  vendorLocationId: 1004101,
  qty: 70,
  cost: 19.95,
  dateCode: '24+',               // REQUIRED at creation
  leadTime: 'STOCK',             // REQUIRED at creation
  notes: 'buying from franchise...',
  isBrokerAsFranchise: true,     // for brokers acting as franchise pass-through
});
```

**What `createManualVQ()` enforces:**
- COO defaults to **PENDING** (not USA!) — we don't know origin until parts arrive
- Warehouse, Warehouse Group, Shipper, Incoterm from program defaults
- Packaging defaults to F-REEL
- Traceability derived from vendor type
- Date Code and Lead Time **required** (no silent nulls)

## VQ Purchase Approval

| Action | WRONG (direct API) | CORRECT (enforced wrapper) |
|--------|-------------------|---------------------------|
| Tick VQ as purchased | `patchRecord('chuboe_vq_line', id, { IsPurchased: 'Y' })` | `tickVQForPurchase(vqId, opts)` |
| Post approval request | `apiPost('r_request', payload)` | `postApproveOrder(opts)` |

```javascript
const { tickVQForPurchase } = require('../shared/vq-patcher');
const { postApproveOrder } = require('../shared/r-request-writer');
```

**What the wrappers enforce:**
- `tickVQForPurchase()` validates ALL required fields before ticking (MFR, COO, Date Code, Lead Time, Promise Date, Packaging, Traceability, Warehouse, etc.) + auto-corrects buyer from Claude Harris → Jake Harris
- `postApproveOrder()` validates VQ is ticked AND links R_Request to the RFQ

**One request per supplier per RFQ:** When buying multiple VQs from the same supplier on the same RFQ (e.g., 9 parts from Mouser on one POV), create ONE R_Request containing all VQs — not separate requests per line.

**Why this exists:** On 2026-07-07, approval request 1166798 was posted with incomplete VQs. On 2026-07-09, manual VQs were created with COO=USA (wrong) and missing warehouse.

**Full workflow:** Read `shared/vq-purchase-workflow.md` before ANY VQ approval.

**Date Code / Lead Time defaults:**
- Stock items: Date Code = `(current year - 2)+` (e.g., "24+")
- Lead time items: Date Code = `(current year)+` (e.g., "26+")
- Lead Time field: "STOCK" for in-stock, or specific time (e.g., "31 WEEKS")

---

# Output Formatting Standards

**ALL outputs — Excel, CSV, HTML emails, console tables — MUST be properly formatted:**

- **Currency:** `$1,234.56` (dollar sign, comma separators, 2-4 decimal places)
- **Percentages:** `18.5%` (with `%` sign). In Excel, use `0.0%` cell format.
- **Quantities:** Use comma separators for 1,000+. No decimals on whole quantities.
- **Excel number formats:** Always set `z` property on cells: `$#,##0.00` for currency, `0.0%` for percentages.
- **Dates / timestamps:** Always Central Time, labeled `CT`. Use helpers in `shared/time-format.js`.

See `shared/data-model.md` § Time-Zone Convention for the full rationale.

---

# Session Greeting

**TRIGGER:** On `SessionStart:startup hook success`, display the greeting immediately.

**Full procedure:** See `docs/session-greeting.md`

**Quick summary:**
1. **Recent Work** — from MEMORY.md Recent Sessions (2-4 entries)
2. **Available Workflows** — see `docs/workflow-catalog.md` (26 workflows)
3. **Roadmaps** — api-integration-roadmap.md, sourcing-roadmap.md, trading-analysis-roadmap.md
4. **Periodic Checks** — template-candidates.md (every 8 days)
5. **Deferred Work** — from deferred-work.md (if any open items)
6. **Cron pause check** — if `.cron-paused` or `.cron-agents-paused` exists, prompt user
7. **Cron drift check** — run `scripts/check-cron-drift.js`
8. **Hung job check** — run `scripts/check-hung-jobs.js --quiet` (added 2026-07-07)
9. **Workflow parity check** — run `scripts/check-workflow-parity.js --quiet`
10. **Agent prompt parity check** — run `scripts/check-agent-prompt-parity.js --quiet`

---

## Scheduling New Activities (REQUIRED workflow)

**Whenever the user asks to schedule a recurring activity, you MUST follow this flow — do NOT hand-edit `crontab -e`:**

### 1. Print the Resilience Checklist FIRST

```
Scheduling new activity: {name}
Resilience checklist:
  • Cadence:           {weekly | daily | every Nm}
  • Registered in:     ~/workspace/astute-workinstructions/cron-jobs.js
  • Cron schedule:     {hourly check for weekly/daily; native frequency for sub-hourly}
  • OT-write?:         {yes — health-gated / no — independent of OT}
  • Catch-up on miss?: {yes — sentinel-gated / n/a — sub-hourly self-heals}
  • Idempotent?:       {confirmed — re-run is safe / NEEDS REVIEW}
  • Visibility:        {drift check at session greeting; log → /path/to/log}
```

### 2. Add entry to `cron-jobs.js`

Required fields: `name`, `cadence`, `cadenceCron`, `command`, `cwd`, `needsOT`, `logFile`, `description`.

### 3. Run installer

```bash
node ~/workspace/astute-workinstructions/scripts/install-crons.js          # preview
node ~/workspace/astute-workinstructions/scripts/install-crons.js --apply  # apply
```

### 4. Verify

```bash
crontab -l
node ~/workspace/astute-workinstructions/scripts/check-cron-drift.js
node ~/workspace/astute-workinstructions/scripts/cron-runner.js --job=NAME --dry-run --force
```

---

## Shared Utilities

**Location:** `shared/`

### Data Model (REQUIRED — READ BEFORE ANY DB QUERY)

**`shared/data-model.md`** is the single source of truth for:
- Table hierarchies (RFQ → RFQ Line → RFQ Line MPN; Offer → Offer Line → Offer Line MPN)
- **Where fields live** (MPN/MFR on `chuboe_rfq_line_mpn`, NOT `chuboe_rfq_line`; VQ has no CPC)
- Join patterns and common wrong joins
- Price column names (`cost` on VQ, `priceentered` on CQ/RFQ/Offer)
- REST API write-back (see `shared/api-writeback.md`)

**RULE:** Never hardcode schema knowledge in individual workflows. Reference `shared/data-model.md` instead.

### CSV Parsing (REQUIRED)

**NEVER use `line.split(',')` for CSV parsing.** Use:

```javascript
const { readCSVFile } = require('../shared/csv-utils');
const csv = readCSVFile('/path/to/file.csv');
```

See `shared/README.md` for full API.

### MFR Equivalence (REQUIRED for manufacturer comparisons)

**Use `shared/mfr-equivalence.js`** — handles formatting variants, aliases, and acquisitions.

```javascript
const { computeMfrMatch } = require('../shared/mfr-equivalence');
const flag = computeMfrMatch(rfqMfr, supplierMfr);
//   ''         → same company
//   'MISMATCH' → different companies
//   '?'        → one side blank
```

### MPN Normalization (REQUIRED for MPN matching)

**Use `shared/mpn-normalization.js`** — handles hyphens, spaces, slashes, leading zeros, case.

```javascript
const { mpnMatch, findByMPN } = require('../shared/mpn-normalization');
if (mpnMatch('ECP-U1C104MA5', 'ECPU1C104MA5')) { ... }  // -> true
```

---

## Documentation Standards

Follow the conventions in `CONVENTIONS.md`:
- Workflow docs use `kebab-case.md` names (e.g., `inventory-file-cleanup.md`, NOT `README.md`)
- Task files go in `tasks/` with `snake_case.md` names
- Session history goes in `MEMORY.md` (4 most recent entries)
- Roadmaps for planned work go in `*-roadmap.md` files

**CRITICAL: Keep CLAUDE.md in sync**
- CLAUDE.md should point to detailed docs, NOT duplicate them inline
- The detailed .md file is the single source of truth; CLAUDE.md just references it

**CRITICAL: Explicit Numbered Steps Required**
All workflow documentation MUST include an "End-to-End Workflow" section with:
- **Numbered steps** (Step 1, Step 2, etc.) in order
- **"Do not skip"** callouts for critical steps
- **Explicit outputs** for each step
- **Commands or queries** for steps requiring system interaction

---

## Terminology

See `MEMORY.md` for full list. Key terms:
- **CPC** — Customer Part Code (customer's internal part number)
- **OT** — Orange Tsunami (internal name for iDempiere-based system)

---

## Workflow Quick Reference

| Workflow | Documentation |
|----------|---------------|
| **Inventory File Cleanup** | `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md` |
| **VQ Loading** | `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md` |
| **Quick Quote** | `Trading Analysis/Quick Quote/quick-quote.md` |

For the complete workflow list with descriptions, see `docs/workflow-catalog.md`.

---

## Session Logging

At the end of each session (or when meaningful progress is made), update the `## Recent Sessions` section in MEMORY.md with a brief summary. Keep only the 4 most recent entries.

---

# Environment

**Full documentation:** See `docs/environment.md`

## Critical Rules (Summary)

- **Database:** `idempiere_replica` — READ-ONLY (SELECT only)
- **Filter:** Always use `isactive = 'Y'` unless told otherwise
- **Write-back:** Use iDempiere REST API via `shared/api-client.js` — see `shared/api-writeback.md`
  - For `analytics_user`: use writers directly
  - For other users: use `shared/writeback-proxy-client.js`
- **Working directory:** `~/workspace`
- **Credentials:** `~/workspace/.env` (gitignored)
- **Full API docs:** `shared/api-writeback.md`, `shared/writeback-proxy.md`

### Consumer Modules (Quick Reference)

| Module | Function | What It Writes |
|--------|----------|----------------|
| `shared/rfq-writer.js` | `writeRFQ(opts)` | chuboe_rfq + lines + line_mpn |
| `shared/offer-writeback.js` | `writeOffer(opts)` | chuboe_offer + lines + line_mpn |
| `shared/vq-writer.js` | `writeVQBatch(rfq, items)` | chuboe_vq_line |
| `shared/cq-writer.js` | `writeCQ(rfq, line)` | chuboe_cq_line |

### iDempiere Bean-Callout Traps

1. **`chuboe_offer_line` CPC dedup collapse** — two lines with same CPC will merge/deactivate
2. **`Chuboe_CPC` non-updateable** — must be set at POST time only
3. **Stale `mfr-cache.json`** — if cache lacks `isSystem`, MPN POSTs may 500
4. **`chuboe_offer_line` auto-creates `chuboe_offer_line_mpn`** — do NOT set `writeMpnRecords: true` or you get duplicates (discovered 2026-07-07)

**Full reference:** `shared/data-model.md` § chuboe_offer_line bean-callouts

**Connected to PRODUCTION** (https://172.31.7.239/api/v1). User: Claude Harris (ID: 1049524). Data written via the API will appear in production.

## Collaboration Style

Don't just execute requests — actively contribute ideas, alternatives, and feedback. Flag potential issues, suggest better approaches, and share observations even when not asked.
