# Trading Analysis Roadmap

Consolidated roadmap for Trading Analysis workflows.

---

## Workflows

| Workflow | Location | Status |
|----------|----------|--------|
| Vortex Matches | `Vortex Matches/` | Operational |
| Quick Quote | `Quick Quote/` | Operational |
| **Live Opportunities (RFQ → Offers)** | `Market Offer Matching for RFQs/` | Operational |
| **Proactive Opportunities (Offers → Historical)** | `Market Offer Matching for RFQs/` | Partial |
| Inventory File Cleanup | `Inventory File Cleanup/` | Operational |
| LAM Kitting Reorder | `LAM Kitting Reorder/` | Operational |
| Stock Market Analysis | — | Planned |

---

# Section A: Vortex Matches

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| A1 | Refine Opportunity Amount Calculation | **Next** | Planned |
| A2 | Filter Low % of Demand Matches | **Next** | Planned |
| A3 | MPN Variant Matching | Later | Planned |

---

## A1. Refine Opportunity Amount Calculation

**Status:** Planned | **Priority:** Next

**Problem:** Current Opp Amount = `RFQ Target × RFQ Qty`. This doesn't account for:
- Supplier quantity available (may be less than RFQ qty)
- Actual potential GP (need to factor in supplier price)

**Solution Options:**
1. `MIN(Supplier Qty, RFQ Qty) × RFQ Target` — capped by available qty
2. `MIN(Supplier Qty, RFQ Qty) × (RFQ Target - Supplier Price)` — actual GP opportunity
3. Both columns: Opp Amount (revenue) + Opp GP (margin)

**Decision:** TBD

---

## A2. Filter Low % of Demand Matches

**Status:** Planned | **Priority:** Next

**Problem:** Stock and other matches with very low % of Demand clutter the output:
- Customer needs 100,000 pcs, we have 50 pcs (0.05%)
- Not worth pursuing — creates noise

**Solution:**
- Add configurable threshold (e.g., minimum 5% of demand)
- Apply especially to Stock file where we control inventory
- Option: separate "Partial Coverage" file for matches between 5-50%

**Thresholds to Consider:**

| % of Demand | Action |
|-------------|--------|
| < 5% | Exclude (not worth the effort) |
| 5-50% | Include, flag as partial |
| > 50% | Include (meaningful coverage) |

---

## A3. MPN Variant Matching

**Status:** Planned | **Priority:** Later

**Problem:** Currently uses exact `chuboe_mpn_clean` matching. Misses:
- Packaging variants (T&R vs Tube)
- RoHS variants (G suffix)
- Same base part, different suffix

**Solution:**
- Extend matching to include packaging-safe variants (from B6 logic in sourcing-roadmap)
- Flag compliance/spec variants for review
- Add `Match Type` column to output

**Depends on:** `mpn_variants.py` module from RFQ Sourcing

---

# Section B: Stock Market Analysis

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| B1 | Warehouse Rotation Schedule | Later | Planned |
| B2 | Market Price Comparison | Later | Planned |
| B3 | Resale Price Recommendations | Later | Planned |

---

## B1. Warehouse Rotation Schedule

**Status:** Planned | **Priority:** Later

**Problem:** Need to systematically analyze inventory across warehouses to optimize resale pricing, but analyzing all warehouses at once is overwhelming.

**Solution:**
- Rotate through warehouses on a schedule (e.g., 1-2 warehouses per week)
- Prioritize high-value or slow-moving inventory
- Track last analysis date per warehouse

**Warehouses to Rotate:**
- Free Stock: W102, W104/W112, W108/W113, W109/W114
- Allocated: MAIN, W105

---

## B2. Market Price Comparison

**Status:** Planned | **Priority:** Later

**Problem:** Current inventory pricing may be stale or not competitive with market.

**Solution:**
- Pull recent VQ data for same MPNs
- Compare to market offers (from Market Offer Uploading)
- Identify parts priced above/below market
- Factor in date codes, quantity breaks

**Inputs:**
- Warehouse inventory file (from Inventory File Cleanup)
- VQ history (last 90 days)
- Market offers

---

## B3. Resale Price Recommendations

**Status:** Planned | **Priority:** Later

**Problem:** Need data-driven resale pricing rather than gut feel.

**Solution:**
- Apply Quick Quote logic (min margin, min GP, fat margin fallback)
- Factor in inventory age/date code
- Consider market pricing from B2
- Generate recommended resale prices

**Outputs:**
- Pricing recommendations CSV
- Flagged items needing price adjustments

---

