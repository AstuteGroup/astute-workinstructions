# Sales Pulse Daily — Sales VP Action-First Design

**Date:** June 2, 2026
**Status:** Mockup Ready for VP Feedback
**Target User:** Josh Pucci (VP Sales)
**Created By:** Melissa Bojar (Sales Productivity Analyst)

---

## Executive Summary

We've redesigned the Sales Pulse Daily report with an **"action-first" layout** optimized for VP-level decision-making. The new design answers the critical question: **"What can I work on TODAY to move the needle?"**

**Current Status:**
- ✅ Comprehensive report built (all 6 sections, functional)
- ✅ Action-first mockup created (new layout, priority-coded)
- ⏸️ Awaiting VP feedback on priority classifications
- ⏸️ Production implementation pending approval

---

## Problem Statement

### Original Design Issue
The comprehensive report (built May 29-June 1) provides complete visibility but requires **too much cognitive load** to extract actionable insights:

- **All sections treated equally** (no priority hierarchy)
- **Data-first presentation** (numbers before actions)
- **No visual hierarchy** (tables everywhere)
- **Critical items buried** in Section 4 subsections
- **Requires 3-5 minutes** to find "what matters today"

### VP Need Identified (June 2)
> "Is there a better format or layout for better digestion of this information — to ultimately answer what can I work on today to move the needle?"

**Target audience:** VP Sales managing 5 regional managers across 3 regions (USA, MEX, APAC with 3 subregions)

---

## Proposed Solution: Action-First Design

### Core Philosophy
**Prioritize decisions over data** — Put the "so what?" before the "what happened?"

### Key Design Principles

1. **30-Second Scannable Executive Brief**
   - Red (Urgent) → Yellow (Monitor) → Green (On Track)
   - Action verbs ("Call Joel", "Escalate", "Confirm")
   - Owner names for accountability
   - Appears FIRST (before all data)

2. **Visual Hierarchy Over Tables**
   - Progress bars replace percentage tables
   - Status badges replace mental math ("Crisis" vs "Strong")
   - Cards with big numbers replace verbose metrics
   - Color coding guides the eye

3. **Collapsible Details**
   - Top 1-3 items expanded, rest collapsed
   - Insight boxes explain "so what?"
   - Full data available but not blocking urgent items

4. **Mobile-Friendly**
   - Executive Brief fits one screen (no scrolling for red flags)
   - Large touch targets for expand/collapse
   - Responsive grid layout

---

## Mockup Location

**File:** `output/sales-pulse-MOCKUP-action-first.html`

**How to Review:**
1. Open the HTML file in a browser
2. Focus on the yellow **Executive Brief** section at top
3. Click collapsible sections to expand/collapse details
4. Compare against the comprehensive version (`sales-pulse-comprehensive-2026-06-02.html`)

---

## What Changed: Before/After Comparison

### NEW: Section 0 — Executive Brief (The Game Changer)

**Yellow-highlighted priority box** appearing FIRST, before all other sections:

```
🚨 CRITICAL ACTIONS TODAY

🔴 URGENT (Do First — Next 2 Hours)
1. MEX Region Crisis — Call Joel Marquez
   • 173 RFQs → only 3 CQs (2% conversion vs 20% expected)
   • Only 2 sold WTD vs 41 target (95% behind pace)
   → Root cause: Sourcing bottleneck or quoting delay?

2. New Customer Risk — Etron Technology (MEX - Alejandro)
   • 162 RFQ lines waiting 7 days with NO quotes
   • First-time customer — risk losing if not quoted today
   → Escalate to sourcing team immediately

3. Revenue Drop Investigation
   • $92K yesterday vs $2.6M avg (↓96%)
   → Review last week's data for anomalies

🟡 MONITOR (Check Before EOD)
• High-Value Follow-Up: GE Aerospace $699K quote (Jake M)
• Texas Instruments Pattern: 259 RFQs, 0% conversion
• Week-to-Date Pace: MEX behind, APAC needs strong Wed-Fri

🟢 ON TRACK (FYI Only)
• Pipeline Input: +76% RFQ inflow vs 5-day avg ✅
• System Discipline: 0% retroactive CQ entries ✅
• USA Region: All metrics trending positive ✅
```

**Why This Works:**
- VP sees **critical actions in 30 seconds**
- Color-coded priorities (no mental sorting needed)
- Owner names enable immediate delegation
- Action verbs ("Call", "Escalate", "Confirm") make it executable

---

