# MI KPI Report Scripts

Production scripts for generating Material Inspection KPI reports.

## Scripts

### 1. mi_kpi_report_v6.js (RECOMMENDED)
**Enhanced tracker with Additional Inspection weights**

**What it does:**
- Counts distinct OTINs (each OTIN counted once)
- Uses differentiated tier weights (T1-P: 0.75, T1-A: 1.0, T1-M: 0.5, etc.)
- Includes Additional Inspection weights (+0.2 per type)
- Generates comprehensive Excel report with multiple sheets

**Output:** `mi_kpi_report_YYYY-MM_v6.xlsx`

**Run:**
```bash
node scripts/mi_kpi_report_v6.js
```

or

```bash
npm run report:v6
```

### 2. mi_kpi_report_manual_method.js
**Replicates existing manual tracker methodology**

**What it does:**
- Line-by-line counting (non-distinct OTINs)
- Uses flat tier weights (all T1=1.0, T2=2.0, etc.)
- Matches manual Excel tracking process
- Used for validation and comparison

**Output:** `mi_kpi_report_YYYY-MM_MANUAL_METHOD.xlsx`

**Run:**
```bash
node scripts/mi_kpi_report_manual_method.js
```

or

```bash
npm run report:manual
```

---

## Prerequisites

### 1. Node.js
- Node.js v18 or higher
- Install from: https://nodejs.org

### 2. Database Access
- Read-only access to `idempiere_replica` PostgreSQL database
- Connection should be pre-configured in your environment
- Required schemas: `adempiere`

### 3. Dependencies
Install required npm packages:
```bash
npm install
```

This installs:
- `xlsx` - Excel file generation

---

## Configuration

### Inspector List
Scripts are configured to track these Austin inspectors:
- Jacob DeWit
- Daisy Mendoza
- Ofelio Martinez
- Juan Serrano
- Jacob Palmertree
- Sharanya Sarkar

To modify the inspector list, edit the SQL query in each script:
```javascript
WHERE name IN ('Inspector Name 1', 'Inspector Name 2', ...)
```

### Date Range
By default, scripts generate reports for the previous month.

To specify a different month, modify the date range in the script:
```javascript
WHERE pick.startdate >= '2026-MM-01'
  AND pick.startdate < '2026-MM+1-01'
```

---

## Output Files

### v6 Report Sheets:
1. **Summary** - Overall KPI totals and targets
2. **Inspection Log** - Detailed OTIN-level breakdown
3. **Kickbacks** - Parts requiring re-work
4. **Service Sends** - External service tracking
5. **Daily Volume** - Day-by-day inspection counts
6. **Recommendations** - Automated insights

### Manual Method Report Sheets:
1. **Summary** - Overall KPI totals
2. **Inspection Lines** - Line-by-line breakdown (matches manual)
3. **Comparison** - Gap analysis vs expected

---

## Formula Reference

### v6 Formula (with Additional Inspections):
```
KPI = DC/LC Count × (Base Tier Weight + Additional Inspection Weights)

Base Tier Weights:
- T1 Passive: 0.75
- T1 Active: 1.0
- T1 Master: 0.5
- T2: 2.0
- T3: 3.0
- T4 (AS6171): 4.0

Additional Inspection Weights (+0.2 each):
- Decapsulation
- Solderability
- SEM
- Scrape
- Destructive Sampling
- Non-conforming conditions
```

### Manual Method Formula:
```
KPI = DC/LC Count × Flat Tier Weight

Flat Tier Weights:
- All T1 types: 1.0
- T2: 2.0
- T3: 3.0
- T4: 4.0
```

---

## Troubleshooting

### "Cannot connect to database"
- Verify PostgreSQL client is installed
- Check database credentials and connection string
- Ensure you have read access to `idempiere_replica`

### "Module not found: xlsx"
- Run `npm install` in the project root directory

### "No data found for month"
- Verify inspectors completed picks in the target month
- Check inspector names match database exactly (case-sensitive)
- Ensure picks are marked as active (`isactive = 'Y'`)

### Output file is empty
- Check date range in script matches intended month
- Verify picks exist in `chuboe_po_userpick` table
- Ensure inspections are linked in `chuboe_insp_lot_lnk`

---

## Schedule / Automation

### Recommended Run Schedule:
**Monthly:** 1st business day of following month (e.g., run June 3rd for May data)

**Why wait 2-3 days?**
- Allows time for inspection validation
- Ensures DC/LC counts are finalized
- Improves match accuracy with manual tracker

### Automated Execution:
Add to cron (Linux/Mac):
```bash
# Run on 3rd day of each month at 6 AM
0 6 3 * * cd /path/to/mi-kpi-tracker && node scripts/mi_kpi_report_v6.js
```

Or use Windows Task Scheduler for automated runs.

---

## Validation

To validate automation accuracy against manual tracker:
```bash
npm run validate
```

This runs `validation/compare_may_v6_vs_manual.js` which:
- Compares automated output to manual Excel tracker
- Identifies missing OTINs and DC/LC differences
- Calculates gap analysis

---

## Support

For questions or issues:
1. Check database schema documentation: `docs/database-schema.md`
2. Review installation guide: `docs/installation.md`
3. Contact: Material Inspection Manager or Analytics Team

---

## Version History

**v1.0.0** (June 2026)
- Initial release
- v6 script with Additional Inspections
- Manual method replication for validation
- Comprehensive Excel output with multiple sheets
