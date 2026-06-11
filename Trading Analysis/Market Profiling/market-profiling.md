# MPN Market Intelligence System

Two complementary workflows for market intelligence:

| Workflow | Purpose | Input | Volume | Cadence | API Enrichment? |
|----------|---------|-------|--------|---------|-----------------|
| **Market Profiling** | Map broker availability | Current inventory | ~50/hour (~1,200/day) | Hourly, 24/7 | **NO** (NC scrape only) |
| **Active Sourcing** | Full pricing on delisted parts | Delisted queue | 200/batch | Mon + Thu | **YES** (API + NC RFQ) |

**Key distinction:**
- **Profiled parts** (current inventory) → NC scrape only, no API calls
- **Delisted parts** (left inventory) → Full treatment: API enrichment + NC RFQ submission

---

## Workflow 1: Market Profiling (Scrape-Only)

### Goal
Build a comprehensive database of broker market availability across Americas/EMEA. Know who has stock of parts we carry, even if we've never gotten a VQ from them.

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Inventory Queue                                               │
│  All MPNs from weekly inventory (5,000+ parts)                │
│  Rotate through continuously                                   │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  NetComponents Scraper (--check-only mode)                     │
│  - Search each MPN                                             │
│  - Parse supplier table (vendor, qty, DC, region)              │
│  - NO RFQ form submission                                      │
│  - NO emails to vendors                                        │
│  - Return availability data only                               │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Availability VQ Loader                                        │
│  - Create Stock Profiling RFQ (batch container)                │
│  - Load $0 VQs with:                                           │
│    • cost = 0, qty = supplier_qty                              │
│    • chuboe_note_user = "Market profile {date}: {vendor}       │
│      has {qty} pcs, DC {dc}. Scrape only, no pricing."         │
│  - Handle unknown vendors via placeholder BP + notes           │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Market Intelligence Database                                  │
│  - VQs accumulate over time                                    │
│  - Query: "Which brokers have MPN X?"                          │
│  - Query: "What's total market availability for MPN X?"        │
│  - Query: "Which vendors appear most often?"                   │
└────────────────────────────────────────────────────────────────┘
```

### Commands

```bash
# Run market profiling (uses default batch size of 50)
node "Trading Analysis/Market Profiling/market-profiler.js" --dry-run

# Run with custom batch size
node "Trading Analysis/Market Profiling/market-profiler.js" --limit 100 --commit

# Check profiling watermark
cat ~/.market-profiling-watermark.json
```

### Self-Regulating Operation

The market profiler runs autonomously:
- **Cadence**: Hourly, 24/7
- **Batch size**: ~50 MPNs per tick (~1,200/day)
- **Rotation**: 14-day window - each MPN profiled once per cycle
- **Full rotation**: ~4-5 days to cover entire inventory

No artificial time restrictions - Astute operates globally with purchasing activity at all hours. The hourly cadence combined with small batch sizes spreads load and reduces bot detection risk.

**Combined NC load** (with Active Sourcing):
- Market Profiling: ~1,200 searches/day (check-only, no form submission)
- Active Sourcing: 200 Mon + 200 Thu (with form submission to select vendors)

---

## Workflow 2: Active Sourcing (Delisted Parts Pipeline)

### Goal
Get full pricing (franchise APIs + broker RFQs) on parts that LEFT inventory. These are parts we no longer stock but want market intelligence on before they disappear from our radar.

**Why delisted parts?**
- Current inventory gets profiled via Market Profiling (NC scrape, no API cost)
- Delisted parts need active sourcing because they won't appear in future profiling runs
- Captures pricing data while the parts are still fresh in supplier inventories

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Inventory Cleanup (Monday)                                    │
│  - Compare prior week offers vs current week                   │
│  - Delta (prior - current) = DELISTED parts                    │
│  - Write to ~/.delisted-parts-queue.json                       │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Selection Engine                                              │
│  - Reads from DELISTED QUEUE (not current inventory)           │
│  - Priority: Top-requested → Shortage → Queue rotation         │
│  - Output: 200 unsourced MPNs per batch                        │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Inventory Gate (waits for NC confirmation)                    │
│  - inventory-gate-poller.js polls stockrfq@ hourly             │
│  - Triggers: NC "upload completed" OR Jake forward             │
│  - Creates ~/.inventory-upload-confirmed                       │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Create "Active Sourcing" RFQ in OT                            │
│  - Type: Stock (1000007)                                       │
│  - Description: "Active Sourcing Batch {date}"                 │
│  - 200 lines from delisted queue                               │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Franchise API Enrichment                                      │
│  - Query DigiKey, Mouser, Arrow, TTI, Future, etc.             │
│  - Get baseline pricing BEFORE going to brokers                │
│  - Write VQs from franchise stock                              │
│  - Store results in chuboe_pricing_api_result                  │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Submit RFQs via NetComponents (full mode)                     │
│  - batch_rfqs_from_system.py (BROKERS ONLY - skips ncauth)     │
│  - Vendors receive email RFQs                                  │
│  - 3 parallel workers, normal timing                           │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Mark Sourced + Send Digest                                    │
│  - Mark MPNs sourced in queue (won't re-select)                │
│  - Email digest: batch stats + queue progress %                │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  First Pass Complete?                                          │
│  - When all delisted parts sourced → 🎉 notification           │
│  - Phase 2: New prioritization with full pricing data          │
└────────────────────────────────────────────────────────────────┘
```

