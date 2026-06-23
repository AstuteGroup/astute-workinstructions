# VP Daily Brief — Sales Pulse

**Status:** ✅ Production Ready
**Created:** 2026-06-18 (based on June 4, 2026 feedback from Josh Pucci)
**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Recipient:** Josh Pucci (VP Sales)

---

## Overview

Strategic 1-page daily snapshot for VP Sales showing yesterday's sales activity with a focus on what matters most. Designed to be scanned in 60 seconds with priority-driven layout.

**Key Differences from Comprehensive Version:**
- Strategic actions vs operational metrics
- Higher thresholds ($250K for late shipments vs $10K)
- Priority-first layout (what matters most at the top)
- Cleaner, more scannable format for executive review
- Monday-only week summary (full report not cluttered daily)

**Delivery:** Mon-Fri at 6:00 AM PT via email

---

## Business Day Logic

**Purpose:** Ensure Monday reports show Friday's data instead of Sunday's (no business activity on weekends).

### Date Calculation

The report uses **previous business day** logic instead of literal "yesterday":

| Day of Week | Report Date Shown | Days Back | Example |
|-------------|-------------------|-----------|---------|
| **Monday** | Friday | 3 days | Monday June 22 → shows Friday June 19 |
| **Tuesday-Friday** | Previous day | 1 day | Thursday June 19 → shows Wednesday June 18 |

### Implementation

**SQL Queries** (`queries/vp-daily-queries-v2.sql`):
```sql
WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
)
WHERE o.created::date = (SELECT report_date FROM business_day)
```

**JavaScript Display** (`scripts/sales-pulse-vp-daily-v2.js`):
```javascript
const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
const businessDay = new Date(today);
if (dayOfWeek === 1) {
  businessDay.setDate(businessDay.getDate() - 3); // Monday: go back to Friday
} else {
  businessDay.setDate(businessDay.getDate() - 1); // Otherwise: yesterday
}
```

**Email Subject** (`scripts/email-vp-daily-brief.js`):
Uses the same business day calculation to ensure the subject line matches the report content.

**Why This Matters:**
- Prevents confusing "no activity" reports on Mondays (Sunday had no sales)
- Ensures consistent business day reporting across all Sales Pulse reports
- Aligns with how the business operates (Mon-Fri activity cycle)

**Last Updated:** 2026-06-19 (business day logic implemented)

---

## Features (Per June 4, 2026 Feedback)

### 1. Blended VP Daily Brief + Action-First Layout ✅
Combines the clean VP Daily Brief structure with priority-driven content from the Action-First mockup.

### 2. New Customers Sold ✅
First-time customer wins - companies that placed their first order yesterday.

### 3. Late Shipments (Needs Attention) ✅
High-value orders ($250K+) that are 3+ days past promised ship date and not yet shipped.

### 4. Inactive ISEs (Needs Attention) ✅
Sellers who haven't loaded RFQs or CQs in 3+ days, grouped by region.

### 5. Week-to-Date Section (Monday Only) ✅
Full prior week summary (Mon-Fri) shown only on Monday morning reports.

### 6. Market Pulse Removed ✅
Market Pulse is now a separate weekly report (see `market-pulse-weekly.md`).

---

## Report Sections

### 1. What Matters Today (Priority Actions)

**Purpose:** Highlight the top 3-5 strategic items requiring VP attention

**Priority Levels:**
- 🔴 **Red (Critical)** - Late shipments, critical metrics below threshold
- 🟡 **Yellow (Warning)** - Inactive sellers, metrics trending downward
- 🟢 **Green (Positive)** - New customer wins, strong performance

**Auto-Generated Based On:**
- Late Shipments count and total value
- Inactive ISEs by region
- New Customer wins count and revenue
- CQ Close Rate vs 30% target (Red <20%, Yellow <30%, Green >40%)

---

### 2. Yesterday's Activity (Global Snapshot)

**Metrics Shown:**
- **RFQ Lines** - Lines entered + customer count
- **CQ Lines** - Lines entered + sold count + close rate %
- **Orders Booked** - Lines booked + total revenue

**Purpose:** Quick health check on daily pipeline flow

---

### 3. By Region (Yesterday)

**Breakdown:** USA, MEX, Laurel (Singapore), Kris (Philippines/China), Lavanya (India)

**Metrics Per Region:**
- RFQ Lines entered
- CQ Lines entered
- CQ Lines sold
- SO Lines booked

**Purpose:** Identify regional performance imbalances

---

### 4. Yesterday's Wins

