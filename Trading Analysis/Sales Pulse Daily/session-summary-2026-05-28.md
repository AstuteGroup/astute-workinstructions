# Session Summary — Sales Pulse Daily Design
**Date:** 2026-05-28 (Thursday)
**Duration:** ~2 hours
**Status:** Design Complete ✅ | Ready for Implementation

---

## What We Accomplished Today

### 1. **Defined the Core Problem**
- Sales leadership needs daily visibility into pre-sales funnel (RFQ → VQ → CQ → SO)
- Current systems (Power BI) focused on post-sales; pre-sales visibility is ad-hoc
- Known challenges:
  - Not all RFQs/VQs/CQs enter the system (off-system work)
  - Close rates skewed due to incomplete data capture
  - Activities/phone logs don't capture true customer engagement
  - Need to work with what IS captured as leading indicators

### 2. **Identified Key Stakeholders & Org Structure**
- **Recipients:** Josh Pucci (VP Sales), Jeff Wallace (USA Director), Joel Marquez (MEX Manager), Laurel Kee (APAC Manager), Kris Munoz aka Silvia (APAC Manager), Lavanya Manohar (APAC Manager)
- **29 Active Sellers:**
  - USA: 9 (excluding Melissa Bojar - Sales Productivity Analyst)
  - MEX: 9
  - APAC: 11 (Laurel 3, Kris 5, Lavanya 3)
  - Note: Edyna Lee (Korea) no longer with company
- **Per-Seller Weekly KPIs:** 20 RFQ lines, 15 CQ lines, 4.5 CQ sold (30% close rate)

### 3. **Designed 5 Key Daily Questions**
1. **Are opportunities flowing in?** → RFQ volume, sourcing conversion
2. **Are we sourcing fast enough?** → VQ response timing (3-stage breakdown)
3. **Are we converting to quotes?** → CQ lines entered, sold
4. **What did we win?** → SO lines booked, $ value
5. **What needs attention?** → Aging quotes, stuck sourcing, new opportunities

### 4. **Iterated Through 5 Design Versions**

**v1 → v2:** Added detailed metrics (VQ timing, CQ sold vs SO, customer counts, system discipline)

**v2 → v3:**
- Switched to 5-day rolling average (vs week-over-week)
- Added APAC drill-down (Laurel/Kris/Lavanya)
- Expanded "Needs Attention" to prioritize by value + opportunity
- Added Market Pulse section (top 3 trends)