### Delisted Parts Queue

**File:** `~/.delisted-parts-queue.json`

```json
{
  "parts": [
    { "mpn": "LM358N", "delistedDate": "2026-06-09", "sourced": false, "sourcedDate": null },
    { "mpn": "MAX232", "delistedDate": "2026-06-09", "sourced": true, "sourcedDate": "2026-06-09T14:30:00Z" }
  ],
  "lastUpdated": "2026-06-11T..."
}
```

**Queue lifecycle:**
1. **Populated by:** `inventory_cleanup.js` (compares prior vs current week)
2. **Consumed by:** `selection-engine.js` (reads unsourced parts)
3. **Updated by:** `active-sourcing-runner.js` (marks parts sourced)

### Batch Digest Email

After each run, operator receives:
```
Subject: Active Sourcing Batch Complete — 35% through delisted queue

THIS BATCH:
  RFQ: 1138472
  Parts sourced: 200
  Franchise coverage: 45/200 (23%)
  API calls: 187 (13 cache hits)

QUEUE PROGRESS:
  Total delisted parts: 1,247
  Sourced so far: 437 (35%)
  Remaining: 810

Next batch: 200 parts on next scheduled run.
```

### First Pass Complete

When queue is exhausted:
```
🎉 FIRST PASS COMPLETE — All delisted parts have been sourced!

Phase 2 prioritization can now begin with full pricing data.
```

Phase 2 will use the collected VQ/API data to prioritize differently (TBD).

### Commands

```bash
# Run selection engine (dry-run)
node "Trading Analysis/Market Profiling/selection-engine.js" --limit 200 --dry-run

# Manage exclusions
node "Trading Analysis/Market Profiling/exclusion-manager.js" list
node "Trading Analysis/Market Profiling/exclusion-manager.js" add --mpns "MPN1,MPN2" --batch "AS-2026-06-03"
node "Trading Analysis/Market Profiling/exclusion-manager.js" clear --batch "AS-2026-06-03"

# Run active sourcing batch
node "Trading Analysis/Market Profiling/active-sourcing-runner.js" --limit 10 --dry-run

# Gate management (inventory upload confirmation)
node "Trading Analysis/Market Profiling/active-sourcing-runner.js" --gate-status
node "Trading Analysis/Market Profiling/active-sourcing-runner.js" --gate-open
node "Trading Analysis/Market Profiling/active-sourcing-runner.js" --limit 200 --commit --force  # bypass gate
```

### Inventory Upload Confirmation Gate

Active Sourcing will NOT run automatically until inventory upload is confirmed:

1. **Cron runs Mon/Thu at 8:30 AM CT** — checks for gate file
2. **Gate closed (default):** Cron exits with "Waiting for inventory upload confirmation"
3. **To open gate:** Jake forwards/replies to inventory upload email to stockrfq@ with "inventory uploaded" in subject
4. **Gate open:** Cron proceeds with sourcing
5. **After successful run:** Gate file consumed — next run waits for new confirmation

This ensures Active Sourcing doesn't run against stale inventory data.

### Schedule

| Day | Time | Activity |
|-----|------|----------|
| Sunday night | — | Fresh inventory file arrives from Infor |
| Monday | 6 AM | Inventory cleanup: write offers to OT, identify delisted parts → queue |
| Monday | 6 AM | NC listing upload (excludes sourcing-in-progress MPNs) |
| Monday | hourly | `inventory-gate-poller` checks for NC confirmation |
| Monday | after gate | **Batch 1**: 200 from delisted queue → API + NC RFQ → digest email |
| Monday-Wednesday | — | Vendor responses arrive, VQ Loading processes them |
| Thursday | hourly | `inventory-gate-poller` checks for NC confirmation |
| Thursday | after gate | **Batch 2**: 200 from delisted queue → API + NC RFQ → digest email |
| Thursday-Sunday | — | Vendor responses arrive |
| Ongoing | — | Queue drains until first pass complete → 🎉 notification |

---

## Shared Infrastructure

### File Structure

