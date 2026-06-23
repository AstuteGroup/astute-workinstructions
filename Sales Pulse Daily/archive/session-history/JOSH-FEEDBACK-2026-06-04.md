# Josh Feedback — VP Sales Pulse (June 4, 2026)

**Meeting Date:** June 4, 2026 (afternoon)
**Attendees:** Josh Pucci (VP Sales), Melissa Bojar
**Decision:** Proceed with VP Daily Brief concept, implement feedback below
**Action Date:** June 5, 2026 (tomorrow)

---

## ✅ Approved Concept

**Winner:** VP Daily Brief - Sales Pulse (1-page format)

**Why this layout:**
- Clean, scannable format
- Right level of detail for VP
- 60-second read time
- Focuses on strategic actions vs operational detail

---

## 🔧 Changes Requested

### 1. **Blend VP Daily Brief + Action-First Mockup**
**Task:** Integrate key sections from `sales-pulse-MOCKUP-action-first.html` into the VP Daily Brief structure

**Questions to answer tomorrow:**
- Which specific sections from action-first should be pulled in?
- How to maintain 1-page format while adding more content?
- What's the priority order of sections?

**Files to review:**
- `output/sales-pulse-VP-DAILY-BRIEF-v2-2026-06-04.html` (current winner)
- `output/sales-pulse-MOCKUP-action-first.html` (source for additional sections)

---

### 2. **Add: New Customers Sold**
**Requirement:** Include new customer wins in the report

**Design questions:**
- Where in layout? (Wins section? Separate "New Customer Highlights"?)
- Definition: First-time order from a customer we've never invoiced before?
- How many to show? (Top 3? Top 5? All from yesterday?)
- What info to display? (Customer name, revenue, product category, ISE name?)

**Data needed:**
- Query: Customers on yesterday's SO who have no prior SOs in history
- Fields: Customer name, SO amount, ISE (seller), product/MPN if relevant

---

### 3. **Add: Late Shipments to Needs Attention**
**Requirement:** Flag shipments that are late (past due 3+ days, $250K+ revenue)

**Criteria:**
- **Late =** Past promised ship date by 3+ days
- **Threshold =** $250K+ revenue per shipment (or order line?)
- **Show:** Customer, promised date, actual days late, revenue, ISE owner

**Design questions:**
- How many to show? (Top 5 by revenue? All that meet criteria?)
- Red/Yellow/Green coding by severity? (3-7 days = yellow, 7+ days = red?)
- Show in same "Needs Attention" section or separate "Late Shipments" alert box?

**Data needed:**
- Table: `c_order` / `m_inout` (shipments)
- Fields: Promised ship date, actual ship date (or today if not shipped), revenue, customer, ISE
- Filter: `DatePromised < CURRENT_DATE - INTERVAL '3 days'` AND `revenue >= 250000` AND `isactive = 'Y'`

---

### 4. **Revise: Week-to-Date Pace (Monday Only)**
**Requirement:** Only show week-to-date section on Monday reports (complete previous week summary)

**Logic:**
- **Monday report:** Show full prior week (Mon-Fri) vs weekly targets
- **Tuesday-Friday reports:** HIDE week-to-date section entirely (or show "See Monday report for weekly summary")

**Implementation:**
- Add day-of-week check in script: `if (today.getDay() === 1) { include WTD section }`
- Monday version = comprehensive weekly summary
- Daily versions = focus on yesterday + alerts only

---

### 5. **Remove: Market Pulse**
**Decision:** Market Pulse will be a separate deliverable (not in daily VP brief)

**Action:**
- Remove "Market Pulse" section from VP Daily Brief
- Create separate Market Pulse report design (future task)
- Scope: Trending manufacturers, hot parts, demand signals, lead time changes

**Note:** Market Pulse still exists in manager-level comprehensive report. Only removing from VP Daily Brief.

---

### 6. **Add: Inactive ISEs to Needs Attention**
**Requirement:** Flag ISEs (sellers) who haven't loaded an RFQ or CQ in 3 days

**Criteria:**
- **Inactive =** No RFQ lines OR CQ lines entered in last 3 days
- **Show:** ISE name, region, last activity date, days since last entry

**Design questions:**
- How many to show? (All inactive ISEs? Top 5 by longest inactive period?)
- Regional breakdown? (Flag by region: "USA: 2 inactive, MEX: 1 inactive, APAC: 0")
- Severity coding? (3-5 days = yellow, 5+ days = red?)

