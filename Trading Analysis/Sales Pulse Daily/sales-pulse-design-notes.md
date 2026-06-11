# Sales Pulse Daily Digest — Design Notes

## Files Created

1. **sales-pulse-daily-sample.txt** — Plain text version (works in any email client)
2. **sales-pulse-daily-sample.html** — HTML version (better visual formatting)
3. This design notes document

## The 5 Key Questions (Answered Daily)

| Question | Metric | Why It Matters |
|----------|--------|----------------|
| **"Are opportunities flowing in?"** | RFQs Received | Leading indicator of pipeline health — if this drops, trouble in 2-3 weeks |
| **"Are we converting fast enough?"** | Quotes Sent | Velocity check — are we responding to demand? Sourcing bottlenecks? |
| **"What's stuck?"** | Aging quotes, stuck RFQs | Identifies blockers that need intervention TODAY |
| **"What did we win?"** | Orders Booked | Morale + celebration + learn from fast closes |
| **"What's at risk?"** | Stale quotes (15-30 days) | Last chance to save deals before they die |

## Design Principles

### 1. **Scannable in 60 Seconds**
- Top section = 4 numbers with trend arrows (glanceable)
- Regional comparison table (spot outliers instantly)
- Action items clearly called out (not buried in prose)
- Wins section (positive reinforcement)

### 2. **Comparative Context**
- Yesterday vs. last Tuesday (week-over-week trend)
- Region vs. region (healthy competition)
- Week-to-date pace vs. target (are we on track?)

### 3. **Actionable, Not Just Informational**
- Each alert has a specific ACTION line
- Thresholds are clear (3 days, 7 days, 15 days)
- High-value stale quotes called out by customer name + $ value

### 4. **Positive + Negative Balance**
- Don't just show problems — celebrate wins
- Call out seller names on wins (public recognition)
- Add "insights" when interesting patterns emerge (fast close, reactivated customer, etc.)

### 5. **Acknowledge Data Gaps**
- "System capture reminder" in Notes section
- Focus on trends and relative performance (not absolute accuracy)
- Even if 60% of activity is captured, rankings and trends are still valid

## Section Breakdown

### 📊 Global Snapshot
- 4 core metrics: RFQs, Quotes, Orders, Avg Quote Age
- Trend arrows (↑↓→) for instant visual scan
- Compare to yesterday AND last week same day

### 📍 By Region
- Same 4 metrics broken down by USA/MEX/APAC
- Managers can see their region vs. others
- APAC sub-breakdown (Laurel/Lavanya/Kris) for drill-down

### 🚨 Needs Attention
- **Prioritized by urgency:**
  1. Aging quotes 7-14 days (medium risk)
  2. RFQs with no VQs after 3+ days (sourcing stuck)
  3. Quotes 15-30 days (critical — last chance)
- Regional breakdown for each blocker
- Specific dollar values on critical items

### 🎉 Yesterday's Wins
- Orders booked yesterday by region
- Call out biggest deals and seller names
- Add "insights" when possible (fast close, interesting pattern)

### 📈 Week-to-Date
- Mon-Wed progress toward weekly targets
- Projected week-end pace (on track? ahead? behind?)
- Dollar values added here (not in daily snapshot — too noisy)

### 📝 Notes
- Observations, patterns, reminders
- Keep it to 3-5 bullet points max
- Include the "system capture" disclaimer

## Org Structure (From Employee Roster)

### USA (Jeff Wallace - Director of Sales)
9 sellers: Aaron Mendoza, Dan Reiser, Jake McAloose, James Diaz, Josh Syre, Justin Goodwin, Michael Stifter, Thomas Haynes, Will Rob

*(Note: Melissa Bojar is Sales Productivity Analyst, not a seller — exclude from seller counts/metrics)*

### MEX (Joel Marquez - Sales Manager)
9 sellers: Alejandro Padilla, Alex Partida, Alfredo Martinez, Carlos Moreno, Carolina Hinestroza, Joel Flores, Juan Botero, Ricardo Morales, Salvador Horner

### APAC (Multiple Managers)
- **Laurel Kee** (Regional Sales Manager, Singapore): Ivy Chew, Jasper Kee, Ray Ng
- **Lavanya Manohar** (Sales Manager, India): Manikandan Subramani, Meenakshi Chidambaram, NANDHINI .
- **Kris Munoz** (Sales Manager, Philippines): James Xu, Joy Phromsatcha, Spring Tu, Wing Zhang, Winnie Lee
- **Edyna Lee** (Director of Sales, Korea): Direct reports to Josh Pucci

Total: ~38 active sales employees across 3 regions

## Delivery Recommendations

**When:** 6:00am PT daily (Mon-Fri)
**To:** Josh Pucci, Jeff Wallace, Joel Marquez, Laurel Kee, Lavanya Manohar, Kris Munoz, Edyna Lee
**CC/BCC:** Sales ops, analytics team, anyone else who wants visibility

**Format Options:**
1. **HTML email** (preferred) — best visual formatting
2. **Plain text** — if HTML doesn't render well in email client
3. **Power BI embedded** — if you build dashboard, can send daily snapshot

**Subject Line Format:**
`Sales Pulse — Wed May 28 (USA ↑ | MEX → | APAC ↓)`

Include trend arrows in subject so managers can see health at-a-glance before opening.

## Thresholds & Targets (To Be Tuned)

These are illustrative — adjust based on actual business:

| Metric | Threshold | Color Code |
|--------|-----------|------------|
| Avg Quote Age | <7d = ✅ | 7-10d = ⚠️ | >10d = 🔥 |
| Aging 7-14 days | <15 quotes = OK | 15-30 = ⚠️ | >30 = 🔥 |
| Aging 15-30 days | <5 quotes = OK | 5-10 = ⚠️ | >10 = 🔥 |
| RFQs with no VQs (3+ days) | <5 = OK | 5-10 = ⚠️ | >10 = 🔥 |
| Weekly orders target | 50 orders, $350K | (adjust per region/season) |
| Daily RFQ volume | ~10 lines/day (50/week target) |

## What's NOT Included (Saved for Weekly)

- Individual seller rankings/performance (too noisy for daily)
- Margin/GP details (not actionable daily)
- Customer-specific breakdowns (too detailed)
- Hot parts / market intelligence (weekly digest)
- Win/loss analysis (weekly/monthly)

## Next Steps

1. **Review format** — Is this the right level of detail? Too much? Too little?
2. **Refine metrics** — Are these the right 5 questions? Any additions/removals?
3. **Set thresholds** — What are realistic targets for quote age, aging buckets, weekly volume?
4. **Build SQL queries** — Once format is approved, I'll build the data pipeline
5. **Automate delivery** — Node.js script + cron job for daily 6am sends

## Open Questions for Review

1. Should we break out APAC managers individually in the regional table (Laurel/Lavanya/Kris as separate rows)?
2. Do you want seller names on wins, or just regional totals?
3. Should "Needs Attention" section include specific customer names for stale quotes (privacy concern in group email)?
4. Is $-value needed in daily snapshot, or save for weekly?
5. Should we add a "Top Opportunity" callout (e.g., "Best quote to push today: Samsung $24K, 18 days old")?
6. Do we need a Friday version that shows full week summary + comparison to prior weeks?
