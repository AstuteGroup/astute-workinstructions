# Customer Health Scoring - Requirements Brainstorm
**Date:** 2026-06-25
**Participants:** Melissa Bojar, Claude

---

## Project Vision

Build a Sales Operations system to proactively identify at-risk customer relationships and prioritize sales efforts for maximum ROI. Focus on **markers for investigation**, not predictions — show what the data says, but acknowledge there's always a story behind the numbers.

---

## Business Context

### Core Problem
**Sales time ROI is the real metric.** Not just "who stopped buying," but:
- Are we chasing quotes that never convert? (wasting time)
- Are strategic accounts slipping through the cracks? (missing growth opportunities)
- Are relationships dying because a key contact left? (need to rebuild)

### Market Context
- Entering constrained/allocated market (2026)
- Customer behavior shifting from extreme shortage era (2020-2022)
- Gap-filling business model = inherently reactive/opportunistic
- **Forecasting doesn't work** — focus on current state & trends only

### Current State
- Super top-heavy customer base (concentration risk)
- Goal: Diversify to reduce "all eggs in one basket" risk
- Data quality issues: Sellers don't consistently load quotes into OT

---

## Key Definitions

### What is "Healthy"?
**Baseline:** Consistent weekly RFQs + Monthly orders

**But it varies by:**
- Customer segment (Mil-Aero vs. Commercial vs. Strategic)
- Customer type (Program vs. Spot/Project)
- Customer potential (High/Medium/Low ITAM)
- Market conditions (shortage vs. surplus)

