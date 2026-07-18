# North Star: Verify It Exists Before Acting

**NEVER assume something exists. ALWAYS verify first.**

Before doing ANYTHING non-trivial — executing a workflow, writing to a table, calling an API, using a shared module — verify:

1. **Does it exist?** Check that the file, table, endpoint, or module is real
2. **Is it wired up?** For workflows: handler + cron + registry entry. For writers: the module exists in `shared/`
3. **Have I read the docs?** Use the Read tool on the relevant `.md` file THIS session

**Verification checklist by action type:**

| Action | Verify in |
|--------|-----------|
| Execute a workflow | `shared/workflow-registry.js` + `docs/workflow-catalog.md` + workflow `.md` |
| Write to a table | `shared/*-writer.js` exists + `shared/api-writeback.md` |
| Use a lookup | `shared/mfr-lookup.js`, `shared/partner-resolver.js` etc. |
| POST/PATCH to API | `shared/api-writeback.md` |
| Reference a cron | `cron-jobs.js` |

**Anti-pattern (WRONG):**
```
"I'll run the Quick Quote workflow"
→ proceeds from memory without verifying it exists
```

**Correct pattern:**
```
1. Check docs/workflow-catalog.md — is Quick Quote listed?
2. Read Trading Analysis/Quick Quote/quick-quote.md
3. Follow the numbered steps in the doc
```

---

# North Star: Read Before Executing

**THE .MD FILE IS THE SOURCE OF TRUTH. YOUR MEMORY IS NOT.**

Before executing ANY workflow:
1. **USE THE READ TOOL** on the workflow's .md file - do not proceed from memory, context summaries, or prior sessions
2. **FIND THE NUMBERED STEPS** - execute them in order, do not skip steps
3. **FIND THE OUTPUT FORMAT** - use the exact column names, field names, and structure defined in the doc
4. **FIND THE REQUIRED QUERIES** - use the SQL/commands documented, do not improvise

If you catch yourself thinking "I remember how this works" - STOP and read the file instead.

---

# Output Formatting Standards

**ALL outputs — Excel, CSV, HTML emails, console tables — MUST be properly formatted:**

- **Currency:** `$1,234.56` (dollar sign, comma separators, 2-4 decimal places)
- **Percentages:** `18.5%` (with `%` sign). In Excel, use `0.0%` cell format.
- **Quantities:** Use comma separators for 1,000+. No decimals on whole quantities.
- **Excel number formats:** Always set `z` property: `$#,##0.00` for currency, `0.0%` for percentages.
- **Dates / timestamps:** Always Central Time, labeled `CT`. Use helpers in `shared/time-format.js`.

---

# North Star: Bug Fix Protocol (Test Before Processing)

**When the operator reports a bug using a specific stuck email/record:**

1. **DO NOT manually process the stuck item first.** The stuck item is your test case.
2. **Diagnose and fix the underlying bug** in the code/workflow.
3. **Use the stuck item to verify the fix works** — clear its stuck state and let the fixed code reprocess it.
4. **If multiple items are stuck**, fix first, then batch-recover all of them as validation.

**Anti-pattern:** Process stuck item → fix bug → no way to verify. **Correct:** Fix bug → reprocess stuck item → verified.

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
- `postApproveOrder()` validates ALL VQs are ticked AND links R_Request to the RFQ

**One request per supplier per RFQ:** When buying multiple VQs from the same supplier on the same RFQ (e.g., 9 parts from Mouser on one POV), create ONE R_Request containing all VQs — not separate requests per line. Pass `vqIds: [id1, id2, ...]` to validate all.

**Why this exists:** On 2026-07-07, approval request 1166798 was posted with incomplete VQs. On 2026-07-09, manual VQs were created with COO=USA (wrong) and missing warehouse.

**Full workflow:** Read `shared/vq-purchase-workflow.md` before ANY VQ approval.

**Date Code / Lead Time defaults:**
- Stock items: Date Code = `(current year - 2)+` (e.g., "24+")
- Lead time items: Date Code = `(current year)+` (e.g., "26+")
- Lead Time field: "STOCK" for in-stock, or specific time (e.g., "31 WEEKS")

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
8. **Workflow parity check** — run `scripts/check-workflow-parity.js --quiet`

