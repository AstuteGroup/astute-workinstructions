# Trading Analysis Roadmap

Consolidated roadmap for Trading Analysis workflows.

---

## Workflows

| Workflow | Location | Status |
|----------|----------|--------|
| Vortex Matches | `Vortex Matches/` | Operational |
| Quick Quote | `Quick Quote/` | Operational |
| Market Offer Matching | `Market Offer Matching for RFQs/` | Operational |
| Inventory File Cleanup | `Inventory File Cleanup/` | Operational |
| LAM Kitting Reorder | `LAM Kitting Reorder/` | Planned |
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

**Status:** Planned | **Priority:** Next

**Problem:** LAM kitting warehouses (W111, W115) need inventory monitoring to trigger reorders, update lead times, and track historical sourcing.

**Solution:** Dedicated workflow — see `LAM Kitting Reorder/lam-kitting-reorder.md`

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

---

*Last updated: 2026-03-10*
