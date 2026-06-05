# MI KPI Methodology Comparison - May 2026

## Summary

| Method | Count Methodology | Weight Methodology | Total "OTINs" | Unique OTINs | Total KPI |
|--------|-------------------|-------------------|---------------|--------------|-----------|
| **Manual (Current)** | Line-by-line | Base tiers only (1-4) | 190 | 174 | 590.00 |
| **Automated v6** | Unique OTIN | Base + Additional Inspections | 176 | 176 | 535.15 |

---

## Current Manual Method

**Counting Approach:** Each line item in the tracker counts as one "OTIN"
- If OTIN 1712812 appears on 2 separate lines, it counts as 2 "OTINs"
- Total line items: 190
- Unique OTINs: 174 (16 OTINs appear multiple times)

**Weight Calculation:** Base tier weights only
- T1 = 1.0, T2 = 2.0, T3 = 3.0, T4 = 4.0
- T1-Passive = 0.75, T1-Master = 0.5
- No Additional Inspection weights (Decap, Solder, SEM, etc.)

**Formula per line:** `KPI = DC/LC Count × Base Tier Weight`

**Example:**
```
Line 1: OTIN 1712812, DC/LC: 3, Tier: 2 → KPI = 3 × 2.0 = 6.0
Line 2: OTIN 1712812, DC/LC: 3, Tier: 2 → KPI = 3 × 2.0 = 6.0 (if appears twice)
```

**Tier Breakdown:**
- T1: 101 lines
- T2: 48 lines
- T3: 28 lines
- T4: 13 lines
- **Total: 190 lines → 590.00 KPI**

---

## New Automated Method (v6)

**Counting Approach:** Each unique OTIN counted once
- If OTIN 1712812 has multiple inspection types, they're aggregated into one line
- Total unique OTINs: 176

**Weight Calculation:** Base tier + Additional Inspections
- Base tier weights: T1-P=0.75, T1-A/T1=1.0, T1-M=0.5, T2=2.0, T3=3.0, T4=4.0
- Additional Inspection weights: +0.2 each (Decapsulation, Solderability, SEM, Scrape, Destructive Sampling, Non-conforming)
- Multiple add-ons stack: Decap + Solder = +0.4

**Formula per OTIN:** `KPI = DC/LC Count × (Base Weight + Sum of Additional Inspection Weights)`

**Example:**
```
OTIN 1712812 has: Tier 2 + Decapsulation + Solderability
  Base weight: 2.0
  Add-ons: 0.2 + 0.2 = 0.4
  Total weight: 2.4
  DC/LC: 3
  KPI = 3 × 2.4 = 7.2
```

**Additional Inspections:**
- 17 OTINs have Additional Inspections
- KPI contribution from add-ons only: 43.40
- Base KPI (without add-ons): 491.75

**Total: 176 unique OTINs → 535.15 KPI**

---

## Gap Analysis

### Why is automated lower? (590.00 vs 535.15 = 54.85 gap)

**1. Missing OTINs (7 OTINs, 61.75 KPI loss)**
- These OTINs are in manual but not automated
- Primarily April 30 picks that fall outside May date range
- Examples: OTIN 1706039 (17 DC/LC, T2, 34 KPI)

**2. Extra OTINs (9 OTINs, 23.60 KPI gain)**
- These OTINs are in automated but not manual
- Later May picks that may not have been finalized in manual tracker

**3. Line Item Duplication**
- Manual has 190 lines but only 174 unique OTINs
- 16 "duplicate" OTINs contribute extra KPI in manual
- Automated counts each OTIN once (no duplication)

**4. DC/LC Count Differences**
- 27 common OTINs have different DC/LC counts
- Net impact: ~48 KPI difference

### Adjusted Comparison

If we adjust for missing OTINs:
- Automated v6: 535.15 + 61.75 (missing) = **596.90 KPI**
- Manual: **590.00 KPI**
- **Automated would EXCEED manual by 6.90 KPI**

This makes sense because:
- Additional Inspection weights add to base tier weights
- Manual uses base only, automated uses base + add-ons
- With all OTINs included, automated should be higher

---

## Recommendations

### Option 1: Keep Unique OTIN Methodology (Recommended)
**Pros:**
- Cleaner, no duplicate counting
- Properly captures Additional Inspection weights
- Each OTIN counted exactly once
- More accurate representation of work complexity

**Cons:**
- Different counting method than current manual (190 vs 176)
- Requires explaining the methodology change

**Action:** Present as "176 unique OTINs, 535.15 KPI" and explain this is more accurate than line-item counting

### Option 2: Match Manual's Line-by-Line Approach
**Pros:**
- Direct comparison to current manual (apples-to-apples)
- Easier transition for MI team

**Cons:**
- Would need to split each OTIN's inspections into separate rows
- More complex to implement
- Doesn't eliminate need for unique OTIN perspective

**Action:** Create a "line-item view" that breaks out each inspection type as a separate row

### Option 3: Provide Both Views
**Pros:**
- Best of both worlds
- Line-item view for comparison to manual
- Unique OTIN view for accurate analysis

**Cons:**
- More complex reporting
- Potential confusion about which number to use

**Action:** Include both a "Line Item Log" (matches manual) and "Unique OTIN Summary" (recommended)

---

## Next Steps

1. **Immediate:** Decide which methodology to use for official reporting
2. **Short-term:** Address missing OTINs (April 30 picks) - should they be included?
3. **Long-term:** Transition to unique OTIN methodology and phase out manual tracking
