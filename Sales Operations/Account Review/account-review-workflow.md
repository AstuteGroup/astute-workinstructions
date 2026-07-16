# Account Review Workflow

**Purpose:** Generate quarterly account review reports for inside sales reps showing account performance metrics, pipeline, and context.

**Output:** Excel workbook with two sections: Assigned Accounts (steward relationship) and Not Assigned (transactional activity without formal assignment).

**Last Updated:** 2026-07-15

---

## Quick Start

```bash
# Navigate to Account Review folder
cd ~/workspace/astute-workinstructions/Sales\ Operations/Account\ Review

# Generate report for Aaron Mendoza, Q2 2026
node generate-account-review.js aaromend 2026 2

# Output saved to:
# Account Review - Aaron_Mendoza - Q2_2026.xlsx
```

---

## Command-Line Usage

### Syntax

```bash
node generate-account-review.js <infor_username> <year> <quarter>
```

### Parameters

| Parameter | Description | Example | Notes |
|-----------|-------------|---------|-------|
| `infor_username` | Seller's Infor username (lowercase) | `aaromend` | Must match "CO Internal Salesperson" in Infor CSVs |
| `year` | Four-digit year | `2026` | Year of the quarter being reviewed |
| `quarter` | Quarter number (1-4) | `2` | 1=Jan-Mar, 2=Apr-Jun, 3=Jul-Sep, 4=Oct-Dec |

### Examples

```bash
# Q1 2026 for Aaron Mendoza
node generate-account-review.js aaromend 2026 1

# Q3 2026 for Daniel Reiser
node generate-account-review.js dreiser 2026 3

# Q4 2025 for Jake Mcaloose
node generate-account-review.js jmcaloos 2026 4
```

---

## Prerequisites

### Required Input Files

The script requires three input files that must be manually downloaded and placed in the correct location:

#### 1. Booked Sales CSV

**Location:** `~/workspace/astute-workinstructions/Sales Pulse Daily/data/`

**Filename pattern:** `Infor Booked Sales by Line YTD - M.DD.YY.csv`

**Source:** Infor ERP export

**Contains:** All booked sales orders (CO lines) by salesperson

**Key columns:**
- `CO Internal Salesperson` (matches username parameter)
- `Customer Name` (for OT↔Infor matching)
- `CO Promise Date` (for quarter filtering)
- `CO Ship Date` (for scheduled GP filtering)
- `Booked GP` (gross profit on order)

#### 2. Invoiced Sales CSV

**Location:** `~/workspace/astute-workinstructions/Sales Pulse Daily/data/`

**Filename pattern:** `Invoiced Sales YYYY by Line - M.DD.YY.csv`

**Source:** Infor ERP export

**Contains:** All invoiced sales by salesperson

**Key columns:**
- `Internal Salesperson` (matches username parameter)
- `Customer Name` (for OT↔Infor matching)
- `Date Invoiced` (for quarter filtering)
- `Invoiced GP` (gross profit on invoice)

#### 3. Sales Goals File

**Location:** `~/workspace/astute-workinstructions/Sales Operations/Account Review/`

**Filename:** `Sales Goals 25-26 - INC - SharePoint.xlsx`

**Source:** SharePoint (downloaded manually)

**Contains:** Monthly GP goals by seller, quarter, and year

