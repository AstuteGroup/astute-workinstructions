# Market Pulse - External Market Intelligence Integration Proposal

**Date:** 2026-06-23
**Purpose:** Integrate external semiconductor market data with internal OT signals to enhance Market Pulse weekly report
**Target Audience:** Sales Leadership (Josh Pucci, regional VPs)

---

## Executive Summary

The Market Pulse report currently shows strong internal signals from OT data (RFQ patterns, VQ responses, franchise lead times). External market research confirms we're tracking the right indicators, and integration will:

1. **Validate internal signals** - Confirm shortages are market-wide vs. customer-specific
2. **Reveal competitive advantages** - Show where our supply access is better than market
3. **Guide sales strategy** - Clear action items based on signal alignment
4. **Provide market context** - Help leadership understand "are we seeing what the market sees?"

---

## Current External Market Landscape (Week 25, 2026)

### Overall State: "Two-Speed Market"

**ALLOCATED (High Pressure):**
- Memory components: 50% price spikes projected, critical shortages
- MCUs: Lead times exceeding 55 weeks
- Automotive SiC modules: 30-40 week lead times
- High-bandwidth memory, interface chips, optical interconnects
- Power discretes and PMICs for automotive/AI applications

**CONSTRAINED (Moderate Pressure):**
- Automotive-grade analog ICs: 16-24 week lead times (improving but still elevated)
- Specialized legacy components
- Components supporting 5G/6G infrastructure

**RECOVERY (Improving):**
- Mainstream semiconductors showing stable availability
- Distributor inventory-to-sales ratios returning to historical norms
- Lead times declined from 50+ weeks (2022 peak) to 16-24 weeks average

**NORMAL:**
- Many commodity passives and mature-node components

### Alignment with OT Data

| External Category | OT Internal Signal | Status |
|------------------|-------------------|--------|
| Memory (ISSI, Micron, Macronix) | IS*, MT*, MX* in shortage signals | ✅ CONFIRMED |
| MCUs (55+ weeks) | STM* showing 29.1w lead time | ⚠️ BETTER SUPPLY |
| Power Mgmt (TI) | TPS* (10 OEM customers) | ✅ CONFIRMED |
| Logic ICs | SN74* in shortage signals | ✅ CONFIRMED |

---

## Proposal 1: External Market Temperature Overlay (Quick Win)

**Implementation Time:** 30 minutes manual, 2 hours to automate

Add a new section between Performance Snapshot and Constraint Indicators:

### 📡 External Market Snapshot — Industry Lifecycle Check

| Category | External Status | Key Signals | Alignment with OT Data |
|----------|----------------|-------------|------------------------|
| **Memory** | 🔴 Allocated | 50% price spikes, severe shortages (ISSI, Micron, Macronix) | ✅ MATCHES: MT*, IS*, MX* in your shortage signals |
| **MCUs** | 🔴 Allocated | 55+ week lead times | ✅ MATCHES: STM* showing 29.1w lead time |
| **Power Mgmt** | 🟡 Constrained | Automotive/AI demand, 16-24w lead times | ✅ MATCHES: TPS* (10 OEM customers) |
| **Logic ICs** | 🟡 Constrained | Supply tightening | ✅ MATCHES: SN74* in shortage signals |
| **Mature Nodes** | 🟢 Recovery | Inventory normalized, buyer-favorable | ⚠️ WATCH: May create pricing pressure |

**Data source:** Weekly scrape/review of:
- Q2 2026 Semiconductor Lead Time & Pricing Outlook
- Semiconductor Market Pulse insights (Avnet)
- Component sourcing reports

---

## Proposal 2: Enhanced Franchise Lead Time Analysis

**Implementation Time:** 4 hours (parsing external sources + integration)

Upgrade existing "Franchise Lead Time Analysis" table with external benchmarks:

| Part Family | Current LT | Baseline LT | **Industry Avg** | **vs. Industry** | Status |
|-------------|-----------|-------------|------------------|------------------|--------|
| MX | 38.2w | 25.5w | **32w** | **+19% vs market** | 🔴 Allocated |
| STM | 29.1w | 28.4w | **55w** | **-47% vs market** | 🟢 Better supply than market |

**Why this matters:**
- Current LT < industry avg → **Competitive advantage** (better supply access)
- Current LT > industry avg → **Worse than market** (investigate supplier relationships)
- Both rising together → **Confirms global constraint** (not just your channels)

**Sales Action:**
- 🟢 Better supply → Market aggressively: "We have what competitors don't"
- 🔴 Worse supply → Proactive customer communication: "Here's what we're doing to secure supply"

---

## Proposal 3: Part Family Heat Map with External Validation

**Implementation Time:** 6 hours (scoring algorithm + UI)

