# API Cache Flow Audit — 2026-07-20

## Executive Summary

The caching system has **multiple gaps** that collectively caused ~215K wasted DigiKey API calls. While the infrastructure for per-distributor caching exists, several bugs prevent it from working:

1. **'carried' results not returned from cache** (FIXED today)
2. **'matched_no_price' never recorded** — found but no pricing = no cache
3. **Envelope cache "Failed" gate** — one failed disty rejects all 10
4. **41:1 not_carried:carried ratio** — suggests 'carried' not being recorded correctly

---

## Cache Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  searchAllDistributors(mpn, qty, { cacheTTL })                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ LAYER 1: Envelope Cache (api-result-writer.js)                         ││
│  │ • Per-MPN JSON blob with ALL distributors                              ││
│  │ • TTL: 7-30 days depending on RFQ type                                 ││
│  │ • ISSUE: Rejects entire envelope if ANY disty has "Failed" status      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                            │                                                │
│                            ▼ (if cache miss or stale)                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ For each distributor: searchPart(disty, mpn, qty)                      ││
│  │                                                                         ││
│  │ ┌─────────────────────────────────────────────────────────────────────┐││
│  │ │ LAYER 2: Negative Cache (api-negative-cache.js - SQLite)           │││
│  │ │ • Per-(MPN, MFR, Distributor) entries                              │││
│  │ │ • Results: 'not_carried' | 'carried' | 'matched_no_price'          │││
│  │ │ • TTL: not_carried=180d, carried=7d, quota_exhausted=midnight      │││
│  │ │                                                                     │││
│  │ │ ISSUE 1: Was only checking 'not_carried' and 'quota_exhausted'     │││
│  │ │          'carried' was IGNORED → fresh API call every time         │││
│  │ │          STATUS: FIXED 2026-07-20                                  │││
│  │ │                                                                     │││
│  │ │ ISSUE 2: 'matched_no_price' NEVER recorded from franchise-api.js   │││
│  │ │          If found=true but no priceBreaks → nothing cached         │││
│  │ │          STATUS: NOT FIXED                                         │││
│  │ └─────────────────────────────────────────────────────────────────────┘││
│  │                                                                         ││
│  │ If no cache hit → Live API call → Record result                        ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  After all distributors complete:                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ writePricingResult() → writes envelope to JSON blob cache               ││
│  │ ISSUE: Includes Failed distys in envelope → poisons cache for Layer 1  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Issue Details

### Issue 1: 'carried' results not returned from cache — FIXED

**Location:** `shared/franchise-api.js` line 320

**Before:**
```javascript
// Only checked not_carried and quota_exhausted
if (hit && (hit.result === 'not_carried' || hit.result === 'quota_exhausted')) {
  return { found: false, cached: true, ... };
}
// 'carried' results fell through → fresh API call
```

**After (fixed 2026-07-20):**
```javascript
// Now also returns cached 'carried' results
if (hit && hit.result === 'carried') {
  return {
    found: true,
    cached: true,
    franchiseQty: hit.stock_qty,
    franchisePrice: hit.cost_unit,
    ...
  };
}
```

**Impact:** This was the primary cause of wasted calls. Even though we recorded 'carried' in the cache, we never used it.

---

### Issue 2: 'matched_no_price' never recorded — NOT FIXED

**Location:** `shared/franchise-api.js` lines 497-519

**Current logic:**
```javascript
if (result?.found === true && hasPriceBreaks) {
  _negCache.record({ result: 'carried', ... });
} else if (result?.found === false) {
  _negCache.record({ result: 'not_carried', ... });
}
// MISSING: found === true && !hasPriceBreaks → nothing recorded!
```

**Problem:** If a distributor returns "we carry this part" but doesn't provide price breaks, we don't cache anything. Next query will make a fresh API call.

**Evidence:** Only 9,356 'carried' entries vs 385,369 'not_carried' (41:1 ratio). This seems too skewed — suggests many "found" results aren't being recorded.

