# Mexico Daily Brief — Sales Pulse

**Status:** ✅ Production Ready
**Created:** 2026-07-01
**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Recipient:** Joel Marquez (Mexico Regional Manager)

---

## Overview

Daily snapshot for Mexico Regional Manager showing yesterday's sales activity for the Mexico team. Designed for quick review of team performance and priority items.

**Key Differences from VP Daily Brief:**
- Filtered to Mexico region only (except Global Strategic Accounts section)
- Section 3 shows individual sales rep performance instead of regional rollup
- Section 1.1 shows top 15 orders (same as VP) with collapsible section
- Section 1.4 uses location-level reactivation tracking (same as VP)
- Section 2.2A shows top 10 late lines (Mexico-specific, VP uses $250K threshold)
- Section 2.2B shows top 5 scheduled to ship this month (Mexico-specific, VP shows top 15)

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

**SQL Queries** (`queries/mexico-daily-queries.sql`):
```sql
WITH business_day AS (
  SELECT CASE
    WHEN EXTRACT(DOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
    ELSE CURRENT_DATE - INTERVAL '1 day'
  END as report_date
)
WHERE o.created::date = (SELECT report_date FROM business_day)
```

**JavaScript Display** (`scripts/sales-pulse-mexico-daily.js`):
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

### 1. Mexico Region Filter ✅
All sections filtered to Mexico team (ad_user_ids: 1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) except Global Strategic Accounts section.

### 2. Individual Sales Rep Breakdown ✅
Section 3 shows activity by sales rep name instead of regional rollup.

### 3. Top 15 Orders with Collapsible Section ✅
Section 1.1 shows top 15 orders (5 visible with medals, next 10 in collapsible section).

### 4. Location-Level Reactivation Tracking ✅
Section 1.4 uses Ship-To City tracking with significance scoring to identify meaningful customer reactivations (30+ day minimum gap).

### 5. Backlog View: Scheduled to Ship This Month ✅
Section 2.2B shows top 5 unshipped lines by GP with promise date in current month, color-coded by urgency.

### 6. Top 10 Late Lines (No Revenue Filter) ✅
Section 2.2A shows top 10 late lines by revenue with no minimum revenue requirement.

---

## Report Sections

### 1. Yesterday's Top Wins (Mexico Only)

**Purpose:** Highlight Mexico team wins

**Subsections:**
- **Top 15 Orders Won** - Highest revenue orders by Mexico sales reps (5 visible + 10 collapsible)
- **New Customers Sold** - First-time customer wins by Mexico team
- **Global Strategic Accounts Activity** - Shows ALL regions (not filtered to Mexico)
- **Reactivated Customers** - Mexico customers returning after 30+ day gap (location-level tracking with significance scoring)

---

### 2. Needs Attention (Mexico Only)

**Four Alert Types:**

#### A. Top 10 Late SO Lines (No Revenue Filter) 🔴

**Criteria:**
- Promised ship date is 3+ days in the past (rolling 31-day window)
- Not yet shipped
- Order status: Completed or Closed
- Mexico region only
- Shows TOP 10 by revenue (no minimum revenue requirement)

**Fields Shown:** Customer, SO#, Line #, MPN, ISE, Region, Promise Date, Days Late, Qty Unshipped, Revenue, GP

**Why It Matters:** Late deliveries impact customer relationships and cash flow - top 10 by revenue shows highest-impact items

**Known Issue:** Some lines may show $0 GP when cost data is not available in the BI view (`bi_order_line_v.s_order_line_gp` returns NULL). This occurs when:
- Order line cost (`pricecost`) is 0 or NULL
- BI view has not been populated for that line
The report footer includes a note that this is under investigation.

#### B. Top 5 Scheduled to Ship This Month (by GP) 🟢🟡🔴

**Criteria:**
- Unshipped lines with promise date in current month
- Mexico region only
- Sorted by GP (not revenue)
- No revenue threshold filter
- Shows TOP 5 only

**Fields Shown:** Customer, SO#, Line #, MPN, ISE, Region, Promise Date, Days +/- from Promise, Qty Unshipped, Revenue, GP

**Color Coding:**
- 🔴 Red: Past due (promise date before today)
- 🟡 Yellow: Due this week (0-7 days)
- 🟢 Green: Future (8+ days)

**Why It Matters:** Backlog view showing what needs to ship by end of month to meet sales goals

#### C. Inactive ISEs (No RFQ/CQ in 3+ days) 🟡

**Criteria (Mexico Only):**
- No chuboe_rfq created in last 3 days AND
- No chuboe_cq_line created in last 3 days
- Mexico sales reps only

**Fields Shown:** ISE Name, Manager (Joel Marquez), Region (MEX), Days Inactive, Last Activity Date

**Visual:** Red badge if 7+ days, yellow badge if 3-6 days

**Why It Matters:** Sellers going dark indicates process breakdown or capacity issues

#### D. New Customers Sold (First-Time Wins) 🟢

**Criteria (Mexico Only):**
- Order created yesterday AND
- No prior orders from this customer in history
- Mexico sales reps only

**Fields Shown:** Customer Name, Revenue, Line Count, ISE

**Why It Matters:** New customer acquisition is a leading indicator of growth

