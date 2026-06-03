# MPN Market Intelligence System

Two complementary workflows for market intelligence:

| Workflow | Purpose | Volume | Cadence | De-list? | Vendor Contact? |
|----------|---------|--------|---------|----------|-----------------|
| **Market Profiling** | Map broker availability | ~50/hour (~1,200/day) | Hourly, 24/7 | No | No (scrape only) |
| **Active Sourcing** | Price check priority parts | 200/batch | Mon + Thu | Yes | Yes (RFQ emails) |

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

## Workflow 2: Active Sourcing (Price Check with De-listing)

### Goal
Get real pricing on 200 priority parts twice weekly. De-list from NetComponents during sourcing so competitors don't see our inventory while we price-check.

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Selection Engine                                              │
│  Priority: Top-requested → High-end MFRs → Shortage → Rotate   │
│  Output: 200 MPNs per batch                                    │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  DE-LIST from NetComponents                                    │
│  - Add MPNs to .sourcing-exclusions.json                       │
│  - inventory_cleanup.js checks this when building NC CSV       │
│  - OT write-back is NOT affected                               │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Create "Active Sourcing" RFQ in OT                            │
│  - Type: Stock (1000007)                                       │
│  - Description: "Active Sourcing Batch {date}"                 │
│  - 200 lines with actual inventory qtys                        │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Submit RFQs via NetComponents (full mode)                     │
│  - batch_rfqs_from_system.py (full submission mode)            │
│  - Vendors receive email RFQs                                  │
│  - 3 parallel workers, normal timing                           │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  Capture Responses                                             │
│  - Vendor quote emails → Standard VQ Loading workflow          │
│  - Scraped availability → $0 VQs (like Market Profiling)       │
└─────────────────────────┬──────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────┐
│  RE-LIST on NetComponents                                      │
│  - Wait for Monday auto-upload (simplest)                      │
│  - Exclusion cleared after 7 days automatically                │
└────────────────────────────────────────────────────────────────┘
```

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
```

### Schedule

| Day | Time | Activity |
|-----|------|----------|
| Sunday night | — | Fresh inventory file arrives from Infor |
| Monday | 6 AM | Inventory upload runs (excludes "sourcing in progress" MPNs from NC CSV) |
| Monday | 8 AM | **Batch 1**: Select 200 → Create RFQ → Profile + Source via NC |
| Monday-Wednesday | — | Vendor responses arrive, VQ Loading processes them |
| Thursday | 8 AM | **Batch 2**: Select 200 → Create RFQ → Profile + Source via NC |
| Thursday-Sunday | — | Vendor responses arrive |
| Sunday night | — | Exclusions auto-expire (7 day TTL) |

---

## Shared Infrastructure

### File Structure

```
Trading Analysis/Market Profiling/
├── market-profiling.md              # This documentation
├── selection-engine.js              # Priority-based MPN selection (Active Sourcing)
├── market-profiler.js               # Continuous availability scraper (Market Profiling)
├── availability-vq-loader.js        # Convert scrape results → $0 VQs
├── active-sourcing-runner.js        # Orchestrator for price-check batches
├── exclusion-manager.js             # Track MPNs excluded from NC upload
├── vendor-bp-mapping.json           # NC supplier name → OT BP lookup
└── output/
    ├── profiling/                   # Market Profiling scrape results
    └── sourcing/                    # Active Sourcing batch results
```

### Coordination Rules

#### Rule 1: Market Profiling checks existing VQs
Before creating a $0 availability VQ, check:
```sql
SELECT 1 FROM adempiere.chuboe_vq_line v
WHERE v.chuboe_mpn_clean = $mpn
  AND v.c_bpartner_id = $vendorBpId
  AND v.created > NOW() - INTERVAL '14 days'
  AND v.isactive = 'Y'
LIMIT 1;
```

#### Rule 2: Active Sourcing profiles AND sources
When Active Sourcing searches an MPN:
- **PROFILE**: Capture ALL availability data from search results
- **SOURCE**: Send RFQs to SELECT vendors based on NC workflow rules

#### Rule 3: Real pricing updates availability records
When Active Sourcing receives real pricing:
- If a $0 availability VQ exists, update with real pricing (PATCH)
- Don't create a duplicate VQ

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

### Step 1: Run selection engine
Query OT for 200 priority MPNs based on request frequency, MFR value, shortage status.
**Output:** List of 200 MPNs

### Step 2: Add to exclusion list
Add MPNs to .sourcing-exclusions.json so next inventory upload excludes them.
**Output:** Updated exclusion file

### Step 3: Create Active Sourcing RFQ
Create Stock RFQ with 200 lines.
**Output:** RFQ search key

### Step 4: Run NC scraper in full mode
```bash
python3 batch_rfqs_from_system.py <rfq_number>
```
**Output:** Excel with sent RFQs + scraped availability

### Step 5: Load availability VQs
Profile data (all vendors) → $0 VQs
Sent RFQs → await vendor quote emails via standard VQ Loading

### Step 6: Monitor responses
VQ Loading processes quote emails over next 3-4 days.

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