**Data needed:**
- Query: All active ISEs (salesreps) with last RFQ/CQ entry date
- Join: `chuboe_rfq_line` + `chuboe_cq_line` by `salesrep_id`, filter `created >= CURRENT_DATE - INTERVAL '3 days'`
- Output: ISEs NOT in that result set = inactive

**Regional mapping:** Use existing `SELLER_REGIONS` from `sales-pulse-comprehensive.js`

---

### 7. **Explore: Power BI Integration**
**Requirement:** Review how to best integrate with Power BI

**Questions to answer:**
- **Data source:** Power BI reads from OT database directly? Or consume JSON output from this script?
- **Refresh cadence:** Real-time dashboard? Daily refresh? On-demand?
- **Layout:** Embed HTML report in Power BI? Or rebuild as native Power BI dashboard?
- **User access:** Who needs Power BI version? (Josh only? Regional managers? Broader sales team?)

**Options to explore:**
1. **JSON export:** Script outputs `.json` file → Power BI imports daily
2. **Direct query:** Power BI connects to `idempiere_replica` with same SQL queries
3. **Hybrid:** Script generates daily snapshot → Power BI visualizes trends over time
4. **Embedded HTML:** Power BI iframe embedding this HTML report (low-code option)

**Action for tomorrow:**
- Research Power BI connector options for PostgreSQL
- Determine if Power BI should replace HTML email or supplement it
- Scope: Daily operational dashboard (Power BI) vs strategic email brief (HTML)?

---

## 🎯 Priority Order for Tomorrow

### High Priority (Must Do)
1. ✅ Blend VP Daily Brief + Action-First sections
2. ✅ Add New Customers Sold
3. ✅ Add Late Shipments to Needs Attention
4. ✅ Add Inactive ISEs to Needs Attention
5. ✅ Implement Monday-only Week-to-Date logic
6. ✅ Remove Market Pulse section

### Medium Priority (Research)
7. 🔍 Power BI integration options (research, not build yet)

---

## 📋 Design Decisions Needed Tomorrow

### Layout & Structure
- **Current VP Daily Brief sections:**
  1. What Matters Today (priority actions)
  2. Q2 Financial Health
  3. Regional Performance
  4. Backlog & Delivery Risk
  5. Key Market Signals
  6. Yesterday's Activity

- **Sections to add/blend from Action-First:**
  - Executive Brief format (Red/Yellow/Green priority)
  - Yesterday's Wins (top 3 with medals)
  - Needs Attention subsections (high-value quotes, high-probability, new customers, sourcing stuck)

- **New sections from Josh feedback:**
  - New Customers Sold
  - Late Shipments (Needs Attention)
  - Inactive ISEs (Needs Attention)

**Question:** How to fit all this in 1-page format?

**Proposed structure for tomorrow:**
1. **Priority Actions** (Red/Yellow/Green - from action-first)
2. **Financial Health** (Q2 metrics - current)
3. **Regional Performance** (table - current)
4. **Needs Attention** (EXPANDED):
   - Late Shipments (NEW - 3+ days, $250K+)
   - Inactive ISEs (NEW - no RFQ/CQ in 3 days)
   - High-Value Quotes (from action-first)
   - New Customer Opportunities (from action-first)
5. **Yesterday's Wins** (top 3 - from action-first)
6. **New Customers Sold** (NEW - first-time orders)
7. **Week-to-Date Pace** (CONDITIONAL - Monday only)

---

## 📊 Data Requirements for New Features

### New Customers Sold
```sql
-- Customers who had an SO yesterday but no prior SOs in history
SELECT DISTINCT
  bp.name as customer,
  SUM(ol.linenetamt) as revenue,
  COUNT(ol.c_orderline_id) as lines,
  u.name as ise_name
FROM c_order o
JOIN c_orderline ol ON o.c_order_id = ol.c_order_id
JOIN c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
JOIN ad_user u ON o.salesrep_id = u.ad_user_id
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
  AND ol.isactive = 'Y'
  AND NOT EXISTS (
    SELECT 1 FROM c_order o2
    WHERE o2.c_bpartner_id = o.c_bpartner_id
      AND o2.created::date < CURRENT_DATE - INTERVAL '1 day'
      AND o2.isactive = 'Y'
  )
GROUP BY bp.name, u.name
ORDER BY revenue DESC;
```

