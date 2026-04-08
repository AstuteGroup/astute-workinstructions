# Market Offer Analysis Workflow

**Purpose:** Take an offer that's already persisted in OT and produce actionable output: enriched, scored, and shaped to match the inferred intent (Reactive / Spec Buy / Consignment).

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
