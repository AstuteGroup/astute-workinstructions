# Sales Funnel Report by Customer

**Status:** In Progress
**Last Updated:** 2026-05-19
**Next Step:** Revise account status thresholds

---

## Overview

A comprehensive sales funnel report showing customer engagement metrics for OEM/EMS customers (excluding brokers). Tracks the customer journey from activities → RFQs → CQs → CQ Sold.

## Output Files

- **SQL Query:** `~/workspace/sales_funnel_report_v2.sql`
- **CSV Output:** `~/workspace/sales_funnel_results.csv` (4,886 rows)

---

## Report Columns

| Column | Description |
|--------|-------------|
| customer_name | Business partner name |
| region | USA, MEX, APAC, OTHER (derived from country) |
| inside_seller | ISE Steward from BP Location |
| outside_seller | FSE Steward or header salesrep_id |
| assignment_status | Assigned / Unassigned |
| account_status | Neglect, Underperformance, Low ROI, Growing, Defend, Active, Dormant |
| ytd_activities | 2026 YTD activity count (via contact→customer link) |
| rfq_count_ytd | Total RFQs in 2026 |
| rfq_shortage/stock/ppv/eol/other | RFQ breakdown by type |
| cq_count_ytd | Total CQs created in 2026 |
| cq_sold_ytd | CQs marked as sold in 2026 |
| cq_sold_value_ytd | $ value of sold CQs in 2026 |
| cq_sold_2025 / cq_sold_value_2025 | 2025 sold metrics |
| cq_sold_lifetime / cq_sold_value_lifetime | All-time sold metrics |
| cq_win_rate_pct | CQ sold / CQ count × 100 |
| revenue_per_activity | CQ sold value / activity count |

---

## Current Account Status Thresholds (NEED REVISION)

```sql
CASE
  WHEN assignment_status = 'Unassigned' THEN 'Unassigned'
  -- Neglect: Assigned but no YTD activities despite having prior business
  WHEN ytd_activities = 0 AND cq_sold_value_2025 > 10000 THEN 'Neglect'
  -- Low ROI: High activity but very low/no CQ sold (spinning wheels)
  WHEN ytd_activities > 50 AND cq_sold_value_ytd < 10000 AND cq_count_ytd > 10 THEN 'Low ROI'
  -- Growing: YTD sold value > 2025 prorated OR significant new business
  WHEN cq_sold_value_ytd > (cq_sold_value_2025 * 0.5) AND cq_sold_value_ytd > 50000 THEN 'Growing'
  -- Defend Mode: Maintaining similar levels
  WHEN cq_sold_value_ytd > 10000 AND cq_sold_value_ytd BETWEEN cq_sold_value_2025 * 0.3 AND cq_sold_value_2025 * 0.7 THEN 'Defend'
  -- Underperformance: High potential but low recent engagement
  WHEN cq_sold_value_lifetime > 500000 AND ytd_activities < 20 AND cq_sold_value_ytd < 50000 THEN 'Underperformance'
  -- Active: Has some activity and CQs
  WHEN ytd_activities > 0 OR cq_count_ytd > 0 THEN 'Active'
  -- Dormant: No recent activity
  ELSE 'Dormant'
END
```

### Questions for Threshold Revision

1. **Neglect threshold:** Currently `cq_sold_value_2025 > $10K` with zero 2026 activities. Should this be higher? Consider tiering by account size?

2. **Underperformance threshold:** Currently `lifetime > $500K` with `<20 activities` and `<$50K YTD sold`. Is $500K the right lifetime cutoff for "high potential"?

3. **Growing vs Defend:** Currently using 50% and 30-70% of 2025 prorated. Should we adjust these percentages? Account for seasonality?

4. **Low ROI:** Currently `>50 activities` with `<$10K sold`. Is 50 activities the right threshold? Should we factor in RFQ count?

5. **Time normalization:** We're ~5 months into 2026 (≈42% of year). Should thresholds be prorated for YTD comparisons?

6. **New accounts:** How should we handle accounts with no 2025 history but active in 2026?

---

## Data Model Notes

### Key Joins Discovered

| Data | Table Path |
|------|------------|
| Customer | `c_bpartner` (iscustomer = 'Y', exclude broker in description) |
| Region | `c_bpartner` → `c_bpartner_location` → `c_location` → `c_country` |
| Inside Seller | `c_bpartner_location.chuboe_ise_steward_id` → `ad_user` |
| Outside Seller | `c_bpartner_location.chuboe_fse_steward_id` OR `c_bpartner.salesrep_id` → `ad_user` |
| Activities | `c_contactactivity` → `ad_user.c_bpartner_id` (activities link to contacts, not directly to BP) |
| RFQs | `chuboe_rfq.c_bpartner_id` |
| CQs | `chuboe_cq_line.c_bpartner_id` |

### Region Mapping

```sql
CASE
  WHEN countrycode IN ('US', 'CA') THEN 'USA'
  WHEN countrycode = 'MX' THEN 'MEX'
  WHEN countrycode IN ('CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN', 'AU', 'NZ') THEN 'APAC'
  ELSE 'OTHER'
END
```

### Broker Exclusion

Customers are filtered out if `LOWER(description) LIKE '%broker%'`. This removes ~324 customers.

---

## Current Results Summary (2026-05-19)

### Account Status Distribution

| Status | Customers | YTD Sold | Lifetime Sold |
|--------|-----------|----------|---------------|
| Growing | 34 | $94.3M | $221.7M |
| Neglect | 112 | $13.5M | $114.5M |
| Active | 409 | $3.1M | $109.7M |
| Underperformance | 21 | $38K | $98.4M |
| Dormant | 4,171 | $0 | $16.2M |
| Defend | 9 | $2.1M | $14.0M |
| Unassigned | 128 | $472K | $5.1M |
| Low ROI | 2 | $8K | $1.1M |

### Key Insight

**Neglect + Underperformance = $212.8M lifetime value** in accounts that aren't getting adequate seller attention.

### Notable Accounts Flagged

- **Neglect:** Applied Materials, Flock Safety, Arrow Global, Marvell (high 2025 sales, zero 2026 activities)
- **Underperformance:** General Motors ($71M lifetime), National Instruments ($9M lifetime)

---

## Future Enhancements (After Threshold Revision)

1. Add trend analysis (6-month rolling comparison)
2. Excel output with formatting and pivot-ready tabs
3. Filter to specific regions or sellers
4. Add "days since last activity" metric
5. Win rate trend over time
6. Seller performance rollup view