### Late Shipments
```sql
-- Shipments past due 3+ days with $250K+ revenue
SELECT
  bp.name as customer,
  o.datepromised,
  CURRENT_DATE - o.datepromised::date as days_late,
  SUM(ol.linenetamt) as revenue,
  u.name as ise_name,
  o.documentno as order_number
FROM c_order o
JOIN c_orderline ol ON o.c_order_id = ol.c_order_id
JOIN c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
JOIN ad_user u ON o.salesrep_id = u.ad_user_id
LEFT JOIN m_inout ship ON o.c_order_id = ship.c_order_id AND ship.isactive = 'Y'
WHERE o.datepromised < CURRENT_DATE - INTERVAL '3 days'
  AND ship.m_inout_id IS NULL  -- Not yet shipped
  AND o.isactive = 'Y'
  AND ol.isactive = 'Y'
GROUP BY bp.name, o.datepromised, u.name, o.documentno
HAVING SUM(ol.linenetamt) >= 250000
ORDER BY days_late DESC, revenue DESC;
```

### Inactive ISEs
```sql
-- ISEs with no RFQ or CQ entries in last 3 days
WITH active_ises AS (
  SELECT DISTINCT salesrep_id, MAX(created) as last_activity
  FROM (
    SELECT salesrep_id, created FROM chuboe_rfq WHERE created >= CURRENT_DATE - INTERVAL '3 days' AND isactive = 'Y'
    UNION ALL
    SELECT salesrep_id, created FROM chuboe_cq_line WHERE created >= CURRENT_DATE - INTERVAL '3 days' AND isactive = 'Y'
  ) combined
  GROUP BY salesrep_id
),
all_ises AS (
  SELECT DISTINCT u.ad_user_id, u.name
  FROM ad_user u
  WHERE u.ad_user_id IN (1039413, 1047077, ...) -- Use SELLER_REGIONS mapping
    AND u.isactive = 'Y'
)
SELECT
  ai.name as ise_name,
  COALESCE(act.last_activity, CURRENT_DATE - INTERVAL '30 days') as last_activity,
  CURRENT_DATE::date - COALESCE(act.last_activity::date, CURRENT_DATE::date - 30) as days_inactive
FROM all_ises ai
LEFT JOIN active_ises act ON ai.ad_user_id = act.salesrep_id
WHERE COALESCE(act.last_activity, CURRENT_DATE - INTERVAL '30 days') < CURRENT_DATE - INTERVAL '3 days'
ORDER BY days_inactive DESC;
```

---

## 🔄 Next Steps (June 5, 2026)

### Morning (Design Phase)
1. Read this feedback document
2. Review both HTML files (VP Daily Brief v2 + Action-First mockup)
3. Sketch combined layout on paper/whiteboard
4. Decide section priority order
5. Determine what to keep 1-page vs expand to 2-page if needed

### Afternoon (Build Phase)
1. Write SQL queries for new features (new customers, late shipments, inactive ISEs)
2. Test queries against database
3. Update `sales-pulse-comprehensive.js` or create new `sales-pulse-vp-daily.js`
4. Generate updated HTML mockup
5. Review with Melissa before sending to Josh

### Research (Parallel)
- Power BI integration options
- Document findings in separate file: `POWER-BI-INTEGRATION-OPTIONS.md`

---

## 📁 Files to Reference Tomorrow

**Current versions:**
- `output/sales-pulse-VP-DAILY-BRIEF-v2-2026-06-04.html` (base layout)
- `output/sales-pulse-MOCKUP-action-first.html` (sections to blend in)
- `sales-pulse-comprehensive.js` (existing script with queries/logic)

**Feedback docs:**
- `JOSH-FEEDBACK-2026-06-04.md` (this file)
- `VP-MOCKUP-REAL-DATA-COMPARISON.md` (context from today's meeting)

**New files to create tomorrow:**
- `sales-pulse-vp-daily.js` (new dedicated script for VP Daily Brief)
- `output/sales-pulse-VP-DAILY-FINAL-2026-06-05.html` (updated mockup)
- `POWER-BI-INTEGRATION-OPTIONS.md` (research findings)

---

## ✅ Success Criteria

**Tomorrow's deliverable should:**
1. ✅ Maintain 1-page format (or justify if 2-page needed)
2. ✅ Include all 6 new requirements (new customers, late shipments, inactive ISEs, blended sections, Monday logic, remove Market Pulse)
3. ✅ Use real data from database (not mock)
4. ✅ Be ready to send to Josh for final review
5. ✅ Have clear documentation of Power BI options

---

*Saved: June 4, 2026 | Action: June 5, 2026*
