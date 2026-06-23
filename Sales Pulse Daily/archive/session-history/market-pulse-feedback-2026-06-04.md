# Market Pulse Standalone Report — Feedback from Josh (2026-06-04)

## Feedback Session
**Date:** June 4, 2026
**Reviewer:** Josh (VP)
**Mockup Version:** market-pulse-standalone-mockup.html

---

## Action Items for Tomorrow

### 1. Constraint Indicators Section

#### ✅ Keep:
- Multi-Customer Parts
- Conversion Drop-Off
- Velocity Spike (with changes below)

#### ❌ Remove:
- **Margin Expansion Leaders** — too customer-specific, not a reliable market signal

#### 🔧 Modify:

**Multi-Customer Parts:**
- **ADD:** Distinct customer count in the display
- Current: "8 customers" is shown but make it more prominent
- Suggested format: "MT47H128M16RT-25E:C — **8 distinct customers**, 47 RFQ lines, 12% quoted"

**Velocity Spike:**
- **REMOVE:** The >50% threshold requirement
- **CHANGE:** Always show **top 3 manufacturers** by velocity increase (even if <50%)
- Rationale: Want to see what's accelerating regardless of threshold
- Display format: Show top 3 with actual % increase

---

### 2. Year-over-Year Seasonality Context

**New concept:** Compare current week to same week last year to account for seasonal patterns

**Example use case:**
- Chinese New Year typically causes business slowdown
- Week 23 of 2026 vs Week 23 of 2025 comparison
- "Are we up or down from last year this week?"

**Implementation questions to resolve:**
- [ ] What metric to compare YoY? (RFQ volume? Booked sales? Both?)
- [ ] Where to display this? (Temperature Gauge section? Separate section?)
- [ ] How many weeks back to compare? (Just this week? Rolling 4-week avg?)
- [ ] Which manufacturers/parts to show YoY trends for? (Top 10? All?)

**Suggested placement:** Add a small section in the Temperature Gauge or as a standalone "Seasonal Context" box

---

### 3. Trending Manufacturers — Table Changes

#### ❌ Remove Column:
- **Avg Quote Age** — not helpful information

#### ✅ Add Column:
- **Booked Sales (30d)** — $ amount of sales orders won for this manufacturer in rolling 30-day window

#### 🔄 Reconsider Ranking Logic:
- **Current:** Top 10 by RFQ line count
- **Proposed:** Top 10 by **Sold** (either $ booked or # of lines sold)
- Rationale: RFQ volume doesn't show what actually converted to revenue
- **Question for tomorrow:** Rank by $ booked or by # lines sold? Or offer both views?

**New table structure:**
| Manufacturer | Customers | RFQ Count | Quoted | Sold | Win % | **Booked Sales** | WoW Velocity | Signals |
|--------------|-----------|-----------|--------|------|-------|------------------|--------------|---------|

---

### 4. New Section: Trending Manufacturers Routed to Buyer Queue

**Concept:** Show which manufacturers have the most RFQs currently in the buyer sourcing queue (not yet quoted)

**Why it matters:**
- Shows what buyers are actively working on
- Identifies bottlenecks (high queue volume = buyers struggling to source)
- Leading indicator of what will be quoted soon

**Suggested metrics:**
- Manufacturer
- # RFQ lines in buyer queue
- Avg days in queue
- Assigned buyer (if applicable)
- Oldest RFQ date in queue

**Implementation question:**
- [ ] What field/status indicates "routed to buyer queue"? (Need to check data model)
- [ ] Should this be a separate section or integrated into Trending Manufacturers?

---

### 5. Astute Stock Indicator

**Requirement:** Flag when trending parts are available in Astute stock

**Implementation:**
- [ ] Join trending parts to inventory tables (chuboe_productstock?)
- [ ] Add a column/badge: "In Stock" or qty available
- [ ] If in stock, show warehouse location(s)?

**Display format:**
- Badge: `🏠 In Stock (W104: 1,200 pcs)`
- Or simpler: `✅ Astute Stock` badge

**Question for tomorrow:**
- Show just "in stock" flag or actual quantities?
- Show warehouse location or just aggregate?

---

### 6. Part Lifecycle Data Integration

**Concept:** Integrate online lifecycle data (active, NRND, EOL, obsolete) for trending parts

**Potential sources:**
- Silicon Expert API
- IHS Markit API
- Octopart API
- Broker aggregators (SiliconExpert, Z2Data)

**Why it matters:**
- EOL/NRND parts trending = allocation/last-time-buy signal
- Active parts trending = demand surge
- Obsolete parts trending = legacy system support needs

**Display format:**
- Add "Lifecycle" column to Trending Parts table
- Badge: `🟢 Active` | `🟡 NRND` | `🔴 EOL` | `⚫ Obsolete`

**Implementation questions:**
- [ ] Which API to use? (License cost? Data coverage?)
- [ ] Real-time API call or batch refresh?
- [ ] Fallback if API unavailable?
- [ ] Store lifecycle data in OT/intermediate schema?

**Action for tomorrow:**
- Research available lifecycle APIs
- Check if we already have any integrations
- Determine feasibility/cost

---

## Summary of Changes

### Remove:
1. Margin Expansion Leaders section (constraint indicators)
2. Avg Quote Age column (trending manufacturers)

### Add:
1. Distinct customer count emphasis (multi-customer parts)
2. Booked Sales column (trending manufacturers)
3. Top 3 velocity manufacturers (always show, no threshold)
4. New section: Trending Manufacturers in Buyer Queue
5. Astute Stock indicator (trending parts)
6. Part lifecycle data (trending parts) — **research needed**

### Modify:
1. Consider ranking by Sold instead of RFQ count (trending manufacturers)
2. Add YoY seasonality context (new concept, placement TBD)

---

## Questions to Resolve Tomorrow

1. **YoY Comparison:**
   - What metric(s) to compare year-over-year?
   - Where to display it in the report?
   - Rolling 4-week avg or just single week?

2. **Trending Manufacturers Ranking:**
   - Rank by $ booked, # lines sold, or RFQ count?
   - Or provide multiple views?

3. **Buyer Queue Data Model:**
   - What field indicates "routed to buyer queue"?
   - Status field? Assignment field? Separate queue table?

4. **Astute Stock Display:**
   - Flag only or show quantities?
   - Aggregate or by warehouse?

5. **Lifecycle Data API:**
   - Which vendor/API to use?
   - Cost and licensing?
   - Real-time or batch refresh?

---

## Next Steps

1. **Read data model** (`shared/data-model.md`) to answer:
   - Buyer queue tracking fields
   - Stock/inventory schema
   - Sales order linking for "booked sales"

2. **Research lifecycle APIs:**
   - Silicon Expert
   - IHS Markit
   - Octopart
   - Z2Data

3. **Update mockup HTML** with approved changes (remove margin expansion, update columns)

4. **Draft SQL queries** for new sections (buyer queue, YoY comparison)

5. **Check existing integrations** — do we already call any lifecycle/market data APIs?

---

## File References

- **Mockup:** `/home/melissa.bojar/workspace/market-pulse-standalone-mockup.html`
- **Data Model:** `~/workspace/astute-workinstructions/shared/data-model.md`
- **API Integrations:** `~/workspace/astute-workinstructions/api-integration-roadmap.md`

---

**Status:** Ready for implementation tomorrow
**Estimated effort:** 1-2 days (API research may extend timeline if new integration required)
