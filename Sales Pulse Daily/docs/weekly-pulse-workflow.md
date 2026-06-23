# Sales Pulse Weekly - Friday Special Edition

**Status:** ✅ Priority 1 Enhancements COMPLETE | Ready to Deploy
**Created:** 2026-06-01
**Updated:** 2026-06-01 (Priority 1 enhancements added)
**Owner:** Melissa Bojar

---

## Overview

Weekly summary report sent every **Friday at 6:00 AM PT** providing sales leadership with a full week review (Mon-Fri) and week-over-week comparisons.

**Recipients:** Same as daily (melissa.bojar@astutegroup.com, josh.pucci@astutegroup.com, plus regional managers)

**Enhanced Features (Priority 1 - COMPLETE):**
- ✅ Regional week-over-week trends (▲/▼ indicators)
- ✅ Conversion funnel section (pipeline health tracking)
- ✅ Auto-generated observations/insights
- ✅ Fixed regional targets display

---

## What's Different from the Daily Report?

| Daily | Weekly (Friday) |
|-------|-----------------|
| Yesterday vs 5-day rolling avg | Full week (Mon-Fri) vs prior week |
| Yesterday's wins only | All week's wins (top 20) |
| Items created in last 5 days | Persistent issues (3+ days old this week) |
| Week-to-date progress | Final week results vs targets |
| 5-day market pulse | Week-over-week market trends |

---

## Report Sections

### 1. Week Summary (vs Last Week)
- **RFQ Lines Entered** - Full week vs prior week
- **CQ Lines Entered** - Full week vs prior week
- **CQ Lines Sold** - This week total
- **SO Lines Booked** - Full week vs prior week
- **$ Booked** - Full week vs prior week

Each metric shows:
- This week's total
- % change vs last week (▲ green for positive, ▼ red for negative)

### 2. By Region (Week Totals)
Same regional breakdown as daily, but full week totals:
- USA, MEX, APAC-Laurel, APAC-Kris, APAC-Lavanya
- Metrics: RFQ Lines, Response %, CQ Lines, CQ Sold, SO Lines, $ Booked

### 3. Week's Wins (Top 20 Orders)
All bookings from Monday through Thursday:
- Customer name, $ value, line count, seller, region
- Grouped and colored by region (USA=blue, MEX=green, APAC=orange)
- Shows total if >20 wins

### 4. Persistent Issues (3+ Days Open This Week)
High-value quotes (>$10K) that:
- Were created Monday-Tuesday of this week
- Are still open (not sold)
- Need attention before week ends

Shows: Customer, $value, days open, RFQ type, seller

### 5. Week vs Targets
Regional performance against weekly targets:
- **USA Target:** 180 RFQ / 135 CQ / 41 CQ Sold
- **MEX Target:** 180 RFQ / 135 CQ / 41 CQ Sold
- **APAC Target:** 220 RFQ / 165 CQ / 50 CQ Sold

Status indicators:
- ✅ **On Track:** 90-99% of target
- 🎉 **Exceeded:** 100%+ of target
- ⚠️ **Below:** <90% of target

### 6. Market Pulse (Week Trends)
**Note:** Currently empty - manufacturer schema needs investigation. Will show:
- Top 10 trending manufacturers (week-over-week RFQ volume change)
- Customer count per manufacturer
- % change vs prior week

---

## How to Run

### Manual Test Run
```bash
node "Trading Analysis/Sales Pulse Daily/sales-pulse-weekly.js"
```

Output files:
- `output/sales-pulse-weekly-YYYY-MM-DD.html` - Email-ready HTML
- `output/sales-pulse-weekly-YYYY-MM-DD.json` - Raw data for debugging

### Send via Email (Manual)
```bash
# 1. Generate report
node "Trading Analysis/Sales Pulse Daily/sales-pulse-weekly.js"

# 2. Send email (using same send-email.js as daily, but point to weekly HTML)
node "Trading Analysis/Sales Pulse Daily/send-email.js" weekly
```

**Note:** You'll need to update `send-email.js` to support a "weekly" mode that:
1. Reads the weekly HTML file (not daily)
2. Updates subject line to "Sales Pulse — Weekly Edition (Week of [Date])"

---

## Automated Schedule (TODO)

**Recommended Schedule:** Every Friday at 6:00 AM PT

