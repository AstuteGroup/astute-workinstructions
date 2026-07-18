# Market Offer Loading Workflow

**Purpose:** Get market offers persisted in OT with full fidelity. Loading writes; it does NOT analyze, enrich, or score.

**By default:** Loading triggers the [Customer Excess Analysis](../Customer%20Excess%20Analysis/customer-excess-analysis.md) workflow on the newly written offer(s) when complete. Use `--no-analyze` to skip.

---

## ⚠️ READ FIRST — Two iDempiere constraints that silently destroy data

Loading offers into OT has two server-side constraints that will corrupt or drop data without any error from the loader. **Every loader script must respect these.**

### 1. CPC bean-callout collapse on `chuboe_offer_line`

The server dedups offer lines by `(chuboe_offer_id, chuboe_cpc)` — strict equality, ignoring MPN. When two lines on the same offer share a non-empty CPC:

- The earlier survivor's `chuboe_mpn` is **comma-merged** in place (e.g., `MPN_A` becomes `MPN_A,MPN_B`) — corrupts its `chuboe_mpn_clean` join key
- The new line is set `isactive=N` with description `"deactived - duplicate CPC - See Line #<survivor>"`
- POST returns `200 OK` and a new ID — the loader sees no error

**Verified empirically 2026-04-08** with totally distinct MPNs (`5962-1620804QZC` vs `TESTAVL-COLLAPSE-CHECK`). The collapse fires regardless of MPN difference.

**Mitigation patterns (pick one based on your data shape):**

| Data shape | Pattern |
|---|---|
| Multi-row-per-CPC (Sanmina date code/lot detail) | **Per-CPC anchor** — only the first row per unique CPC carries `chuboe_cpc`; all others POST with `chuboe_cpc=''`. Capture the linkage in `Description` text. |
| AVL / multi-MPN-per-CPC (one part with N alternate MPNs) | **Sub-row alternates** — write the primary MPN as one `chuboe_offer_line` row, write the alts as `chuboe_offer_line_mpn` sub-rows under it. Sub-table is **not** subject to the callout. |
| Single-MPN-per-CPC (most cases) | No mitigation needed — each line has a unique CPC value. |

### 2. `Chuboe_CPC` is non-updateable on existing rows

PATCH against the column returns `500 "Cannot update column Chuboe_CPC"`. CPC must be set at POST time only. There is no recovery path via the standard write API for a missing CPC.

### See also

- `shared/offer-writeback.js` header docstring (full warning + mitigation code)
- `shared/data-model.md` § chuboe_offer_line CPC bean-callout (schema-level reference)
- `shared/api-writeback.md` § 12. chuboe_offer_line (API-level reference)
- `feedback_avl_multi_mpn_loading.md` (loading-rule rationale + workarounds)
- `project_chuboe_offer_line_cpc_collapse.md` (incident detail + Chuck follow-up)

---

## Pipeline

```
Retrieve from inbox/file
        │
        ▼
Resolve partner ──── NEEDS-PARTNER ──→ flag, route to NeedsPartner folder, STOP
        │
        ▼
Resolve MFRs (per line)
        │
        ▼
Write to OT  ──→  chuboe_offer (header)
                  + chuboe_offer_line (per line)
                  + chuboe_offer_line_mpn (optional)
        │
        ▼
Move email → Processed
        │
        ▼
Trigger Analysis (default)  ──→  passes new offerId(s) to Workflow B
```

---

## Cogs Used

| Cog | Role | Status |
|---|---|---|
| `shared/email-fetcher.js` | List/read/move emails, download attachments. Factory: `createFetcher('excess')` | Built, in production use by VQ + Stock RFQ loaders |
| `shared/email-tracker.js` | Processed-email dedup, retry queue | Built |
| `shared/partner-lookup.js` | 4-tier resolve (email → domain → hint → name) | Built |
| `shared/mfr-lookup.js` | Alias → DB → cache, returns `isSystem` flag | Built |
| `shared/offer-writeback.js` | `writeOffer({...})` — header + lines + optional `_line_mpn`, MFR resolution, system-MFR skip | **Built but untested in prod — smoke test required on first use** |
| `shared/api-client.js` | Underlying REST client; auto-auth, batch, retry | Built |

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 0: First-Use Smoke Test (one time per environment)

`writeOffer()` has not yet been exercised in prod. Before any full-batch write, do a one-line smoke test against the target inbox's first offer:

1. Pick the smallest line from the offer (1 MPN, 1 qty, 1 price if available)
2. Call `writeOffer({ bpartnerId, offerTypeId, description, lines: [oneLine] })`
3. Verify in OT:
   - New `chuboe_offer` row exists with the returned `searchKey`
   - One `chuboe_offer_line` exists under it
   - One `chuboe_offer_line_mpn` exists (auto-created by iDempiere bean callout)
   - MFR text resolved correctly (canonical name, not raw)
