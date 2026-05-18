# RFQ Loading through AI

AI-assisted extraction and loading of RFQs from customer emails into the RFQ Import Template for OT (iDempiere).

Handles **two parallel pipelines** with a shared extraction core:

| | Stock RFQ | General Customer RFQ |
|---|---|---|
| **Inbox** | `stockRFQ@orangetsunami.com` | `rfqloading@orangetsunami.com` |
| **Himalaya account** | `stockrfq` | `rfqloading` |
| **RFQ Type** | Always "Stock" (1000007) | User must specify — ask if missing |
| **Customer unknown** | Unqualified Broker (1008499) | Prompt to help create BP *(future workflow)* |
| **Contact person** | Required — infer from email sender, prompt if unresolved | Required — infer from forwarded/CC'd email, prompt if unresolved |
| **Missing info** | Process what's there | Draft reply requesting missing fields |
| **Output prefix** | `StockRFQ_UPLOAD_` | `RFQ_UPLOAD_` |
| **Email folder routing** | Processed / NotRFQ / NeedsReview | Processed / NotRFQ / NeedsReview / NeedInfo |

---

## Email Accounts

```bash
# Stock RFQ inbox
himalaya envelope list --account stockrfq --folder INBOX --page-size 500
himalaya message read --account stockrfq --folder INBOX [ID]
himalaya attachment download --account stockrfq --folder INBOX [ID]

# General Customer RFQ inbox
himalaya envelope list --account rfqloading --folder INBOX --page-size 500
himalaya message read --account rfqloading --folder INBOX [ID]
himalaya attachment download --account rfqloading --folder INBOX [ID]
```

**Himalaya config:** `~/.config/himalaya/config.toml`

---

## Template: RFQ Import Template

**File:** `RFQ Import Template.csv`

| Col | Column Name | Required | Population Logic |
|-----|-------------|----------|------------------|
| A | `Chuboe_RFQ_ID[Value]` | Conditional | See Column A Logic below |
| B | `Chuboe_CPC` | **YES** | Customer's part code if distinct from MPN. If no distinct CPC → use MPN |
| C | `Chuboe_MFR_Text` | No | Manufacturer name matched to `chuboe_mfr.name` in DB. Use `mfr-aliases.json` for normalization |
| D | `Chuboe_MPN` | **YES** | Manufacturer Part Number from the RFQ |
| E | `Qty` | **YES** | Quantity requested |
| F | `PriceEntered` | No | Customer's **target price** if provided. Leave blank if not stated |
| G | `Description` | No | Part-specific notes. See per-pipeline rules below |

> **Schema reference:** For RFQ table hierarchy and where MPN/MFR/CPC fields live, see [`shared/data-model.md`](../../shared/data-model.md) § RFQ Chain.

### Column A Logic (Chuboe_RFQ_ID)

**Stock RFQ pipeline:**
```
IF user provides RFQ# → use RFQ#
ELSE IF customer found in DB → customer BP search_key
ELSE → "1008499" (Unqualified Broker)
```

**General Customer RFQ pipeline:**
```
IF user provides RFQ# → use RFQ#
ELSE IF customer found in DB → customer BP search_key
ELSE → HOLD — prompt user to create BP (future workflow)
```

**Why search_key?** The user needs to create the RFQ in OT first. Having the customer ID lets them quickly create the RFQ and then bulk-import the lines.

### Column B Logic (Chuboe_CPC)

```
IF customer provides a distinct internal part code → use CPC
ELSE → use MPN (same value as column D)
```

### Column C Logic (Chuboe_MFR_Text)

MFR resolution follows the standard pattern. See [`shared/data-model.md`](../../shared/data-model.md) § Manufacturer for resolution order.

### Column G Logic (Description)

**Stock RFQ pipeline:** If customer is Unqualified Broker (1008499), put the actual customer/company name here.

**General Customer RFQ pipeline:** Part-specific notes from the RFQ (lead time requirements, packaging preferences, date code constraints, etc.).

---

## Customer/Partner Matching (DO NOT SKIP)

**Uses shared module:** `shared/partner-lookup.js` — see `shared/partner-matching.md` for full documentation.