# Section C: LAM Kitting Reorder

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| C1 | LAM Kitting Reorder Workflow | **Next** | Planned |

---

## C1. LAM Kitting Reorder Workflow

**Status:** Operational | **Priority:** Complete

**Problem:** LAM kitting warehouses (W111, W115) need inventory monitoring to trigger reorders, update lead times, and track historical sourcing.

**Solution:** `lam-kitting-reorder.js` — compares W111+W115 inventory to Excel thresholds, generates reorder alerts with historical sourcing data.

**Output:** `LAM_Reorder_Alerts_YYYY-MM-DD.csv` emailed to jake.harris@astutegroup.com

---

# Section D: Market Offer Matching

Two complementary workflows for matching market offers to demand:

| # | Workflow | Direction | Purpose | Status |
|---|----------|-----------|---------|--------|
| D1 | Live Opportunities | RFQ → Offers | Match new RFQs against existing offers for immediate fulfillment | Operational |
| D2 | Proactive Opportunities | Offers → Historical + Market | Match new offers against historical RFQs + market conditions for proactive outreach | Partial |

---

## D1. Live Opportunities (RFQ → Offers)

**Status:** Operational | **Trigger:** New RFQs

**Purpose:** When new RFQs arrive, identify existing market offers that can fulfill the demand.

**Data Sources:**
- **RFQs:** New RFQs from database (incremental, tracks last processed)
- **Offers:** Customer Excess offers in database (90-day lookback)

**Process:**
1. Get new RFQs since last run
2. Match against Customer Excess offers (type_id = 1000000)
3. Calculate opportunity value and coverage
4. Tier results (TIER_1/2/3)
5. Output `Excess_Match_MM-DD_RFQ_[start]-[end].csv`

**Documentation:** `Market Offer Matching for RFQs/market-offer-matching.md`

**Limitation:** Offers must be imported to database first. Does not see offers still in CSV form.

---

## D2. Proactive Opportunities (Offers → Historical + Market)

**Status:** Partial | **Trigger:** New market offers uploaded

**Purpose:** When new market offers arrive, identify historical demand signals and market conditions for proactive sales outreach.

**Data Sources:**
- **Offers:** New offers from CSV (just extracted, not yet in DB)
- **Historical RFQs:** ALL RFQ history (not time-limited) — demand signal doesn't expire
- **Market Conditions:** VQ history, pricing trends, related offers (TBD)

**Process:**
1. Extract offers from CSV (Market Offer Uploading Step 1-6)
2. Match MPNs against ALL historical RFQs
3. Pull market intelligence (VQ pricing, demand frequency, last activity)
4. Identify proactive outreach opportunities
5. Output actionable report

**Current Implementation:** `analyze-new-offers.js` — partial (180-day RFQ lookback only, no market conditions)

**Gaps to Address:**
| Gap | Description | Priority |
|-----|-------------|----------|
| D2.1 | Expand RFQ lookback to ALL TIME (or configurable 2+ years) | Next |
| D2.2 | Add market conditions: VQ pricing history for matched MPNs | Next |
| D2.3 | Add demand frequency: how often has this MPN been requested? | Next |
| D2.4 | Add recency signal: when was the last RFQ for this MPN? | Next |
| D2.5 | Add customer context: which customers have requested this? | Later |

**Output Columns (Target):**
```
offer_mpn, offer_qty, offer_price, offer_partner,
historical_rfq_count, last_rfq_date, customers_requested,
avg_vq_cost, min_vq_cost, max_vq_cost, last_vq_date,
demand_signal_strength, recommended_action
```

---

# Completed Items

## Section A: Vortex Matches
- [x] Initial implementation — match RFQs to VQs/MOs/Stock
- [x] Stock file separation (Astute inventory always shown)
- [x] Good Prices / All Prices / No Prices categorization
- [x] RFQ line deduplication (MPN + Qty + Target + CPC)
- [x] Column cleanup (removed RFQ Manufacturer, Vendor Grade)
- [x] MO Type blank for VQs (only applies to Market Offers)
- [x] % Under Target moved to column B in Good Prices
- [x] Decimal precision preserved for prices
- [x] % of Demand as actual percent format

---

# Version History

| Date | Section | Changes |
|------|---------|---------|
| 2026-03-09 | A | Vortex Matches initial setup |
| 2026-03-10 | A | Full implementation: deduplication, column cleanup, MO Type fix |
| 2026-03-17 | C | LAM Kitting Reorder: Operational |
| 2026-03-17 | D | Added Market Offer Matching section with D1 (Live) and D2 (Proactive) workflows |

---

*Last updated: 2026-03-17*