### Red Flags (Warning Signs)
1. **Low conversion** — High quoting activity, few/no orders
   - General/Commercial: <10% conversion
   - Mil-Aero: <20% conversion (they're normally 50-60%)
2. **Declining trends** — RFQ, CQ, or bookings dropping
3. **Complete drop-off** — No activity (RFQs or orders) beyond threshold
4. **Artificial inflation** — Seller with 90%+ conversion (data quality issue, not real success)

### Customer Segmentation

**By Potential (ITAM — Independent Total Available Market):**
- **High potential:** Large component spend, big pie to chase
- **Medium potential:** Moderate spend
- **Low potential:** True one-offs (normal, not a problem)
- **Rule of thumb:** ITAM ≈ 10% of DTAM (Distribution Total Available Market)
- **Goal:** Capture 10% of ITAM in high-potential accounts = good

**By Customer Type:**
- **OEM** — Original Equipment Manufacturers
- **EMS** — Electronics Manufacturing Services (complex, messy ownership)
- **Brokers** — Exclude from tracking (focus on true customers only)

**By Customer Pattern:**
- **Program customers** (e.g., LAM Research):
  - Recurring shipments of same parts
  - Predictable, stable revenue
  - Going silent = BIG PROBLEM (recurring revenue lost)
- **Spot/Project customers:**
  - Different parts every order
  - Variable frequency (gaps are normal between projects)
  - Part diversity = broad relationship

**Strategic Accounts (Manual List):**
- 6 global strategic growth accounts:
  1. Eaton
  2. ABB
  3. RTX
  4. Thales
  5. Parker-Meggitt
  6. GE Healthcare
- Will expand over time (user will provide updates)

---

## Conversion Rates & Timing

### Healthy Conversion Rates by Segment

| Segment | Healthy | Red Flag Low | Red Flag High (Data Quality) |
|---------|---------|--------------|------------------------------|
| **Mil-Aero** | 50-60%+ | <20% | 90%+ |
| **Commercial/General** | 25-30%+ | <10% | 90%+ |

### Quote-to-Order Timing (CQ → SO)

| RFQ Type | Expected Close Time |
|----------|-------------------|
| **Shortage** | <7 days (will compress to hours/1 day in allocation market) |
| **PPV/Cost Savings** | Longer (approval cycles required) |
| **Mil-Aero** | 3-6 months (multiple re-quotes are normal) |
| **LTB/EOL/Obsolete** | Similar to Mil-Aero (longer cycles) |

### Mil-Aero Nuance
- **High conversion rates (50-60%) eventually**
- **BUT:** RFQ → CQ fast, CQ → SO takes 3-6 months
- Multiple re-quotes are **normal and expected**
- Don't flag as "low conversion" due to time lag

---

## Data Quality Issues

### Seller Backfill Pattern
**Problem:** Sellers don't load all quotes into OT. Common pattern:
- SO won outside system → CQ created + SO created at same time (minutes apart)
- Only entered quote because order was won
- Creates artificial 100% conversion rate

**Detection (Seller-Level, Not Deal-Level):**
- Calculate conversion per seller: `(CQs that became SOs) / (Total CQs)`
- If >90% → Flag as **"⚠️ Artificially Inflated - Incomplete Quote Loading"**
- This is a chronic seller behavior (e.g., Mexico team except Carolina)

**Solution:**
- Flag sellers with 90%+ conversion in reports
- Sales managers follow up weekly until behavior improves
- Note data quality issue when showing that seller's account conversions

---

## Regional Structure

### Regions to Track
- **USA**
- **MEX** (Mexico)
- **APAC** (Asia-Pacific)
- *EMEA is separate division (not included)*

### Region Determination
- Based on **seller's location** (not customer location, not ship-to)
- No other territory definitions currently exist
- A USA seller might service customers anywhere globally, but tagged as USA region

### Data Sources
- Unknown if region field exists in OT database (need to explore)
- **Employee roster exists:** Stored in "Lots-Shipped-Received project folder"
- Maps sales org chart (seller → region)

### Note on India Team
- Lavanya's team resigned
- Won't see activity going forward
- Should exclude from reports or flag as inactive

---

## Planned Outputs

### 1. Monthly Regional Report (Strategic/Collaborative)
**Purpose:**
- Regional visibility into RFQ, CQ, SO activity trends
- Enable cross-regional collaboration
- Leverage relationships across geographies

**Audience:** Sales managers + potentially broader team

**Focus:** Trends, patterns, opportunities for collaboration

**Sections (TBD):**
- Regional activity summary (USA, MEX, APAC)
- Top accounts by region
- Cross-regional account visibility
- Seller performance by region
- Data quality flags (sellers with 90%+ conversion)

---

### 2. Weekly Sales Manager Action List (Tactical/Urgent)
**Purpose:**
- **High-signal, low-noise**
- Only what TRULY needs attention this week
- Prioritized by ROI/urgency

**Audience:** Sales managers specifically

**Focus:** Immediate interventions

**Prioritization Logic (TBD):**
- Strategic accounts with any decline?
- High-potential accounts with red flags?
- Revenue-at-risk threshold?
- Conversion efficiency problems (low conversion, wasting time)?

**Sections (TBD):**
- Immediate action required (high-value + red flags)
- Investigate this week (declining trends, conversion issues)
- Data quality follow-ups (sellers with backfill issues)

---

## Open Questions & To Be Defined

### 1. Activity Cadence Thresholds
- When does "no RFQs" become a red flag? 30/60/90 days? Varies by segment?
- When does "no orders" trigger action? Varies by segment?
- What's "declining" vs. normal fluctuation?

### 2. "Accounts That Hold Weight" Filtering
- How do we exclude noise from manager reports?
- LTV threshold? Order count? Recent activity?
- Or refine iteratively based on manager feedback?

### 3. Weekly Action List Prioritization
- How many items? (Top 5? Top 10? All red flags?)
- Prioritize by: Revenue at risk? Strategic importance? Potential (ITAM)?

### 4. Customer Type Identification in Data
- How do we detect OEM vs. EMS vs. Broker?
- BP Group field? Name patterns? Manual research?

### 5. Unique Parts as Health Metric
- Track unique parts sold per customer?
- Declining unique parts = narrowing relationship = warning?
- Or too complex for Phase 1?

### 6. Report Delivery
- Format: Email HTML? Excel? Both?
- Recipients: Who gets monthly regional? Who gets weekly action list?
- Timing: What day/time?

---

## Next Steps

### Phase 1: Data Exploration
1. Explore database for region field (`ad_user`, `ad_org`, sales rep tables)
2. Locate employee roster in Lots-Shipped-Received folder
3. Build seller → region mapping (USA, MEX, APAC)
4. Explore customer type identification (OEM/EMS/Broker detection)
5. Analyze activity patterns (RFQ/CQ/SO cadence by customer segments)
6. Document findings in `data-exploration.md`

### Phase 2: POC Reports
1. Build draft Monthly Regional Report with reasonable assumptions
2. Build draft Weekly Manager Action List with reasonable assumptions
3. Get feedback on thresholds, prioritization, format
4. Iterate based on manager input

### Phase 3: Refine & Automate
1. Adjust thresholds based on feedback
2. Finalize report formats
3. Schedule automated delivery (weekly/monthly)
4. Build manager feedback loop for continuous improvement

---

## Key Principles

1. **Markers, not facts** — Data shows patterns; managers know the story behind them
2. **ROI focus** — Prioritize sales time on high-potential, convertible opportunities
3. **No forecasting** — Current state & trends only, adapt to market shifts
4. **Context-aware** — Different customer types need different thresholds
5. **Iterative refinement** — Build, get feedback, adjust, repeat
6. **Data quality transparency** — Flag known issues (seller backfills), don't hide them
7. **Actionable insights** — Every flag should suggest a manager action

---

## Success Metrics (Future)

- Sales managers use the reports weekly/monthly (adoption)
- At-risk accounts identified and saved (retention improvement)
- Sales time shifted from low-conversion to high-potential accounts (efficiency)
- Customer base diversification (reduced concentration risk)
- Data quality improvement (fewer sellers with 90%+ conversion over time)
