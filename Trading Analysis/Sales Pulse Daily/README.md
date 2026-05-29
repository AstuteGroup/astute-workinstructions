# Sales Pulse Daily — Pre-Sales Visibility Dashboard

**Status:** Design Complete ✅ | Ready for SQL Implementation
**Created:** 2026-05-28
**Owner:** Melissa Bojar (Sales Productivity Analyst)

---

## Project Overview

Daily email digest providing sales leadership (Jeff Wallace, Joel Marquez, Laurel Kee, Kris Munoz, Lavanya Manohar) with actionable visibility into pre-sales funnel health, seller performance, and market trends.

**Purpose:** Give managers a 60-second daily pulse on:
- What's flowing in (RFQs, sourcing velocity)
- What's moving through (quotes, conversions)
- What needs attention (aging quotes, stuck sourcing, new opportunities)
- What we won (yesterday's bookings)
- What the market is telling us (trending parts, demand signals)

**Delivery:** HTML email at 6:00am PT daily (Mon-Fri)

---

## Key Design Principles

### 1. **Fresh & Actionable (5-Day Rolling Window)**
- Most metrics compare yesterday vs 5-day rolling average (smooths noise)
- "Needs Attention" shows only items **created in last 5 business days**
- After 5 days, items fall off the report (prevents stale backlog)

**Why:** A Shortage quote created 3 days ago has 7 days left to close (actionable). A Shortage quote created 18 days ago is dead (not shown).

### 2. **Prioritized by Value & Opportunity**
- High-value quotes (>$10K) listed first
- High-probability customers (30-50% win rate) highlighted
- New customer opportunities (first-time RFQs) prioritized
- Pricing benchmarks for market intel (not pursuit)

### 3. **Context for Decision-Making**
- RFQ type shown (Shortage/PPV/EOL/etc.) so managers assess if aging is appropriate
- Customer win rate shown for high-probability accounts
- Seller/buyer names for sourcing stuck (enables escalation)
- Days left in close window for quotes

### 4. **Acknowledges Data Gaps**
- "These numbers reflect OT activity only" disclaimer
- Focus on trends and relative performance vs absolute accuracy
- Not all RFQs/VQs/CQs make it into the system (known reality)

---

## Organization Structure

**29 Active Sellers (as of 2026-05-28):**

| Region | Manager | Sellers | Weekly Targets (RFQ / CQ / CQ Sold) |
|--------|---------|---------|-------------------------------------|
| **USA** | Jeff Wallace | 9 | 180 / 135 / 41 |
| **MEX** | Joel Marquez | 9 | 180 / 135 / 41 |
| **APAC** | Multiple | 11 | 220 / 165 / 50 |
| ↳ Singapore | Laurel Kee | 3 | — |
| ↳ Philippines/China | Kris Munoz (aka Silvia) | 5 | — |
| ↳ India | Lavanya Manohar | 3 | — |
| **GLOBAL** | — | **29** | **580 / 435 / 132** |

**Per-Seller Weekly KPIs:**
- 20 RFQ lines entered
- 15 CQ lines entered
- 4.5 CQ lines sold (30% close rate)
- 100 activities (not tracked in this report)

---

## Report Sections (Final v5 Design)

### 1. **Global Snapshot** (Yesterday vs 5-Day Rolling Avg)

**Pipeline Input (5 metrics):**
- RFQ Lines Entered (+ distinct customers)
- RFQ Lines with 1+ Response (VQ or No-Bid)
- Buyer Queue Time (routed → picked by buyer)
- Buyer Response Time (picked → first VQ or no-bid)
- Total Response Time (routed → first response)

**Quoting Activity (4 metrics):**
- CQ Lines Entered (+ distinct customers)
- CQ Lines Selected as 'Sold'
- Avg Quote Age - Short-cycle (Shortage/PPV/Other: 10-30d auto-close)
- Avg Quote Age - Long-cycle (Mil-Aero/EOL/Obsolete/LTB: 64d auto-close)

**Wins (2 metrics):**
- SO Lines Booked
- $ Booked

**System Discipline (2 metrics):**
- CQs entered within 2hrs of marking 'sold' (timeliness %)
- Retroactive CQ entry rate (% entered after sold)

---

### 2. **By Region** (Yesterday's Activity)

Shows USA, MEX, APAC (with drill-down to Laurel/Kris/Lavanya) for:
- RFQ Lines Entered
- RFQ Lines with Response (%)
- Total Response Time
- CQ Lines Entered
- CQ Lines Sold
- SO Lines Booked
- Avg Quote Age (Short-cycle)

---

### 3. **Yesterday's Wins** (Orders Booked)

By region, showing:
- Customer name, line count, $ value, seller name
- Insights when notable (e.g., "3-day-old quote = fast close!")

---

### 4. **Needs Attention** (Created in Last 5 Business Days)

**A. High-Value Quotes (>$10K, created in last 5 days) — Top 5**
- Shows: $ value, created date, RFQ type, days left in window, seller
- Example: "Samsung - $24K, created 3 days ago (Shortage - 10d window, 7d left)"

**B. High-Probability Customers (30-50% win rate, quoted in last 5 days) — Top 5**
- Shows: Customer name, $ value, quoted date, RFQ type, win rate, seller
- Example: "Premier - $9K, quoted 4 days ago (Shortage) - 45% win rate"

**C. New Customer Opportunities (first-time RFQs in last 5 days, no quotes yet) — Top 5**
- Shows: Customer name, RFQ line count, RFQ entry date, assigned seller
- Example: "TechGlobal Inc - 4 RFQ lines, entered 5/23 (5 days ago)"

**D. Pricing Benchmarks (last 30 days: 30+ lines quoted, <10% win rate)**
- Shows: Customer name, lines quoted, wins, win rate
- Persist for 5 days after first appearance, then fall off unless pattern continues

**E. Sourcing Stuck (routed RFQ lines with no response after 3+ days)**
- Shows: MPN, MFR, QTY, Customer, Seller, Buyer (or "Pool"), Routed date
- Example: "TPS54620 (Texas Instruments) | QTY: 500 | Customer: Premier | Seller: Dan Reiser | Buyer: Pool | Routed: 5/24 (4 days ago)"

---

### 5. **Week-to-Date** (Mon-Thu Progress)

By region, showing:
- RFQ Lines, CQ Lines, CQ Sold vs Weekly Targets
- Pace indicator (✅ On track, ⚠️ Below pace)
- Projected week-end performance

---

### 6. **Market Pulse** (5-Day Rolling Trends) — Top 3

Shows:
- Hot parts (demand spikes by MPN/MFR)
- Trending up (parts booking faster than normal)
- Trending down (declining RFQ categories)

Examples:
- "Microchip Technology: 23 RFQ lines from 10 customers (vs 9/4 last week = +156%)"
- "Parts with prefix '74LS': Booking 2.3× faster (2.1d to close vs 4.8d avg)"

---

### 7. **Observations**

3-5 bullet points highlighting:
- Regional performance differences
- System discipline trends
- Sourcing velocity improvements/concerns
- Market opportunities

---

## Time Frame Logic (CRITICAL)

### **"Created in Last 5 Business Days" Rule**

All "Needs Attention" items (except Pricing Benchmarks and Sourcing Stuck) show what was **created in the last 5 business days**, then fall off:

| Item Type | Show If... | Falls Off After... |
|-----------|-----------|-------------------|
| High-Value Quotes | Quote **created** in last 5 days | 5 business days from quote date |
| High-Probability Customers | Quote **created** in last 5 days | 5 business days from quote date |
| New Customer Opportunities | RFQ **created** in last 5 days | 5 business days from RFQ date |
| Pricing Benchmarks | 30+ lines quoted in last 30 days, <10% win rate | 5 days after first appearance, unless pattern continues |
| Sourcing Stuck | RFQ line **routed** 3+ days ago with no response | When response received or closed |

**Why This Works:**
- Keeps daily pulse focused on fresh, actionable items
- Prevents stale backlog from cluttering the report
- Forces daily action on opportunities while still viable

---

## Auto-Close Rules by RFQ Type

| RFQ Type | Auto-Close Window | Category |
|----------|-------------------|----------|
| Shortage | 10 business days | Short-cycle |
| PPV / Cost Saving | 15 business days | Short-cycle |
| All Other | 30 business days | Short-cycle |
| Mil-Aero | 64 business days | Long-cycle |
| EOL (End of Life) | 64 business days | Long-cycle |
| Obsolete | 64 business days | Long-cycle |
| LTB (Last Time Buy) | 64 business days | Long-cycle |

Used to calculate:
- Avg Quote Age (separate for short/long-cycle)
- Days left in window for aging quotes

---

## Files in This Folder

| File | Description |
|------|-------------|
| `README.md` | This file - project overview and design specs |
| `sales-pulse-daily-sample-v5.html` | Final HTML email template with sample data |
| `sales-pulse-design-notes-v2.md` | Detailed design evolution and decisions |
| `session-summary-2026-05-28.md` | What we accomplished today + next steps |

---

## Next Steps (SQL Implementation)

### Phase 1: Data Model Research
- [ ] Read `shared/data-model.md` for table/field mappings
- [ ] Identify fields for:
  - VQ timing workflow (routed timestamp, picked timestamp, first response timestamp)
  - CQ "sold" checkbox field
  - RFQ type field
  - Customer win rate calculation
  - Buyer assignment (specific buyer vs pool)

### Phase 2: SQL Query Development
- [ ] Global Snapshot queries (13 metrics)
- [ ] Regional breakdown queries (8 metrics × 4 regions)
- [ ] Needs Attention queries (5 sections, prioritized + capped at top 5)
- [ ] Yesterday's Wins query (with seller names)
- [ ] Week-to-Date queries (vs per-seller targets)
- [ ] Market Pulse queries (top 3 trends, 5-day rolling)

### Phase 3: Mart Tables (Optional but Recommended)
- [ ] `mart.sales_pulse_daily_snapshot` (historical tracking)
- [ ] `mart.sales_pulse_regional` (regional metrics)
- [ ] `mart.sales_pulse_needs_attention` (prioritized alerts)
- [ ] Schedule daily refresh (cron at 5:45am PT)

### Phase 4: Email Automation
- [ ] Node.js script to run queries + format HTML
- [ ] Email delivery via `nodemailer`
- [ ] Schedule cron job (6:00am PT daily, Mon-Fri)
- [ ] Set recipients (Josh, Jeff, Joel, Laurel, Kris, Lavanya + analytics team)

### Phase 5: Iterate & Refine
- [ ] Tune thresholds based on actual data
- [ ] Add Friday special version (full week summary)?
- [ ] Power BI integration?

---

## Questions to Resolve Before SQL Implementation

1. **VQ Timing Fields:**
   - How is "routed to buyer queue" tracked? (status field? timestamp?)
   - How is "picked by buyer" tracked? (assignment field? status change?)

2. **CQ "Sold" Status:**
   - What field indicates a CQ line is marked "sold"? (checkbox? docstatus?)
   - What timestamp indicates when it was marked sold?

3. **RFQ Type:**
   - Where is RFQ type stored? (chuboe_rfq.rfqtype? custom field?)
   - Valid values confirmed?

4. **Customer Win Rate:**
   - How to calculate across all time vs last 90 days?
   - Count only CQs with clear win/loss outcome?

5. **Buyer Assignment:**
   - How to identify "Pool" vs specific buyer?
   - Field name for assigned buyer?

**Action:** Read `shared/data-model.md` to answer these before building queries.

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholders:** Josh Pucci (VP Sales), Jeff Wallace (Director - USA), Joel Marquez (Manager - MEX), Laurel Kee (Manager - APAC), Kris Munoz (Manager - APAC), Lavanya Manohar (Manager - APAC)

**Related Workflows:**
- RFQ Sourcing (NetComponents)
- VQ Loading
- Quick Quote
- Market Offer Analysis

---

*Last Updated: 2026-05-28*
