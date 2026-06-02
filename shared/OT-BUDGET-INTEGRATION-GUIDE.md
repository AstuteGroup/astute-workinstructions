# Global OT API Budget - Integration Guide

**Reference implementation:** `shared/vq-writer.js` (completed 2026-06-02)

## Pattern (Copy-Paste Ready)

### 1. Import at top of file

```javascript
const otBudget = require('./ot-api-budget');
```

### 2. Add budget check at start of write function

```javascript
async function writeXXX(opts) {
  const itemCount = opts.lines.length; // or whatever determines write count
  const isBackfill = opts.unseenEmailCount >= 20; // or other backfill trigger

  // TIER 1: Global budget check
  const globalCheck = otBudget.checkBudget({
    table: 'chuboe_xxx',           // Target table
    count: itemCount,              // Estimated writes
    caller: 'xxx-agent',           // From LIMITS.priorities in ot-api-budget.js
    isBackfill,                    // Boolean
  });

  if (!globalCheck.allowed) {
    logger.warn(`Global budget exhausted: ${globalCheck.reason}`);
    return {
      written: [],
      rateLimited: true,
      rateLimitReason: globalCheck.reason,
      rateLimitTier: 'global',
    };
  }

  // TIER 2: Process-specific checks (if any)
  // ... your existing rate limiter ...

  // Reserve budget before writing
  otBudget.reserve('chuboe_xxx', itemCount, 'xxx-agent');

  // Claim backfill slot if in backfill mode
  if (isBackfill) {
    otBudget.claimBackfillSlot('xxx-agent');
  }

  const writeStartTime = Date.now();

  // ... do the writes ...
}
```

### 3. Record writes at end of function

```javascript
  const writeDuration = Date.now() - writeStartTime;

  if (successCount > 0) {
    otBudget.recordWrites('chuboe_xxx', successCount, {
      caller: 'xxx-agent',
      success: true,
      durationMs: writeDuration,
    });
  }

  if (failureCount > 0) {
    for (let i = 0; i < failureCount; i++) {
      otBudget.recordFailure();
    }
  }

  // Release backfill slot if we claimed it
  if (isBackfill) {
    otBudget.releaseBackfillSlot('xxx-agent');
  }

  return { written, failed, ... };
```

## Remaining Integrations (Priority Order)

### 1. ✅ `shared/vq-writer.js` - DONE
- Priority 3 (VQ loading)
- Table: `chuboe_vq_line`
- Caller: `vq-loading-agent`
- Integrated: 2026-06-02

### 2. `shared/rfq-fast-loader.js`
- Priority 4 (RFQ loading - HIGHEST)
- Table: `chuboe_rfq` / `chuboe_rfq_line` / `chuboe_rfq_line_mpn`
- Caller: `rfq-loading-agent`
- Function: `loadRFQ(opts)` at line ~89
- Estimated writes: `opts.lines.length * 2` (line + line_mpn for each)

### 3. `shared/offer-writeback.js`
- Priority 2 (Excess, Inventory)
- Table: `chuboe_offer` / `chuboe_offer_line` / `chuboe_offer_line_mpn`
- Caller: `excess-agent` or `inventory-cleanup`
- Functions: `writeOffer(opts)` and `writeOffers(offers)`
- Estimated writes: Similar to RFQ (header + lines + line_mpns)

### 4. `shared/api-result-writer.js`
- Priority 2 (Enrichment)
- Table: `chuboe_pricing_api_result`
- Caller: `enrich-poller`
- Function: `writePricingResult(opts)` and `flushCacheToDB()`
- Note: External API calls to DigiKey/Mouser stay in `enrichment-rate-limiter.js`

### 5. `shared/cq-writer.js`
- Priority 2
- Table: `chuboe_cq_line`
- Caller: `stockrfq-cq-agent`
- Functions: `writeCQ(rfq, line)` and `writeCQBatch(rfq, lines)`

### 6. Stock RFQ Agent
- Priority 1 (LOWEST - gets throttled first)
- Table: `chuboe_rfq` / `chuboe_rfq_line` / `chuboe_rfq_line_mpn`
- Caller: `stockrfq-agent`
- Location: `shared/workflow-actions/stockrfq.js` in `action_load_rfq()` handler
- Estimated writes: ~3 per email (header + line + line_mpn)

## Testing

After integrating each writer:

```bash
# Check global budget status
node -e "const r=require('./astute-workinstructions/shared/ot-api-budget'); console.log(JSON.stringify(r.getStatus(), null, 2));"

# Watch for 5-min burst protection triggering
tail -f /tmp/vq-loading-agent.log | grep "5-min burst"
```

## Backfill Detection Logic

- **VQ loading:** `unseenEmailCount >= 20`
- **RFQ loading:** `unseenEmailCount >= 20` (or check queue depth)
- **Enrichment:** `unenrichedCount >= 30`
- **Stock RFQ:** `unseenEmailCount >= 20`
- **Excess:** `unseenEmailCount >= 20`

## Common Gotchas

1. **Don't forget to release backfill slot** - use try/finally if needed
2. **Reserve BEFORE writing** - prevents race conditions
3. **Use correct table name** - matches LIMITS.perTable in ot-api-budget.js
4. **Use correct caller name** - matches LIMITS.priorities in ot-api-budget.js
5. **Duration tracking is optional** - helps with future adaptive throttling

## Caller Names (from ot-api-budget.js)

```javascript
priorities: {
  'rfq-loading-agent': 4,    // Highest
  'rfq-fast-loader': 4,      // Same tier
  'vq-loading-agent': 3,     // Second
  'excess-agent': 2,         // Third
  'stockrfq-agent': 1,       // Lowest
  'stockrfq-cq-agent': 1,    // Lowest
  'enrich-poller': 2,        // Third
  'offer-writeback': 2,      // Third
  'inventory-cleanup': 2,    // Third
}
```