Create composite "Market Stress Score" combining internal + external signals:

```
Market Stress Score = (
  0.25 × Internal_RFQ_Velocity +        // Your shortage signals
  0.20 × Internal_Lead_Time_Change +     // Your franchise LT analysis
  0.25 × External_Lead_Time +            // Industry reports
  0.15 × External_Price_Velocity +       // Industry price trends
  0.15 × External_Allocation_Flag        // Supplier allocation notices
)
```

**Output Table:**

| Part Family | Internal Signal | External Signal | Convergence | Sales Action |
|-------------|----------------|-----------------|-------------|--------------|
| TPS* (Power) | 🔴 10 OEM customers | 🟡 Constrained (16-24w) | ✅ ALIGNED | Premium positioning justified |
| MT* (Memory) | 🔴 7 OEM customers | 🔴 Allocated (50% spike) | ✅ ALIGNED | Proactive outreach - severe shortage |
| STM* (MCUs) | 🔴 29.1w lead time | 🔴 Industry >55w | ⚠️ BETTER | Competitive advantage - market it |
| LM* (Analog) | 🟡 7 OEM customers | 🟢 Normal supply | ⚠️ DIVERGENCE | Customer-specific, not market-wide |

**Interpretation Guide:**
- ✅ ALIGNED + 🔴 → Confirmed shortage, premium pricing justified
- ⚠️ BETTER → You have supply advantage over competitors
- ⚠️ DIVERGENCE → Investigate: design-in demand vs. allocation

---

## Proposal 4: Automated External Data Collection Pipeline

**Implementation Time:** 8-10 hours initial setup, 1 hour/month maintenance

### Architecture:

```
Weekly Cron Job (Mondays 6 AM CT)
  ↓
Scrape 5-6 industry sources (Playwright)
  - Sourceability market outlook
  - Semiconductor Market Pulse (Avnet)
  - J2 Sourcing lead time tracker
  - ComponentSense industry trends
  - Deloitte semiconductor outlook
  ↓
Extract structured data:
  - Part category lead times (Memory, MCU, Power, Logic, Passives)
  - Price trend indicators (up/down/stable %)
  - Allocation notices by manufacturer
  - Market lifecycle stage (Normal/Constrained/Allocated/Recovery)
  ↓
Save to: ~/workspace/Sales Pulse Daily/data/external-market/YYYY-MM-DD.json
  ↓
Report generation script reads latest JSON + OT database
  ↓
HTML report with integrated internal + external view
```

### JSON Schema (external-market-data.json):

```json
{
  "reportDate": "2026-06-23",
  "categories": {
    "memory": {
      "lifecycle": "allocated",
      "leadTimeWeeks": 38,
      "priceChange": "+50%",
      "notes": "50% price spikes, ISSI/Micron/Macronix severe shortages"
    },
    "mcus": {
      "lifecycle": "allocated",
      "leadTimeWeeks": 55,
      "priceChange": "+25%",
      "notes": "Lead times exceeding 55 weeks"
    },
    "powerMgmt": {
      "lifecycle": "constrained",
      "leadTimeWeeks": 20,
      "priceChange": "+15%",
      "notes": "Automotive/AI demand, 16-24w lead times"
    }
  },
  "manufacturers": {
    "Texas Instruments": {
      "categories": ["powerMgmt", "analog", "logic"],
      "status": "constrained",
      "notes": "TPS* family showing allocation signals"
    }
  }
}
```

**Fallback:** If scraping fails, manual JSON update takes 10 minutes.

---

## Proposal 5: Sales Leadership Dashboard Enhancement

**Implementation Time:** 4 hours (UI + logic)

Add **Market Alignment Index** at top of report:

```
📊 Market Alignment Index: 78% (↑ from 65% last week)

🔴 High-Confidence Shortages (Internal + External Aligned): 6 part families
   → Action: Sales should proactively contact customers with these parts

🟡 Emerging Constraints (Internal signal, external confirming): 8 part families
   → Action: Monitor closely, position value-add services

🟢 Competitive Advantages (Your supply better than market): 2 part families
   → Action: Market aggressively - you have what competitors don't

⚠️ False Positives (Internal signal, external normal): 3 part families
   → Action: Customer-specific demand, not market-wide - quote competitively
```

**This answers:** "Are our internal signals confirming what the market is seeing, or are we ahead/behind the curve?"

---

## Implementation Roadmap

### Phase 1: Proof of Concept (This Week - 2 hours)
**Deliverable:** Enhanced Week 25 report with manual external data

1. Add "External Market Snapshot" section to this week's report
2. Pull data from industry sources (already researched)
3. Map to existing OT part families
4. Show alignment/divergence in simple table
5. **Validate hypothesis:** Does external data add value to sales leadership?

