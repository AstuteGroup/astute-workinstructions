# Account Review Automation

Generate quarterly account review reports for inside sales reps showing account performance metrics, pipeline, and context.

## Quick Start

```bash
# Navigate to this folder
cd ~/workspace/astute-workinstructions/Sales\ Operations/Account\ Review

# Generate report for Aaron Mendoza, Q2 2026
node generate-account-review.js aaromend 2026 2

# Output saved to:
# output/Account Review - Aaron_Mendoza - Q3_2026.xlsx
```

## Documentation

- **[account-review-workflow.md](account-review-workflow.md)** — Complete user guide with command-line usage, column reference, troubleshooting
- **[account-review-roadmap.md](account-review-roadmap.md)** — Completed features and future enhancements

## Folder Structure

```
Account Review/
├── README.md                          ← You are here
├── generate-account-review.js         ← Main script
├── account-review-workflow.md         ← User documentation
├── account-review-roadmap.md          ← Roadmap
├── Sales Goals 25-26 - INC - SharePoint.xlsx  ← Input: GP goals
├── output/                            ← Generated reports
│   ├── Account Review - Aaron_Mendoza - Q3_2026.xlsx
│   ├── Account Review - Carlos_Carrasco - Q2_2026.xlsx
│   └── Account Review - Daniel_Reiser - Q3_2026.xlsx
├── examples/                          ← Reference materials
│   ├── Account Reviews - Aaron Mendoza Example.xlsx
│   ├── Aaron Q2 Excel Check.png
│   └── Aaron Q2 Snipping - Invoiced Check.png
└── dev/                               ← Development scripts
    ├── check-all-aaron-2026.js
    ├── debug-infor-parsing.js
    ├── test-fuzzy-matching.js
    └── verify-booked-gp.js
```

## Prerequisites

Three input files must be manually downloaded and placed in the correct locations:

### 1. Booked Sales CSV
- **Location:** `~/workspace/astute-workinstructions/Sales Pulse Daily/data/`
- **Filename:** `Infor Booked Sales by Line YTD - M.DD.YY.csv`
- **Source:** Infor ERP export

### 2. Invoiced Sales CSV
- **Location:** `~/workspace/astute-workinstructions/Sales Pulse Daily/data/`
- **Filename:** `Invoiced Sales YYYY by Line - M.DD.YY.csv`
- **Source:** Infor ERP export

### 3. Sales Goals File
- **Location:** This folder
- **Filename:** `Sales Goals 25-26 - INC - SharePoint.xlsx`
- **Source:** SharePoint (downloaded manually)

## Usage Examples

```bash
# Q1 2026 for Aaron Mendoza
node generate-account-review.js aaromend 2026 1

# Q3 2026 for Daniel Reiser
node generate-account-review.js dreiser 2026 3

# Q4 2025 for Jake Mcaloose
node generate-account-review.js jmcaloos 2026 4
```

## Output Format

Report filename: `Account Review - {Seller_Name} - Q{N+1}_{YEAR}.xlsx`

Tab name: `{Seller Name} - Q{N+1} {YEAR}`
- Example: "Aaron Mendoza - Q3 2026"
- Note: Shows NEXT quarter (planning) while reviewing PREVIOUS quarter's performance

Report sections:
1. **ASSIGNED ACCOUNTS** — Business partners with ISE Steward assignment
2. **NOT ASSIGNED** — Activity without formal assignment (potential opportunities)

18 columns including:
- Account context (OT name, Infor name, locations, assignment dates)
- Historical metrics (Activities, RFQs, CQs, conversions, GP)
- Planning (Scheduled GP, GP Target, Strategies)

## Key Features

✅ Automated OT database queries for pre-sales metrics
✅ Infor CSV parsing for post-sales GP data
✅ Fuzzy customer name matching (OT ↔ Infor)
✅ Account context columns (months assigned, first assigned, last sale date)
✅ Visual indicators for inactive accounts (RED zeros)
✅ GP goal integration from SharePoint file
✅ Scheduled pipeline for next quarter
✅ Parameterized for any seller/quarter
✅ CSV parsing handles company names with commas

## Status

**Production-ready** — All core automation features complete (2026-07-16)

See [account-review-roadmap.md](account-review-roadmap.md) for backlog items.

## Support

**Questions or issues?** Contact Melissa Bojar (melissa.bojar@astutegroup.com)