**Shows:** Top 5 orders booked yesterday by revenue

**Fields:** Customer, Revenue, Line Count, ISE Name

**Visual:** 🥇🥈🥉 medals for top 3

**Purpose:** Celebrate wins and recognize top performers

---

### 5. Needs Attention

**Three Alert Types:**

#### A. Late Shipments (3+ days, $250K+) 🔴

**Criteria:**
- Promised ship date is 3+ days in the past
- Order revenue >= $250,000
- Not yet shipped (no m_inout record with docstatus CO/CL)
- Order status: Completed or Closed

**Fields Shown:** Customer, Days Late, Revenue, ISE, Order #

**Why It Matters:** High-value delivery risk - impacts customer relationships and cash flow

#### B. Inactive ISEs (No RFQ/CQ in 3+ days) 🟡

**Criteria:**
- No chuboe_rfq created in last 3 days AND
- No chuboe_cq_line created in last 3 days

**Fields Shown:** ISE Name, Region, Days Inactive, Last Activity Date

**Visual:** Red badge if 7+ days, yellow badge if 3-6 days

**Why It Matters:** Sellers going dark indicates process breakdown or capacity issues

#### C. New Customers Sold (First-Time Wins) 🟢

**Criteria:**
- Order created yesterday AND
- No prior orders from this customer in history

**Fields Shown:** Customer Name, Revenue, Line Count, ISE

**Why It Matters:** New customer acquisition is a leading indicator of growth

**If No Items:** Shows "No items need attention"

---

### 6. Prior Week Summary (Monday Only)

**Shows When:** Monday morning reports only (isMonday = true)

**Time Window:** Full prior week (Mon-Fri, last 7 days)

**Metrics:**
- RFQ Lines (total)
- CQ Lines (total + sold + close rate %)
- Orders Booked (lines + revenue)

**Purpose:** Weekly performance review without cluttering daily reports

---

## Data Sources

### Queries

All queries are in `/queries/vp-daily-queries-v2.sql`

**Key Query Notes:**
- **Business Day Logic:** All queries use business_day CTE (Monday → Friday, else yesterday)
- **New Customers:** NOT EXISTS subquery to ensure truly first-time
- **Late Shipments:** LEFT JOIN on m_inout to find unshipped orders
- **Inactive ISEs:** Recent activity check within last 30 days, filtered by 3+ day gap

### Seller Region Mapping

```javascript
'USA': [1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017]
'MEX': [1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224]
'APAC-Laurel': [1041139, 1023803, 1016958]
'APAC-Kris': [1039414, 1009866, 1013042, 1009528, 1009478, 1009210]
'APAC-Lavanya': [1024444, 1023478, 1017011]
```

*29 active sellers total*

---

## Thresholds

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| **Late Shipment Days** | 3+ days | Beyond normal slip tolerance |
| **Late Shipment Revenue** | $250K+ | VP-level materiality (vs $10K for managers) |
| **Inactive ISE Days** | 3+ days | Weekend + 1 business day (red flag) |
| **CQ Close Rate Target** | 30% | Company baseline |
| **CQ Close Rate Warning** | <30% | Below target |
| **CQ Close Rate Critical** | <20% | Half of target |
| **CQ Close Rate Excellent** | >40% | Well above target |

---

## Running the Report

### Manual Execution

**Generate Report:**
```bash
cd ~/workspace/Sales\ Pulse\ Daily/scripts
node sales-pulse-vp-daily-v2.js
```

**Generate and Email:**
```bash
node email-vp-daily-brief.js
```

**Output Files:**
- `../output/vp-daily-brief-v2-YYYY-MM-DD.html` - Formatted email body
- `../output/vp-daily-brief-v2-YYYY-MM-DD.json` - Raw data for debugging

### Automated Delivery

**Schedule:** Mon-Fri at 8:00 AM via cron

**Script:** `scripts/email-vp-daily-brief.js`

**Recipients:**
- Josh Pucci (josh.pucci@astutegroup.com)
- Melissa Bojar (melissa.bojar@astutegroup.com)

**Email Sender:** salesanalytics@orangetsunami.com

**Cron Entry:** *(Configured in analytics_user crontab)*

```bash
0 8 * * 1-5 cd /home/melissa.bojar/workspace/Sales\ Pulse\ Daily/scripts && node email-vp-daily-brief.js
```

---

## Design Philosophy

### Priority-Driven Layout

**What Matters Most → First**