**Key columns:**
- `ISE Name` (seller's Infor username)
- `Goal Quarter` (Q1, Q2, Q3, Q4)
- `Goal Year` (2025, 2026, etc.)
- `Invoice GP Goal` (monthly goal amount)

**Note:** The script sums all monthly goals for the quarter to get the quarterly target.

---

## Output File Structure

### Excel Workbook

**Filename:** `Account Review - {Seller_Name} - Q{N}_{YEAR}.xlsx`

**Tab name:** `{Seller Name} - Q{N+1} {YEAR}`
- Example: "Aaron Mendoza - Q3 2026"
- Note: Tab shows NEXT quarter (Q3) while reviewing PREVIOUS quarter's performance (Q2)
- Rationale: Review Q2 results to set Q3 strategy

### Report Sections

#### Section 1: ASSIGNED ACCOUNTS

**Accounts included:** Business partners with at least one location where the seller is assigned as ISE Steward (`chuboe_ise_steward_id`)

**Metrics timeframe:** The quarter specified in the command (e.g., Q2 2026 = Apr 1 - Jun 30, 2026)

**Scheduled GP timeframe:** NEXT quarter (e.g., for Q2 review, shows Q3 scheduled pipeline)

#### Section 2: NOT ASSIGNED

**Accounts included:**
- Business partners WITHOUT ISE steward assignment to this seller
- BUT with activity from this seller (RFQs, CQs, orders, invoices) in the specified quarter
- PLUS any Infor-only customers (customers with GP in Infor but no matching OT account)

**Purpose:** Surface transactional relationships that may warrant formal assignment

### Separator Rows

- **"GRAND TOTALS"** — Sums of ASSIGNED section (appears between sections)
- **"NOT ASSIGNED - GRAND TOTALS"** — Sums of NOT ASSIGNED section (appears at bottom)

### GP Goal Row

**Label:** `GP Goal Q{N+1} {YEAR}`
- Example: "GP Goal Q3 2026" when reviewing Q2 2026

**Column D (Scheduled GP):** Shows quarterly GP goal amount from Sales Goals file

**All other columns:** Blank (formula row for totals)

---

## Column Reference

### Column A: Account (OT)

**Source:** `c_bpartner.name` (OT database)

**Description:** Customer name as it appears in Orange Tsunami / iDempiere

**Notes:**
- Primary identifier for account assignment
- May differ from Infor name (see Column B)
- RED text = account with zero activity across all metrics (RFQ/CQ/Sales)

### Column B: Account INFOR

**Source:** Fuzzy-matched customer names from Infor CSVs

**Description:** One or more Infor customer names matched to this OT account

**Matching logic:**
1. Exact match after normalization
2. Full substring match
3. Keyword overlap (3+ char words)
4. Levenshtein distance < 5

**Separator:** Pipe (`|`) for multiple matches
- Example: `Alstom Transportation Inc.|Alstom Transport Canada Inc`

**Blank if:** No Infor activity this quarter or no name match found

### Column C: Locations

**Source:** Count of `c_bpartner_location` records where `chuboe_ise_steward_id = seller_id`

**Description:** Number of business partner locations assigned to this seller

**ASSIGNED section:** Always ≥1 (that's how accounts qualify for this section)

**NOT ASSIGNED section:** Always 0 (no steward assignment)

### Column D: Months Assigned

**Source:** Database calculation from earliest interaction date

**Formula:** `(years × 12) + months` from earliest of:
- Contact activity `startdate`
- RFQ `created`
- Sales order `created`

**Why not location creation date?** Location records may predate seller employment. We use first interaction as proxy for assignment date.

**Blank if:** No interactions found (shouldn't happen for ASSIGNED accounts)

### Column E: First Assigned

**Source:** Database calculation from earliest interaction date

**Formula:** `LEAST(activity.startdate, rfq.created, order.created)` for this seller

**Format:** YYYY-MM-DD

**Purpose:** Shows when seller started working with this account

**Blank if:** No interactions found

### Column F: Last Sale Date

**Source:** Database calculation from most recent sale

**Formula:** `GREATEST(invoice.dateinvoiced, order.created)` for this seller

**Why `order.created` not `order.dateordered`?** Captures when the SO was booked, even if it's still In Progress/Draft.

**Status filter:** Includes all non-voided orders (Draft, In Progress, Completed, Closed). Excludes Voided.

**Purpose:** Shows account health - recent activity vs dormant accounts

**Blank if:** No sales activity for this seller (ever)

### Column G: Activities Q{N}

**Source:** `c_contactactivity` records via `ad_user` link

**Join logic:** `c_contactactivity.ad_user_id → ad_user.ad_user_id → ad_user.c_bpartner_id`

**Filter:** `startdate` within quarter, `salesrep_id = seller_id`, `isactive = 'Y'`

**Description:** Count of logged customer interactions (calls, emails, meetings)

**RED text (0):** Account with no logged activity this quarter (ASSIGNED section only)

### Column H: RFQ Lines Q{N}

**Source:** `chuboe_rfq → chuboe_rfq_line → chuboe_rfq_line_mpn`

**Filter:** `created` within quarter, `salesrep_id = seller_id`, `isactive = 'Y'`

**Description:** Count of RFQ line MPNs (quoted part numbers)

**RED text (0):** Account with no RFQs this quarter (ASSIGNED section only)

### Column I: CQ Lines Q{N}

**Source:** `chuboe_cq_line` joined to RFQ

**Filter:** `created` within quarter, RFQ `salesrep_id = seller_id`, `isactive = 'Y'`

**Description:** Count of customer quotes (CQs) sent

**RED text (0):** Account with no CQs this quarter (ASSIGNED section only)

### Column J: CQ Lines Won Q{N}

**Source:** `chuboe_cq_line` with `iswon = 'Y'`

**Filter:** `created` within quarter, RFQ `salesrep_id = seller_id`, `isactive = 'Y'`

**Description:** Count of CQs marked as Won

**RED text (0):** Account with no wins this quarter (ASSIGNED section only)

### Column K: Conversion Rate Q{N}

**Formula:** `CQ Lines Won / CQ Lines` (shown as percentage)

**Format:** `0.0%` (e.g., "25.0%")

**Blank if:** No CQs sent (division by zero)

**Purpose:** Sales effectiveness metric - what percentage of quotes convert to wins

### Column L: Booked GP Q{N}

**Source:** Infor "Booked Sales" CSV, column `Booked GP`

**Filter:** `CO Promise Date` within quarter, `CO Internal Salesperson = username`

**Matching:** Uses fuzzy-matched Infor customer names (Column B)

**Format:** `$#,##0.00` (e.g., "$12,345.67")

**Purpose:** Gross profit on orders booked this quarter (whether invoiced or not)

### Column M: Invoiced GP Q{N}

**Source:** Infor "Invoiced Sales" CSV, column `Invoiced GP`

**Filter:** `Date Invoiced` within quarter, `Internal Salesperson = username`

**Matching:** Uses fuzzy-matched Infor customer names (Column B)

**Format:** `$#,##0.00`

**Purpose:** Gross profit on invoices sent this quarter (revenue recognized)

### Column N: B to I Q{N}

**Formula:** `Booked GP / Invoiced GP`

**Format:** `0.00` (e.g., "1.25")

**Interpretation:**
- `> 1.0` = Booking ahead of invoicing (pipeline growth)
- `< 1.0` = Invoicing backlog (pipeline consumption)
- `= 1.0` = Balanced

**Blank if:** Invoiced GP is zero (division by zero)

### Column O: % of Inv Total Q{N}

**Formula:** `Account Invoiced GP / Total Invoiced GP for seller`

**Format:** `0.0%` (e.g., "15.3%")

**Purpose:** Account concentration - what percentage of total invoiced GP came from this account

**Blank if:** Total invoiced GP is zero

### Column P: Scheduled GP Q{N+1}

**Source:** Infor "Booked Sales" CSV, column `Booked GP`

**Filter:**
- `CO Promise Date` within NEXT quarter (e.g., Jul 1 - Sep 30 for Q3)
- `CO Ship Date` is BLANK (not yet shipped)
- `CO Internal Salesperson = username`

**Format:** `$#,##0.00`

**Purpose:** Pipeline visibility - orders scheduled to ship next quarter that haven't invoiced yet

**Why next quarter?** Review Q2 → set Q3 strategy → see Q3 pipeline

### Column Q: GP Target Q{N+1}

**Source:** Sales Goals file, column `Invoice GP Goal`

**Filter:** `ISE Name = username`, `Goal Quarter = Q{N+1}`, `Goal Year = year`

**Calculation:** Sum of all monthly goals for the quarter

**Format:** `$#,##0.00`

**Editable:** Yes (manual entry, not formula)

**Purpose:** Goal-setting for next quarter

**Row 2 (GP Goal row):** Shows quarterly goal total in Column P

### Column R: Delta Q{N+1}

**Formula:** `Scheduled GP - GP Target`

**Format:** `$#,##0.00`

**Color coding:**
- GREEN text = positive (ahead of target)
- RED text = negative (below target)

**Purpose:** Gap analysis - how much additional pipeline needed to hit goal

### Column S: Quarter Strategies Q{N+1}

**Source:** Manual entry

**Format:** Text (multi-line supported)

**Purpose:** Action items and strategic notes for next quarter

---

## Visual Indicators

### RED Zeros (ASSIGNED Section Only)

**Columns affected:** G (Activities), H (RFQ Lines), I (CQ Lines), J (CQ Lines Won)

**Rule:** If metric = 0, display in RED bold font

**Purpose:** Quickly identify inactive assigned accounts needing attention

**Not applied in NOT ASSIGNED section** — transactional accounts expected to have sporadic activity

### Delta Color Coding

**Column R (Delta):**
- Positive values (≥0) = GREEN text
- Negative values (<0) = RED text

**Purpose:** Visual gap to goal

---

## Troubleshooting

### Issue: "No accounts found for seller"

**Possible causes:**
1. Wrong Infor username (case-sensitive in OT username lookup)
2. Seller has no assigned locations in OT
3. Seller had no activity in specified quarter

**Fix:**
- Verify username matches `ad_user.name` in OT database
- Check `c_bpartner_location.chuboe_ise_steward_id` for assignments
- Try a different quarter with known activity

### Issue: "Scheduled GP showing $0"

**Possible causes:**
1. Infor CSV file is outdated (not refreshed this week)
2. No orders with blank ship date and promise date in next quarter
3. Infor username mismatch (case-sensitive)

**Fix:**
- Download fresh Infor "Booked Sales" CSV
- Verify username matches `CO Internal Salesperson` exactly
- Check promise dates - they must fall in Q{N+1}

### Issue: "GP totals don't match Infor pivot tables"

**Possible causes:**
1. Customer name matching failed (OT name vs Infor name)
2. Quarter date boundaries differ
3. Infor filters include/exclude certain order types

**Debug:**
- Check script console output for customer matching results
- Look for "✗ Customer Name (no match)" messages
- Verify date ranges: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
- Check Infor CSVs for null/blank customer names

### Issue: "Months Assigned shows pre-employment dates"

**Possible causes:**
1. Activity records predate seller's employment (legacy data)
2. Location assignment predates seller (transferred accounts)

**Expected behavior:**
- Script uses EARLIEST interaction (activity/RFQ/order) as assignment proxy
- If account was transferred from another seller, early dates may appear
- This is informational - shows full account history with any seller

**Not a bug:** Months Assigned counts from first interaction, which may include pre-hire activity if account was transferred

### Issue: "Last Sale Date is blank but I sold to them this quarter"

**Possible causes:**
1. Sale was voided (`docstatus = 'VO'`)
2. Order hasn't been created yet (in RFQ/CQ stage only)
3. Different seller's order (not assigned to you in `salesrep_id`)

**Fix:**
- Check order status in OT - Voided orders excluded
- Confirm order was actually created (not just quoted)
- Verify `salesrep_id` on order matches your user ID

### Issue: "Excel file won't open"

**Possible causes:**
1. File path contains unsupported characters
2. ExcelJS library version mismatch
3. Disk space full

**Fix:**
- Check file was created (script outputs full path)
- Verify `exceljs` package installed: `npm list exceljs`
- Check disk space: `df -h ~/workspace`

---

## Data Refresh Cadence

| Data Source | Update Frequency | Owner | Notes |
|-------------|------------------|-------|-------|
| OT Database | Real-time | Automatic | No manual steps |
| Infor Booked Sales CSV | Weekly | Melissa | Download before quarterly reviews |
| Infor Invoiced Sales CSV | Weekly | Melissa | Download before quarterly reviews |
| Sales Goals File | Quarterly | Management | Download when goals change |

**Best practice:** Download fresh Infor CSVs the day before quarterly review meetings to ensure current pipeline data.

---

## Known Limitations

1. **Customer name matching is fuzzy** — May miss matches if OT and Infor names are very different. Review console output for "no match" warnings.

2. **Scheduled GP only shows next quarter** — If you want Q4 pipeline while reviewing Q2, you'd need to modify the script. Current design: always shows quarter N+1.

3. **No historical trending** — Report shows one quarter at a time. For Q-over-Q comparison, generate two reports and manually compare.

4. **Manual Infor CSV downloads** — Script cannot auto-fetch from Infor. Requires manual download and file placement.

5. **GP Target is quarterly** — If seller has different monthly goals, the quarterly total may mask monthly variations.

---

## Future Enhancements

See `account-review-roadmap.md` for planned improvements:
- Batch mode (all sellers at once)
- Historical trend analysis (Q-over-Q)
- Auto-fetch Infor CSVs (if API available)
- Customer name mapping database
- Scheduled GP breakdown by order status

---

## Related Documentation

- **Roadmap:** `account-review-roadmap.md`
- **Session History:** `~/workspace/MEMORY.md` (Recent Sessions)
- **Data Model:** `~/workspace/astute-workinstructions/shared/data-model.md`
- **Infor Data Sources:** `~/workspace/astute-workinstructions/Sales Pulse Daily/data/`

---

## Support

**Questions or issues?** Contact Melissa Bojar (melissa.bojar@astutegroup.com)

**Bug reports:** Document the issue with:
- Command used
- Error message (full stack trace)
- Expected vs actual results
- Input file dates and locations
