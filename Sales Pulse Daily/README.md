# Sales Pulse — Pre-Sales Visibility Dashboard

**Status:** ✅ Daily Live | ✅ Weekly Built (Ready to Deploy) | ✅ Market Pulse Built
**Created:** 2026-05-28 (Daily), 2026-06-01 (Weekly), 2026-06-11 (Market Pulse)
**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Market Pulse Standard Format:** Option A Dashboard (as of 2026-06-29)

---

## Overview

Daily and weekly email digests providing sales leadership with actionable visibility into pre-sales funnel health, seller performance, and market trends.

**Recipients:** Jeff Wallace (Director USA), Joel Marquez (Manager MEX), Laurel Kee (Manager APAC), Kris Munoz (Manager APAC), Lavanya Manohar (Manager APAC), Josh Pucci (VP Sales)

**Delivery Schedule:**
- **Daily Comprehensive:** Mon-Fri at 6:00 AM PT (`sales-pulse-comprehensive.js`)
- **Weekly Summary:** Fridays at 6:00 AM PT (`sales-pulse-weekly.js`)
- **Market Pulse Weekly:** Fridays at 6:00 AM PT (`market-pulse-weekly.js`)

---

## Quick Start

### Run Daily Report
```bash
cd ~/workspace/Sales\ Pulse\ Daily/scripts
node sales-pulse-comprehensive.js
```

### Run Weekly Report
```bash
cd ~/workspace/Sales\ Pulse\ Daily/scripts
node sales-pulse-weekly.js
```

### Run Market Pulse
```bash
cd ~/workspace/Sales\ Pulse\ Daily/scripts
node market-pulse-weekly.js
```

### Send Email
```bash
cd ~/workspace/Sales\ Pulse\ Daily/scripts
node send-email.js
```

Outputs are saved to `output/` with timestamps (e.g., `sales-pulse-comprehensive-2026-06-11.html`)

---

## Folder Structure

```
Sales Pulse Daily/
├── README.md                    # This file - project overview
├── .env.example                 # Environment configuration template
│
├── scripts/                     # Active production scripts
│   ├── sales-pulse-comprehensive.js  # Daily comprehensive report
│   ├── sales-pulse-weekly.js         # Weekly summary report
│   ├── market-pulse-weekly.js        # Market pulse weekly report
│   ├── vp-daily-brief-detailed.js    # VP daily brief
│   ├── generate-detailed-report.js   # Detailed report generator
│   ├── email-vp-daily-brief.js       # VP brief email sender
│   └── send-email.js                 # General email sender
│
├── queries/                     # SQL queries organized by purpose
│   ├── comprehensive-queries.sql     # Daily comprehensive queries
│   ├── market-pulse-queries.sql      # Market pulse queries
│   ├── regional-alerts.sql           # Regional alert queries
│   └── vp-daily-queries-detailed.sql # VP brief queries
│
├── docs/                        # Active documentation
│   ├── daily-pulse-workflow.md       # Daily report workflow
│   ├── weekly-pulse-workflow.md      # Weekly report workflow
│   ├── market-pulse-workflow.md      # Market pulse workflow
│   ├── vp-daily-brief-workflow.md    # VP brief workflow
│   ├── vp-strategic-design.md        # VP report design notes
│   ├── setup-guide.md                # Setup instructions
│   ├── AUTOMATION-SETUP.md           # Automation configuration
│   ├── DETAILED-REPORT-USAGE.md      # Detailed report usage guide
│   ├── PART-DETAILS-FINDINGS.md      # Part details analysis
│   └── PERFORMANCE-OPTIMIZATION.md   # Performance optimization notes
│
├── data/                        # Input data files
│   └── [Infor exports, source data files]
│
├── output/                      # Generated reports (timestamped, organized by type)
│   ├── daily/                   # Daily comprehensive reports
│   ├── weekly/                  # Weekly summary reports
│   ├── market-pulse/            # Market pulse reports
│   ├── vp-briefs/               # VP daily briefs
│   └── mockups/                 # Design mockups
│
├── logs/                        # Application logs
│
└── archive/                     # Historical artifacts
    ├── development/             # Old versions & experiments
    ├── design-notes/            # Design evolution
    ├── session-history/         # Session summaries & feedback
    └── reports/                 # One-off executive reports
```

