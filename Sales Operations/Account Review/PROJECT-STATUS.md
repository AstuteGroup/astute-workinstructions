# Account Review Automation - Project Status

**Last Updated:** 2026-07-14
**Status:** In Progress - Database Schema Exploration & Requirements Gathering Complete

---

## Quick Pickup Summary

When resuming this project, reference this checklist:

### ✅ Completed Today (2026-07-14)

1. **Project setup** - Created `Account Review` folder under Sales Operations
2. **Requirements gathered** - Analyzed example Excel template (Aaron - Q2 2026)
3. **Database schema explored** - Identified all data sources and table structures
4. **Context reviewed** - Read Context Portfolio to understand role, systems, and data architecture
5. **Data source mapping** - Determined OT vs Infor data split
6. **Test queries built** - Created and validated initial SQL queries for OT metrics
7. **Infor data analyzed** - Parsed booked/invoiced CSVs to understand structure

### 🎯 Next Steps (Priority Order)

1. **Build complete OT queries** using `created` date (as specified)
2. **Create Infor CSV parsing logic** for Booked/Invoiced GP
3. **Implement customer name fuzzy matching** (OT ↔ Infor)
4. **Build "Not Assigned" section** query
5. **Create Excel generation script** with proper formatting
6. **Add scheduled GP calculation** (open orders)
7. **Import GP targets** from goals file
8. **Parameterize for any seller/quarter**
9. **Write workflow documentation**

---

## Project Overview

**Goal:** Automate quarterly account review reports for sales reps

**Current Process (Manual):**
- Download data from OT and Infor into Excel templates
- Manually fuzzy match customer names between systems
- Calculate metrics and format reports
- Time-consuming and error-prone

**Future Process (Automated):**
- Input: Seller name, quarter, Infor CSV files, goals file
- Processing: Query OT, parse Infor CSVs, match customers, calculate metrics
- Output: Excel file ready for quarterly review meetings

---

## Template Analysis

**Source:** `Account Reviews - Aaron Mendoza Example.xlsx`
**Tab:** "Aaron - Q2 2026"

### Report Structure

**Two Main Sections:**
1. **Assigned Accounts** (26 accounts) - Strategic accounts with ISE Steward assignment
2. **Not Assigned** (17 accounts) - Accounts with activity but no formal assignment

### Metrics Breakdown

| Metric | Data Source | Access Method | Status |
|--------|-------------|---------------|--------|
| **Account Information** | | | |
| Account (OT) | OT | c_bpartner.name | ✅ Working |
| Account INFOR | Infor | Manual mapping | ⏳ TODO |
| Locations | OT | COUNT(c_bpartner_location) | ✅ Working |
| **Historical (Previous Quarter - Q1 2026)** | | | |
| Activities | OT | c_contactactivity via ad_user | ✅ Working |
| RFQ Lines | OT | chuboe_rfq_line_mpn | ✅ Working |
| CQ Lines | OT | chuboe_cq_line | ✅ Working |
| CQ Lines Won | OT | c_orderline joined to CQ | ✅ Working |
| Conversion Rate | Calculated | CQ Won / CQ Lines | ✅ Working |
| Booked GP | **Infor CSV** | "Infor Booked Sales by Line YTD" | ⏳ TODO |
| Invoiced GP | **Infor CSV** | "Invoiced Sales 2026 by Line" | ⏳ TODO |
| B to I Ratio | Calculated | Booked GP / Invoiced GP | ⏳ TODO |
| % of Inv Total | Calculated | After totals computed | ⏳ TODO |
| Q1 2026 Notes | Manual | User input | Manual |
| **Planning (Current Quarter - Q2 2026)** | | | |
| Scheduled GP | **Infor CSV** | Open orders/backlog | ⏳ TODO |
| GP Target | **Goals File** | Manual upload | ⏳ TODO |
| Q2 2026 Strategy | Manual | User input | Manual |

---

## Data Architecture

### Two-System Reality

**OT (Orange Tsunami)** - Pre-Sales CRM
- Activities (logged by sellers)
- RFQs (customer requests for quote)
- VQs (vendor quotes received)
- CQs (customer quotes sent)
- Sales Orders (conversions)

**Infor** - Post-Sales ERP
- Bookings (orders booked)
- Billings (invoices)
- Backlog (open orders)

### Integration Pattern