### Section 1: Yesterday's Scorecard (Redesigned)

**Before:** Verbose table with 13 metrics + comparisons
**After:** Visual 2x2 grid with big numbers + trend indicators

```
┌─────────────────────┬─────────────────────┐
│ Pipeline Input      │ Quoting Activity    │
│ 565 RFQs            │ 30 CQs              │
│ ↑ 76% vs 5-day ✅   │ ↓ 16% vs 5-day ⚠️   │
├─────────────────────┼─────────────────────┤
│ Wins                │ System Discipline   │
│ $92K                │ 19% on-time         │
│ ↓ 96% vs 5-day 🚨   │ ↓ 8pts vs 5-day ⚠️  │
└─────────────────────┴─────────────────────┘

Quote Aging:
Short-cycle: 9.6d ✅ (↓23% — faster close)
Long-cycle: 32.6d ⚠️ (↑8% — aging)
```

**Key Changes:**
- **Visual cards** instead of metric rows
- **Icons for trends** (↑↓✅⚠️🚨)
- **Annotations explain context** ("faster close", "aging")
- **Scannable in 10 seconds**

---

### Section 2: Regional Performance (Redesigned)

**Before:** Table with 8 columns of numbers
**After:** Table with **Status column** + insight boxes

```
Region      RFQs  Sourced  CQs  Sold  SOs  Status
────────────────────────────────────────────────
USA (8)      41    49% ✅   17    8   18   🟢 Strong
MEX (8)     173    36% ⚠️    3    0    1   🔴 Crisis
APAC (12)    10    40% ✅    4    4    2   🟢 Solid

🔴 MEX Red Flag: 173 RFQs but only 3 CQs (2% conversion)
   → Sourcing bottleneck? Quoting delay? Needs investigation

🟢 USA Highlight: 49% sourced, 18 SOs (strong execution)
```

**Key Changes:**
- **Status badges** (Strong/Solid/Crisis) replace mental math
- **Insight boxes** explain outliers (no table reading needed)
- **Subregions collapsed** (expandable on click)
- **Manager names** for quick escalation

---

### Section 3: Needs Attention (Redesigned)

**Before:** 5 equal subsections (High-Value, High-Probability, New Customers, Pricing Benchmarks, Sourcing Stuck)
**After:** Priority-coded structure (Priority 1 > 2 > 3 > FYI)

```
Priority 1: High-Value Pipeline ($2.5M)
────────────────────────────────────────
1. GE Aerospace — $699K (Shortage, 1d old) — Jake M
   → 41.7% win rate customer, 9 days left in window
2. MKS Instruments — $695K (EOL, 6d old) — Josh S
[+3 more] (click to expand)

Priority 2: New Customer Risk (168 RFQ lines)
────────────────────────────────────────
🚨 Etron Technology — 162 lines, 7d old — Alejandro P
   → First-time customer, needs quotes TODAY
[+4 more] (click to expand)

Priority 3: High-Probability Wins ($778K)
────────────────────────────────────────
• Eastman Kodak — $2K (50% win rate) — Aaron M
[+4 more] (click to expand)

FYI: Pricing Benchmarks (monitor, no action)
────────────────────────────────────────
• Unqualified Broker — 223 lines, 0% win
• RTX — 36 lines, 0% win
```

**Key Changes:**
- **Explicit priority levels** (Priority 1/2/3, FYI)
- **Top 1-2 items expanded**, rest collapsed
- **Red flags highlighted** (Etron Technology)
- **Action context** ("needs quotes TODAY")

---

### Section 4: Week-to-Date Pace (Redesigned)

**Before:** Table with 5 columns of numbers
**After:** Visual progress bars with status indicators

```
USA (Jeff Wallace, 8 sellers)
RFQs:  [▓▓▓░░░░░░░] 48/180  27% 🟢 Ahead of pace
CQs:   [▓▓▓░░░░░░░] 42/135  31% 🟢 Ahead of pace
Sold:  [▓▓▓▓▓▓▓░░░] 30/41   73% 🟢 On track
$:     $920K

MEX (Joel Marquez, 8 sellers)
RFQs:  [▓▓▓▓▓▓▓▓▓▓] 177/180 98% 🟢 On track
CQs:   [▓░░░░░░░░░] 5/135    4% 🔴 CRITICAL GAP
Sold:  [░░░░░░░░░░] 2/41     5% 🔴 CRITICAL GAP
$:     $725

🔴 MEX needs 93 CQs + 39 sold in 4 days (impossible pace)
```