```javascript
const { resolvePartner } = require('../../shared/partner-lookup.js');

const result = resolvePartner({
  email: senderEmail,
  companyName: companyNameFromSignature,
  partnerType: 'any'
});
```

**Stock RFQ fallback:** No match → use `1008499` (Unqualified Broker), put company name in Description.

**General Customer RFQ fallback:** No match → HOLD the email. Draft a response to the user explaining no BP match was found and offer to help create one *(future workflow — see Roadmap)*.

---

## Contact Person Resolution (REQUIRED — Both Pipelines)

Contact person (`Chuboe_User_ID`) is **required on ALL RFQs** — both Stock and General Customer. It maps to `Chuboe_User_ID` on the RFQ header. The `rfq-writer.js` module enforces this and will throw an error if `userId` is not provided.

There are TWO contacts to resolve, and they're often different people:

| Field | Who | Default | Notes |
|---|---|---|---|
| `userId` (`Chuboe_User_ID`) | The **customer contact** — person at the customer BP who owns this RFQ on their side | — (required, no default) | Resolve via the customer-side ladder below |
| `salesrepId` (`SalesRep_ID`) | The **Astute operator-on-record** — internal owner | 1000004 (Jake) | Resolve via the Astute-side ladder ("Astute Operator Resolution") |

### Customer-side ladder (sets `userId`)

1. **Email sender:** Extract sender email address from the email
2. **Forwarded email (General RFQ):** Extract the original sender's email from forwarded message headers
3. **CC'd contacts:** Check CC/To fields for customer-domain emails (not internal @astutegroup.com / @orangetsunami.com)
4. **Match against OT:** Look up email in `ad_user` table:
   ```sql
   SELECT u.ad_user_id, u.name, u.email, u.c_bpartner_id
   FROM adempiere.ad_user u
   WHERE u.isactive = 'Y'
     AND u.email ILIKE $1
     AND u.c_bpartner_id = $2;  -- must belong to the matched customer BP
   ```
5. **Multiple matches:** If multiple contacts exist for the same BP, list them and ask the user to confirm
6. **No match → PROMPT USER:** Do not proceed without a contact. Present: "Contact [name/email] not found under [Customer]. Please provide the correct contact ID or confirm if we should create a new one." *(Contact creation = future workflow — see Roadmap)*

> **Important:** This applies to Stock RFQs too. If the sender email doesn't resolve to an `ad_user` under the matched BP (or under Unqualified Broker 1008499), prompt the user before writing.

### Astute Operator Resolution (sets `salesrepId`)

Support staff (assistants, ops people) increasingly forward customer RFQs on behalf of the sales rep who owns the account. The outer `From:` is the support person; the real operator is one hop deeper in the quoted chain. Resolve in this order, first match wins:

- **Tier A — Internal forward chain (primary signal).** If the **outer `From:`** is `@astutegroup.com` AND there is a **deeper `@astutegroup.com` `From:`** in the quoted block, the **outer is the forwarder** and the **deeper one is the operator-on-record**. Resolve the deeper email via `resolveAstuteUserByEmail(deeperEmail)` from `shared/partner-lookup.js` and pass the result as `salesrepId`. This is the dead giveaway pattern; it does not require any explicit text hint.
- **Tier B — Explicit text hint (fallback).** If Tier A doesn't fire, scan the forwarder's note + signature block + subject for explicit owner hints like `on behalf of <Name>`, `for <Name>`, `assigned to <Name>`, `salesrep: <Name>`. If found, call `resolveAstuteUserByName(name)`:
  - `unambiguous: true` → pass that `userId` as `salesrepId`.
  - `ambiguous: true` → escalate via `need_info` with the candidate list rather than guessing.
  - `null` → fall through to Tier C.
- **Tier C — Outer forwarder.** If the outer `From:` is `@astutegroup.com` and Tier A didn't fire (no deeper internal sender), resolve the outer via `resolveAstuteUserByEmail(outerEmail)`. This is the standard direct-from-rep pattern.
- **Tier D — Default (last resort).** No internal sender anywhere → omit `salesrepId` from the payload. The handler defaults to Jake (1000004).

