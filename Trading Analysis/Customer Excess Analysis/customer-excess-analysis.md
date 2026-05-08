# Customer Excess Loading + Analysis Workflow

> **Folder rename, 2026-05-04**: this workflow was previously known as "Market Offer Analysis." It was scoped down to **Customer Excess** (and Customer Lead Time Buy) only because broker/franchise offers are handled by a lighter data-capture path inside the same universal pipeline. See section "Pipeline architecture (V1 spine)" below.

> **Architecture migration, 2026-05-07**: this workflow is migrating from a static cron-driven pipeline (`shared/offer-poller.js` + 4 cron entries) to the **agent pattern** defined in [`email-workflow-architecture.md`](../../email-workflow-architecture.md). The "Agent operating instructions" section below is the new contract; the pipeline-architecture / V1-spine sections describe the static path still in service until the migration is verified.

**Purpose:** Take customer-excess emails forwarded to `excess@orangetsunami.com`, load each as a `chuboe_offer` in OT, and (downstream) produce actionable analysis output: enriched, scored, and shaped to match the inferred intent (Reactive / Spec Buy / Proactive Customer Offer).

---

## Agent operating instructions (NEW — read first)

### Your goal

Your job is to **load each offer to OT under the correct customer BP**. The decision tree below is the recommended order — it codifies the patterns we've seen most often. But the tree may have gaps; emails arrive in shapes nobody has documented yet.

When the tree's prescribed steps don't fit:
- **Use judgment.** If a customer is clearly named in the subject, body prose, attachment filename, or forward-chain text — even when not in any `From:` line — try to resolve them by name before escalating.
- **Don't let an incomplete tree override evidence in the email.** Steps below are descriptive of common cases, not exhaustive.
- **Escalation is a last resort.** `needs_partner` / `needs_review` exist for genuine ambiguity (the email has zero usable signal), not for "the tree didn't have a step for what I'm seeing."

### Before any escalation, sanity-check yourself

Before you call `route <uid> needs_partner` or `route <uid> needs_review`, re-read the email one more time and ask:
- Is the customer actually named in the **subject**? (e.g., `FW: Excess <Company>`, `<Company> CONSIGNMENT`, `<Company> RFQ`)
- Is the customer named in the **body prose** outside the `From:` lines? (e.g., `<Company> is the customer`, `Customer: <Company>`, `for <Company>`, `<Company>'s excess`)
- Is the customer named in an **attachment filename**? (e.g., `Celestica_Excess_2026-04.xlsx`)
- Did I dismiss **plain-prose line listings** (qty / mfr / mpn on consecutive lines) because they weren't a table?

If yes to any of these, try the obvious thing — call `resolvePartner({ companyName: '<name>', partnerType: 'customer' })` or extract the prose lines — *before* escalating. The escalation actions exist for cases where you've genuinely exhausted the email; they're not the fallback for "I worked the tree and it didn't match."

### CLI primitives

This is the contract the `/schedule` routine reads each tick. Per [`email-workflow-architecture.md`](../../email-workflow-architecture.md), the agent uses three CLI primitives:

```
node shared/email-workflow-poller.js list                     --workflow excess
node shared/email-workflow-poller.js read <uid>               --workflow excess
node shared/email-workflow-poller.js download-attachments <uid> --workflow excess
node shared/email-workflow-poller.js route <uid> <action> --workflow excess --payload <json|file>
```

### Per-message decision tree

For each unseen message, the agent decides **one** routing action. Order of checks:

1. **Junk / automation noise** → `not_offer`
   - Subject matches `Upload MO_*` (sender confirmation, no offer data)
   - Subject matches OOO / auto-reply / undeliverable / bounce / read-receipt / newsletter
   - Body contains SMTP bounce headers (`Reporting-MTA:`, `Final-Recipient:`, `Diagnostic-Code:`)
   - Effectively empty body AND no parseable attachment

