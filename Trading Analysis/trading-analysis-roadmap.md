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