**Don't conflate the two ladders.** `userId` is on the CUSTOMER side (their contact); `salesrepId` is on the ASTUTE side (our operator). A typical forwarded RFQ has the customer contact buried in the quoted block AND a separate Astute forward chain on top of it — both need separate resolution.

---

## RFQ Type Resolution (General Customer RFQ Only)

The RFQ type is **required** on general customer RFQs. It determines how the RFQ is categorized in OT.

### Valid RFQ Types

| ID | Name | When to use |
|----|------|-------------|
| 1000000 | Shortage | Customer has a shortage / urgent need |
| 1000001 | PPV | Purchase price variance / cost reduction |
| 1000002 | Astute Franchised | Franchise fulfillment |
| 1000003 | EOL/LTB | End of life / last time buy |
| 1000004 | 3PL/VMI | Third-party logistics / vendor managed inventory |
| 1000005 | Proactive Offer | Astute proactively offering |
| 1000006 | Import | Import order |
| 1000007 | Stock | Broker stock inquiry (Stock RFQ pipeline default) |
| 1000012 | Unqualified Spot RFQ | Unqualified spot buy |
| 1000013 | Hot Parts | High-demand / hot market parts |

### Inference Rules

Before asking the user, try to infer:
1. **Email subject line** — keywords like "shortage", "EOL", "LTB", "PPV", "urgent"
2. **Customer context** — known program types (e.g., LAM kitting = 3PL/VMI)
3. **Forwarding salesperson** — if they consistently handle one type

If still unclear → **draft reply** requesting the RFQ type (see Missing Info Handling below).

---

## Missing Info Handling (General Customer RFQ Only)

When required information is missing, draft a reply for the user to review before sending.

### Required Fields Check

| Field | Required? | If Missing |
|-------|-----------|------------|
| RFQ Type | Yes | Draft reply requesting type |
| Customer / BP | Yes | Draft reply — offer to help create BP |
| Contact Person | **Yes (both pipelines)** | Prompt user — ask for contact or offer to create |
| MPN | Yes | Draft reply — cannot process without parts |
| Quantity | Yes | Draft reply — need qty to load |
| Manufacturer | Nice-to-have | Proceed — attempt MFR inference from MPN |
| Target Price | Nice-to-have | Proceed — leave blank |
| CPC | Nice-to-have | Proceed — default to MPN |

### Draft Reply Template

When drafting a reply, present it to the user for approval. Format:

```
To: [original sender / forwarding salesperson]
Subject: RE: [original subject]

Hi [name],

I'm processing this RFQ but need a few details:

[List only what's actually missing:]
- **RFQ Type:** Is this a Shortage, PPV, EOL/LTB, or other? (Options: Shortage, PPV, Astute Franchised, EOL/LTB, 3PL/VMI, Hot Parts)
- **Contact:** I couldn't match [email] to a contact in OT. Can you confirm who this should be under?
- **Quantities:** Quantities weren't listed for some line items — can you confirm?

Thanks,
[sent from rfqloading inbox]
```

**Important:** Always show the draft to the user for review. Do not auto-send.

---

## Skip / Flag Rules

| Condition | Action | Applies to |
|-----------|--------|------------|
| Email with MPN + quantity | **Process** | Both pipelines |
| Broker blast with MPN + qty | **Process** as 1008499 | Stock RFQ only |
| Inquiry only (no parts listed) | **Skip** → `NotRFQ` | Both |
| Duplicate (same customer + parts already processed) | **Skip** → `Duplicates` | Both |
| PDF/attachment only (no inline data) | **Queue** for attachment extraction | Both |
| No extractable part data (marketing, newsletters) | **Skip** → `Junk` | Both |
| Missing required info (type, contact, customer) | **Hold** → `NeedInfo` | General RFQ only |

### Why we process everything (Stock RFQ)

Every RFQ with a part number represents **activity around that part**. Even if we won't quote a particular sender, capturing the MPN + quantity as an RFQ line gives the trading team visibility into demand. A sender not matching a DB partner just means they're loaded under Unqualified Broker (1008499). The trading team decides whether to quote.

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 1: Identify Pipeline

Determine which inbox the user wants to process:
- `stockrfq` → Stock RFQ pipeline
- `rfqloading` → General Customer RFQ pipeline

