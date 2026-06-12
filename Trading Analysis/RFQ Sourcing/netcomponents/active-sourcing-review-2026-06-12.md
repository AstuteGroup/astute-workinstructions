# Active Sourcing Workflow — Review & Proposed Changes

**Date:** 2026-06-12
**Status:** Paused for review (`.cron-agents-paused` set)

---

## Current Process Summary

### Overview

Active Sourcing automatically price-checks inventory by:
1. Selecting 200 priority MPNs from current inventory
2. Temporarily hiding them from NetComponents (competitor protection)
3. Submitting RFQs to brokers via NetComponents portal
4. Loading responses as VQs over the following days

**Schedule:** Monday + Thursday at 6:30 AM CT

---

### Step-by-Step Flow

| Step | Component | Action |
|------|-----------|--------|
| 1 | `selection-engine.js` | Pick 200 MPNs by priority (top-requested, high-value MFRs, shortage parts) |
| 2 | `exclusion-manager.js` | Add to exclusion list (7-day TTL) — hides from NC uploads |
| 3 | `active-sourcing-runner.js` | Create RFQ in OT, add 200 lines |
| 4 | `enrich-rfq.js` | Get franchise baseline pricing (DigiKey, Mouser, Arrow) |
| 5 | `batch_rfqs_from_system.py` | Submit RFQs to NC brokers (3 per region max) |
| 6 | `availability-vq-loader.js` | Load $0 availability VQs from scrape |
| 7 | VQ Loading workflow | Real pricing comes via email over next few days |

---

### Broker Selection Logic (Current)

For each MPN, select up to **3 suppliers per region** (Americas + Europe):

- In-stock only (skip "Brokered Inventory Listings")
- Non-franchise (skip authorized distributors)
- Prioritize by: fresh date code → qty coverage → unknown DC buffer

**Problem:** If Broker X lists 40 of the 200 MPNs, they receive 40 RFQ emails in one batch.

---

## Issues Identified

### Issue #1: Supplier Fatigue (Primary)

**Symptom:** Same broker getting blasted with many RFQs in a single batch.

**Example:** Active Sourcing runs with 200 parts. Broker "ABC Electronics" lists 35 of them. They receive 35 separate RFQ emails within ~45 minutes.

**Impact:**
- Annoying for suppliers
- Risk of being flagged as spam
- May damage relationship / response rates

**Root cause:** No per-batch supplier cap — selection is per-MPN without cross-MPN awareness.

---

### Issue #2: Duplicate MPNs Across Batches

**Symptom:** Same MPN appearing in Monday's batch and Thursday's batch.

**Impact:** Brokers get asked for same part twice in one week.

**Root cause:** Cooldown logic existed (`rfq_history.py`) but was NOT integrated into `batch_rfqs_from_system.py`.

**Status:** FIXED today (2026-06-12). Cooldown now checks before sending and records after.

---

## Changes Implemented Today

### Cooldown Integration (Done)

Modified `batch_rfqs_from_system.py`:

1. **Before sending RFQ:** Check `rfq_history.check_cooldown(supplier, mpn)`
2. **Skip if blocked:** Status = `COOLDOWN` (light blue in Excel output)
3. **After successful send:** Call `rfq_history.record_rfq()` to track

**Cooldown windows:**
| Scenario | Window |
|----------|--------|
| Default | 60 days |
| Memory products | 14 days |
| After no-bid | 90 days |

---

## Proposed Changes (Not Yet Implemented)

### Proposal: Per-Batch Supplier Cap

**Goal:** Limit any single supplier to N RFQs per batch run.

**Implementation approach:**
1. Track running count per supplier during batch processing
2. Before sending RFQ, check if supplier has hit cap
3. If at cap, skip with status `SUPPLIER_CAP` and continue to next supplier
4. Log skipped suppliers for visibility

**Suggested caps:**

| Cap | Behavior |
|-----|----------|
| **5** | Conservative — good for relationship building |
| **10** | Moderate — allows high-volume suppliers to participate |
| **15** | Light touch — just prevents extreme cases |

**Trade-offs:**
- Lower cap = better supplier relations, but may miss coverage on some MPNs
- Higher cap = more coverage, but more supplier fatigue risk
- Could make cap configurable per supplier (e.g., larger brokers tolerate more)

**Decision needed:** What cap value to implement?

---

### Proposal: Supplier Tier System (Future)

Categorize suppliers by relationship quality and set different caps:

| Tier | Cap | Examples |
|------|-----|----------|
| Preferred | 15 | High-response suppliers with good conversion |
| Standard | 10 | Most brokers |
| Cautious | 5 | Low-response or complained previously |
| Blocked | 0 | Do not RFQ (bad experience) |

**Depends on:** Tracking response rates over time (partially exists in `rfq_history.py` supplier stats)

---

### Proposal: Pre-Batch Distribution Analysis (Future)

Before processing, analyze supplier overlap:
1. For all 200 MPNs, scrape which suppliers list each
2. Identify high-overlap suppliers
3. Distribute RFQs across suppliers more evenly
4. Could prefer less-contacted suppliers when multiple qualify

**Trade-off:** Adds complexity and processing time.

---

## Files Changed Today

| File | Change |
|------|--------|
| `batch_rfqs_from_system.py` | Integrated cooldown checks + recording |
| `rfq-sourcing-netcomponents.md` | Documented cooldown feature |
| `sourcing-roadmap.md` | Updated changelog |
| `.cron-agents-paused` | Created to pause sourcing |

---

## Next Steps

1. **Decide on supplier cap value** (5 / 10 / 15)
2. **Implement per-batch supplier cap** in `batch_rfqs_from_system.py`
3. **Test with dry-run** on existing RFQ
4. **Remove pause file** to resume: `rm ~/workspace/.cron-agents-paused`
5. **Monitor first batch** after resumption

---

## Commands Reference

```bash
# Check cooldown status for a supplier+MPN
python rfq_history.py check "Broker Name" "MPN123"

# View supplier rankings (template prioritization)
python rfq_history.py rankings

# View history summary
python rfq_history.py summary

# Resume sourcing when ready
rm ~/workspace/.cron-agents-paused

# Run manually with dry-run
node active-sourcing-runner.js --limit 50 --dry-run

# Run manually for real
node active-sourcing-runner.js --limit 50 --commit --force
```

---

*Document generated 2026-06-12 for weekend review.*