---

## Report Types

### 1. Daily Comprehensive (Mon-Fri)

**Purpose:** 60-second tactical pulse on yesterday's activity vs 5-day rolling average

**Sections:**
1. **Global Snapshot** - Pipeline input, quoting activity, wins, system discipline
2. **By Region** - USA, MEX, APAC breakdown
3. **Yesterday's Wins** - Orders booked with seller names
4. **Needs Attention** - High-value quotes, high-probability customers, new opportunities, pricing benchmarks, sourcing stuck
5. **Week-to-Date** - Progress vs weekly targets
6. **Market Pulse** - Hot parts, trending categories
7. **Observations** - Key insights and action items

**Time Window:** 5-day rolling (items fall off after 5 business days to prevent stale backlog)

**See:** `docs/daily-pulse-workflow.md` for detailed specifications

---

### 2. Weekly Summary (Fridays)

**Purpose:** Strategic review of full week (Mon-Fri) vs prior week

**Sections:**
1. **Weekly Performance** - Total RFQs, quotes, conversions, wins
2. **Regional Comparison** - USA vs MEX vs APAC trends
3. **Top Performers** - Sellers by activity and wins
4. **Pipeline Health** - Quote aging, sourcing velocity
5. **Customer Insights** - New customers, high-win-rate accounts
6. **Week-over-Week Trends** - Key metric deltas

**See:** `docs/weekly-pulse-workflow.md` for detailed specifications

---

### 3. Market Pulse Weekly (Fridays)

**Purpose:** Market intelligence and supply chain visibility

**Sections:**
1. **Temperature Gauge** - Market heat vs capacity
2. **Supply Constraints** - Parts with sourcing challenges
3. **Trending Manufacturers** - Demand spikes by MFR
4. **Trending Parts** - Hot MPNs and part families
5. **Customer Exposure** - Top customers by volume/value
6. **Regional Activity** - Geographic demand patterns
7. **Response Times** - Buyer performance by category
8. **New Market Entrants** - First-time customers

**See:** `docs/market-pulse-workflow.md` for detailed specifications

---

## Key Design Principles

### 1. Fresh & Actionable (5-Day Rolling Window)
- Most metrics compare yesterday vs 5-day rolling average (smooths noise)
- "Needs Attention" shows only items **created in last 5 business days**
- After 5 days, items fall off the report (prevents stale backlog)

**Why:** A Shortage quote created 3 days ago has 7 days left to close (actionable). A Shortage quote created 18 days ago is dead (not shown).

### 2. Prioritized by Value & Opportunity
- High-value quotes (>$10K) listed first
- High-probability customers (30-50% win rate) highlighted
- New customer opportunities (first-time RFQs) prioritized
- Pricing benchmarks for market intel (not pursuit)

### 3. Context for Decision-Making
- RFQ type shown (Shortage/PPV/EOL/etc.) so managers assess if aging is appropriate
- Customer win rate shown for high-probability accounts
- Seller/buyer names for sourcing stuck (enables escalation)
- Days left in close window for quotes

### 4. Acknowledges Data Gaps
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
- 100 activities (not tracked in these reports)

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

## Related Workflows

See also:
- **RFQ Sourcing** - NetComponents supplier submission (`~/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/`)
- **VQ Loading** - Process supplier quote emails (`~/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/`)
- **Quick Quote** - Generate baseline quotes from recent VQs (`~/workspace/astute-workinstructions/Trading Analysis/Quick Quote/`)
- **Market Offer Analysis** - Excess inventory intelligence (`~/workspace/astute-workinstructions/Trading Analysis/Market Offer Analysis/`)

---

## Contact

**Owner:** Melissa Bojar (Sales Productivity Analyst)
**Stakeholders:** Josh Pucci (VP Sales), Jeff Wallace (Director USA), Joel Marquez (Manager MEX), Laurel Kee (Manager APAC), Kris Munoz (Manager APAC), Lavanya Manohar (Manager APAC)

---

*Last Updated: 2026-06-23 (Folder structure reorganized)*