```
SharePoint (Hub)
    ├── Power BI → Infor (Post-Sales)
    ├── Metabase → OT (Pre-Sales)
    └── Claude → OT (Analysis & Automation)
```

---

## Key Technical Decisions

### 1. Date Fields
**Decision:** Use `created` date for orders (not `dateordered`)
**Label:** "Booked Created Date"
**Rationale:** User specified - matches Infor export methodology

### 2. Booked/Invoiced GP Data Source
**Decision:** Parse Infor CSV files (not query OT)
**Rationale:**
- OT has no invoices in Q1 2026
- Infor data matches Excel template ($47,493 booked, $27,523 invoiced)
- OT booked GP inflated due to data differences

### 3. Customer Name Matching
**Decision:** Implement fuzzy matching logic
**Challenge:**
- OT: "Alstom", "GE Healthcare", "Morey Corporation"
- Infor: "Alstom Transportation Inc.", "GE Precision Healthcare LLC", "THE MOREY CORPORATION"

---

## Database Schema Reference

### Sellers/ISE Stewards
- **Table:** `ad_user`
- **Aaron Mendoza ID:** 1039413
- **Assignment field:** `c_bpartner_location.chuboe_ise_steward_id`

### Activities
- **Table:** `c_contactactivity`
- **Link:** `ad_user_id` → `ad_user.c_bpartner_id` (account link)
- **Filter:** `salesrep_id` = seller, `startdate` in quarter range

### Account Locations
- **Table:** `c_bpartner_location`
- **ISE Steward:** `chuboe_ise_steward_id` → `ad_user_id`
- **Roll up:** GROUP BY `c_bpartner_id` for account-level view

### RFQ/CQ/SO Tables
- **RFQ:** `chuboe_rfq` → `chuboe_rfq_line` → `chuboe_rfq_line_mpn`
- **CQ:** `chuboe_cq_line` (links to RFQ line)
- **SO:** `c_order` → `c_orderline` (links to CQ)
- **Filter:** `salesrep_id`, `created` date

---

## Test Results (Aaron Mendoza Q1 2026)

### OT Query Results
| Metric | Query Result | Excel Value | Match |
|--------|--------------|-------------|-------|
| Alstom Locations | 2 | 2 | ✅ |
| Alstom Activities | 2 | 2 | ✅ |
| Alstom RFQ Lines | 12 | 12 | ✅ |
| Alstom CQ Lines | 18 | 18 | ✅ |
| Alstom Conversion | 0.5556 | 0.5 | ⚠️ Close |
| Total Booked GP (OT) | ~$61,846 | $31,917 | ❌ Different |

### Infor CSV Results
| Metric | Infor Result | Excel Value | Match |
|--------|--------------|-------------|-------|
| Total Booked GP | $47,493 | $31,917 | ⚠️ Closer |
| Total Invoiced GP | $27,523 | $29,307 | ✅ Very Close |

**Analysis:** Infor data is much closer to Excel template than OT queries. Use Infor CSVs for GP metrics.

---

## Infor CSV Structure

### Booked Sales CSV
**File:** `Infor Booked Sales by Line YTD - 6.19.26.csv`

**Columns:**
- Year, Week Number, Date
- Customer Name
- **CO Internal Salesperson** (seller username: "aaromend")
- CO Number
- Manufacturer Name, Item, Item Description
- Booked Revenue, **Booked GP**, GP%
- CO Promise Date, CO Ship Date

### Invoiced Sales CSV
**File:** `Invoiced Sales 2026 by Line - 6.19.26.csv`

**Columns:**
- Week Number, Invoice Date
- Sales Region
- **Internal Salesperson** (seller username)
- CO Number, Customer Name
- Manufacturer Name, Item, Item Description
- Invoice Revenue, **Invoice GP**, Invoice GM%

### Seller Username Mapping
- Aaron Mendoza → `aaromend`
- Josh Syre → `joshsyre`
- Joel Flores → `joelflor`
- (etc. - see unique salespersons list)

---

## Quarter Date Ranges

| Quarter | Start Date | End Date |
|---------|------------|----------|
| Q1 2026 | 2026-01-01 | 2026-03-31 |
| Q2 2026 | 2026-04-01 | 2026-06-30 |
| Q3 2026 | 2026-07-01 | 2026-09-30 |
| Q4 2026 | 2026-10-01 | 2026-12-31 |

