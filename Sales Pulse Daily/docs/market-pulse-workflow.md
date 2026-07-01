# Market Pulse Weekly — Standalone Market Intelligence Report

**Status:** 🚧 Under Development (Foundation Complete)
**Created:** 2026-06-11
**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholder:** Josh Pucci (VP Sales)

---

## Overview

Weekly market intelligence report providing 30-day rolling window analysis of:
- Market temperature and constraint signals
- Trending manufacturers and parts
- Allocation risk indicators
- Regional demand patterns
- Supply chain stress signals

**Delivery:** HTML email (weekly schedule TBD)
**Recipients:** Sales leadership (Josh, regional managers)

**Current Format:** Option A Dashboard (as of 2026-06-29)
**Active Script:** `market-pulse-option-a.js`

---

## External Market Research (REQUIRED BEFORE EACH REPORT)

**Critical:** Market intelligence must be **current** - this report keeps our finger on the market pulse. Do fresh research for each week's report, **not before**.

### Research Process

**Timing:** Complete this as part of report generation, typically Thursday for the current week.

**Step 1: Search for Latest Articles (Past 7-14 Days)**

Search on these recommended sources for the most current articles:

**Primary Sources:**
- **Evertiq** (https://evertiq.com/) - European electronics manufacturing news, component shortages, supply chain
- **Sourceability** - Market intelligence, lead time trackers, allocation alerts
- **FindChips** (https://blog.findchips.com/) - Real-time inventory data, pricing trends
- **Tom's Hardware** - Consumer/enterprise memory market coverage
- **Avnet** - Franchise distributor reports, component lifecycle

**Additional Sources:**
- **773 GROUP** - Component market analysis
- **EE News Europe** - European electronics industry news
- **Apex Component** - Supply chain intelligence
- **J2 Sourcing** - Component shortage updates
- **Texas Instruments** - Logic IC inventory and availability

**Search Topics:**
- Memory shortages (HBM, DRAM, NAND)
- MLCC constraints and allocation
- MCU availability (STM32, Renesas, etc.)
- Logic IC supply (TI, commodity parts)
- Power Management trends
- Any emerging component shortages

**Step 2: Update External Data Sources Section**

Organize articles by constraint category:
- 🔴 Memory (DRAM/NAND/HBM)
- 🔴 MLCCs (Passives)
- 🔴 MCUs (STM32, Renesas)
- 🟢 Logic ICs (Commodity)
- 🟡 Power Management

For each article:
- Include publication date (e.g., "Jun 29, 2026" or "Q2 2026")
- Verify link works
- Write concise description of what it covers

**Step 3: Replace Outdated Sources**

- If an article from the previous week is still the latest available, keep it
- If there's a newer article on the same topic, replace it
- Prioritize articles dated within the past 7-14 days

**Step 4: Verify Coverage**

Ensure each constraint category mentioned in the report has at least 1-2 source links explaining why it's allocated/constrained/normal.

---

## What Makes This Different from Sales Pulse?

| Sales Pulse Daily/Weekly | Market Pulse Weekly |
|--------------------------|---------------------|
| Sales funnel metrics (RFQ→CQ→SO) | Market intelligence signals |
| Seller/team performance | Manufacturer/part trends |
| Yesterday/this week vs targets | 30-day rolling window |
| Tactical: "What needs attention today?" | Strategic: "What's coming in 2-4 weeks?" |
| Internal operations focus | External market focus |

**Key Insight:** Market Pulse is a **leading indicator** of allocation/constraint **before** manufacturers announce, giving sales teams 2-4 weeks advance notice.

---

## Report Sections

### 1. Temperature Gauge
Overall market status with constraint signal counts:
- Status indicator (Normal 🟢 / Heating Up 🟡 / Constrained 🔴)
- Active signal count
- Signal grid: Conversion Drop, Velocity Spike, Multi-Customer Parts, APAC Concentration, Response Time Increase

### 2. Constraint Indicators (Early Warning Signals)
- **Multi-Customer Parts (5+ customers)** — When same part requested by 5+ distinct customers = scarcity signal
- **Conversion Drop-Off (>10pts)** — Win rate declining = supply tightening
- **Velocity Spike** — Top 3 manufacturers by RFQ volume increase (no threshold per Josh feedback)

**REMOVED per Josh feedback:** Margin Expansion Leaders (too customer-specific, not reliable market signal)

### 3. Trending Manufacturers (Top 10)
Columns:
- Manufacturer
- Customers
- RFQ Count
- Quoted
- Sold
- Win %
- **Booked Sales (30d)** — NEW per Josh feedback
- WoW Velocity
- Signals

**Changes per Josh feedback:**
- ✅ ADDED: Booked Sales (30d) column
- ❌ REMOVED: Avg Quote Age column
- 🔄 RECONSIDERING: Rank by Sold instead of RFQ count

### 4. Trending Parts (Top 10)
Columns: MPN, Manufacturer, Customers, RFQ Count, Quoted, Sold, Win %, First Seen, Scarcity Signal

### 5. Manufacturer Exposure (Pipeline Concentration Risk)
Columns: Manufacturer, Open RFQ Value, Open CQ Value, Total Exposure, % of Pipeline, Largest Customer, Risk Level

### 6. Regional Demand Divergence (APAC Concentration Signals)
Columns: Manufacturer, Total RFQs, APAC %, USA %, MEX %, Other %, Signal

**Why it matters:** APAC constraint typically hits 3-4 weeks before USA, 6-8 weeks before MEX

### 7. Response Time Trends (Supply Chain Stress Indicator)
Columns: Manufacturer, Current Avg Response Time, vs Prior 30d, Change %, Sample Size, Signal

**Why it matters:** Expanding response time = suppliers struggling to source = early constraint signal

### 8. New Entrants (Emerging Hotspots)
Parts/manufacturers that weren't in top 20 last period but are trending now

---

## Changes from Mockup (Josh's Feedback 2026-06-04)

### Removed:
1. ❌ Margin Expansion Leaders section — too customer-specific, not reliable market signal
2. ❌ Avg Quote Age column (Trending Manufacturers table)

### Added:
1. ✅ Booked Sales (30d) column (Trending Manufacturers)
2. ✅ Distinct customer count emphasis (Multi-Customer Parts)

### Modified:
1. 🔧 Velocity Spike — Always show top 3 manufacturers (removed >50% threshold)
2. 🔧 Ranking logic — Consider ranking Trending Manufacturers by Sold instead of RFQ count

### Future (Deferred — Research Needed):
1. ⏭️ Year-over-Year Seasonality Context — Compare current week to same week last year
2. ⏭️ Trending Manufacturers in Buyer Queue — Show what buyers are actively working on
3. ⏭️ Astute Stock Indicator — Flag when trending parts are in stock
4. ⏭️ Part Lifecycle Data — Integrate online lifecycle data (Active/NRND/EOL/Obsolete)

---

## Constraint Signal Thresholds

| Signal | Threshold | What It Means |
|--------|-----------|---------------|
| **Multi-Customer Parts** | 5+ distinct customers | Scarcity — many customers chasing same part |
| **Conversion Drop** | >10pts vs prior 30d | Supply tightening — harder to win quotes |
| **Velocity Spike** | Top 3 by volume increase | Demand surge — allocation risk |
| **APAC Concentration** | >70% of RFQs | Regional constraint (USA follows in 3-4 weeks) |
| **Response Time Increase** | >20% slower vs prior 30d | Suppliers struggling to source |

**Allocation Risk Framework:**
- 0-1 signals = 🟢 Normal Market
- 2-3 signals = 🟡 Heating Up (prepare for constraint)
- 4-5 signals = 🔴 Constrained (allocation likely within 2-4 weeks)
- 6+ signals = 🔴 Critical (allocation imminent or active)

---

## Implementation Status

### ✅ Phase 1: Foundation (COMPLETE — 2026-06-11)
- [x] Create market-pulse-weekly.js script
- [x] Set up 30-day rolling window logic
- [x] HTML email template with styling (based on mockup)
- [x] JSON output for debugging
- [x] Applied Josh's feedback to structure (removed Margin Expansion, modified Velocity Spike)

### 🚧 Phase 2: SQL Queries (IN PROGRESS)
- [ ] Temperature Gauge metrics
- [ ] Constraint Indicators (multi-customer parts, conversion drop, velocity spike)
- [ ] Trending Manufacturers (with Booked Sales column)
- [ ] Trending Parts
- [ ] Manufacturer Exposure
- [ ] Regional Demand Divergence
- [ ] Response Time Trends
- [ ] New Entrants

### ⏭️ Phase 3: Data Integration
- [ ] Test with real data
- [ ] Tune thresholds based on actual data patterns
- [ ] Validate constraint signals against historical allocations
- [ ] Review output with Josh

### ⏭️ Phase 4: Automation
- [ ] Email delivery via nodemailer
- [ ] Schedule (weekly? bi-weekly? monthly?)
- [ ] Set recipients

### ⏭️ Phase 5: Future Enhancements (Research Needed)
- [ ] Year-over-Year Seasonality Context
- [ ] Buyer Queue section
- [ ] Astute Stock indicator
- [ ] Part Lifecycle API integration (Silicon Expert, IHS Markit, Octopart, Z2Data)

---

## Files

| File | Purpose |
|------|---------|
| `market-pulse-weekly.js` | Main report generator (foundation complete, queries in progress) |
| `MARKET-PULSE-WEEKLY.md` | This documentation |
| `market-pulse-standalone-mockup.html` | Original mockup (reference) |
| `market-pulse-feedback-2026-06-04.md` | Josh's feedback on mockup |
| `output/market-pulse-weekly-*.html` | Generated HTML emails |
| `output/market-pulse-weekly-*.json` | Raw data (debugging) |

---

## How to Run (Current State)

### Option A Dashboard (Current Format - Active as of 2026-06-29)

**Schedule:** Weekly, typically **Thursday** for the current week

**Before Running:**
1. **Do fresh external market research** (see "External Market Research" section above)
2. Update `getExternalMarketData()` function if market conditions changed
3. Verify week number is correct

**Generate Report:**
```bash
node "Sales Pulse Daily/scripts/market-pulse-option-a.js" <week_number>

# Example for Week 27
node "Sales Pulse Daily/scripts/market-pulse-option-a.js" 27
```

**Output files:**
- `output/market-pulse/market-pulse-option-a-week<N>-YYYY-MM-DD.html` - Email-ready HTML report

**What it includes:**
- Executive Brief (Performance WoW, Market Shifts WoW, Top 3 Actions)
- Constraint Signals (Hot Part Families, Trending Manufacturers, Franchise Lead Times)
- External Market Validation (industry sources cross-referenced with OT data)
- External Data Sources (current article links organized by constraint category)

---

## Next Steps

1. **Read data model** (`astute-workinstructions/shared/data-model.md`) to understand:
   - Manufacturer table/field names
   - RFQ→VQ→CQ→SO relationships
   - Customer/part tracking
   - Regional assignment logic

2. **Write SQL queries** for each section (start with Temperature Gauge and Constraint Indicators)

3. **Test with real data** and validate signal accuracy

4. **Review with Josh** to tune thresholds and add missing sections

5. **Automate delivery** once data is validated

---

## Questions for User

1. **Scheduling:** How often should this run? Weekly? Bi-weekly? Monthly?
   - Recommendation: Weekly (Fridays) to match Sales Pulse Weekly cadence

2. **Recipients:** Who should receive this?
   - Recommendation: Josh, Jeff, Joel, Laurel, Kris, Lavanya (same as Sales Pulse)

3. **Future features:** Which deferred items are priority?
   - YoY Seasonality Context?
   - Buyer Queue section?
   - Astute Stock indicator?
   - Lifecycle API integration?

---

**Status:** 🚧 Foundation complete, SQL queries in progress
**Next Session:** Start writing SQL queries for Temperature Gauge and Constraint Indicators

*Last Updated: 2026-06-11*
