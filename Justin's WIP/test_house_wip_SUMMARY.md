# Test House WIP Analysis - Executive Summary

**Date:** July 6, 2026
**Analysis Period:** April - June 2026 (Q2)
**Assumptions:**
- 5-day turnaround at test houses
- 50% of orders send 100% of material; 50% send 5% sample only

---

## **Bottom Line: ~$1.1 Million WIP**

Approximately **$1.1 million** in material value is at test houses on any given workday, representing **33 material orders** in steady-state processing (with varying sample sizes).

This estimate **excludes extreme outliers** (top/bottom 5%) and assumes half of orders send full material while half send only 5% samples for testing.

---

## Key Findings

### Material Flow
- **440 material orders** analyzed (excluding outliers)
- **6.67 orders sent per workday** to test houses
- **33 orders in-process** at any time (5-day float)
- **$28.1M total material value** purchased in Q2 2026
- **Effective material at test house:** ~52.5% of order value (weighted avg)
  - 50% of orders: 100% of material sent
  - 50% of orders: 5% sample sent

### Average Material Order Value (Total Purchase)
- **Mean:** $63,912 (trimmed)
- **Median:** $23,055 (typical order)
- **P25-P75 Range:** $4,980 - $93,748

### Weighted Average Material AT TEST HOUSE
- **Mean:** $33,554 (52.5% of order value)
- **Median:** $12,104 (52.5% of order value)

### WIP Estimate Scenarios

| Scenario | Calculation | WIP Value | Use Case |
|----------|-------------|-----------|----------|
| **Trimmed Average (RECOMMENDED)** | 33.4 orders × $33,554 | **$1,119,021** | Financial planning, typical operations |
| Trimmed Median | 33.4 orders × $12,104 | $403,664 | Conservative estimate |
| Full Dataset Average (100% sent) | 37.4 orders × $93,201 | $3,481,055 | If all material sent (unrealistic) |

**Recommendation:** Use **$1.1M** as baseline WIP estimate for cash flow and financial modeling.

---

## What We Measured

### ✅ CORRECT: Material Value at Test Houses
- Components/inventory physically at test houses
- Found by identifying material purchases on RFQs that also had testing service purchases
- 493 total material VQs on 179 RFQs (trimmed to 440 after removing outliers)

### ❌ WRONG (Initial Analysis): Testing Service Charges
- What test houses bill us for testing (avg $2,575)
- This is the **cost of testing**, not the **value of what's being tested**
- Material orders are 36x larger than testing fees

### Partial Sampling Model
Of the **33 orders in-process** at any given time (5-day turnaround):

| Order Type | Count | Material Sent | Avg Value at Test House | Total WIP |
|------------|-------|---------------|------------------------|-----------|
| Full material sent | ~17 orders | 100% | $63,912 | ~$1,066,000 |
| Sample only | ~17 orders | 5% | $3,196 | ~$53,000 |
| **Weighted Total** | **33.4 orders** | **52.5% avg** | **$33,554** | **~$1,119,000** |

This assumes **50% of orders send full material** while **50% send only 5% samples**.

---

## Data Quality & Methodology

### Strengths
✅ Based on 440 actual transaction records (cost × qty from system)
✅ Trimmed dataset removes extreme outliers (top/bottom 5%)
✅ Logical linkage: material + testing on same RFQ = material at test house
✅ Conservative: only includes clearly paired material/service orders

### Assumptions & Caveats
⚠️ **5-day turnaround assumed** - actual may vary by vendor/service type

⚠️ **Partial sampling assumption:**
- 50% of orders send 100% of material to test house
- 50% of orders send only 5% sample to test house
- Weighted average: 52.5% of material value at test house
- Actual split may vary by order type, vendor, or testing requirements

⚠️ **Trimmed data excludes:**
- 24 smallest orders (< $4,980)
- 25 largest orders (> $93,748)
- These outliers add $17.8M to total but are atypical

⚠️ **May not capture all material:**
- Customer consignment material (not our purchase)
- Material sent without testing service on same RFQ
- Repeat testing without new VQ generation

---

## Material Vendor Breakdown

**85% of material comes from Global Sourcing vendors:**

| Vendor Type | Orders | Total Value | Avg Order |
|-------------|--------|-------------|-----------|
| Global Sourcing | 382 | $39.0M | $102,156 |
| New/Ungraded | 13 | $2.7M | $208,900 |
| Quality | 18 | $1.1M | $59,082 |
| Other | 80 | $3.2M | varies |