**Decision Point:** If valuable → proceed to Phase 2. If not → iterate on format.

---

### Phase 2: Semi-Automated (Week 26 - 4 hours)
**Deliverable:** Reusable external data collection process

1. Build web scraping script for 2-3 key sources
2. Create JSON schema for external data storage
3. Manual review/editing of scraped data (quality check)
4. Integrate into report generation script

**Decision Point:** Scraping reliable? → Full automation. Unreliable? → Keep manual review step.

---

### Phase 3: Full Integration (Week 27 - 6 hours)
**Deliverable:** Automated weekly process + composite scoring

1. Add to cron (runs Monday mornings before report generation)
2. Build composite "Market Stress Score" algorithm
3. Generate "Market Alignment Index" automatically
4. Create sales action guide based on convergence/divergence

**Ongoing:** 15 minutes/week to review automated data quality

---

## External Data Sources (Curated List)

### Tier 1 - Weekly Updates (High Priority)
1. **Sourceability Market Outlook** - https://sourceability.com/post/whats-ahead-in-2026-for-the-semiconductor-industry
   - Lead times by category
   - Allocation notices
   - Price trends

2. **Avnet Semiconductor Market Pulse** - https://my.avnet.com/silica/resources/article/semiconductor-market-pulse-insights/
   - Quarterly insights
   - Component-specific trends
   - Regional demand patterns

3. **J2 Sourcing Lead Time Tracker** - https://j2sourcing.com/blog/semiconductor-shortages-50-memory-price-spikes-55-week-lead-times-2026/
   - Real-time lead time data
   - Memory price tracking
   - Shortage alerts

### Tier 2 - Monthly Updates (Context)
4. **Deloitte Semiconductor Outlook** - https://www.deloitte.com/us/en/insights/industry/technology/technology-media-telecom-outlooks/semiconductor-industry-outlook.html
   - Market size/growth
   - Technology trends
   - Strategic context

5. **ComponentSense Industry Trends** - https://www.componentsense.com/blog/semiconductor-industry-trends-report-2026
   - Industry analysis
   - Demand drivers
   - Capacity outlook

### Tier 3 - Ad Hoc (Special Reports)
6. Industry allocation notices (manufacturer announcements)
7. Supply chain disruption alerts (geopolitical, natural disaster)
8. Technology transition milestones (AI chip launches, etc.)

---

## Recommended Starting Point

**Start with Proposal 1 (Manual Entry) - Tomorrow's Session:**

1. I'll create the "External Market Snapshot" HTML section
2. Map current week's external data to your part families
3. Show alignment/divergence with your existing shortage signals
4. Generate simple sales action guide

**Time:** 30-45 minutes tomorrow morning
**Output:** Enhanced Week 25 report ready for distribution
**Value:** Immediate validation of concept before automation investment

**Then we decide:** Is this valuable enough to automate? If yes → Phase 2 next week.

---

## Questions for Tomorrow's Session

1. **Report cadence:** Weekly distribution schedule? (Mondays? Fridays?)
2. **Distribution list:** Who receives this? (Just Josh + regional VPs, or broader?)
3. **Action orientation:** Do recipients want prescriptive guidance ("Do X") or information only?
4. **Data freshness:** How critical is same-day data vs. 24-48 hour lag acceptable?
5. **Automation priority:** Quick manual process acceptable, or must be fully automated?

---

## Research Sources (2026-06-23)

- [2026 Global Electronic Components Market Outlook](https://www.einpresswire.com/article/896097443/2026-global-electronic-components-market-outlook-supply-chain-stabilization-and-ai-led-structural-growth)
- [Component Sourcing in 2026: Constraint, Volatility, and a New Procurement Reality](https://www.electropages.com/blog/2026/06/component-sourcing-2026-constraint-volatility-and-new-procurement-reality)
- [2026 Semiconductor Industry Outlook | Deloitte](https://www.deloitte.com/us/en/insights/industry/technology/technology-media-telecom-outlooks/semiconductor-industry-outlook.html)
- [Semiconductor Shortages: 50% Memory Price Spikes and 55+ Week Lead Times](https://j2sourcing.com/blog/semiconductor-shortages-50-memory-price-spikes-55-week-lead-times-2026/)
- [Q2 2026 Semiconductor Lead Time & Pricing Outlook](https://supplyics.com/insights/market-intelligence/q2-2026-semiconductor-lead-time-pricing-outlook/)
- [Semiconductor Market Pulse: Five Key Points for Q2 2026](https://my.avnet.com/silica/resources/article/semiconductor-market-pulse-insights/)

---

**Next Steps:** Review this proposal tomorrow, then build Proposal 1 (manual external snapshot) for Week 25 distribution.