---

### 3. Yesterday's Activity (Mexico Individual Sales Reps)

**Breakdown:** Individual Mexico sales reps (not rolled up by manager)

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

All queries are in `/queries/mexico-daily-queries.sql`

**Key Query Notes:**
- **Business Day Logic:** All queries use business_day CTE (Monday → Friday, else yesterday)
- **Mexico Filter:** Most queries filter by Mexico ad_user_ids (except Strategic Accounts)
- **Top 10 Limit:** High Value Late Lines shows top 10 instead of all

### Mexico Sales Rep IDs

```javascript
'MEX': [1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224]
```

**Mexico Team Members:**
- Alejandro Padilla (1047106)
- Alex Partida (1026393)
- Alfredo Martinez (1042653)
- Carlos Moreno (1038225)
- Carolina Hinestroza (1026394)
- Joel Flores (1010361)
- Ricardo Morales (1012788)
- Salvador Horner (1038224)

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
node sales-pulse-mexico-daily.js
```

**Generate and Email:**
```bash
node email-mexico-daily-brief.js
```

**Output Files:**
- `../output/mexico-briefs/mexico-daily-brief-YYYY-MM-DD.html` - Formatted email body
- `../output/mexico-briefs/mexico-daily-brief-YYYY-MM-DD.json` - Raw data for debugging

### Automated Delivery

**Schedule:** Mon-Fri at 6:00 AM PT via cron

**Script:** `scripts/email-mexico-daily-brief.js`

**Recipients:**
- Joel Marquez (joel.marquez@astutegroup.com)
- Melissa Bojar (melissa.bojar@astutegroup.com)

**Email Sender:** salesanalytics@orangetsunami.com

**Cron Entry:** *(To be configured in analytics_user crontab)*

```bash
0 6 * * 1-5 cd /home/melissa.bojar/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts && node email-mexico-daily-brief.js
```

---

## Design Philosophy

### Regional Focus

**Mexico Team Accountability**
- Individual sales rep breakdown for clear performance visibility
- Manager (Joel Marquez) can see each rep's activity
- Highlights team wins and needs attention items

### Streamlined Alerts

**Focus on Impact**
- Top 10 high-value late lines (not exhaustive list)
- Removed redundant "Top 5 Late SO Lines" section
- Clear priority for action items

---

## Maintenance

### When Sellers Join/Leave Mexico Team

Update the Mexico seller list in `mexico-daily-queries.sql`:

```sql
WHEN ad_user_id IN (1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224) THEN 'MEX'
```

### When Thresholds Change

**High Value Late Lines Limit:** Edit line in `mexico-daily-queries.sql`
```sql
ORDER BY ol.linenetamt DESC
LIMIT 10  -- Change top 10 threshold
```

**Inactive ISE Days:** Same as VP Daily Brief (edit in `mexico-daily-queries.sql`)

---

## Comparison: Mexico Daily Brief vs VP Daily Brief

| Feature | Mexico Daily Brief | VP Daily Brief |
|---------|----------------|----------------|
| **Recipient** | Joel Marquez (Mexico Manager) | Josh Pucci (VP Sales) |
| **Focus** | Mexico team performance | Global strategic actions |
| **Region Filter** | Mexico only (except Strategic Accounts) | All regions |
| **Section 1.1 Orders** | Top 15 (5 visible + 10 collapsible) | Top 15 (5 visible + 10 collapsible) |
| **Section 1.4 Reactivations** | Location-level, 30+ day gap, Mexico only | Location-level, 30+ day gap, all regions |
| **Section 2.2A Late Lines** | Top 10 by revenue (no minimum) | High Value $250K+ |
| **Section 2.2B Scheduled to Ship** | Top 5 by GP (Mexico only) | Top 15 by GP (all regions) |
| **Section 3** | Individual sales reps | Regional rollup by manager |

---

## Related Reports

- **VP Daily Brief** (`vp-daily-brief-workflow.md`) - Strategic VP-level daily snapshot
- **USA Daily Brief** (`usa-daily-brief-workflow.md`) - USA team daily snapshot
- **Sales Pulse Comprehensive** (`sales-pulse-comprehensive.js`) - Detailed operational report
- **Sales Pulse Weekly** (`sales-pulse-weekly.js`) - Weekly strategic review

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholder:** Joel Marquez (Mexico Regional Manager)

---

## Changelog

**2026-07-17** - CRITICAL BUG FIX: Race condition causing regional filter crossover
- Fixed concurrent execution issue where USA/MEX/VP briefs overwrote each other's temp query files
- Changed temp file from shared `temp-query.sql` to unique `temp-query-mexico.sql`
- Resolves issue where Mexico sellers (Alex Partida, Joel Flores) appeared in USA brief
- See `docs/BUGFIX-2026-07-17-race-condition.md` for full details

**2026-07-01** - Initial release based on USA Daily Brief
- Filtered to Mexico region (except Strategic Accounts section)
- Section 3 shows individual sales reps instead of regional rollup
- High Value Late Lines limited to top 10
- Manager set to Joel Marquez
- Email recipient: joel.marquez@astutegroup.com

---

*Last Updated: 2026-07-01*