**Key Insight:** This is primarily overseas component purchases requiring testing/certification before resale.

---

## Comparison of Analyses

| Analysis Version | What Was Measured | Avg at Test House | Est. WIP (5-day) | Notes |
|------------------|-------------------|-----------|----------|-------|
| **Initial (WRONG)** | Testing service charges | $2,575 | $68K | Measured testing fees, not material |
| **Corrected (All Data, 100%)** | Material value | $93,201 | $3.5M | Assumes all material sent |
| **Trimmed (100% sent)** | Material excl. outliers | $63,912 | $2.1M | Assumes all material sent |
| **Trimmed w/ Sampling (RECOMMENDED)** | Material excl. outliers (52.5% sent) | **$33,554** | **$1.1M** | Reflects partial sampling |

---

## Recommendations

### For Financial Planning
1. **Use $1.1M as WIP baseline** for cash flow modeling
2. **Actual range: $900K - $1.3M** depending on order mix and sampling rates
3. **Flag orders over $250K** for separate tracking (7% of volume, high $ impact)
4. **Sensitivity to sampling assumption:**
   - If 100% of material sent: WIP = $2.1M (91% higher)
   - If 75%/25% split (vs 50%/50%): WIP = $1.7M
   - Current estimate assumes 50/50 split

### For Operations
1. **Validate assumptions** by vendor:
   - Survey actual turnaround times (5-day assumption)
   - Track actual material sent vs sample-only orders
   - May vary by service type or vendor requirements
   - High-value orders may have different SLAs

2. **Track material separately from service charges:**
   - Service charges: ~$68K WIP (testing fees, 5-day float)
   - Material value: ~$1.1M WIP (components at test houses)
   - Total exposure: ~$1.2M

3. **Consider inventory tracking improvements:**
   - Currently inferred from RFQ pairing
   - Could track explicitly via warehouse movements or locators
   - Track full vs sample shipments to refine 50/50 assumption

---

## SQL Query Used

```sql
-- Material orders on service RFQs, excluding top/bottom 5%
WITH service_rfqs AS (
    SELECT DISTINCT chuboe_rfq_id
    FROM adempiere.chuboe_vq_line
    WHERE isactive = 'Y'
        AND ispurchased = 'Y'
        AND chuboe_vendortype_id = 1000006  -- Services
        AND created >= '2026-04-01' AND created < '2026-07-01'
        AND chuboe_rfq_id IS NOT NULL
),
material_orders AS (
    SELECT
        cost * qty as order_value,
        PERCENT_RANK() OVER (ORDER BY cost * qty) as percentile
    FROM adempiere.chuboe_vq_line
    WHERE isactive = 'Y'
        AND ispurchased = 'Y'
        AND chuboe_rfq_id IN (SELECT chuboe_rfq_id FROM service_rfqs)
        AND chuboe_vendortype_id != 1000006
        AND cost IS NOT NULL AND qty IS NOT NULL
        AND cost > 0 AND qty > 0
)
SELECT
    COUNT(*) as order_count,
    ROUND(AVG(order_value)::numeric, 2) as avg_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY order_value)::numeric, 2) as median
FROM material_orders
WHERE percentile >= 0.05 AND percentile <= 0.95;  -- Trim outliers
```

---

## Quick Reference Card

**WIP at Test Houses (5-day turnaround, 50/50 sampling):**
```
Total Orders In-Process:     33.4 orders
  ├─ Full material (50%):    ~17 orders × $63,912 = $1,066,000
  └─ Sample only (50%):      ~17 orders × $3,196  = $53,000

Total Material WIP:          $1,119,000
Testing Service WIP:         $68,000
────────────────────────────────────────────
TOTAL EXPOSURE:              ~$1,190,000
```

**Daily Flow:**
- Orders sent per day: 6.67
- Effective material rate: 52.5% of order value
- Daily WIP churn: ~$224K sent, ~$224K returned

**Sensitivity:**
- If 100% material sent: WIP = $2.1M (+91%)
- If 7-day turnaround: WIP = $1.6M (+40%)
- If median order value: WIP = $404K (-64%)

---

## Files Generated

1. `test_house_wip_SUMMARY.md` - This executive summary (RECOMMENDED)
2. `test_house_wip_FINAL.md` - Comprehensive analysis with all data
3. `test_house_wip_executive_summary_REVISED.md` - Initial corrected version
4. `service_house_vqs_3months.txt` - Service VQ counts by vendor/month

---

**Prepared by:** Analytics Team
**Contact:** For questions about methodology or to validate assumptions