1. **Priority Actions** - Strategic alerts (red/yellow/green)
2. **Global Snapshot** - Health check metrics
3. **Regional Performance** - Identify imbalances
4. **Wins** - Celebrate success
5. **Needs Attention** - Actionable items
6. **Week Summary** - Context (Monday only)

### 60-Second Scan Rule

- **Title + Date** = 3 seconds
- **Priority Actions** = 15 seconds (3-5 bullet points max)
- **Metrics** = 10 seconds (3 cards, visual hierarchy)
- **Regional Table** = 10 seconds (5 rows)
- **Wins** = 10 seconds (top 5)
- **Needs Attention** = 12 seconds (3 alert types, collapsible)

**Total:** ~60 seconds for full scan, 2-3 minutes for deep read

### Visual Hierarchy

**Color Coding:**
- Red = Critical (requires action today)
- Yellow = Warning (monitor closely)
- Green = Positive (celebrate/maintain)
- Gray = Neutral (informational)

**Typography:**
- Section titles: 13px bold
- Metrics: 20px bold values, 10px labels
- Tables: 12px body, 10px headers
- Footer: 10px

---

## Maintenance

### When Sellers Join/Leave

Seller regions are defined inline in SQL queries in `vp-daily-queries-v2.sql`. Update the CASE statements in each regional query:

```sql
CASE
  WHEN u.ad_user_id IN (1039413, 1047077, ...) THEN 'USA'
  WHEN u.ad_user_id IN (1047106, 1026393, ...) THEN 'MEX'
  -- etc.
END as region
```

### When Thresholds Change

**Late Shipments:** Edit line ~382 in `vp-daily-queries-v2.sql`
```sql
o.grandtotal >= 250000  -- Change $250K threshold
```

**Inactive ISE Days:** Edit line ~474 in `vp-daily-queries-v2.sql`
```sql
WHERE COALESCE(CURRENT_DATE - ra.last_rfq_date::date, 30) >= 3  -- Change 3-day threshold
```

### When Adding New Alert Types

1. Add SQL query to `queries/vp-daily-queries.sql`
2. Add data collection function in script (`async function getNewAlert()`)
3. Call in `collectData()` and add to `data.needsAttention`
4. Add HTML generation in `generateNeedsAttention()`
5. Add priority action logic in `generatePriorityActions()`

---

## Comparison: VP Daily Brief vs Comprehensive

| Feature | VP Daily Brief | Comprehensive (Managers) |
|---------|---------------|-------------------------|
| **Recipient** | Josh Pucci (VP Sales) | Regional Managers (Jeff/Joel/Laurel/Kris/Lavanya) |
| **Focus** | Strategic actions | Operational metrics |
| **Late Shipments** | $250K+ | $10K+ |
| **Layout** | Priority-first, 1-page | Section-by-section, comprehensive |
| **Week-to-Date** | Monday only | Daily progress bars |
| **Market Pulse** | Separate weekly report | Included inline |
| **Needs Attention** | 3 types (Late/Inactive/New) | 5 types (High-Value Quotes, High-Probability, etc.) |
| **Read Time** | 60 seconds | 3-5 minutes |

**Both reports use the same underlying data sources** - only presentation and thresholds differ.

---

## Feedback History

### June 4, 2026 - Josh Pucci Initial Feedback

**Approved Concept:** VP Daily Brief (1-page format)

**Requested Changes:**
1. ✅ Blend VP Daily Brief + Action-First sections
2. ✅ Add New Customers Sold
3. ✅ Add Late Shipments (3+ days, $250K+)
4. ✅ Add Inactive ISEs (3+ days)
5. ✅ Week-to-Date Monday only
6. ✅ Remove Market Pulse (separate weekly)

**Status:** All changes implemented June 18, 2026

---

## Related Reports

- **Sales Pulse Comprehensive** (`sales-pulse-comprehensive.js`) - Daily operational report for regional managers
- **Sales Pulse Weekly** (`sales-pulse-weekly.js`) - Weekly strategic review (all stakeholders)
- **Market Pulse Weekly** (`market-pulse-weekly.js`) - Market intelligence and supply chain visibility

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholder:** Josh Pucci (VP Sales)

---

## Changelog

**2026-06-19** - Business day logic implemented (Monday shows Friday, not Sunday)
- Updated `sales-pulse-vp-daily-v2.js` with business day calculation
- Updated `email-vp-daily-brief.js` with matching logic for subject line
- SQL queries already had business day logic via CTEs

**2026-06-18** - Initial production release (V2 restructured per Josh feedback)

---

*Last Updated: 2026-06-19*
