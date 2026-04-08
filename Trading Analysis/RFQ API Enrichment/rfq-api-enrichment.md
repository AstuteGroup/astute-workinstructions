# RFQ API Enrichment

**Purpose:** Route every new RFQ through the franchise distributor APIs automatically. Build a pricing-history record on `chuboe_pricing_api_result` and capture VQ lines from any franchise quote that matches the RFQ quantity.

This is the canonical entry point for "run APIs on an RFQ." All RFQ types go through this pipeline regardless of downstream consumption — the API call is the same whether the result feeds Stock RFQ Loading, Quick Quote, Vortex Matches, or Hurricane Search.

## Architecture

```
┌─────────────────────────────┐
│  adempiere.chuboe_rfq       │
│  (new RFQs appear)          │
└──────────────┬──────────────┘
               │
               │ cron every 15 min
               ▼
┌─────────────────────────────┐
│  enrich-poller.js           │
│  - query new RFQs since     │
│    last-run timestamp       │
│  - iterate → enrichRFQ()    │
│  - daily summary email      │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  enrich-rfq.js              │
│  library: enrichRFQ(num)    │
│  - pull lines + MPNs + qty  │
│  - resolve RFQ type TTL     │
│  - shared/franchise-api.js  │
│    (cacheTTL gate)          │
│  - shared/vq-writer.js      │
│  - shared/api-result-       │
│    writer.js                │
└──────────────┬──────────────┘
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
   ┌──────┐ ┌──────┐ ┌─────────────┐
   │ VQs  │ │ API  │ │ Local cache │
   │      │ │result│ │ (envelopes) │
   │      │ │ rows │ │             │
   └──────┘ └──────┘ └─────────────┘
```

## TTL by RFQ Type

Source of truth: `api-integration-roadmap.md` § API Response Caching. This table mirrors that one.

| RFQ Type | TTL |
|---|---|
| PPV | 30 days |
| Astute Franchised | 30 days |
| Shortage | 7 days |
| Stock | 7 days |
| EOL/LTB | 7 days |
| 3PL/VMI | 7 days |
| Hot Parts | 7 days |
| Proactive Offer | 7 days |
| *(any)* + cached price < customer target | Force refresh |

TTL is applied MPN-level in the cache gate (`shared/api-result-writer.js` `getFreshness()`). Fresh envelopes short-circuit all 7 API calls — the same MPN appearing on multiple RFQs within the TTL window costs zero API calls.

## End-to-End Workflow

### Step 1 — Cron trigger fires
`*/15 * * * *` runs `enrich-poller.js`. Do not skip.

### Step 2 — Query new RFQs
`enrich-poller.js` reads the watermark from `~/workspace/.last-rfq-enrich` (ISO timestamp). It selects `chuboe_rfq` rows where `isactive='Y' AND created > <watermark>`. On first run with no watermark, it processes RFQs created in the last 1 hour only — this workflow does **not** backfill historical RFQs.

### Step 3 — Iterate each new RFQ
For each RFQ, call `enrichRFQ(rfqDocNumber)`.

### Step 4 — Pull RFQ lines + MPNs + qty + RFQ type
SQL pulled inside `enrichRFQ()`:

```sql
SELECT rlm.chuboe_rfq_line_id,
       rlm.chuboe_rfq_line_mpn_id,
       rlm.chuboe_mpn_clean AS mpn,
       rlm.chuboe_mfr_text  AS mfr,
       rlm.chuboe_cpc_clean AS cpc,
       rl.qty,
       rt.name              AS rfq_type
FROM adempiere.chuboe_rfq r
JOIN adempiere.chuboe_rfq_line     rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
JOIN adempiere.chuboe_rfq_type     rt  ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
WHERE r.value = $1
  AND r.isactive='Y'
  AND rlm.chuboe_mpn_clean IS NOT NULL
  AND rlm.chuboe_mpn_clean <> '';
```

### Step 5 — Resolve TTL for the RFQ type
Lookup: `PPV → 30`, `Astute Franchised → 30`, default `7`.