**Key Changes:**
- **Visual progress bars** (easier than mental math)
- **Color-coded bars** (green/yellow/red)
- **Status text** (Ahead/On track/Behind/Critical)
- **Manager accountability** (names in header)

---

### Section 5: Yesterday's Wins (Redesigned)

**Before:** All 7 wins listed with full details
**After:** Top 3 with medals, rest collapsed

```
🥇 GE Aerospace — $37K (8 lines) — USA - Jake Mcaloose
🥈 ABB — $27K (1 line) — APAC - Laurel Kee
   High-value single line (watch for follow-on opportunities)
🥉 Blue Origin — $10K (8 lines) — USA - James Diaz

[View All 7 Wins (+$28K More)] (click to expand)
```

**Key Changes:**
- **Medal icons** (visual hierarchy)
- **Top 3 only** (rest collapsed)
- **Annotations** ("High-value single line")
- **Quick morale check** (celebrate wins without drowning in detail)

---

### Section 6: Market Pulse (Redesigned)

**Before:** Two 10-row tables (Trending Manufacturers, Trending Parts)
**After:** Insight boxes with "So What?" commentary

```
🔥 Hot Manufacturers (Demand Spikes)

1. Texas Instruments — 259 RFQs from 19 customers
   → Concentrated demand (13.6 RFQs/customer)
   → 0% conversion ⚠️ Pricing issue or benchmark activity?

2. Micron Technology — 87 RFQs from 16 customers
   → 1% conversion (4 quoted, 1 sold)

💎 High-Conversion Parts (Close These!)

• DCR1-AM (Sierra Safety) — 8 RFQs → 8 sold (100% win!) ⭐
  → Perfect conversion — what's working here?

• FT2232HL-REEL (FTDI) — 22 RFQs, 17 quoted (77%), 0 sold
  → Opportunity: High quote rate but not closing. Why?

[View Full Tables] (click to expand)
```

**Key Changes:**
- **Insights not data** ("Concentrated demand", "What's working here?")
- **Actionable questions** ("Why not closing?")
- **Full tables collapsed** (available but not blocking)

---

## VP Feedback Needed

### Critical Decision Points

#### 1. **Executive Brief Priority Classifications**

**Current classifications (in mockup):**

**🔴 URGENT (Do First — Next 2 Hours):**
1. MEX Region Crisis (173 RFQs → 3 CQs)
2. New Customer Risk (Etron Technology, 162 lines, 7 days old)
3. Revenue Drop Investigation ($92K vs $2.6M avg)

**🟡 MONITOR (Check Before EOD):**
- High-Value Follow-Up (GE $699K quote)
- Texas Instruments Pattern (259 RFQs, 0% conversion)
- Week-to-Date Pace

**🟢 ON TRACK (FYI Only):**
- Pipeline Input (+76% RFQ inflow)
- System Discipline (0% retroactive)
- USA Region (all metrics positive)

**QUESTIONS FOR VP:**
- [ ] Do these priority levels match your mental model?
- [ ] Should "Revenue Drop Investigation" be Red or Yellow?
- [ ] Should "Texas Instruments Pattern" trigger urgent action or just monitoring?
- [ ] Are there other patterns that should auto-escalate to Red?

---

#### 2. **Thresholds for Auto-Escalation**

**Current thresholds (implied in mockup):**

| Metric | Red (Urgent) | Yellow (Monitor) | Green (FYI) |
|--------|--------------|------------------|-------------|
| Regional CQ conversion | <5% | 5-15% | >15% |
| New customer quote delay | >7 days | 5-7 days | <5 days |
| High-value quote age | >5 days (Shortage) | 3-5 days | <3 days |
| WTD pace vs target | <10% | 10-20% | >20% |
| Revenue drop | >90% | 50-90% | <50% |

**QUESTIONS FOR VP:**
- [ ] Do these thresholds match your escalation criteria?
- [ ] Should thresholds differ by region (e.g., MEX vs USA)?
- [ ] Should certain customers always escalate (e.g., GE, RTX)?
- [ ] Should RFQ type affect urgency (Shortage = red, EOL = yellow)?

---

#### 3. **Manager Accountability in Executive Brief**

**Current approach:** Include manager names in urgent items (e.g., "Call Joel Marquez")

**QUESTIONS FOR VP:**
- [ ] Is naming managers in the brief helpful or too direct?
- [ ] Should urgent items route to managers first (private) vs VP (public)?
- [ ] Should there be a "Manager View" vs "VP View" of the same report?