**Fix needed:**
```javascript
if (result?.found === true && hasPriceBreaks) {
  _negCache.record({ result: 'carried', ... });
} else if (result?.found === true && !hasPriceBreaks) {
  _negCache.record({ result: 'matched_no_price', ... });  // ADD THIS
} else if (result?.found === false) {
  _negCache.record({ result: 'not_carried', ... });
}
```

---

### Issue 3: Envelope cache "Failed" gate — NOT FIXED

**Location:** `shared/api-result-writer.js` lines 331-337

**Current logic in getFreshness():**
```javascript
const failedDistys = statusEntries
  .filter(s => s.PricingResponseStatus === 'Failed')
  .map(s => s.APIName);
if (failedDistys.length > 0) {
  return { fresh: false, ... };  // ENTIRE envelope rejected
}
```

**Problem:** If DigiKey failed (rate limit), but Mouser/Arrow/etc succeeded, the entire envelope is rejected. This forces re-query of ALL 10 distributors.

**Why it didn't cause the disaster (with our Layer 2 fix):**
- Envelope cache (Layer 1) rejects → falls through to per-disty calls
- Per-disty calls now check negative cache (Layer 2) first
- With 'carried' fix, successful results ARE served from Layer 2
- So effectively Layer 1 is bypassed when it has failures

**But it's still wasteful:** Layer 1 could serve 9 successful distys and only re-call DigiKey, instead of falling through to Layer 2 for all 10 checks.

**Recommendation:** Change the Failed gate to return partial results for distys that succeeded, and only mark failed distys for re-query.

---

### Issue 4: Rate limiting architecture gaps — PARTIALLY FIXED

**Today's fixes:**
- Added DigiKey + all distys to `api-throttle.js` (pre-emptive token bucket)
- Added circuit breaker (10 consecutive 429s → 30min cooldown)
- Added daily ceilings for all distys in `api-daily-counter.js`
- Added `markAtCeiling()` — on first 429, block ALL calls until midnight
- Added jitter to 429 retry (1-2h instead of fixed 1h)

**Remaining gap:**
- The retry queue can still attempt calls faster than the throttle allows if items are already queued
- Consider: should we drain the retry queue through the throttle instead of just gating new calls?

---

## Cache Stats (as of 2026-07-20)

### Negative Cache (SQLite)
| Result | Count | TTL |
|--------|-------|-----|
| not_carried | 385,369 | 180 days |
| carried | 9,356 | 7 days |
| quota_exhausted | 768 | midnight |

### Envelope Cache (JSON blobs)
- 61,869 files in `shared/data/api-pricing-cache/`
- 66% of July files have at least one "Failed" distributor
- Effectively useless for cacheTTL checks due to Failed gate

---

## Recommended Fixes (Priority Order)

### 1. ✅ DONE: Return 'carried' from negative cache
Implemented today. Cached pricing data now served instead of fresh API calls.

### 2. ✅ DONE: Record 'matched_no_price'
When found=true but no priceBreaks, now records to negative cache so we don't re-call.
Also added cache check handling to return cached 'matched_no_price' results.

### 3. TODO: Fix envelope Failed gate
Options:
- Serve partial results (9/10 distys from cache, re-call only failed)
- Don't write Failed status to envelope
- Remove the Failed gate entirely (rely on Layer 2 per-disty cache)

### 4. TODO: Investigate 41:1 ratio
Why so few 'carried' vs 'not_carried'? Possibilities:
- Most parts really aren't carried by most distys (plausible)
- 'carried' isn't being recorded due to missing priceBreaks (likely)
- Some other code path bypasses recording

---

## Test Plan

After fixes, verify:
1. Same MPN queried twice within 7 days → 0 API calls (all from cache)
2. DigiKey rate limit → only DigiKey blocked, other 9 distys still work
3. Large RFQ (>100 MPNs) → calls spread across days, not dumped immediately
4. Cache hit rate improves from ~0% to >50% for repeat MPNs
