# USA Daily Brief — Sales Pulse

**Status:** ✅ Production Ready
**Created:** 2026-06-25
**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Recipient:** Jeff Wallace (USA Regional Manager)

---

## Overview

Daily snapshot for USA Regional Manager showing yesterday's sales activity for the USA team. Designed for quick review of team performance and priority items.

**Key Differences from VP Daily Brief:**
- Filtered to USA region only (except Global Strategic Accounts section)
- Section 3 shows individual sales rep performance instead of regional rollup
- Section 2 shows top 10 high-value late lines (not all)
- Removed "Top 5 Late SO Lines" subsection

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

**SQL Queries** (`queries/usa-daily-queries.sql`):
```sql
WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
)
WHERE o.created::date = (SELECT report_date FROM business_day)
```

**JavaScript Display** (`scripts/sales-pulse-usa-daily.js`):
```javascript
const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
const businessDay = new Date(today);
if (dayOfWeek === 1) {
  businessDay.setDate(businessDay.getDate() - 3); // Monday: go back to Friday
} else {
  businessDay.setDate(businessDay.getDate() - 1); // Otherwise: yesterday
}
```

---

## Features

### 1. USA Region Filter ✅
All sections filtered to USA team (ad_user_ids: 1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) except Global Strategic Accounts section.

### 2. Individual Sales Rep Breakdown ✅
Section 3 shows activity by sales rep name instead of regional rollup.

### 3. Top 10 Late Lines (No Revenue Filter) ✅
Section 2 shows top 10 late lines by revenue with no minimum revenue requirement.

### 4. Streamlined Needs Attention ✅
Removed "Top 5 Late SO Lines" subsection for cleaner focus.

---

## Report Sections

### 1. Yesterday's Top Wins (USA Only)

**Purpose:** Highlight USA team wins

**Subsections:**
- **Top 5 Orders Won** - Highest revenue orders by USA sales reps
- **New Customers Sold** - First-time customer wins by USA team
- **Global Strategic Accounts Activity** - Shows ALL regions (not filtered to USA)
- **Reactivated Customers** - USA customers returning after 6+ month gap

---

### 2. Needs Attention (USA Only)

**Three Alert Types:**

#### A. Top 10 Late SO Lines (No Revenue Filter) 🔴

**Criteria:**
- Promised ship date is 3+ days in the past (rolling 31-day window)
- Not yet shipped
- Order status: Completed or Closed
- USA region only
- Shows TOP 10 by revenue (no minimum revenue requirement)

**Fields Shown:** Customer, SO#, Line #, MPN, ISE, Region, Promise Date, Days Late, Qty Unshipped, Revenue, GP

**Why It Matters:** Late deliveries impact customer relationships and cash flow - top 10 by revenue shows highest-impact items

**Known Issue:** Some lines may show $0 GP when cost data is not available in the BI view (`bi_order_line_v.s_order_line_gp` returns NULL). This occurs when:
- Order line cost (`pricecost`) is 0 or NULL
- BI view has not been populated for that line
The report footer includes a note that this is under investigation.

#### B. Inactive ISEs (No RFQ/CQ in 3+ days) 🟡

**Criteria (USA Only):**
- No chuboe_rfq created in last 3 days AND
- No chuboe_cq_line created in last 3 days
- USA sales reps only

**Fields Shown:** ISE Name, Manager (Jeff Wallace), Region (USA), Days Inactive, Last Activity Date

**Visual:** Red badge if 7+ days, yellow badge if 3-6 days

**Why It Matters:** Sellers going dark indicates process breakdown or capacity issues

#### C. New Customers Sold (First-Time Wins) 🟢

**Criteria (USA Only):**
- Order created yesterday AND
- No prior orders from this customer in history
- USA sales reps only

**Fields Shown:** Customer Name, Revenue, Line Count, ISE

**Why It Matters:** New customer acquisition is a leading indicator of growth

---

### 3. Yesterday's Activity (USA Individual Sales Reps)

**Breakdown:** Individual USA sales reps (not rolled up by manager)

**Metrics Per Sales Rep:**
- RFQ Lines entered
- CQ Lines entered
- CQ Lines sold
- SO Lines booked
- Revenue
- GP

**Purpose:** Identify individual performance and accountability

**Change from VP Daily Brief:** Shows "Sales Rep Name" column instead of "Manager" column