If the user says "RFQ loading" without specifying, ask which inbox.

### Step 2: Fetch Emails

```bash
# Stock RFQ
himalaya envelope list --account stockrfq --folder INBOX --page-size 500

# General Customer RFQ
himalaya envelope list --account rfqloading --folder INBOX --page-size 500
```

List all unprocessed emails in INBOX. Note email IDs for processing.

### Step 3: Read and Categorize Emails

Read each email body (and attachments if needed). Categorize:
- **Process** — has MPN + quantity
- **NotRFQ** — no parts data
- **Duplicate** — same customer + parts already processed
- **NeedInfo** *(General RFQ only)* — has parts but missing required fields
- **LargeRFQApproval** *(General RFQ only)* — see Step 3a below

### Step 3a: Large-RFQ Approval Replies (DO NOT SKIP — quick scan before normal triage)

Before applying the rest of Steps 3–10, check the subject line. The large-RFQ approval gate (`shared/large-rfq-gate.js`) sends emails from `rfqloading@` with subject pattern:

```
[APPROVAL NEEDED] Large RFQ <RFQ#> from <customer> — <N> lines
```

Replies appear with `RE:` prepended. **If the subject matches `RE: [APPROVAL NEEDED] Large RFQ <RFQ#>`**, treat this as an approval reply, NOT a customer RFQ. Steps 4–9 do NOT apply.

**Extract directive from the first non-empty line of the reply body** (above any quoted-original or signature):

| Reply directive (case-insensitive, first non-quoted line) | Action |
|---|---|
| `yes` / `y` / `approve` / `go` / `proceed` | `approve_large_rfq` with `rfq_number` extracted from subject, no cap |
| `yes --max-lines 1000` / `limit 1000` / `cap 1000` | `approve_large_rfq` with `rfq_number` + `max_lines: 1000` |
| `yes --cache-only` / `cache only` / `cache-only` | `approve_large_rfq` with `rfq_number` + `cache_only: true` — runs enrichment off cached envelopes only, no live API spend |
| `no` / `n` / `reject` / `skip` / `decline` | `reject_large_rfq` with `rfq_number` extracted from subject; pull `reason` from any trailing text on the same line if present |
| Anything else / unclear | `needs_review` — let the operator clarify |

**Combinable modifiers:** `yes --cache-only --max-lines 1000` is valid — pass both `cache_only: true` and `max_lines: 1000`.

**RFQ # extraction:** the subject ALWAYS contains `Large RFQ <N>` — regex `Large RFQ\s+(\d+)` captures it.

**Body parsing notes:**
- Ignore everything below a quoted-original marker (`From: ...`, `On <date>, <name> wrote:`, `>` prefix lines, `-----Original Message-----`).
- Ignore signature blocks below the first line (typical pattern: corporate footer like "Trading Manager … Astute Electronics Inc.").
- Read just the first non-empty, non-quoted line. A reply containing only "No" plus a sig block is a reject — that's the canonical case from the 2026-05-13 preview test.

**Move processed approval messages to `LargeRFQApprovals/` folder.** Acknowledgment email back to operator is sent automatically by the action handler.

**No new BP, contact, or RFQ-line extraction is needed for approval replies** — the action just calls `largeRfqGate.markApproved` / `markRejected`. Skip the entire customer-resolution stack for these.

### Step 4: Triage Missing Info (General Customer RFQ Only — DO NOT SKIP)

For each General Customer RFQ email, check:
1. **RFQ Type** — Can it be inferred? If not → draft reply
2. **Customer** — Does BP exist? If not → draft reply, offer to help create *(future workflow)*
3. **Contact** — Can contact be resolved from forwarded/CC'd email? If not → draft reply
4. **Quantities** — Are they present for all line items? If not → draft reply

If any required field is missing:
- Draft the reply (see template above)
- Present to user for review
- Move email to `NeedInfo` folder
- Continue processing remaining emails

### Step 5: Extract RFQ Line Items (Two-Agent Validation)

- **Agent A (Extractor):** Reads emails, extracts: MPN, Qty, MFR, CPC (if distinct), target price (if given), customer name/email
- **Agent B (Verifier):** Independently reads same emails, verifies extractions
- Resolve discrepancies by re-reading the email