```
Trading Analysis/Market Profiling/
├── market-profiling.md              # This documentation
├── selection-engine.js              # Reads from delisted queue, marks sourced
├── market-profiler.js               # Continuous availability scraper (current inventory)
├── availability-vq-loader.js        # Convert scrape results → $0 VQs (brokers only)
├── active-sourcing-runner.js        # Orchestrator: API + NC + digest emails
├── inventory-gate-poller.js         # Polls for NC upload confirmation
├── exclusion-manager.js             # Track MPNs excluded from NC upload
├── vendor-bp-mapping.json           # NC supplier name → OT BP lookup
└── output/
    ├── profiling/                   # Market Profiling scrape results
    └── sourcing/                    # Active Sourcing batch results

State files (in ~/workspace/):
├── .delisted-parts-queue.json       # Delisted MPNs queue (populated by inventory_cleanup)
├── .inventory-upload-confirmed      # Gate file (created by poller, consumed after run)
├── .inventory-gate-poller-state.json # Poller state (last check, last confirmation)
└── .sourcing-exclusions.json        # MPNs excluded from NC CSV upload
```

### Coordination Rules

#### Rule 1: Market Profiling — brokers only, no APIs
Market Profiling scrapes NC for availability but:
- **Skips franchised suppliers** (ncauth CSS class in NC results)
- **No API calls** — franchise data comes via RFQ API Enrichment
- Creates $0 profile VQs for broker availability only

#### Rule 2: Profile VQ deactivation
When real priced VQs arrive (cost > 0), deactivate matching $0 profile VQs:
```sql
-- Find $0 profile VQs within 10-day window
SELECT chuboe_vq_line_id FROM adempiere.chuboe_vq_line
WHERE chuboe_rfq_line_id = $rfqLineId
  AND chuboe_mpn_clean = $mpn
  AND c_bpartner_id = $bpId
  AND cost = 0 AND isactive = 'Y'
  AND created > NOW() - INTERVAL '10 days';
-- PATCH IsActive = false on each
```
This prevents duplicate VQs (profile + real) for same MPN/vendor.

#### Rule 3: Broker VQ consolidation
When a broker has multiple availability rows for same MPN (different date codes, etc.):
- **Consolidate** into 1 VQ with total qty
- Use best date code from the group
- Prevents cluttered VQ lists

#### Rule 4: Delisted queue is source of truth
Active Sourcing pulls ONLY from delisted queue, not current inventory.
- Current inventory → Market Profiling (NC scrape only)
- Delisted parts → Active Sourcing (API + NC RFQ)

### De-listing Clarification

**IMPORTANT:** The exclusion mechanism ONLY affects NetComponents CSV files.

| Data destination | Excluded? | Reason |
|------------------|-----------|--------|
| OT `chuboe_offer` | NO | Our internal inventory record stays complete |
| NetComponents CSV | YES | Hide from competitors during price-check |

---

## End-to-End Workflow: Market Profiling

### Step 1: Query inventory MPNs
Query OT for all active inventory MPNs not profiled in last 14 days.
**Output:** List of MPNs with qty

### Step 2: Get or create profiling RFQ
Create a new "Stock Profiling {date}" RFQ if one doesn't exist for this week.
**Output:** RFQ search key

### Step 3: Run NC scraper in check-only mode
```bash
cd ~/workspace/astute-workinstructions/Trading\ Analysis/RFQ\ Sourcing/netcomponents/python
python3 batch_rfqs_from_system.py --check-only --limit 500 <rfq_number>
```
**Output:** Excel with availability data (Status = SCRAPED)

### Step 4: Load availability VQs
Convert scrape results to $0 VQs. Handle unknown vendors via placeholder BP.
**Output:** VQs written to chuboe_vq_line

### Step 5: Update watermark
Record which MPNs were profiled and when.
**Output:** Updated .market-profiling-watermark.json

---

## End-to-End Workflow: Active Sourcing

### Step 1: Check inventory gate
Verify NC has confirmed inventory upload. Gate file: `~/.inventory-upload-confirmed`
**If closed:** Exit, wait for next hourly poll
**If open:** Proceed

### Step 2: Run selection engine
Read 200 unsourced MPNs from delisted queue (`~/.delisted-parts-queue.json`).
**Output:** List of 200 MPNs (or fewer if queue nearly exhausted)

### Step 3: Add to exclusion list
Add MPNs to .sourcing-exclusions.json so next inventory upload excludes them.
**Output:** Updated exclusion file

### Step 4: Create Active Sourcing RFQ
Create Stock RFQ with lines from delisted queue.
**Output:** RFQ search key

### Step 5: Add lines to RFQ
POST each selected MPN to `chuboe_rfq_line` + `chuboe_rfq_line_mpn`.
**Output:** RFQ with line items