---

#### 4. **Cadence & Distribution**

**Current plan:** Daily email at 6:00 AM EST (Mon-Fri)

**QUESTIONS FOR VP:**
- [ ] Is 6:00 AM the right time for your workflow?
- [ ] Should managers receive the same report or a filtered view?
- [ ] Should there be a Friday "weekly summary" variant?
- [ ] Should weekend activity (Sat-Sun) roll into Monday's report?

---

## Technical Implementation

### Current Status

**✅ Comprehensive Report (Functional):**
- File: `sales-pulse-comprehensive.js`
- All 6 sections built
- Customers column added to Market Pulse (June 2)
- Data tested with June 1-2 actuals

**✅ Action-First Mockup (Static HTML):**
- File: `output/sales-pulse-MOCKUP-action-first.html`
- Executive Brief section manually coded
- Collapsible sections functional
- Progress bars styled
- Ready for VP review

**⏸️ Production Implementation (Pending Approval):**
- Requires VP feedback on priorities
- Estimated 3-4 hours to build
- Will generate Executive Brief dynamically from data
- Will apply threshold-based auto-escalation

---

### What Needs to Be Built

If VP approves the action-first design:

1. **Executive Brief Generator**
   - Read all section data
   - Apply thresholds to classify Red/Yellow/Green
   - Generate priority-sorted action items
   - Auto-detect patterns (regional gaps, new customer delays, etc.)

2. **Dynamic Collapsible Sections**
   - JavaScript to expand/collapse on click
   - Default states (Red expanded, Yellow collapsed, Green collapsed)

3. **Progress Bar Generator**
   - Calculate % complete vs weekly targets
   - Apply color coding (green >20%, yellow 10-20%, red <10%)
   - Generate status text

4. **Insight Box Generator**
   - Auto-detect outliers (e.g., MEX 2% conversion)
   - Generate "So What?" commentary
   - Flag anomalies for investigation

5. **Mobile-Responsive Styling**
   - Ensure Executive Brief fits one mobile screen
   - Large touch targets for collapsible sections

---

## Next Steps

### Immediate (This Week)

1. **VP Review Session**
   - Open mockup file in browser
   - Walk through Executive Brief structure
   - Discuss priority classifications
   - Confirm threshold values
   - Decide on manager accountability approach

2. **Collect VP Feedback**
   - Document threshold adjustments
   - Note priority classification changes
   - Capture additional "always red" patterns
   - Confirm cadence & distribution preferences

3. **Iterate Mockup** (if needed)
   - Adjust priorities based on feedback
   - Refine thresholds
   - Add/remove sections as requested

### Week of June 9 (After VP Approval)

4. **Build Production Version**
   - Implement Executive Brief generator
   - Add dynamic thresholds
   - Build collapsible section logic
   - Test with historical data (May 25-29 week)

5. **Parallel Testing**
   - Run comprehensive + action-first side-by-side for 5 days
   - Collect VP feedback on accuracy
   - Refine auto-escalation logic

6. **Go Live**
   - Replace comprehensive with action-first
   - Schedule daily 6:00 AM delivery
   - Set up cron job (if not already automated)

---

## Design Rationale

### Why Action-First Works for VP Role

**VP's Primary Job:**
- Spot where managers need support
- Escalate blockers (sourcing, pricing, new customers)
- Reallocate resources (MEX crisis → USA help?)
- Celebrate wins (morale + pattern recognition)

**Action-First Design Supports This:**
- **30-second Executive Brief** = Immediate situational awareness
- **Status badges** (Strong/Crisis) = Visual manager performance
- **Progress bars** = Quick weekly pace check (no math needed)
- **Collapsible details** = Deep dive only when needed
- **Insight boxes** = "So What?" without analysis paralysis

**Comprehensive Design Limitation:**
- Required 3-5 minutes to extract same insights
- No priority hierarchy (all sections equal weight)
- Critical items buried in Section 4 subsections
- Mental math needed to compare regions

---

### Why Color Coding Matters

**Red/Yellow/Green Priority Levels:**

**🔴 Red (Urgent)** = Action required in next 2 hours
- MEX crisis (173 RFQs → 3 CQs)
- New customer about to be lost (7+ days, no quote)
- Major pipeline at risk (>$500K quote aging)

**🟡 Yellow (Monitor)** = Check before end of day
- High-value quotes (follow-up confirmation)
- Pricing patterns (spot-check competitive position)
- Weekly pace trends (flag if slipping further)