### Step 6: Resolve Customer IDs (CRITICAL — DO NOT SKIP)

For each email's sender:
1. Extract sender email domain (or forwarded sender for General RFQ)
2. Look up in DB using domain-based partner matching
3. **Stock RFQ:** If found → record `search_key`. If NOT found → use `1008499`
4. **General RFQ:** If found → record `search_key`. If NOT found → HOLD (should have been caught in Step 4)

### Step 7: Resolve Contact Person (BOTH PIPELINES — DO NOT SKIP)

1. Extract contact email from sender (Stock RFQ) or forwarded/CC'd headers (General RFQ)
2. Match against `ad_user` for the resolved BP
3. If matched → record `ad_user_id` and `name`
4. If not matched → **prompt user** for the contact before proceeding to output

### Step 8: MFR Matching

For each manufacturer in the extracted data:
1. Check `mfr-aliases.json` for canonical name
2. If no alias, search DB: `SELECT name FROM adempiere.chuboe_mfr WHERE ad_client_id = 1000000 AND name ILIKE '%keyword%'`
3. If new alias found, add to `mfr-aliases.json`

### Step 9: Output — Choose Path

Three output paths are available. Choose based on RFQ size:

| RFQ size | Path | Notes |
|---|---|---|
| < 100 lines | **Path A** (rfq-writer.js) | MFR + description enriched inline, sequential |
| 100+ lines | **Path A-Fast** (fast loader / daemon queue) | Concurrent (10 workers, ~12 lines/s), no enrichment — MFR resolved later by reconciler |
| Any (fallback) | **Path B** (CSV) | Manual import into OT |

#### Path A: Direct Write-Back via API (Preferred)

See [`shared/api-writeback.md`](../../shared/api-writeback.md) for payload specs and [`shared/rfq-writer.js`](../../shared/rfq-writer.js) for the write module.

1. **POST RFQ header** — `chuboe_rfq` with: `C_BPartner_ID`, `Chuboe_RFQ_Type_ID`, `SalesRep_ID`, `Chuboe_User_ID` (contact — required), `Description`
2. **Capture system-generated RFQ ID and search key** from response (`id` for linking, `Value` for user reference)
3. **POST RFQ lines** — `chuboe_rfq_line` with: `Chuboe_RFQ_ID` (from step 1), `Chuboe_CPC`, `Qty`, `PriceEntered`
4. **POST RFQ line MPNs** — `chuboe_rfq_line_mpn` with: `Chuboe_RFQ_Line_ID` (from step 2), `Chuboe_MPN`, `Chuboe_MFR_Text` + `Chuboe_MFR_ID` (auto-resolved by `rfq-writer.js`)

##### Known issue (fixed 2026-04-06): MFR cache stale schema → silent prod failures

The first prod run of `rfq-writer.js` (LAM EPG, RFQ 1132037, voided) had ~80% of `chuboe_rfq_line_mpn` POSTs rejected with `"System ID X cannot be used in Chuboe_MFR_ID"`. Root cause:

- `shared/data/mfr-cache.json` had been built up against the test instance and lacked the `isSystem` field on 116/122 entries
- `lookupMfr()` returned `isSystem: false` for system-level MFRs (AD_Client_ID=0)
- `rfq-writer.js` then included `Chuboe_MFR_ID` in payloads for those MFRs
- **Test iDempiere silently accepts** system MFR IDs in client tables; **prod iDempiere enforces a model validator that rejects them with a 500**

**Fixes applied:**
- `shared/mfr-lookup.js` — stale-cache guard: ignores cache entries with an `id` but no `isSystem` field, forces re-resolve from DB
- `shared/api-client.js` — installs an Undici dispatcher with `rejectUnauthorized: false` when `IDEMPIERE_BASE_URL` is HTTPS (prod uses a self-signed cert that Node fetch rejected by default)
- `shared/data/mfr-cache.json` — rebuilt fresh

**If you ever rebuild or hand-edit the MFR cache, every entry must carry `{name, id, isSystem}`.** Omitting `isSystem` will silently poison subsequent writes. See memory `feedback_mfr_text_only_api` and `project_test_vs_prod_idempiere`.