2. **Partner resolution** — try in order, first match wins:
   - **Subject hint** (highest priority): `MO_<NNNNN>`, `Search Key <NNNNN>`, `Search key#<NNNNN>`, `[#<NNNNN>]` → use that BP search key directly
   - **Body hint:** `BP: <NNNNN>`, `Partner: <NNNNN>`, `BPartner ID: <NNNNN>`
   - **Forward chain:** parse all `From:` lines in the body; prefer the deepest sender whose email is NOT `@astutegroup.com`. Resolve via `partner-lookup.js` 4-tier resolver (exact email → email domain → domain hint → name match). All tiers exclude `IsEmployee='Y'` BPs.
   - **External direct send:** outer From is not `@astutegroup.com` → resolve via partner-lookup directly.
   - **Company-name fallback (NEW 2026-05-08):** when none of the above resolve (typically because the email is an *internal* forward where Astute employees discuss a customer's parts), scan the subject and body for a clearly-named customer and call `resolvePartner({ companyName: '<name>', partnerType: 'customer' })` — the resolver's name-match tier handles fuzzy lookup. Recognise patterns like:
       - **Subject patterns:** `FW: Excess <Company>`, `FW: <Company> Excess`, `<Company> CONSIGNMENT`, `<Company> RFQ`, `<Company> Inventory Available`. Strip noise like `FW:`, `RE:`, location modifiers (`Lohja`, `MX`, `EU`, `Asia`), date stamps.
       - **Body patterns:** explicit assertions like `<Company> is the customer`, `Customer: <Company>`, `customer name: <Company>`, `<Company>'s excess`, `<Company> wants to sell`, `Hi from <Company>`.
       - When in doubt, try multiple candidate names — the resolver returns `matched: false` if none hit, in which case fall through to `needs_partner`.
   - If still no match → `needs_partner` with payload `{ subject, outerFrom, hints: "<what was tried, including company-name candidates attempted>" }`

3. **Line extraction** — try in order:
   - Run `download-attachments` if `has_attachment` is true. Prefer xlsx > csv > pdf attachments.
   - For xlsx/csv: walk first ~10 header rows looking for an MPN column. Header synonyms: mpn / part number / mfr part / aml / p/n. Other columns: qty, price, mfr, dateCode, description, cpc.
   - For pdf: use the standard Read tool; extract tabular content if confidence is high enough.
   - If no attachment yields lines, try the HTML body (Outlook inline tables) and plaintext body (tab/pipe-delimited).
   - **Plain-prose lists** count too — bodies like `50.000 pcs` / `Broadcom` / `HSMQ-C191` (qty, mfr, mpn on consecutive lines) are valid offers. Use judgment to group consecutive lines into per-part records.
   - **Filter junk MPNs:** reject lines whose "MPN" cell is a URL fragment (`<HTTPS://...>`, `^WWW.`, anchor-tag fragments). These are footer/signature noise, not real parts.
   - If 0 valid lines → `needs_review` with payload `{ reason: "no parseable lines", subject, outerFrom, details: "<attachment names + body shape>" }`. **Note:** an email with a clear customer-name subject but empty body (signature/disclaimer only) is still `needs_review` — partner resolution alone doesn't make it loadable. Don't conflate "no partner" with "no lines."

4. **Offer type determination:**
   - Default for `excess@` = **Customer Excess** (`1000000`)
   - Body hint `Type: Broker` / `Type: Customer Excess` / `Type: Franchise Offers` / `Type: Customer Lead Time Buy` overrides
   - **Vendor-only flip:** if resolved partner has `iscustomer='N'` AND `isvendor='Y'`, flip Customer Excess → **Broker Stock Offer** (`1000001`). Catches broker liquidation lists landing in `excess@`.

5. **Cross-forward dedup check** (preempts the write):
   ```sql
   SELECT value, chuboe_offer_id FROM adempiere.chuboe_offer
   WHERE isactive='Y'
     AND c_bpartner_id = <resolved BP>
     AND chuboe_offer_type_id = <resolved type>
     AND created >= NOW() - INTERVAL '6 hours'
     AND (count active lines on this offer) = <extracted line count>
     AND EXISTS (line with chuboe_mpn = <sorted first MPN>)
     AND EXISTS (line with chuboe_mpn = <sorted last MPN>)
   LIMIT 1
   ```
   If matched → `dup_skip` with payload `{ existingSearchKey: <prior offer search key> }`. Don't write a duplicate offer.

6. **Write to OT** → `load_offer` with payload `{ bpartnerId, offerType, lines }`. The handler calls `writeOffer()` which writes the header, lines, and `chuboe_offer_line_mpn` AVL sub-rows. Description auto-generated unless provided.

### Routing actions (full payload reference)

| Action | Required payload | Folder | Side effect |
|---|---|---|---|
| `load_offer` | `{ bpartnerId, offerType, lines[] }` (also `description, sourceUid`) | `Processed` | `writeOffer()` to OT + `loaded` breadcrumb |
| `needs_partner` | `{ subject, outerFrom }` (also `hints`) | `NeedsPartner` | Email Jake with `PARTNER:` reply prompt + `needs-partner` breadcrumb |
| `needs_review` | `{ reason, subject, outerFrom }` (also `details`) | `NeedsReview` | Email Jake diagnostics + `needs-review` breadcrumb |
| `not_offer` | `{ reason }` | `NotOffer` | Silent move + `not-offer` breadcrumb |
| `dup_skip` | `{ existingSearchKey }` | `Processed` | Silent move + `dup-skipped` breadcrumb |

### Schedule

The expected pattern is a **`/schedule` routine** that runs every 30 minutes. Recommended prompt for the routine:

```
Process all unseen messages in the excess@orangetsunami.com inbox.

1. Read Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md
   section "Agent operating instructions" before starting (the .md is the
   source of truth — do not work from prior-session memory).
2. Run `node shared/email-workflow-poller.js list --workflow excess` to
   see unseen envelopes.
3. For each envelope, follow the per-message decision tree in section
   "Per-message decision tree" and dispatch via `route` with the right
   action + payload.
4. If any single message hits a transient error (writeOffer 5xx, partner
   lookup throws), log it and continue with the next message. Do not abort
   the batch. Email Jake a one-line summary at the end if any errored.
5. If the inbox has 0 unseen messages, exit silently.
```

On-demand invocation (operator asks "process excess inbox") works identically — the agent should follow the same per-message decision tree.

### Key shared modules (tools the agent calls in-session)

- `shared/partner-lookup.js` — `resolvePartner({email, companyName, partnerType})` for tier-1.5 + domain matching. All tiers exclude IsEmployee='Y'.
- `shared/data-model.md` — schema reference for `chuboe_offer` chain. Read before constructing the `lines[]` payload.
- `shared/api-writeback.md` — REST payload structure for `writeOffer` (the action handler does this; the agent supplies the line shape).

---

## Pipeline architecture (V1 spine — STATIC, being replaced by agent pattern)

---

## Pipeline architecture (V1 spine)

The universal offer pipeline is a chain of cogs that all communicate via a single JSONL breadcrumb file at `~/workspace/.offer-pipeline/breadcrumbs.jsonl`. Each cog owns its own concern; the only shared contract is the breadcrumb format.

```
inbox(es)
   │
   ▼  every 30 min, lockfile-guarded
[shared/offer-poller.js]      ← cog 1, universal
   │   • partner resolution (BP hint → forward → outer From → name)
   │   • line extraction (xlsx → csv → pdf → tabular body)
   │   • writeOffer() to OT (chuboe_offer + line + line_mpn)
   │   • routes failures to NeedsPartner / NeedsReview folders
   ▼
[shared/offer-router.js]      ← cog 3, type-driven dispatch
   │
   ├─→ Customer Excess (1000000) / Lead Time Buy (1000003) → analyze-offer.js (THIS WORKFLOW)
   ├─→ Broker Stock Offer (1000001) → broker-data-capture (breadcrumb only)
   └─→ Franchise Offers (1000002)   → franchise-data-capture (breadcrumb only)

[Customer Excess Analysis]      ← cog 4, this workflow
   │   • Step 2: intent classifier (rules-based) — STUB IN V1
   │   • Step 3: enrich (franchise APIs + OT history)
   │   • Step 4: score (supply scarcity / price advantage / demand signal)
   │   • Step 5: render (Spec Buy ranked list / Proactive Customer table / Reactive RFQ-match)
   ▼
[breadcrumbs.jsonl]

[digest-builder.js]            ← cog 7, consumes breadcrumbs
   │   • runs at 11/16/20 UTC (7am/12pm/4pm EDT)
   │   • emails operator a 4-section HTML summary
   ▼
operator inbox
   │  reply with PARTNER:/INTENT:/SKIP: directives
   ▼
[reply-parser.js]              ← cog 8, feeds back into pipeline
   │   • writes to feedback-overrides.json
   │   • offer-poller consumes overrides on next run
   ▼
loop back to top
```

**Reply directives (operator → reply parser):**
```
PARTNER: <uid> = <BP id (6-8 digits) OR company name>     # resolves NeedsPartner
INTENT:  <searchKey> = <spec-buy | proactive | reactive>  # overrides classifier (V1: noted only)
SKIP:    <searchKey>                                       # excludes from drill-down (V1: noted only)
```
Anything from the Astute domain that doesn't match grammar gets a clarification reply.

**Seller forwarding conventions (subject → BP):** When a seller forwards a customer excess email to `excess@`, they put the OT search key in the subject so the poller doesn't have to guess from the multi-hop forward chain. Recognized patterns (case-insensitive, both 6-8 digit search keys and `MO_` IDs):

```
FW: Upload MO_Search Key 1008289     → BP search key 1008289
FW: Upload MO_1002733                → BP search key 1002733
FW: Matrix comsec - Search key#1009991 → BP search key 1009991
FW: <whatever> [#1234567]             → BP search key 1234567
```

The subject hint takes precedence over the body's `BP:`/`Partner:` hint and over forward-chain From-line resolution. If no subject hint is present, the poller walks all `From:` lines in the body and prefers the deepest **non-`@astutegroup.com`** sender — this avoids latching onto the prior internal hop on multi-hop chains.

**`Upload MO_*` emails are NOT offers.** Subject pattern `Upload MO_*` flags an internal seller notification confirming a manual market-offer upload — body has no real MPN data. The junk-classifier auto-routes these to NotOffer.

**Vendor-only BP ⇒ Broker Stock Offer.** When a forwarded "excess" email resolves to a vendor-only BP (e.g., Future Electronics' "Daily Liquidation List"), the poller flips the offer type from Customer Excess (1000000) to Broker Stock Offer (1000001). The body hint `Type: Broker` works as an explicit override.

**Cross-forward dedup.** If the same source email is forwarded by two employees within 6 hours, the poller writes the first one and skip-with-breadcrumb on the second (matched by BP + offer-type + line count + first/last MPN).

**V1 status:** Spine is live. Cog 4 (this workflow's intent classifier + scoring + renderers, Steps 2–5 below) is still a stub — `analyze-offer.js` writes a "queued" breadcrumb only. The downstream cogs (digest, reply parser) work end-to-end already; cog 4 builds out incrementally without touching them.

---

**Critical constraint:** Analysis input is a `chuboe_offer_id` (or set of IDs, or selector). It is NEVER raw extracted lines from email. This means analysis can be re-run on any historical offer at any time without re-loading.

> ⚠️ **Watch for CPC bean-callout collapse artifacts in historical data.** The server-side bean callout on `chuboe_offer_line` deduplicates by `(offer_id, chuboe_cpc)` and comma-merges MPNs on the survivor row (e.g., `chuboe_mpn = "MPN_A,MPN_B"`). If you see a comma in `chuboe_mpn` during analysis, that's a collapse artifact, not real data — the underlying offer was loaded before the loader honored the per-CPC anchor pattern. The cleaned join key (`chuboe_mpn_clean`) on these rows is unmatchable. Detect with `WHERE chuboe_mpn LIKE '%,%'`. Full incident: `shared/data-model.md` § chuboe_offer_line CPC bean-callout, memory `project_chuboe_offer_line_cpc_collapse.md`.

> **Forcing function:** If Analysis ever needs a field that isn't in `chuboe_offer` / `_line` / `_line_mpn`, the fix is to make [Loading](../Market%20Offer%20Loading/market-offer-loading.md) write that field, not to pass it in memory. This discipline keeps revisits possible.

---

## Pipeline

```
Fetch from OT  ──→  chuboe_offer + lines + line_mpn + partner
        │
        ▼
Infer intent  ──→  Reactive / Spec Buy / Consignment
        │            (rules-based, --intent override available)
        ▼
Enrich       ──→  Supply (franchise APIs)
                  Demand (RFQ + CQ + SO history)
        │
        ▼
Score        ──→  per-line 0–100, tier HOT/WARM/COOL/SKIP
        │
        ▼
Output       ──→  shape determined by intent
```

---

## Trigger Modes

| Mode | When | Invocation |
|---|---|---|
| **Auto** (default) | Loading just wrote a new offer | Loading calls `analyzeOffer({ offerIds: [newId] })` at the end of its Step 7 |
| **Manual revisit** | User wants to re-analyze a historical offer | `node analyze-offer.js --offer-search-key 1005525` |
| **Bulk re-score** | Scoring model changed; want to re-run across history | `node analyze-offer.js --partner GE_Aerospace --since 2026-01-01` |
| **Multi-offer lot** | A logical lot was loaded as multiple offers (e.g., GE rev share Batch 1 + Batch 2) | `node analyze-offer.js --offer-ids 9000123,9000124` |

---

## Cogs Used

| Cog | Role | Status |
|---|---|---|
| `shared/api-client.js` | `apiGet('chuboe_offer', {filter})` for fetching offers | Built |
| `shared/db-helpers.js` | `psqlQuery(...)` for fetching demand signals from `adempiere` schema | Built |
| `shared/franchise-api.js` | `searchAllDistributors(mpn, qty)` — supply-side enrichment | Built, in production use |
| `shared/api-result-writer.js` | `extractPriceAtQty(mpn, qty, {maxAgeDays})` — read cached franchise results before re-calling APIs | Built; DB write blocked on Chuck (cache works) |
| `shared/market-data.js` | `getBulkMarketData(mpns[])` — bulk demand signals across many MPNs in one set of psql round-trips (~1000× faster than per-MPN at scale). Per-MPN `getAllMarketData()` retained for single-part deep dives. | Built (bulk version added 2026-04-08, GE Batch 1 was first user) |
| **Intent classifier** | Rules-based: signals → Reactive / Spec Buy / Consignment | **Not yet built** |
| **Scoring engine** | Per-line 0–100 via Supply/Price/Demand model | **Not yet built** |
| **Output renderers** | Lot summary / spec buy ranker / reactive RFQ-match table | **Not yet built** (lot summary partially exists in `GE_Aerospace_Excess_Analysis_2026-04-02.xlsx` shape) |

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 1: Fetch Offer from OT

Read the offer header, lines, and line MPNs from OT. **This is a read, not a load.** No email, no extraction, no partner resolution — those happened in [Loading](../Market%20Offer%20Loading/market-offer-loading.md).

```javascript
const { apiGet } = require('../../shared/api-client');

// By offer ID (most common — passed from Loading)
const header = await apiGet('chuboe_offer', { filter: `chuboe_offer_id eq ${offerId}` });
const lines = await apiGet('chuboe_offer_line', { filter: `chuboe_offer_id eq ${offerId} and IsActive eq true` });
const lineMpns = await apiGet('chuboe_offer_line_mpn', { filter: `chuboe_offer_id eq ${offerId} and IsActive eq true` });
```

**Or by SQL** (faster for batch reads, since `adempiere` schema is a read-only replica):
```sql
SELECT o.chuboe_offer_id, o.value AS offer_search_key, o.description, o.created,
       ot.name AS offer_type, bp.name AS partner_name, bp.value AS partner_search_key,
       ol.line, olm.chuboe_mpn, olm.chuboe_mfr_text,
       ol.qty, ol.priceentered, ol.chuboe_date_code, ol.chuboe_cpc
FROM adempiere.chuboe_offer o
JOIN adempiere.chuboe_offer_type ot ON ot.chuboe_offer_type_id = o.chuboe_offer_type_id
JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id
JOIN adempiere.chuboe_offer_line_mpn olm ON olm.chuboe_offer_line_id = ol.chuboe_offer_line_id
WHERE o.chuboe_offer_id = $offerId
  AND o.isactive = 'Y' AND ol.isactive = 'Y' AND olm.isactive = 'Y';
```

> **Schema reference:** [`shared/data-model.md`](../../shared/data-model.md) § Offer Chain. Note that MPN and MFR text live on `chuboe_offer_line_mpn`, NOT `chuboe_offer_line`.

**Output of Step 1:** Normalized offer object:
```javascript
{
  offerId, searchKey, description, created,
  offerType,                          // e.g., 'Customer Excess'
  partner: { id, name, search_key },
  lines: [
    { lineNum, mpn, mfrText, qty, price, dateCode, cpc, leadTime, packaging },
    ...
  ]
}
```

### Step 2: Infer Intent

Rules-based classifier. Pass the offer object through the rule table; first match wins. Override with `--intent` flag if the user knows better.

#### Inference Rules (first match wins)

| Rule | Signal | → Intent |
|---|---|---|
| 1 | Override flag set (`--intent consignment`) | Use override |
| 2 | Offer type = `LAM Kitting Inventory` (1000025) | Consignment |
| 3 | Description contains "rev share" / "rev-share" / "revshare" / "E&O" / "buyback" | Consignment |
| 4 | Partner is an existing OEM/EMS customer (has prior SO history as `c_bpartner` on `c_order` with `issotrx='Y'`) AND offer has 50+ lines AND ≥30% of lines have null `priceentered` | Consignment |
| 5 | Partner is a known broker (BP type or domain hint = broker) AND offer has 5+ lines | Spec Buy |
| 6 | Default | Reactive |

**Why first-match-wins:** Reactive is the safe default — it just matches against open RFQs, which is useful for any offer. Spec Buy is opt-in (broker pattern). Consignment is most specific (named offer type or explicit language). Misclassifying down (e.g., consignment → reactive) is fine because the reactive output is still readable; misclassifying up (e.g., reactive → consignment) wastes effort on lot-level summary noise.

**Edge case escalation:** If rules are ambiguous (e.g., a customer broker who sometimes consigns), the classifier returns `intent: 'reactive'` plus a `confidence: 'low'` flag. User can override with `--intent` on a re-run.

### Step 3: Enrich

Run on every line regardless of intent. Both passes are mandatory.

#### 3a: Supply Side (franchise APIs) — three-state coverage model

**Critical distinction:** Not all "no franchise stock" lines mean the same thing. The franchise-api summary exposes both `distributorsCarrying` (anyone listed the part in their catalog at all) and `distributorsWithStock` (subset that has stock > 0). Combining the two gives three states, each with a different downstream meaning:

| State | Condition | Meaning | Score impact | Output framing |
|---|---|---|---|---|
| **In stock** | `distributorsWithStock > 0` | Franchise carries it AND has inventory | Existing supply scoring (coverage % vs offered qty) | Standard "available" line |
| **Out of stock** | `distributorsCarrying > 0 AND distributorsWithStock == 0` | Franchise carries it BUT zero inventory across all 8 | **Real scarcity opportunity** — market wants it, no authorized channel has it | +12 supply scarcity, flag `FRANCHISE_OUT_OF_STOCK` |
| **Not listed** | `distributorsCarrying == 0` | No distributor has any catalog entry — part isn't in franchise universe at all | **Insufficient data** — don't score supply scarcity (parallel to NO_OFFER_PRICE for Price Advantage) | Flag, sub-classify (see below) |

**The "Not Listed" sub-classification — internal vs mil-spec vs unknown.** Lines that no franchise has heard of fall into one of three buckets, and they need different downstream actions. Use `shared/mpn-classifier.js → classifyMpnNonFranchise(mpn, mfrText, cpc)`:

| Sub-class | Heuristic | Action |
|---|---|---|
| `NO_LISTING_INTERNAL` | MPN contains "REV " followed by a letter; or contains internal annotations like `(SCRN)` / `(PROG)` / `(SCREENED)`; or CPC field is populated and differs from MPN; or matches a known customer-prefix pattern | **Push back on the customer** to provide an industry MPN or cross-reference. The customer should know what their internal codes are. |
| `NO_LISTING_MILSPEC` | Matches mil-spec patterns: `5962-*`, `JANTX*`, `M[0-9]+/`, `MS[0-9]`, `MIL-*` | Note as obscure-but-legitimate. May warrant manual broker channel research. Different conversation than internals. |
| `NO_LISTING_UNKNOWN` | Neither — no clear internal or mil-spec signal | Catch-all. Research case-by-case. |

**Why this matters:** When ~65% of a partner's lot comes back with no franchise listings, the actionable pushback isn't "we can't sell this" — it's "X of those are YOUR internal AML codes, please resolve them on your side; Y are mil-spec one-offs that need a different channel; Z are genuinely unknown." Each bucket has a different conversation with the customer.

**Implementation pattern:**

```javascript
const { searchAllDistributors } = require('../../shared/franchise-api');
const { writePricingResult, extractPriceAtQty } = require('../../shared/api-result-writer');
const { classifyMpnNonFranchise } = require('../../shared/mpn-classifier');

for (const line of offer.lines) {
  // Cache first (14-day freshness)
  let franchise;
  const cached = extractPriceAtQty(line.mpn, line.qty || 1, { maxAgeDays: 14 });
  if (cached.length > 0) {
    franchise = reconstructSummaryFromCache(cached, line.qty);
  } else {
    const result = await searchAllDistributors(line.mpn, line.qty || 1);
    // ALWAYS persist the cache so future runs benefit
    await writePricingResult({
      searchResult: result, mpn: line.mpn, qty: line.qty || 1,
      source: 'market-offer-analysis',
    }).catch(err => console.warn(`cache write failed for ${line.mpn}: ${err.message}`));
    franchise = result;
  }

  const s = franchise.summary;
  line.enrichment = line.enrichment || {};
  line.enrichment.supply = {
    distributorsCarrying:  s.distributorsCarrying,   // anyone listed it
    distributorsWithStock: s.distributorsWithStock,  // anyone has stock
    totalStock:            s.totalStock,
    lowestPrice:           s.lowestPrice,
    coverage:              s.coverage,                // FULL / PARTIAL / NONE
  };

  // Classify state
  if (s.distributorsWithStock > 0) {
    line.franchiseState = 'IN_STOCK';
  } else if (s.distributorsCarrying > 0) {
    line.franchiseState = 'FRANCHISE_OUT_OF_STOCK';   // real scarcity
  } else {
    // Not in franchise catalog at all — sub-classify
    const sub = classifyMpnNonFranchise(line.mpn, line.mfrText, line.cpc);
    line.franchiseState = sub;   // NO_LISTING_INTERNAL / NO_LISTING_MILSPEC / NO_LISTING_UNKNOWN
  }
}
```

**Freshness rule:** 14 days. Older than that → re-call APIs.

**Cache write rule:** ALWAYS call `writePricingResult()` after a live API call. Skipping it (which happened during the GE Batch 1 first run) means the cache stays empty and every future run pays full API cost. The cache is the standard mechanism — opting out of it isn't a choice the caller gets to make.

#### 3b: Demand Side (OT history) — bulk pattern

**Always use the bulk function** `getBulkMarketData(mpns[])`. The per-MPN `getAllMarketData()` call costs ~63 seconds per MPN (5+ separate psql spawns) and would take ~9 hours on a 500-line lot. The bulk function does the same work in one set of SQL round-trips — ~12 seconds for 500+ MPNs. ~1000× speedup.

```javascript
const { getBulkMarketData, cleanMpn } = require('../../shared/market-data');

// ONE call for the entire lot
const mpnCleans = offer.lines.map(l => cleanMpn(l.mpn));
const demandMap = getBulkMarketData(mpnCleans, {
  vqMonths: 12,
  salesMonths: 24,
  rfqDaysActive: 90,
  rfqMonthsHist: 12,
});
// → Map<mpn_clean, BulkMarketRecord>

for (const line of offer.lines) {
  const d = demandMap.get(cleanMpn(line.mpn)) || {};
  line.enrichment.demand = {
    vqCount:           d.vqCount || 0,
    brokerSaleCount:   d.brokerSaleCount || 0,
    customerSaleCount: d.customerSaleCount || 0,
    activeRfqCount:    d.activeRfqCount || 0,
    historicalRfqCount: d.historicalRfqCount || 0,
    demandStrength:    d.demandStrength || 'NONE',
    historicalBuyers:  (d.topBuyers || []).map(b => b.name),
    isBrokerHeavy:     (d.topBuyers || []).some(b => b.isBroker),
  };
}
```

> **Why a separate cog:** `market-data.js` already distinguishes broker sales from customer sales — broker sales are a much stronger price signal (per the `feedback_suggested_resale.md` rule). The bulk version preserves this split via `brokerSaleCount` / `customerSaleCount` and the `isBroker` flag on each `topBuyers` entry.

> **Limitation:** `getBulkMarketData` uses **exact equality** on `chuboe_mpn_clean`, not the ILIKE prefix matching the per-MPN function does. Packaging-variant suffixes (`-REEL`, `-TR`, etc.) won't be auto-included. Acceptable trade for the 1000× speedup; if a single line genuinely needs variant matching, fall back to per-MPN `getAllMarketData()` for that one case.

### Step 4: Score

Every line gets a 0–100 score and a tier. Three weighted categories.

| Category | Weight | Range |
|---|---|---|
| Supply Scarcity | 40% | 0–40 |
| Price Advantage | 35% | 0–35 |
| Demand Signal | 25% | 0–25 |

#### Supply Scarcity (0–40)

**Only score lines where the franchise APIs found at least one carrier** (`distributorsCarrying > 0`). Lines with no franchise listing at all (`NO_LISTING_*`) are flagged and left unscored on the supply axis — they have insufficient data for the model to mean anything (parallel to NO_OFFER_PRICE on the price axis).

| Condition | Points |
|---|---|
| EOL / Obsolete / NRFND lifecycle | +15 |
| `FRANCHISE_OUT_OF_STOCK` (carrying > 0, with-stock = 0) — real scarcity | +12 |
| Franchise stock < offered qty | +8 |
| Franchise stock < 2× offered qty | +4 |
| Lead time > 40 weeks | +8 |
| Lead time > 20 weeks | +5 |
| Active lifecycle + high franchise stock (>10× offered qty) | −10 |

*Cap 40, floor 0.*

**Lines in `NO_LISTING_INTERNAL` / `NO_LISTING_MILSPEC` / `NO_LISTING_UNKNOWN` get supplyScore = `null` (not 0)**, so they sort to the bottom of supply rankings rather than appearing as "good scarcity opportunities" — which is the bug that the original two-state model produced.

#### Price Advantage (0–35)

Compares offered price against lowest franchise price at offered qty. **Astute typically resells stock at 20–30% of lowest franchise price.** To profit on a spec buy, acquisition cost must be well below that.

| Offer / Franchise Best | Signal | Points |
|---|---|---|
| < 5% | Suspiciously cheap — flag for verification | +30 + `VERIFY` |
| 5–10% | Strong buy — massive margin room | +30 |
| 10–15% | Good buy — comfortable margin under resale ceiling | +25 |
| 15–20% | Decent — margin exists but tighter | +18 |
| 20–25% | Marginal — at or near typical resale price | +8 |
| 25–30% | Break-even territory | +3 |
| > 30% | No broker value — buying at or above resale | 0 |
| No franchise data | Flag `NEEDS PRICING DATA`, do not score | unscored |
| No offer price (consignment, often) | Flag `NO OFFER PRICE`, do not score | unscored |

*Cap 35, floor 0.*

#### Demand Signal (0–25)

| Condition | Points |
|---|---|
| Active open RFQ (last 90 days) | +10 |
| Active open CQ (last 90 days) | +8 |
| 3+ RFQs in last 90 days | +5 (bonus) |
| Prior SO on this MPN (any customer, 12 months) | +7 |
| Repeat customer demand (same MPN, same customer, 2+ SOs) | +5 (bonus) |
| Zero historical demand | 0 |

*Cap 25, floor 0.*

#### Tier Assignment

| Tier | Score | Meaning |
|---|---|---|
| **HOT** | 70+ | High-value opportunity — act immediately |
| **WARM** | 40–69 | Worth pursuing — include in daily review |
| **COOL** | 20–39 | Marginal — log for reference |
| **SKIP** | < 20 | Franchise-available commodity — don't surface to sellers |

### Step 5: Output (shape determined by intent)

#### Reactive Output

**Per-line scored list + RFQ/CQ matches + viability filter.**

| Column | Source |
|---|---|
| MPN, MFR, Qty, Offered Price | Step 1 |
| Partner Name, Search Key | Step 1 |
| Score, Tier | Step 4 |
| Franchise Best Price, Stock, Lifecycle | Step 3a |
| Matching Open RFQs (search key + customer) | Step 3b |
| Matching Active CQs (search key + customer + quoted price) | Step 3b |
| Historical Buyers | Step 3b |
| Flags | Step 4 |

**Viability filter:** Suppress lines scoring < 20 (SKIP tier) from seller notifications. These are commodity parts available at franchise — not worth broker effort.

**Proactive push annotation:** For lines with SO history but no open RFQ/CQ, flag as `PROACTIVE PUSH` with the historical buyer list. These are reach-out-before-they-ask opportunities.

#### Spec Buy Output

**Ranked buy list + known buyers + close-first flag.**

Same columns as Reactive, plus:
- `Close First?` — YES if active RFQ/CQ exists (don't buy speculatively when you can close a deal now)
- `Est. Resale Price` — 20–30% of franchise best (the broker resale ceiling)
- `Est. Margin` — `(Est. Resale − Offered Price) / Est. Resale`

**Sort:** by score descending. Lines with `Close First = YES` floated to the top.

#### Consignment Output

**Lot-level portfolio summary + per-line drill-down.**

**Lot Summary:**
- Partner name, total lines, total qty, total book value (if priced)
- % of lines scoring HOT (70+)
- % of lines scoring WARM+ (40+)
- % of lines with franchise scarcity (EOL, low stock, no coverage)
- % of lines with historical demand (any RFQ/CQ/SO)
- % commodity lines (SKIP tier) — "dead weight"
- Top 10 highest-scoring lines (the parts that make the deal worth doing)
- Known buyer coverage: % of lines where at least one historical buyer exists

**Pursuit Signal:**

| Coverage | Signal |
|---|---|
| 40%+ scarce/in-demand lines | Aggressive pursuit |
| 20–40% | Moderate — cherry-pick the best lines |
| < 20% | Pass or negotiate hard on terms |

**Per-line detail:** Same as Reactive output, available as drill-down.

**Multi-offer lot handling:** If the analysis was invoked with multiple offer IDs (e.g., GE rev share Batch 1 + Batch 2), the lot summary aggregates across all of them, deduplicating by `(mpn, mfr)`. Per-line detail keeps the source `offer_search_key` so you can trace any line back to its origin offer.

---

## Flags

| Flag | Source | Meaning |
|---|---|---|
| `FRANCHISE_OUT_OF_STOCK` | Step 3a | Franchise carries the part but zero across all distributors — real scarcity opportunity |
| `NO_LISTING_INTERNAL` | Step 3a | No franchise listing AND MPN looks customer-internal (REV markers, parens annotations, etc.) — push back on customer to resolve |
| `NO_LISTING_MILSPEC` | Step 3a | No franchise listing AND MPN matches mil-spec patterns (5962-, JANTX, M-prefix) — obscure but legitimate |
| `NO_LISTING_UNKNOWN` | Step 3a | No franchise listing, no clear sub-pattern — research case-by-case |
| `VERIFY` | Step 4 (Price Advantage) | Offer price < 5% of franchise best — check authenticity |
| `NEEDS PRICING DATA` | Step 4 | No franchise pricing data; can't score price advantage |
| `NO OFFER PRICE` | Step 4 | Offer didn't include price (typical for consignment) |
| `PROACTIVE PUSH` | Step 5 (Reactive) | SO history exists but no open RFQ/CQ — reach out |
| `CLOSE FIRST` | Step 5 (Spec Buy) | Active RFQ/CQ exists — close before buying speculatively |
| `EXPIRED` | Step 1 | Offer past expiration date (if known) |
| `PRICE CHECK?` | Step 5 | Exact-stock-qty match from a Chinese broker — likely price checking, not buying |

---

## Known Issues / Blockers

| Issue | Impact | Workaround |
|---|---|---|
| Intent classifier not yet built | Step 2 returns hardcoded default until built | Manual `--intent` flag for now |
| Scoring engine not yet built | Step 4 — need to implement the model above | Manual scoring on small batches; build module after first real run reveals edge cases |
| Output renderers not yet built | Step 5 — three intent shapes need code | Reuse `GE_Aerospace_Excess_Analysis_2026-04-02.xlsx` shape for consignment as the reference template |
| `chuboe_pricing_api_result` JSONB write blocked (Chuck) | Step 3a results don't persist to DB | Cache write works; `extractPriceAtQty()` falls back to cache; re-runs of Analysis re-call APIs more often than ideal |
| `Market Offer Matching for RFQs/analyze-new-offers.js` only does 180-day RFQ lookback | Step 5 Reactive output is partial | Use directly for now; merge into this workflow's Step 5 once scoring engine exists |
| `getBulkMarketData()` uses exact mpn_clean equality, not the ILIKE prefix matching of the per-MPN function | Packaging variants (`-REEL`, `-TR` suffixes) won't auto-include each other in bulk runs | Acceptable trade for ~1000× speedup; for the rare single-line variant lookup case, fall back to per-MPN `getAllMarketData()` |

---

## Related

- [Market Offer Loading](../Market%20Offer%20Loading/market-offer-loading.md) — upstream Workflow A. Loading triggers Analysis by default.
- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/market-offer-matching.md) — partial Reactive implementation. Will eventually be folded into Step 5 here.
- [`shared/franchise-api.js`](../../shared/franchise-api.js) — supply-side enrichment cog
- [`shared/market-data.js`](../../shared/market-data.js) — demand-side enrichment cog
- [`shared/api-result-writer.js`](../../shared/api-result-writer.js) — franchise result cache + DB
- [`shared/data-model.md`](../../shared/data-model.md) § Offer Chain — schema reference