4. If clean → mark Step 0 satisfied for this environment, proceed to Step 1
5. If broken → fix the writer, void the test offer, retry. Same protocol as RFQ 1132037 → 1132040 (see `MEMORY.md` and `project_test_vs_prod_idempiere.md`)

> **Why this exists:** `offer-writeback.js` mirrors `rfq-writer.js` patterns but has never been called against prod. Same lesson as the RFQ writer's first run — bean callouts and system-MFR rejections only fire in prod, not test.

### Step 1: Retrieve

```javascript
const { createFetcher } = require('../../shared/email-fetcher');
const fetcher = createFetcher('excess');

const envelopes = await fetcher.listEnvelopes('INBOX', 500);
// for each new envelope:
const body = await fetcher.readMessage(id);
await fetcher.downloadAttachments(id, downloadDir);
```

**For attachments (xlsx/csv):** parse via `xlsx` package or `shared/csv-utils.js`. **Never use `line.split(',')`.**

**For body-only offers:** extract MPN/qty rows from prose. Many emails are forwards — actual offer data is BELOW the signature block. Always read to the bottom.

**Output of Step 1:** Array of normalized line objects per offer:
```javascript
[{ mpn, mfrText, qty, price, dateCode, cpc, leadTime, packageDesc }, ...]
```

### Step 2: Resolve Partner (CRITICAL — DO NOT SKIP)

```javascript
const { resolvePartner } = require('../../shared/partner-lookup');
const result = resolvePartner({
  email: senderEmail,
  companyName: companyNameFromSignature,
  partnerType: 'any'
});
// → { search_key, name, matched, tier, tierName }
```

**Tiers (in order):** exact email → email domain → domain hint → name match.

**If `result.matched === false`:** flag offer as `NEEDS-PARTNER`, move email to `NeedsPartner` folder, **do NOT write to OT.** Loading stops here for this offer.

> **Why this matters:** An offer without a resolved partner has no `c_bpartner_id`, which is mandatory on `chuboe_offer`. Trying to write would fail anyway. Stopping early prevents wasted API calls and dirty error logs.

### Step 3: Resolve Manufacturers (per line)

`writeOffer()` does this internally via `shared/mfr-lookup.js`, but pre-warming the cache reduces per-line latency and surfaces unresolved MFRs early:

```javascript
const { lookupMfr } = require('../../shared/mfr-lookup');
for (const line of lines) {
  const m = lookupMfr(line.mfrText);
  if (!m.matched) console.warn(`Unresolved MFR: ${line.mfrText}`);
  if (m.isSystem) {
    // System-level MFR — writer will use text only, skip Chuboe_MFR_ID
  }
}
```

**Add unresolved entries to** `mfr-aliases.json` if recurring (canonical names from `chuboe_mfr.name`). See `shared/data-model.md` § Manufacturer.

### Step 4: Determine Offer Type

| Type | ID | When to use |
|---|---|---|
| Customer Excess | 1000000 | Customer (OEM/EMS) selling their surplus, including consignment / rev-share |
| Broker Stock Offer | 1000001 | Broker pushing a stock list (not customer) |
| Franchise Offers | 1000002 | Authorized distributor offering excess |
| Customer Lead Time Buy | 1000003 | Customer offering lead-time committed inventory |
| Stock - Austin Warehouse | 1000008 | Internal Astute inventory, Austin |
| Stock - Hong Kong Warehouse | 1000009 | Internal Astute inventory, HK |
| Stock - Stevenage | 1000006 | Internal Astute inventory, UK |
| Stock - Philippines Warehouse | 1000014 | Internal Astute inventory, PH |
| LAM Kitting Inventory | 1000025 | LAM consignment inventory |

Full list of 24 types in `shared/offer-writeback.js` → `OFFER_TYPES`. Pass either the numeric ID or the string name to `writeOffer()`.

### Step 5: Write to OT

```javascript
const { writeOffer } = require('../../shared/offer-writeback');

// NOTE: Do NOT set writeMpnRecords: true — the iDempiere bean callout on
// chuboe_offer_line auto-creates the chuboe_offer_line_mpn record.
// Writing it ourselves caused duplicates (discovered 2026-07-07).
const result = await writeOffer({
  bpartnerId: partnerResult.search_key ? Number(partnerResult.search_key) : null,
  offerTypeId: 'Customer Excess',                      // or 1000000
  description: '04.08.2026-GE_Aerospace_RevShare_B1',  // MM.DD.YYYY-PartnerName-context
  lines: extractedLines,
});
// → { offerId, searchKey, linesWritten, errors }
```

**Validate:**
- `result.offerId` is non-null
- `result.linesWritten === lines.length`
- `result.errors.length === 0`

If any of these fail, **do not move the email to `Processed`** (Step 6). Move to `NeedsReview` instead and surface errors to the user.

### Step 6: Move Email