#### Path A-Fast: Queue via Loader Daemon (for 500+ line RFQs)

Use when the RFQ has 100+ lines. Loads concurrently with 10 workers (~20 lines/s). No MFR ID resolution at load time — MFR text is written raw, and the MFR reconciler cron (J4, Wed+Sun) resolves IDs system-wide later. Franchise API enrichment happens via `enrich-poller.js` (every 15 min) after loading.

See [`shared/rfq-fast-loader.js`](../../shared/rfq-fast-loader.js) and [`shared/rfq-load-queue.js`](../../shared/rfq-load-queue.js).

1. **Build the payload** — same fields as Path A: `bpartnerId`, `type`, `userId`, `salesrepId`, `description`, `lines[]`
2. **Enqueue the job:**
   ```javascript
   const { enqueue } = require('../../shared/rfq-load-queue');
   const jobId = enqueue({
     bpartnerId, type, description, salesrepId, userId,
     lines, // raw: { mpn, mfrText, qty, targetPrice, cpc, description, dateCode }
   });
   console.log(`Queued as ${jobId} — daemon loads within 10 seconds`);
   ```
3. **Monitor progress:**
   ```bash
   node astute-workinstructions/scripts/rfq-loader-daemon.js --status
   ```
4. **When status = `loaded` or `partial`:**
   - `rfqId` and `searchKey` are in the queue item
   - `errors[]` contains line-level failures (header + most lines are complete)
   - `enrich-poller.js` picks up the new RFQ on its next 15-min tick for franchise API enrichment
   - MFR reconciler (Wed+Sun) resolves `Chuboe_MFR_ID` from raw text

**Priority:** RFQs under 100 lines = high priority (loaded first). 100+ = low priority (preempted by small RFQs arriving mid-load). The daemon resumes large jobs from checkpoint after small jobs complete.

**Daemon lifecycle:** Cron healthcheck every 5 min starts the daemon if not running. PID file prevents duplicates. Graceful shutdown on SIGTERM writes checkpoint for resume.

#### Path B: Generate CSV for Manual Import

Use when: API is unavailable, or user explicitly requests a CSV for manual import into OT.

- **One consolidated file per run per pipeline** (not per email)
- Filename: `StockRFQ_UPLOAD_YYYYMMDD.csv` or `RFQ_UPLOAD_YYYYMMDD.csv`
- Template format: 7 columns matching `RFQ Import Template.csv`
- Populate `Chuboe_RFQ_ID[Value]` with RFQ# (if given) or customer search_key
- **Stock RFQ:** Populate Description with customer name if using 1008499
- **General RFQ:** Include a summary header comment with: RFQ type, contact name, contact email

**Output location:** `Trading Analysis/RFQ Loading/output/`

**Note:** Both paths can run together — generate the CSV as a backup/audit trail even when using API write-back.

### Step 10: Post-Write Summary

After write-back (or CSV generation) is complete, present results. This is a **report**, not a confirmation gate — writing happens in Step 9.

**Stock RFQ example:**
```
═══════════════════════════════════════════════════════════
  Stock RFQ Loading Summary — 2026-04-01
═══════════════════════════════════════════════════════════

  Emails:  6 processed  |  1 skipped (NotRFQ)
  Lines:   38 written

  ┌─────────────────────────────┬────────────┬───────┬──────────────┐
  │ Customer                    │ Search Key │ Lines │ Contact      │
  ├─────────────────────────────┼────────────┼───────┼──────────────┤
  │ Velocity Electronics        │ 1003887    │    12 │ M. Chen      │
  │ Chip One Exchange           │ 1002104    │     9 │ R. Tanaka    │
  │ Unqualified Broker          │ 1008499    │    17 │ Jake Harris  │
  │   → "Global Parts Direct" (8 lines)                            │
  │   → "Shenzhen IC Supply" (5 lines)                             │
  │   → "BCS Components" (4 lines)                                 │
  └─────────────────────────────┴────────────┴───────┴──────────────┘
```