### Step 6 — Call franchise-api with cacheTTL
```javascript
const result = await searchAllDistributors(mpn, qty, {
  cacheTTL: ttlDays,
  cacheBypassIf: customerTargetPrice
    ? (env) => (env?.data?._meta?.lowestPrice ?? Infinity) < customerTargetPrice
    : null,
});
```
If `result.summary.fromCache === true`, the envelope was reused — no API call made.

### Step 7 — Write VQs for qty matches
For each franchise distributor where stock >= RFQ qty (full coverage) AND price is present:
```javascript
await writeVQFromAPI(rfqDocNumber, cpc, result, { searchedMpn: mpn });
```
`vq-writer.js` handles MFR resolution, BP lookup, cross-ref checks, and writes via the iDempiere REST API.

### Step 8 — Write thin-pointer row to chuboe_pricing_api_result
Only when a live API call was made (not on cache hit):
```javascript
await writePricingResult({
  searchResult: result,
  mpn,
  qty,
  rfqId: rfq.id,
  source: 'rfq-api-enrichment',
});
```
This writes one thin-pointer row per MPN per pull (audit trail) + the full envelope to local cache (canonical store until the OT JSON column is un-virtualized — see `api-integration-roadmap.md` § Pricing Envelope OT-Native Storage).

### Step 9 — Advance watermark + send summary email
After all RFQs in the batch complete, write the new high-water timestamp to `~/workspace/.last-rfq-enrich`. If any errors occurred, send an immediate error email. Daily at 08:00 local, send a summary email covering the previous 24h (RFQs processed, lines enriched, VQs written, cache hit rate, errors).

## Outputs

| Output | Location | Notes |
|---|---|---|
| VQ lines (qty-matched franchise quotes) | `adempiere.chuboe_vq_line` (via REST API) | Written by `vq-writer.js writeVQFromAPI()` |
| Thin-pointer row per pull | `adempiere.chuboe_pricing_api_result` (via REST API) | One row per (MPN, pull). Joins to RFQ via `AD_Table_ID=1000002 + Record_ID=chuboe_rfq_id` |
| Full pricing envelope | `shared/data/api-pricing-cache/{MPN}_{YYYY-MM-DD}.json` | Local canonical store. Vortex, Quick Quote, Hurricane read here today. |
| Watermark | `~/workspace/.last-rfq-enrich` | Single ISO timestamp, updated atomically after each batch |
| Daily summary email | Jake | 08:00 local, covers prev 24h |
| Error email | Jake | Immediate on any error |

## Files

| File | Purpose |
|---|---|
| `rfq-api-enrichment.md` | This doc (source of truth for the workflow) |
| `enrich-rfq.js` | Library: `enrichRFQ(rfqDocNumber)` → `{summary, vqsWritten, apiCalls, cacheHits, errors}`. Also CLI wrapper: `node enrich-rfq.js --rfq 1132021` |
| `enrich-poller.js` | Cron entry: reads watermark, iterates new RFQs, calls `enrichRFQ`, updates watermark, sends email |

## Manual / On-Demand Runs

```bash
# Single RFQ, bypassing the watermark
node "Trading Analysis/RFQ API Enrichment/enrich-rfq.js" --rfq 1132021

# Force refresh (ignore cache)
node "Trading Analysis/RFQ API Enrichment/enrich-rfq.js" --rfq 1132021 --force

# Dry run (no writes)
node "Trading Analysis/RFQ API Enrichment/enrich-rfq.js" --rfq 1132021 --dry-run
```

## Related

- **`shared/franchise-api.js`** — the API cog. Owns the `cacheTTL` / `cacheBypassIf` interface.
- **`shared/api-result-writer.js`** — owns `getFreshness()`, `writePricingResult()`, and the local cache. "Wherever the api_result idea lives is where the frequency lives."
- **`shared/vq-writer.js`** — `writeVQFromAPI()` handles the VQ capture.
- **`api-integration-roadmap.md` § API Response Caching** — TTL table source of truth.
- **`api-integration-roadmap.md` § Pricing Envelope OT-Native Storage** — the JSON column un-virtualization work that would let thin-pointer rows carry the full envelope in OT.
