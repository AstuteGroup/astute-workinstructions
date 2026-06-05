# MI KPI Project

**Material Inspection KPI Tracking and Automation**
**Austin Site - 2026**

## Current Status

✅ **All 3 Tasks Complete (as of June 5, 2026)**
- Task 1: Manual method automation (87% match)
- Task 2: v6 tracker with Additional Inspections (112.3% of target)
- Task 3: Visual dashboard for MI Manager review

**Awaiting:** MI Manager feedback and approval for production deployment

---

## Quick Start

### Latest Deliverables (May 2026)
All current reports are in: **`deliverables/may-2026/`**

1. **mi_kpi_report_2026-05_v6.xlsx** (RECOMMENDED)
   - 176 unique OTINs, 606.40 KPI (112.3% of 540 target)
   - Includes Additional Inspection weights (+0.2 each)
   - Formula: KPI = DC/LC Count × (Base Weight + Additional Inspections)

2. **mi_kpi_report_2026-05_MANUAL_METHOD.xlsx**
   - 187 lines, 515 KPI (87% match to manual's 590)
   - Replicates manual line-by-line methodology
   - Uses flat tier weights (all T1=1.0)

3. **MI_KPI_Dashboard_May2026_v6.png**
   - Visual dashboard with individual inspector performance
   - Top performers: Daisy Mendoza (180.7%), Ofelio Martinez (158.0%), Juan Serrano (129.1%)

4. **methodology_comparison.md**
   - Detailed comparison of manual vs automated approaches
   - Gap analysis and recommendations

### Run Current Reports

**v6 Report (with Additional Inspections):**
```bash
node "MI KPIs/scripts/mi_kpi_report_v6.js"
```

**Manual Method Recreation:**
```bash
node "MI KPIs/scripts/mi_kpi_report_manual_method.js"
```

---

## Project Structure

```
MI KPIs/
├── README.md                   # This file
├── deliverables/               # Final outputs for MI Manager
│   ├── may-2026/              # Current month deliverables
│   └── march-2026/            # Archived monthly reports
├── source-data/               # Reference materials
│   ├── Manual OTIN Tracker Austin - May 2026 Finalized.xlsx
│   └── Inspection weight chart - 5.06.26.xlsx
├── scripts/                   # Production scripts
│   ├── mi_kpi_report_v6.js               (CURRENT - with add-ons)
│   ├── mi_kpi_report_manual_method.js    (CURRENT - manual replication)
│   └── archived/                         (Old versions: v2, v3, v4, v5)
├── analysis/                  # Investigation & comparison scripts
├── documentation/             # Manager feedback & session notes
│   ├── manager-feedback/      # MI Manager reviews & responses
│   └── session-notes/         # Development session logs
├── archive/                   # Old iterations
│   ├── dashboards-old/        # Previous dashboard versions
│   └── reports-old/           # Old report files
└── queries/                   # SQL queries
```

---

## Key Concepts

### KPI Formula

**v6 (Current - with Additional Inspections):**
```
KPI = DC/LC Count × (Base Tier Weight + Additional Inspection Weights)
```

**Base Tier Weights:**
- Tier 1 Passive: 0.75
- Tier 1 Active: 1.0
- Tier 1 Master: 0.5
- Tier 2: 2.0
- Tier 3: 3.0
- Tier 4 (AS6171): 4.0

**Additional Inspection Weights (+0.2 each):**
- Decapsulation
- Solderability
- SEM
- Scrape
- Destructive Sampling
- Non-conforming conditions

### Counting Methodologies

**Manual Method (Task 1):**
- Line-by-line counting (non-distinct OTINs)
- Each OTIN-inspection combination = separate line
- Uses FLAT tier weights (all T1=1.0 regardless of type)
- 187 lines from 213 pick sessions

**v6 Method (Task 2 - RECOMMENDED):**
- Distinct OTIN counting
- Aggregates multiple inspections per OTIN
- Uses differentiated tier weights + Additional Inspections
- 176 unique OTINs

### Cross-Month Activity

OTINs are attributed to the month of **first pick date**. Example: OTINs picked on April 30 are included in May's report if their first pick occurred then.

---

## Performance Targets

- **Team Target:** 540 KPI/month (6 inspectors × 90 KPI/inspector)
- **May 2026 Actual (v6):** 606.40 KPI (112.3% of target) ✅
- **Individual Target:** 90 KPI/inspector/month

### May 2026 Inspector Performance
1. **Daisy Mendoza:** 162.6 KPI (180.7%) 🟢
2. **Ofelio Martinez:** 142.2 KPI (158.0%) 🟢
3. **Juan Serrano:** 116.2 KPI (129.1%) 🟢
4. **Sharanya Sarkar:** 83.0 KPI (92.2%) 🟡
5. **Jacob DeWit:** 82.3 KPI (91.4%) 🟡
6. **Jacob Palmertree:** 20.2 KPI (22.4%) 🔴

---

## Known Issues & Gaps

### Task 1 (Manual Method Recreation) - 13% Gap

**Manual Tracker:** 590 KPI, 190 lines
**Task 1 Automated:** 515 KPI, 187 lines
**Gap:** 75 KPI (13%)

**Causes:**
1. **DC/LC Count Differences:** ~48-50 KPI (27 OTINs with different counts)
2. **Missing 3 Lines:** ~15-20 KPI (187 vs 190)
3. **Timing/Snapshot:** ~5-7 KPI (manual finalized later)

**Recommendation:** Run automated report 2-3 days after month-end when all inspections are validated to achieve 95%+ match.

---

## Database Tables

**Primary Tables:**
- `chuboe_po_userpick` - Pick sessions and dates
- `chuboe_insp_mpnlot_v` - OTIN and lot information
- `chuboe_insp_lot_lnk` - Links lots to inspections
- `chuboe_insp` - Inspection types and weights
- `chuboe_insp_datelotcode` - DC/LC counts

**Austin Inspectors:**
- Jacob DeWit
- Daisy Mendoza
- Ofelio Martinez
- Juan Serrano
- Jacob Palmertree
- Sharanya Sarkar

---

## History

### Key Milestones

**June 5, 2026:** Tasks 1-3 complete, awaiting MI Manager review
- Implemented manager feedback: MASTER OTIN weight fix (1.0→0.5)
- Added Additional Inspection weights (+0.2 each)
- Resolved 276+ KPI gap between manual and initial automated
- Created visual dashboard matching Enhanced_CORRECTED layout

**June 1, 2026:** Validation date methodology exploration
- Compared pick date vs validation date attribution
- Determined first pick date is correct attribution method

**May 28, 2026:** Initial May 2026 reports generated

**May 6-7, 2026:** Project inception and March 2026 baseline

---

## Next Steps

1. **Immediate:** MI Manager review of all 3 deliverables
2. **Pending Approval:**
   - Transition to v6 methodology as official tracker
   - Phase out manual Excel tracking
   - Set up monthly automated report generation
3. **Future Enhancement:**
   - Weekly/real-time dashboard updates
   - Automated email delivery to MI Manager
   - Trend analysis across multiple months

---

## Contact

**Project Owner:** Material Inspection Manager
**Developed by:** Analytics Team
**Last Updated:** June 5, 2026