| Outcome | Folder |
|---|---|
| Step 5 succeeded (full write, zero errors) | `Processed` |
| Step 2 returned `NEEDS-PARTNER` | `NeedsPartner` |
| Step 5 had errors / partial write | `NeedsReview` |
| Email had no offer data (inquiry only, empty forward) | `NotOffer` |

```javascript
await fetcher.moveMessage(emailId, 'Processed');
```

### Step 7: Trigger Analysis (DEFAULT)

Loading auto-invokes the [Customer Excess Analysis](../Customer%20Excess%20Analysis/customer-excess-analysis.md) workflow on the newly-written offer ID(s):

```javascript
// Pseudocode — actual orchestrator TBD
const { analyzeOffer } = require('../Customer Excess Analysis/analyze-offer');
await analyzeOffer({ offerIds: [result.offerId], source: 'loading-trigger' });
```

**Override:** `--no-analyze` flag (e.g., when loading a multi-batch lot to be analyzed as one logical group separately).

> **Why this exists:** Analysis takes a `chuboe_offer_id` as input, not raw extracted memory. By the time Step 5 finishes, the canonical data lives in OT — exactly what Analysis needs. Auto-triggering keeps the new-offer path one-touch while preserving the ability to revisit any historical offer later.

---

## File Output

**Loading does NOT produce CSV files for ERP import.** That was the old (pre-writeback) pattern; with `writeOffer()` going directly to REST, no intermediate file is needed.

The legacy CSVs in `output/` are kept as historical reference only. The legacy `extract-market-offers.js` and `send-offer-email.js` scripts are deprecated — kept for git history but not part of the new pipeline.

---

## Field Reference

Loading writes to three tables: `chuboe_offer` (header), `chuboe_offer_line` (per line), and optionally `chuboe_offer_line_mpn` (cross-references).

> **Schema reference:** See [`shared/data-model.md`](../../shared/data-model.md) § Offer Chain for the full field list, types, and which columns live where.
>
> **Payload reference:** See [`shared/api-writeback.md`](../../shared/api-writeback.md) § 11 (chuboe_offer) for the exact REST payload structure that `writeOffer()` produces.

**Key rules:**
- **Only populate what's explicit.** Do not assume defaults for lead time, date code, packaging, country, etc.
- **Multiple MPNs in one line:** create a separate line for EACH MPN (same qty, same price).
- **MFR:** writer always uses `Chuboe_MFR_Text` (canonical name from `mfr-lookup`). `Chuboe_MFR_ID` is only set when the resolved MFR is non-system.
- **Description (line-level):** part-specific notes only (expiry, conditions, location). NOT source metadata.

---

## Skip Rules (Email Routing)

| Condition | Action |
|---|---|
| Empty forward (no offer data in body or attachment) | Move to `NotOffer` |
| Inquiry only (asking about availability, not offering stock) | Move to `NotOffer` |
| Duplicate (same partner/MPN/qty already loaded recently) | Skip + flag |
| PDF-only offer (data only in attachment, no parser yet) | Move to `NeedsReview` |
| Body has data, attachment has more — read both | Combine before write |

---

## Known Issues / Blockers

| Issue | Impact | Workaround |
|---|---|---|
| `writeOffer()` untested in prod | Unknown failure modes (callouts, schema constraints) | Step 0 smoke test mandatory on first use |
| `writeMpnRecords: true` (the `chuboe_offer_line_mpn` write path) untested | Without it, downstream MPN-cross-ref matching is weaker | Smoke test with the flag enabled to find out before full batch |
| `chuboe_pricing_api_result` JSONB write blocked (Chuck) | Affects Analysis enrichment persistence, NOT loading | Cache write works; `extractPriceAtQty()` falls back to cache |
| No generalized xlsx → line normalizer cog | Each new vendor format needs ad-hoc parsing | Build `shared/offer-extractor.js` after a few real loads reveal common shapes |
| Old `extract-market-offers.js` hardcodes MFR map duplicating `mfr-lookup.js` | Drift risk | Deprecated; not used by new path |

---

## Related

- [Customer Excess Analysis](../Customer%20Excess%20Analysis/customer-excess-analysis.md) — downstream consumer (Workflow B). Loading triggers this by default.
- [`shared/offer-writeback.js`](../../shared/offer-writeback.js) — the writer
- [`shared/partner-lookup.js`](../../shared/partner-lookup.js) — partner resolution
- [`shared/mfr-lookup.js`](../../shared/mfr-lookup.js) — MFR resolution
- [`shared/email-fetcher.js`](../../shared/email-fetcher.js) — inbox operations
- [`shared/data-model.md`](../../shared/data-model.md) § Offer Chain — schema reference
- [`shared/api-writeback.md`](../../shared/api-writeback.md) § 11 — REST payload reference
- [Inventory File Cleanup](../Inventory%20File%20Cleanup/inventory-file-cleanup.md) — sister workflow that also writes to `chuboe_offer` (own stock by warehouse)