---

## Files Created

### Queries
- `account-review-full-query.sql` - Comprehensive OT query (pre-sales metrics)
- `test-account-review-query.sql` - Initial test query

### Analysis Scripts
- `analyze-account-review.js` - Excel template analyzer
- `analyze-booked-invoiced.js` - Infor booked sales analyzer
- `analyze-invoiced.js` - Infor invoiced sales analyzer

**Status:** All test scripts validated and working

---

## Customer Name Matching Challenge

### Examples of Mismatches

| OT Name | Infor Name | Match Strategy |
|---------|------------|----------------|
| Alstom | Alstom Transportation Inc. | Fuzzy match on "Alstom" |
| GE Healthcare | GE Precision Healthcare LLC | Fuzzy match on "GE" + "Healthcare" |
| Morey Corporation | THE MOREY CORPORATION | Case-insensitive + "Corporation" strip |
| Qual-Pro Corporation | Qual-Pro Corporation | Exact match |

### Proposed Solution
1. Normalize both sides (uppercase, strip legal entities)
2. Use fuzzy string matching (Levenshtein distance)
3. Manual mapping table for edge cases
4. Review and approve matches before Excel generation

---

## Conditional Formatting Requirements

From Excel template analysis:

1. **Conversion Rate < 10%** → RED highlight
2. **Blank values** when CQ Lines = 0 (not "0.0000")
3. **Currency formatting:** `$1,234.56` (always with $, commas, 2 decimals)
4. **Percentage formatting:** `18.5%` (with % sign)
5. **Numbers:** Comma separators for 1,000+

---

## "Not Assigned" Section Logic

**Definition:** Accounts where seller had activity/RFQs/CQs/SOs/Invoices in previous quarter BUT seller is NOT current ISE Steward

**Business Purpose:**
- Flag accounts needing assignment review
- Identify dropped accounts
- Surface related accounts (e.g., sister companies)
- Catch one-off credits/orders

**Query TODO:**
- Find accounts with seller activity in Q1 2026
- EXCLUDE accounts where seller is ISE Steward
- Same metrics as Assigned section

---

## User Context (From Context Portfolio)

### Role
- **Accountable for:** Account Review structure and information accuracy
- **Purpose:** Help leadership identify what to focus on and what actions are required
- **Cadence:** Quarterly reviews with sellers and management

### Tools
- **Power BI:** Post-sales analytics (Infor data)
- **Claude:** Pre-sales analysis (OT data)
- **SharePoint:** Integration hub

### Data Flow
```
Pre-Sales:  OT → Claude/Metabase → SharePoint
Post-Sales: Infor → Power BI → SharePoint
```

---

## Next Session Checklist

When you return to this project:

1. **Review this document** - Read the full status
2. **Check test queries** - Review `account-review-full-query.sql`
3. **Ask user:**
   - Do you have updated Infor CSV files for Q3?
   - Do you have the 2026 seller goals file ready?
   - Which quarter/seller should we test with first?

4. **Then proceed with:**
   - Build Infor CSV parser
   - Implement fuzzy matching
   - Create "Not Assigned" query
   - Build Excel generator
   - Test end-to-end

---

## Questions for Next Session

1. **Infor CSV files:** Do you have Q3 2026 data ready, or should we use Q2 data for testing?
2. **Goals file:** What format is the 2026 seller goals file? (Excel, CSV?)
3. **Scheduled GP:** Should we calculate from OT open orders, or import from Infor backlog export?
4. **Customer mapping:** Do you want to review and approve fuzzy matches before Excel generation?
5. **Seller list:** Should we build a seller mapping table (name → user_id → username)?

---

## Success Criteria

**MVP (Minimum Viable Product):**
- ✅ Generate Excel report for any seller + quarter
- ✅ Pull all pre-sales metrics from OT
- ✅ Pull Booked/Invoiced GP from Infor CSVs
- ✅ Fuzzy match customer names (80%+ accuracy)
- ✅ Format Excel properly (currency, percentages, conditional)
- ✅ Include "Not Assigned" section

**Future Enhancements:**
- Auto-fetch Infor CSVs (if API available)
- Store customer name mappings in database
- Generate for all sellers at once (batch mode)
- Email reports directly to sellers
- Add historical trend analysis (Q-over-Q)

---

**Ready to resume!** 🚀