---

## Scheduled Jobs (cron)

**Source of truth:** `cron-jobs.js` (registry). Crontab is auto-generated; never hand-edit `crontab -e`.

**Workflow for adding a scheduled activity:**
1. Print the Resilience Checklist (see workspace `CLAUDE.md` § Scheduling New Activities)
2. Add entry to `cron-jobs.js`
3. `node scripts/install-crons.js --apply`
4. Verify with `crontab -l` and `node scripts/check-cron-drift.js`

**Resilience pattern (built in via `cron-runner.js`):**
- **Sentinel** — per-job state records `lastSuccess` and `nextDue`
- **OT health gate** — jobs with `needsOT: true` probe `/api/v1/` before running
- **Drift check** — `scripts/check-cron-drift.js` runs at session start

---

## Shared Utilities

**Location:** `shared/`

### Data Model (REQUIRED — READ BEFORE ANY DB QUERY)

**`shared/data-model.md`** is the single source of truth for:
- Table hierarchies (RFQ → RFQ Line → RFQ Line MPN)
- Where fields live (MPN/MFR on `chuboe_rfq_line_mpn`, NOT `chuboe_rfq_line`)
- Join patterns and price column names (`cost` on VQ, `priceentered` on CQ/RFQ/Offer)
- REST API write-back (see `shared/api-writeback.md`)

### CSV Parsing (REQUIRED)

**NEVER use `line.split(',')`.** Use `shared/csv-utils.js`. See `shared/README.md`.

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

Follow conventions in `CONVENTIONS.md`:
- Workflow docs use `kebab-case.md` names
- Session history goes in `MEMORY.md` (4 most recent entries)
- Roadmaps for planned work go in `*-roadmap.md` files

**CRITICAL:** CLAUDE.md should point to detailed docs, NOT duplicate them inline.

---

## Terminology

See `MEMORY.md` for full list. Key terms:
- **CPC** — Customer Part Code
- **OT** — Orange Tsunami (iDempiere-based system)

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

At the end of each session, update the `## Recent Sessions` section in MEMORY.md. Keep only the 4 most recent entries.

---

# Environment

**Full documentation:** See `docs/environment.md`

## Critical Rules (Summary)

- **Database:** `idempiere_replica` — READ-ONLY (SELECT only)
- **Filter:** Always use `isactive = 'Y'` unless told otherwise
- **Write-back:** Use iDempiere REST API via `shared/api-client.js`
  - For `analytics_user`: use writers directly
  - For other users: use `shared/writeback-proxy-client.js`
- **Full API docs:** `shared/api-writeback.md`, `shared/writeback-proxy.md`

### Consumer Modules (Quick Reference)

| Module | Function | What It Writes |
|--------|----------|----------------|
| `shared/rfq-writer.js` | `writeRFQ(opts)` | chuboe_rfq + lines + line_mpn |
| `shared/offer-writeback.js` | `writeOffer(opts)` | chuboe_offer + lines + line_mpn |
| `shared/vq-writer.js` | `writeVQBatch(rfq, items)` | chuboe_vq_line |
| `shared/cq-writer.js` | `writeCQ(rfq, line)` | chuboe_cq_line |

### ⚠️ iDempiere Bean-Callout Traps

1. **`chuboe_offer_line` CPC dedup collapse** — two lines with same CPC will merge/deactivate
2. **`Chuboe_CPC` non-updateable** — must be set at POST time only
3. **Stale `mfr-cache.json`** — if cache lacks `isSystem`, MPN POSTs may 500
4. **`chuboe_offer_line` auto-creates `chuboe_offer_line_mpn`** — do NOT set `writeMpnRecords: true` or you get duplicates (discovered 2026-07-07)

**Full reference:** `shared/data-model.md` § chuboe_offer_line bean-callouts

---

**Connected to PRODUCTION** (https://172.31.7.239/api/v1). User: Claude Harris (ID: 1049524). Data written via the API will appear in production.

## Collaboration Style

Don't just execute requests — actively contribute ideas, alternatives, and feedback. Flag potential issues and suggest better approaches.