---

## Data Sources

### Queries

All queries are in `/queries/usa-daily-queries.sql`

**Key Query Notes:**
- **Business Day Logic:** All queries use business_day CTE (Monday → Friday, else yesterday)
- **USA Filter:** Most queries filter by USA ad_user_ids (except Strategic Accounts)
- **Top 10 Limit:** High Value Late Lines shows top 10 instead of all

### USA Sales Rep IDs

```javascript
'USA': [1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017]
```

---

## Thresholds

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| **Late Shipment Days** | 3+ days | Beyond normal slip tolerance |
| **Late Lines Display** | Top 10 by revenue | Focus on highest impact items (no minimum revenue) |
| **Late Lines Window** | Rolling 31 days | ISEs should update promise dates; old items indicate stale data |
| **Inactive ISE Days** | 3+ days | Weekend + 1 business day (red flag) |

---

## Running the Report

### Manual Execution

**Generate Report:**
```bash
cd ~/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts
node sales-pulse-usa-daily.js
```

**Generate and Email:**
```bash
node email-usa-daily-brief.js
```

**Output Files:**
- `../output/usa-briefs/usa-daily-brief-YYYY-MM-DD.html` - Formatted email body
- `../output/usa-briefs/usa-daily-brief-YYYY-MM-DD.json` - Raw data for debugging

### Automated Delivery

**Schedule:** Mon-Fri at 6:00 AM PT via cron

**Script:** `scripts/email-usa-daily-brief.js`

**Recipients:**
- Jeff Wallace (jeff.wallace@astutegroup.com)
- Melissa Bojar (melissa.bojar@astutegroup.com)

**Email Sender:** salesanalytics@orangetsunami.com

**Cron Entry:** *(To be configured in analytics_user crontab)*

```bash
0 6 * * 1-5 cd /home/melissa.bojar/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts && node email-usa-daily-brief.js
```

---

## Design Philosophy

### Regional Focus

**USA Team Accountability**
- Individual sales rep breakdown for clear performance visibility
- Manager (Jeff Wallace) can see each rep's activity
- Highlights team wins and needs attention items

### Streamlined Alerts

**Focus on Impact**
- Top 10 high-value late lines (not exhaustive list)
- Removed redundant "Top 5 Late SO Lines" section
- Clear priority for action items

---

## Maintenance

### When Sellers Join/Leave USA Team

Update the USA seller list in `usa-daily-queries.sql`:

```sql
WHEN ad_user_id IN (1039413, 1047077, 1000011, 1042807, 1005243, 1025669, 1047795, 1000017) THEN 'USA'
```

### When Thresholds Change

**High Value Late Lines Limit:** Edit line in `usa-daily-queries.sql`
```sql
ORDER BY ol.linenetamt DESC
LIMIT 10  -- Change top 10 threshold
```

**Inactive ISE Days:** Same as VP Daily Brief (edit in `usa-daily-queries.sql`)

---

## Comparison: USA Daily Brief vs VP Daily Brief

| Feature | USA Daily Brief | VP Daily Brief |
|---------|----------------|----------------|
| **Recipient** | Jeff Wallace (USA Manager) | Josh Pucci (VP Sales) |
| **Focus** | USA team performance | Global strategic actions |
| **Region Filter** | USA only (except Strategic Accounts) | All regions |
| **Section 3** | Individual sales reps | Regional rollup by manager |
| **Late Lines Section** | Top 10 by revenue (no minimum) | All lines $200K+ |
| **Top 5 Late Lines Section** | Removed | Included |

---

## Related Reports

- **VP Daily Brief** (`vp-daily-brief-workflow.md`) - Strategic VP-level daily snapshot
- **Sales Pulse Comprehensive** (`sales-pulse-comprehensive.js`) - Detailed operational report
- **Sales Pulse Weekly** (`sales-pulse-weekly.js`) - Weekly strategic review

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholder:** Jeff Wallace (USA Regional Manager)

---

## Changelog

**2026-06-25** - Initial release based on VP Daily Brief V2
- Filtered to USA region (except Strategic Accounts section)
- Section 3 shows individual sales reps instead of regional rollup
- High Value Late Lines limited to top 10
- Removed "Top 5 Late SO Lines" section

---

*Last Updated: 2026-06-25*