**v3 → v4:**
- Reordered sections (Yesterday's Wins before Needs Attention)
- Clarified time frames for Needs Attention
- Added RFQ type context to aging quotes

**v4 → v5 (FINAL):**
- **Simplified time frame logic:** Show what was **created in last 5 business days**, then it falls off
- Key insight: "A Shortage quote created 3 days ago has 7 days left to close (actionable). A Shortage quote created 18 days ago is dead (not shown)."
- Added detailed Sourcing Stuck info: MPN, MFR, QTY, Customer, Seller, Buyer, Routed date
- Finalized all specifications

### 5. **Locked Down Critical Design Decisions**

**Time Frames:**
- Global Snapshot: Yesterday vs 5-day rolling avg
- Needs Attention: Created in last 5 business days
- Pricing Benchmarks: Last 30 days, persist 5 days after appearance
- Sourcing Stuck: Routed 3+ days ago

**Prioritization:**
- High-Value Quotes: >$10K, top 5
- High-Probability Customers: 30-50% win rate, top 5
- New Customers: First-time RFQs, top 5
- Market Pulse: Top 3 trends

**VQ Timing (3-stage breakdown):**
1. Buyer Queue Time (routed → picked)
2. Buyer Response Time (picked → first response)
3. Total Response Time (end-to-end)

**Dual Quote Age Metrics:**
- Short-cycle: Shortage/PPV/Other (10-30d auto-close)
- Long-cycle: Mil-Aero/EOL/Obsolete/LTB (64d auto-close)

**System Discipline:**
- CQs entered within 2hrs of marking 'sold'
- Retroactive CQ entry rate

### 6. **Created Deliverables**
- ✅ HTML email template (v5) with sample data
- ✅ Comprehensive README with all specifications
- ✅ Design notes documenting evolution
- ✅ This session summary

---

## Key Insights & Decisions

### **"Fresh & Actionable" Principle**
The breakthrough was simplifying time frames to "created in last 5 business days":
- Keeps daily pulse focused on what's actionable NOW
- Prevents stale backlog from cluttering the report
- Aligns with natural close windows (Shortage = 10d, so 5d window shows half the lifecycle)

### **Acknowledge Data Gaps, Work With What's Captured**
- Not all activity enters OT → focus on trends and relative performance
- System discipline metrics surface the gap (% timely CQ entry, % retroactive)
- Use captured data as leading indicators, not absolute truth

### **Context Over Raw Numbers**
- Show RFQ type so managers can assess if aging is appropriate
- Show customer win rate for high-probability accounts
- Show days left in close window for quotes
- Show seller/buyer names for actionable escalation

### **Prioritization by Value & Opportunity**
Not all alerts are equal:
- $72K in high-value quotes deserves more attention than $5K
- 45% win rate customer deserves faster follow-up than 10% win rate
- New customer first impression matters more than repeat low-performer

---

## What We Learned About the Business

### **Seller Behavior Patterns**
- Many sellers work off-system (quotes, follow-ups not logged)
- Retroactive CQ entry is common (47% entered after sold)
- Only 53% of CQs entered within 2hrs of marking sold (down from 62%)
- This affects data quality but doesn't invalidate trend analysis

### **Regional Dynamics**
- USA leading on velocity (6.1d avg quote age vs 6.8d global)
- MEX sometimes below pace (need to investigate: lighter load or bottleneck?)
- APAC benefits from bulk VQ upload (data entry + Claude Harris AI)

### **Sourcing Workflow**
- Sellers route RFQs to buyer queue (specific buyer or pool)
- Buyer picks up, requests sources, waits for VQ or no-bid feedback
- 3-stage timing reveals where bottlenecks occur (queue vs actual sourcing)

### **Close Window Expectations**
- Shortage: 10 business days (fast turnaround expected)
- PPV/Cost Saving: 15 days
- Standard: 30 days
- Mil-Aero/EOL/Obsolete/LTB: 64 days (longer sales cycle)

---

## Questions Still to Resolve (Before SQL Implementation)

### 1. **Data Model Mappings**
Need to identify exact fields for:
- [ ] VQ timing: How is "routed to buyer queue" tracked? Picked by buyer?
- [ ] CQ "sold" status: Checkbox field name? Timestamp when marked sold?
- [ ] RFQ type: Field name? Valid values?
- [ ] Buyer assignment: How to detect "Pool" vs specific buyer?
- [ ] Customer win rate: Historical scope (all-time? 90 days?)

**Action:** Read `shared/data-model.md` before starting SQL queries

### 2. **Threshold Tuning**
Current thresholds are assumptions, need validation with actual data:
- Is 5-day rolling avg the right window? (vs 7-day or 10-day?)
- Is 30-50% the right "high-probability" win rate range?
- Is >$10K the right "high-value" threshold?
- Is 3 days the right "sourcing stuck" threshold?

**Action:** Run initial queries, review distributions, adjust thresholds

### 3. **Email Delivery Details**
- [ ] Who should be in To: vs CC: vs BCC:?
- [ ] Plain text fallback needed? (or HTML-only?)
- [ ] Subject line format confirmed?
- [ ] Reply-to address (analytics team or Melissa directly)?

---

## Next Session Agenda (2026-05-29 or later)

### **Phase 1: Data Model Deep Dive (30-60 min)**
1. Read `shared/data-model.md` thoroughly
2. Map each metric to specific tables/fields/joins
3. Document any gaps or uncertainties
4. Create field reference table for SQL implementation

### **Phase 2: Build Sample Queries (1-2 hours)**
Start with simpler metrics to validate approach:
1. Global Snapshot - Pipeline Input (RFQ lines entered, with customers)
2. Global Snapshot - Wins (SO lines booked, $ value)
3. By Region - basic breakdown
4. Test queries against actual data, review results

### **Phase 3: Build Complex Queries (2-3 hours)**
Tackle the harder sections:
1. VQ timing (3-stage breakdown) - requires understanding workflow fields
2. Needs Attention - High-Value Quotes (prioritized, capped at 5)
3. Needs Attention - Sourcing Stuck (detailed: MPN/MFR/QTY/Customer/Seller/Buyer)
4. Customer win rate calculation
5. Market Pulse trends

### **Phase 4: Create Mart Tables (1-2 hours)**
If query performance is slow or we want historical tracking:
1. Design mart table schemas
2. Create mart tables in `mart` schema
3. Write daily refresh logic
4. Schedule cron job for 5:45am PT refresh

### **Phase 5: Email Automation (1-2 hours)**
1. Node.js script to run queries and format HTML
2. Test email delivery (to test recipients first)
3. Schedule cron job for 6:00am PT daily (Mon-Fri)
4. Add error handling and logging

### **Phase 6: Iterate & Tune (ongoing)**
After first live send:
1. Gather feedback from stakeholders
2. Tune thresholds based on actual data distributions
3. Add/remove metrics as needed
4. Refine formatting for readability

---

## Success Criteria

**The Sales Pulse Daily will be successful if:**

1. **Adoption:** Managers read it daily (track email open rates)
2. **Actionability:** Leads to specific actions (follow-ups, escalations, closed deals)
3. **Accuracy:** Trends match managers' intuition (validates data quality)
4. **Efficiency:** Takes <60 seconds to scan (design is tight)
5. **Trust:** Becomes a relied-upon daily ritual (managers ask for it if missing)

**Early signals to watch:**
- Do managers reply with questions about specific items?
- Do they forward it to their teams?
- Do they reference it in meetings ("As we saw in today's pulse...")?
- Do they ask for additional metrics or drill-downs?

---

## Lessons Learned (Design Process)

### **What Worked Well**
1. **Iterative refinement:** v1 → v5 allowed us to evolve clarity without starting over
2. **User-centric focus:** Constantly asking "Would a manager act on this?"
3. **Concrete examples:** Mock data in samples helped visualize final product
4. **Simplification:** "Created in last 5 days" is clearer than "entered aging window"
5. **Context over numbers:** RFQ type, win rates, days left in window add meaning

### **What We'd Do Differently**
1. **Start with org structure earlier:** Knowing seller counts upfront would've sped up target calculations
2. **Clarify field names sooner:** Would've caught VQ timing field questions earlier
3. **Lock format before iterating metrics:** We refined both simultaneously, which caused some rework

### **Design Anti-Patterns We Avoided**
- ❌ Too many metrics (cognitive overload)
- ❌ Stale backlog shown daily (old quotes that can't be saved)
- ❌ No prioritization (everything looks equally urgent)
- ❌ Raw numbers without context (what does "8.2 days" mean without knowing expected close time?)
- ❌ No regional breakdown (managers can't act on global-only data)

---

## Files Created Today

All saved in `/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/`:

1. **README.md** — Complete project overview, design specs, next steps
2. **sales-pulse-daily-sample-v5.html** — Final HTML email template (reference implementation)
3. **sales-pulse-design-notes-v2.md** — Design evolution and detailed decisions
4. **session-summary-2026-05-28.md** — This document

Also in `/home/melissa.bojar/workspace/` (working files):
- sales-pulse-daily-sample-v1 through v4 (iteration history)
- sales-pulse-design-notes-v1.md (earlier version)

---

## Closing Thoughts

This was a highly productive design session. We went from "we need daily sales visibility" to a complete, actionable specification ready for implementation.

**The breakthrough:** Simplifying time frames to "created in last 5 business days" — this single decision made the entire report more actionable and aligned with natural sales cycles.

**The challenge ahead:** Mapping the design to actual OT data model fields. Some fields (VQ timing, buyer assignment) may not be cleanly captured, requiring creative SQL or acceptance of approximations.

**Confidence level:** High (8/10) that this design will deliver value. The format is tight, metrics are relevant, and prioritization logic is sound. Main risk is data availability/quality in OT.

**Ready to proceed:** Yes. Next session can jump straight into `shared/data-model.md` review and SQL query development.

---

**Status:** ✅ Design Complete | ⏭️ Ready for SQL Implementation

*Session completed 2026-05-28 at ~9:50pm PT*