**🟢 Green (On Track)** = FYI only, no action needed
- Positive trends (pipeline growth, discipline improving)
- Regions performing well (USA strong execution)
- Normal operations (sourcing velocity acceptable)

**Why This Works:**
- **Reduces decision fatigue** (don't evaluate every item's urgency)
- **Enables delegation** (Red = VP action, Yellow = manager action, Green = celebrate)
- **Aligns with mental model** (matches how VPs already triage)

---

## Success Metrics

### How We'll Know This Design Works

**Quantitative (Track After 30 Days):**
1. **Time to Action** — VP can identify top 3 priorities in <30 seconds
2. **False Positives** — Red flags that weren't actually urgent (<10%)
3. **Missed Escalations** — Urgent items that stayed Yellow/Green (0 target)
4. **Manager Engagement** — Response time to urgent items (track via follow-up emails)

**Qualitative (Ask VP After 2 Weeks):**
1. "Does the Executive Brief match what you would have flagged yourself?"
2. "Are the Red/Yellow/Green classifications accurate?"
3. "Do you still need to read the full comprehensive report, or is action-first sufficient?"
4. "What patterns are we missing that should auto-escalate?"

---

## Open Questions

### For VP Feedback Session

**Priority Classification:**
1. Should revenue drops >50% always be Red, or only >90%?
2. Should new customer delays be Red at 5 days or 7 days?
3. Should high-value quotes ($500K+) always be Yellow, or only Red if aging >X days?
4. Should certain customers (GE, RTX, Applied Materials) have different thresholds?

**Threshold Tuning:**
5. Is <5% regional CQ conversion the right Red threshold, or should it be <10%?
6. Should WTD pace <10% of target be Red, or <20%?
7. Should Texas Instruments (259 RFQs, 0% conversion) be Red or Yellow?

**Manager Accountability:**
8. Should manager names appear in Red flags, or is that too confrontational?
9. Should managers receive a filtered version (only their region's flags)?
10. Should there be a "Manager View" vs "VP View" toggle?

**Cadence & Format:**
11. Is daily the right frequency, or should we add a Friday "weekly rollup"?
12. Should the comprehensive version still be available, or fully replace it?
13. Should mobile optimization be prioritized (do you check on phone)?

---

## Appendix: Sample Data Context

### June 2, 2026 Snapshot (Used in Mockup)

**Global Metrics:**
- RFQs: 565 lines (↑76% vs 5-day avg of 320)
- CQs: 30 lines (↓16% vs 5-day avg of 35)
- Sold: 26 lines (↑30% vs 5-day avg of 20)
- Revenue: $92K (↓96% vs 5-day avg of $2.6M) ← **Anomaly**

**Regional Breakdown:**
- USA: 41 RFQs, 17 CQs, 8 sold (strong)
- MEX: 173 RFQs, 3 CQs, 0 sold (crisis)
- APAC: 10 RFQs, 4 CQs, 4 sold (solid)

**Week-to-Date (Day 1 of 5):**
- USA: 48 RFQs, 42 CQs, 30 sold (27-31-73% of weekly targets)
- MEX: 177 RFQs, 5 CQs, 2 sold (98-4-5% of weekly targets) ← **Critical gap**
- APAC: 66 RFQs, 11 CQs, 11 sold (30-7-22% of weekly targets)

**Needs Attention:**
- High-Value: $2.5M pipeline (GE $699K, MKS $695K, GE Healthcare $562K, RTX $253K, Parker $242K)
- New Customers: Etron Technology (162 lines, 7 days old, no quotes)
- Pricing Benchmarks: Unqualified Broker (223 lines, 0% win), RTX (36 lines, 0% win)

**Market Pulse:**
- Hot MFRs: Texas Instruments (259 RFQs, 19 customers, 0% conversion), Micron (87 RFQs, 16 customers)
- Hot Parts: FT2232HL-REEL (22 RFQs, 77% quoted, 0% sold), DCR1-AM (8 RFQs, 100% sold)

---

## Document History

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-06-02 | 1.0 | Initial design review summary | Melissa Bojar |

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholder:** Josh Pucci (VP Sales)
**File Location:** `Trading Analysis/Sales Pulse Daily/SALES-PULSE-SALES-VP-DESIGN.md`
**Mockup Location:** `Trading Analysis/Sales Pulse Daily/output/sales-pulse-MOCKUP-action-first.html`

---

*Ready for VP review session — awaiting feedback on priority classifications and thresholds.*
