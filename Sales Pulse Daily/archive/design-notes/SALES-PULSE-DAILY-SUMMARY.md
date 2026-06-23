# Sales Pulse Daily - Implementation Summary

**Date:** May 29, 2026
**Status:** SQL Queries Complete & Tested ✅ | Node.js Automation In Progress

---

## What We Built

### 1. **Global Snapshot (V5 Approach)** - All RFQ Lines
Measures total pipeline activity regardless of source

**Metrics:**
- RFQ Lines Entered in OT (all sources)
- VQ Coverage % (any VQ - human or Claude)
- Source Breakdown: Self-sourced / Claude / Buyer-sourced
- CQ/SO activity
- Avg response times

### 2. **Buyer Queue Effectiveness** - Last 3 Business Days Rolling
Specifically tracks the buyer queue problem

**Metrics:**
- Lines routed to buyer queue
- Human buyer response rate
- Avg response time (when responded)
- Lines stuck >48hrs
- Daily trend breakdown

---

## Real Data from Yesterday (Thu May 28, 2026)

### Global Snapshot:
- **57 RFQ lines entered** from 17 customers
- **27 got VQs** (47.4% coverage)
- **30 no VQs** (52.6% - opportunity gap)

**Source Breakdown (of the 27 with VQs):**
- **51.9% self-sourced** by sellers (14 lines)
- **48.1% buyer-sourced** (13 lines)
- **0% Claude Harris** (Claude doesn't work yesterday's fresh RFQs)

### Buyer Queue (Last 3 Days: Tue-Thu):
- **194 lines routed** to buyer queue
- **Only 8 got human VQs** (4.1% response) 🔥
- **Trend:** Improving (2.3% → 4.8% → 5.8%)

**Thursday alone:**
- 52 routed, 3 responded (5.8%)

---

## 🔥 Key Findings

### Finding #1: Sellers Self-Source More Than Using Buyer Queue
- **14 lines self-sourced** (24.6% of all RFQs)
- **Only 3 buyer queue responses** (5.3% of all RFQs)
- Sellers bypass the queue when they can source themselves

### Finding #2: Buyer Queue Has 95.9% No-Response Rate
- 194 routed over 3 days, only 8 responded
- This confirms the buyer effectiveness problem from prior analysis
- Buyers may be working outside OT or not loading VQs

### Finding #3: Response Rate IS Improving
- Tue: 2.3% → Wed: 4.8% → Thu: 5.8%
- Still critically low, but trending upward
- Need more days to confirm if sustainable

---

## Files Delivered

### SQL Queries (Tested & Working):
1. **`sales-pulse-queries-final.sql`** - All metrics queries
   - Global snapshot (yesterday, v5 approach)
   - Buyer queue (3-day rolling)
   - Daily breakdown for trends

2. **`sales-pulse-regional-alerts.sql`** - Regional breakdown & stuck lines
   - By region (USA/MEX/APAC)
   - Lines >48hrs needing attention

### Documentation:
3. **`sales-pulse-data-model-findings.md`** - Research notes
4. **`sales-pulse-preview.md`** - Email structure preview
5. **`SALES-PULSE-DAILY-SUMMARY.md`** - This file

### Automation (In Progress):
6. **`sales-pulse-daily.js`** - Node.js script (needs completion)
   - Query execution via subprocess
   - HTML email formatting
   - Nodemailer integration
   - Cron scheduling

---

## Next Steps to Complete

### Node.js Script:
- [ ] Fix query execution (use psql subprocess approach)
- [ ] Add HTML email template formatting
- [ ] Integrate nodemailer for sending
- [ ] Add error handling & logging

### Email Template:
- [ ] Port v5 HTML design
- [ ] Add Buyer Queue Effectiveness section
- [ ] Add footer insights with real percentages
- [ ] Add regional breakdown table
- [ ] Add stuck lines alert section

### Scheduling:
- [ ] Set up cron job (6am PT daily, Mon-Fri)
- [ ] Test email delivery
- [ ] Configure recipient list (Josh, Jeff, Joel, Laurel, Kris, Lavanya)

---

## Recommended Email Recipients

**Primary:**
- Josh Pucci (SVP Sales)
- Jeff Wallace (Director, USA)
- Joel Marquez (Manager, MEX)
- Laurel Kee (Manager, Singapore)
- Kris Munoz/Silvia (Manager, Philippines/China)
- Lavanya Manohar (Manager, India)

**Optional:**
- Purchasing leadership (to address buyer response issue)
- Data entry team leads (context on VQ loading)

---

## Questions for Finalization

1. **Email recipients** - Confirm the list above?
2. **Send time** - 6am PT works? (9am EST, 9pm SGT)
3. **Monday-Friday only** - Or also weekends?
4. **Stuck lines threshold** - Keep at 48hrs or adjust?
5. **Regional breakdown** - Include in daily email or separate report?

---

## Technical Notes

- **Claude Harris ID:** 1049524 (excluded from human buyer metrics)
- **Buyer Queue Request Type:** 1000001 (r_request.r_requesttype_id)
- **Business Days:** Calculated excluding Sat/Sun
- **3-Day Rolling:** Always last 3 business days (not calendar days)
- **Database:** idempiere_replica (read-only, peer auth)