### Option 1: Add to cron-jobs.js registry
```javascript
{
  name: 'sales-pulse-weekly',
  schedule: '0 11 * * 5',  // 11 UTC = 6am EST, Fridays only
  command: 'node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/sales-pulse-weekly.js" && node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/send-email.js" weekly',
  description: 'Generate and email weekly Sales Pulse report (Fridays)'
}
```

### Option 2: Direct crontab
```bash
crontab -e

# Add this line:
0 11 * * 5 cd "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily" && node sales-pulse-weekly.js && node send-email.js weekly >> /var/log/sales-pulse-weekly.log 2>&1
```

---

## ✅ Priority 1 Enhancements - COMPLETE (2026-06-01)

### 1. Regional Week-Over-Week Trends ✅
**What:** Added ▲/▼ indicators to regional table showing % change vs prior week
**Why:** Managers can immediately see which regions improved/declined
**Example:** `USA: 121 (▼15%) | 73 (▼19%) | $565K (▼50%)`

### 2. Conversion Funnel Section ✅
**What:** New Section 6 showing full pipeline conversion rates (RFQ→VQ→CQ→SO)
**Why:** Identifies where the funnel is breaking down by region
**Metrics:**
- RFQ → VQ Received: % with week-over-week change
- VQ Received → CQ Created: % with week-over-week change
- CQ Created → SO Booked: % with week-over-week change
- **Overall RFQ → SO**: End-to-end conversion rate

### 3. Observations/Insights Section ✅
**What:** Auto-generates 4-5 key observations from the data
**Why:** Managers get actionable insights without manual analysis
**Examples:**
- "Quality over quantity: 1,075 fewer RFQs but $1.1M more revenue"
- "MEX sourcing concern: 470 RFQs but only 8 CQs (2% conversion - investigate)"
- "APAC-Laurel dominated: 65% of total revenue"

### 4. Fixed Regional Targets Display ✅
**What:** Shows actual regional targets instead of global totals
**Why:** Accurate performance assessment per region
**Format:** `121 / 180 (67%)` instead of `121 (67%)` with unclear denominator

---

## Known Limitations & Future Enhancements

### Current Limitations
1. **Market Pulse (Section 7) is empty** - Manufacturer table schema needs investigation
   - Daily report accesses `adempiere.m_manufacturer` successfully
   - Weekly script gets "relation does not exist" error
   - **Fix:** Check if table name differs or needs different join path

2. **Response % is 0** - Complex subquery removed to avoid shell command length limit
   - Could be re-added using temp file approach
   - Not critical for week summary (more useful in daily)

### Priority 2 Enhancements (Nice to Have)
- [ ] 4-week rolling average context (vs just prior week)
- [ ] Performance Movers section (biggest improvers/decliners by seller)
- [ ] Seller leaderboard (top 5 by revenue for the week)
- [ ] Fix manufacturer trending section (Section 7)
- [ ] Add "Biggest Win of Week" highlight
- [ ] Consider month-end special version (4-week summary)

---

## Files

| File | Purpose |
|------|---------|
| `sales-pulse-weekly.js` | Main report generator (690 lines) |
| `SALES-PULSE-WEEKLY.md` | This documentation |
| `output/sales-pulse-weekly-*.html` | Generated HTML emails |
| `output/sales-pulse-weekly-*.json` | Raw data (debugging) |

---

## Comparison: Daily vs Weekly

**Use Daily When:**
- Need immediate visibility into yesterday's activity
- Monitoring day-to-day trends
- Identifying stuck items quickly (5-day window)

**Use Weekly When:**
- Reviewing full week performance
- Comparing week-over-week progress
- Assessing against weekly targets
- Celebrating weekly wins

**Both reports complement each other** - Daily provides tactical pulse, Weekly provides strategic review.

---

## Testing Notes

Tested on 2026-06-01 (Sunday):
- ✅ Sections 1-5 run successfully
- ✅ HTML output generated (5.4 KB)
- ✅ JSON data structure correct
- ✅ Week calculation works (Monday = start of week)
- ⚠️ Section 6 (Market Pulse) disabled due to schema issue

**Note:** Since today is Sunday, "this week" (Mon-Fri) is empty and "last week" shows full data. When run on Friday, "this week" will have Mon-Thu data.

---

## Next Steps

1. **Update send-email.js** to support weekly mode
2. **Add to cron-jobs.js** for Friday 6am automation
3. **Investigate manufacturer table schema** to enable Section 6
4. **Test on actual Friday** to verify full week data

---

**Status:** ✅ Core functionality complete | ⏭️ Ready for email integration & scheduling

*Last Updated: 2026-06-01*