**General Customer RFQ example:**
```
═══════════════════════════════════════════════════════════
  Customer RFQ Loading Summary — 2026-04-01
═══════════════════════════════════════════════════════════

  Emails:  3 written  |  1 held (NeedInfo)
  Lines:   52 written

  ┌──────────────────────┬────────────┬──────────┬──────────────┬───────┐
  │ Customer             │ Search Key │ RFQ Type │ Contact      │ Lines │
  ├──────────────────────┼────────────┼──────────┼──────────────┼───────┤
  │ LAM Research         │ 1000512    │ 3PL/VMI  │ S. Park      │    28 │
  │ Celestica            │ 1000190    │ Shortage │ D. Nguyen    │    15 │
  │ GE Aerospace         │ 1000455    │ PPV      │ K. Patel     │     9 │
  └──────────────────────┴────────────┴──────────┴──────────────┴───────┘

  ⚠ Held — NeedInfo (1 email, 23 lines):
    → Fwd from Tim Premo: "RFQ from Acme Electronics"
      Customer: Acme Electronics (1004221)
      Contact: lisa.wong@acmeelectronics.com → Lisa Wong (confirmed)
      Missing: RFQ Type not specified

      Sample lines:
        MPN                    Qty      Target
        BAT54SLT1G           5,000     $0.12
        LM358DR              2,500       —
        STM32F103C8T6        1,000     $3.50
        ... +20 more

      Likely type? Parts mix suggests Shortage or PPV.
      → Specify type to proceed, or I'll draft a reply to Tim asking.
```

**Key points:**
- Summary shows what was **already written**, not what's pending approval
- NeedInfo emails show enough context (customer, contact, sample lines) for the user to resolve inline
- Unqualified Broker (1008499) always defaults to Jake Harris as contact
- Unqualified Broker sub-entries show the actual company names (captured in Description)

### Step 11: Route and Move Emails

```bash
# Move processed emails
himalaya message move --account [account] --folder INBOX [destination] [IDs...]
```

| Condition | Folder |
|-----------|--------|
| Processed (MPN+qty extracted) | `Processed` |
| Not an RFQ (no parts data) | `NotRFQ` |
| Missing required info (General RFQ) | `NeedInfo` |
| Needs manual review | `NeedsReview` |

### Step 12: Email Output File

Send consolidated CSV to jake.harris@astutegroup.com.

**Stock RFQ subject:** `Stock RFQ Upload Ready - YYYY-MM-DD`
**General RFQ subject:** `Customer RFQ Upload Ready - YYYY-MM-DD`

### Step 13: Commit and Push

```bash
git -C ~/workspace/astute-workinstructions add "Trading Analysis/RFQ Loading/"
git -C ~/workspace/astute-workinstructions commit -m "Add RFQ upload: YYYY-MM-DD"
git -C ~/workspace/astute-workinstructions push
```

---

## Cadence

- **Stock RFQ:** Steady inflow, not high volume. Process regularly (daily or every few days).
- **General Customer RFQ:** Process as they arrive — salesperson is waiting on the RFQ to be loaded.

---

## Automation (Claude-driven, General Customer RFQ)

**Pattern:** This workflow is the reference implementation for the email-driven workflow architecture. **All email-driven workflows in this codebase use the same pattern.** See [`email-workflow-architecture.md`](../../email-workflow-architecture.md) (top-level) for the full spec.

**CLI:** `shared/email-workflow-poller.js` (generic) — invoked with `--workflow rfq-loading`. The legacy entry point `Trading Analysis/RFQ Loading/rfq-loading-poller.js` is preserved as a delegating shim for the existing `/schedule` routine; both paths produce identical output.

**Workflow module:** `shared/workflow-actions/rfq-loading.js` — owns the inbox name, notifier config, and routing-action handlers (the per-workflow logic).

**Extraction:** performed by Claude in-session (not by an external API call). The CLI exposes IMAP + routing primitives only.

### How it works

The poller CLI has three commands (all require `--workflow rfq-loading`, or use the legacy shim which auto-injects it):

| Command | Purpose |
|---|---|
| `list` | Prints UNSEEN envelopes in `rfqloading@orangetsunami.com` as JSON (uid, subject, from, attachment names) |
| `read <uid>` | Prints the full email as JSON: body, parsed forwarded-message headers, external sender (vs. internal forwarder), attachment list |
| `route <uid> <action> --payload <json\|file>` | Executes a routing decision and moves the email to the matching folder |