### Step 6: Franchise API enrichment
Query DigiKey, Mouser, Arrow, TTI, Future, etc. for baseline pricing.
**Output:** Franchise VQs written to chuboe_vq_line, API results to chuboe_pricing_api_result

### Step 7: Run NC scraper in full mode (BROKERS ONLY)
```bash
python3 batch_rfqs_from_system.py <rfq_number>
```
**Note:** Skips franchised suppliers (ncauth CSS class) — franchise data comes from APIs.
**Output:** Excel with sent RFQs + scraped broker availability

### Step 8: Load availability VQs
Broker availability → $0 VQs (consolidated: multiple rows same MPN/vendor → 1 VQ with total qty)
Deactivates existing $0 profile VQs when real priced VQs arrive.

### Step 9: Mark sourced in queue
Update delisted queue: set `sourced: true`, `sourcedDate: now` for processed MPNs.
**Output:** Queue updated, MPNs won't be re-selected

### Step 10: Send batch digest email
Email operator with:
- Batch stats (RFQ#, parts sourced, franchise coverage %)
- Queue progress (X/Y sourced, Z% complete, remaining)

### Step 11: Consume gate + check completion
- Delete gate file (next run waits for new NC confirmation)
- If queue exhausted → send "First Pass Complete" notification

**Value of franchise enrichment (Step 6):**
- Baseline pricing BEFORE broker quotes arrive
- Identify franchise-covered vs broker-only parts
- Price comparison context for buyer decisions

---

## Verification Commands

```bash
# Test check-only mode
cd ~/workspace/astute-workinstructions/Trading\ Analysis/RFQ\ Sourcing/netcomponents/python
python3 batch_rfqs_from_system.py --check-only --limit 5 <test_rfq>

# Test availability VQ loading (dry-run)
node "Trading Analysis/Market Profiling/availability-vq-loader.js" --dry-run scrape_results.xlsx

# Test exclusion integration
node "Trading Analysis/Market Profiling/exclusion-manager.js" add --mpns "TEST123" --batch test
node "Trading Analysis/Inventory File Cleanup/inventory_cleanup.js" <input.xlsx> --dry-run
# Verify TEST123 is excluded from NC CSV

# Full active sourcing test
node "Trading Analysis/Market Profiling/active-sourcing-runner.js" --limit 10 --dry-run
```

---

## Roadmap

### Completed Enhancements

| Date | Enhancement | Description |
|------|-------------|-------------|
| 2026-06-03 | **Proactive franchise enrichment** | ✅ Active Sourcing enriches selected MPNs with DigiKey/Mouser/Arrow APIs BEFORE sourcing to brokers. |
| 2026-06-11 | **Delisted parts pipeline** | ✅ Active Sourcing now sources from DELISTED parts queue instead of current inventory. Inventory cleanup tracks delta (prior - current week), writes to queue. Selection engine reads from queue, marks sourced. |
| 2026-06-11 | **NC confirmation gate** | ✅ `inventory-gate-poller.js` polls stockrfq@ for NC upload confirmation. Active Sourcing waits for gate before running. |
| 2026-06-11 | **Batch digest emails** | ✅ After each batch: email with parts sourced, franchise coverage %, queue progress (X/Y sourced). |
| 2026-06-11 | **First pass notification** | ✅ When all delisted parts sourced → "First Pass Complete" email. Phase 2 prioritization can begin. |
| 2026-06-11 | **Profile VQ deactivation** | ✅ $0 profile VQs are deactivated when real priced VQs arrive (same MPN/vendor within 10 days). |
| 2026-06-11 | **Broker VQ consolidation** | ✅ Multiple availability rows for same MPN/vendor → consolidated to 1 VQ with total qty. |
| 2026-06-11 | **Franchise skip in NC scraper** | ✅ NC scraper skips suppliers with `ncauth` class (franchised) — franchise data comes via APIs. |

### Planned Enhancements

| Priority | Enhancement | Description |
|----------|-------------|-------------|
| 🔴 | **Phase 2 prioritization** | After first pass complete, use collected VQ/API data to prioritize next rotation differently. TBD: risk-weighted, demand-based, price-volatility signals. |
| 🟡 | **Risk-weighted rotation** | Cycle higher-risk parts more frequently. Criteria: high-value MFRs, volatile pricing history, customer demand signals, long lead times. |
| 🟡 | **Weekly RFQ container** | Single "Market Intelligence Week of {date}" RFQ per week for all profiling + sourcing VQs. |
| 🟢 | **Full inventory franchise rotation** | Continuous enrichment ~500 MPNs/day covering full inventory in 10 days. Complements Active Sourcing with broader franchise coverage. |