Claude drives the workflow by calling `list`, then `read` per email, performing the extraction + BP/contact resolution in-session, and calling `route` with one of four actions:

| Action | Payload | Effect |
|---|---|---|
| `enqueue` | `{ bpartnerId, type, userId, description, lines[] }` | Enqueues to `rfq-load-queue` (picked up by the fast-loader daemon within 5 min); moves email → `Processed` |
| `need_info` | `{ recipient, missing[], subject }` | Auto-replies to the external sender with the specific missing-info list (Jake on CC, Reply-To: Jake); moves email → `NeedInfo` |
| `needs_review` | `{ reason, details, subject, from }` | Emails Jake diagnostics for manual triage; moves email → `NeedsReview` |
| `not_rfq` | `{}` | Silent move → `NotRFQ` |

The `missing[]` array accepts: `mpn`, `qty`, `rfq_type`, `contact`, `customer`.

### Scheduling

The expected pattern is a **scheduled remote agent** (see `/schedule`) that runs every 2 minutes, fetches the unseen list, and processes each one end-to-end. On-demand invocation (operator asks "process rfqloading inbox") works identically.

### Flags

- `--dry-run` — prints what would happen; does not enqueue, send email, or move messages

### Dependencies

- `shared/email-fetcher.js` (ImapFlow) — reused transitively by the shared auth pattern
- `shared/notifier.js` — extended 2026-04-15 with `cc` / `bcc` / `replyTo` opts
- `shared/rfq-load-queue.js` — `enqueue()` for the fast-loader daemon
- `shared/partner-lookup.js` — `resolvePartner()` (Claude calls this during extraction)
- `~/workspace/.env` → `WORKMAIL_PASS`, `IMAP_HOST`, `IMAP_PORT`

### v1 scope / known limits

- **Attachment RFQs (PDF/xlsx):** the poller surfaces attachment names in `list` and `read` output. Claude reads attachments via the standard Read tool (for PDFs, paged). No separate extraction pipeline.
- **Stock RFQ pipeline not yet wired.** The `rfqloading` account is hardcoded; generalize to accept an `--account` flag if we want to reuse for `stockrfq`.
- **Auto-sends customer replies.** The `need_info` action sends immediately. If approval-first is needed, add a `draft_need_info` action that mails Jake the proposed reply.

---

## Future Workflows (see Roadmap)

These workflows are referenced above but not yet built:

| Workflow | Trigger | Roadmap Location |
|----------|---------|------------------|
| **Business Partner Creation** | General RFQ customer not found in OT | `trading-analysis-roadmap.md` § F1 |
| **Contact Creation** | Contact email not found under known BP | `trading-analysis-roadmap.md` § F2 |

**For now:** When these situations arise, draft a clear response to the user explaining what's needed and offer to assist manually.

---

## Migration: Stock RFQ Loading

The existing `Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md` workflow is the predecessor to this unified doc. The Stock RFQ pipeline described here supersedes it. The old directory (`Stock RFQ Loading/output/`) can continue to hold historical output files; new output goes to `RFQ Loading/output/`.

---

## Setup Required

- [ ] Create `rfqloading@orangetsunami.com` mailbox in AWS WorkMail
- [ ] Add `rfqloading` account to `~/.config/himalaya/config.toml`
- [ ] Create email folders in rfqloading mailbox: Processed, NotRFQ, NeedsReview, NeedInfo
- [ ] Test email fetch with `himalaya envelope list --account rfqloading --folder INBOX`

---

## Related

- [Stock RFQ Loading (legacy)](../Stock%20RFQ%20Loading/stock-rfq-loading.md) — Predecessor, Stock pipeline only
- [Market Offer Loading](../Market%20Offer%20Loading/market-offer-loading.md) — Sister workflow, same MFR matching and partner lookup patterns
- [VQ Loading](../RFQ%20Sourcing/vq_loading/vq-loading.md) — Similar two-agent extraction pattern
- MFR Aliases: `../Market Offer Loading/mfr-aliases.json` (shared)
- [Data Model](../../shared/data-model.md) — Schema reference for RFQ tables
