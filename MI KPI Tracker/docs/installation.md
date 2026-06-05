# Installation Guide - MI KPI Tracker

Complete setup instructions for the Material Inspection KPI automation system.

## Prerequisites

### Required Software

1. **Node.js** (v18.0.0 or higher)
   - Download: https://nodejs.org
   - Verify installation:
   ```bash
   node --version  # Should show v18.0.0 or higher
   npm --version   # Should show 8.0.0 or higher
   ```

2. **PostgreSQL Client** (psql)
   - Should already be configured on your system
   - Verify connection:
   ```bash
   psql -d idempiere_replica -c "SELECT current_database();"
   ```

3. **Git** (for cloning repository)
   - Download: https://git-scm.com
   - Verify:
   ```bash
   git --version
   ```

### Required Access

- **Database Access:** Read-only SELECT permission on `idempiere_replica` database
- **Network Access:** Ability to connect to iDempiere PostgreSQL server
- **File System:** Write permission to save Excel output files

---

## Installation Steps

### Step 1: Clone Repository

```bash
# Clone from GitHub
git clone https://github.com/YOUR-USERNAME/mi-kpi-tracker.git

# Navigate to project directory
cd mi-kpi-tracker
```

### Step 2: Install Dependencies

```bash
# Install all required npm packages
npm install
```

This installs:
- `xlsx@^0.18.5` - Excel file generation library

### Step 3: Verify Database Connection

Test that you can connect to the iDempiere database:

```bash
# Test basic connection
psql -d idempiere_replica -c "SELECT COUNT(*) FROM adempiere.ad_user WHERE name = 'Daisy Mendoza';"
```

**Expected output:** Should return a count (likely `1`)

If this fails, contact your database administrator to verify:
- Database name: `idempiere_replica`
- Schema access: `adempiere`
- Connection credentials are configured

### Step 4: Test Script Execution

Run a test to ensure everything works:

```bash
# Run the v6 script (generates report for previous month)
npm run report:v6
```

**Expected output:**
- Console log showing OTINs processed
- New file created: `mi_kpi_report_YYYY-MM_v6.xlsx`
- File should contain multiple sheets (Summary, Inspection Log, etc.)

---

## Configuration

### Inspector List

By default, scripts track these Austin inspectors:
- Jacob DeWit
- Daisy Mendoza
- Ofelio Martinez
- Juan Serrano
- Jacob Palmertree
- Sharanya Sarkar

**To modify for another site (Hong Kong, Stevenage, etc.):**

1. Open script file: `scripts/mi_kpi_report_v6.js`
2. Find the `austin_inspectors` CTE (around line 50)
3. Update the inspector names:

```javascript
WITH austin_inspectors AS (
    SELECT ad_user_id, name FROM adempiere.ad_user
    WHERE name IN (
        'Inspector Name 1',
        'Inspector Name 2',
        'Inspector Name 3'
    )
)
```

4. Repeat for `scripts/mi_kpi_report_manual_method.js`

**Finding inspector names:**
```bash
psql -d idempiere_replica -c "SELECT name FROM adempiere.ad_user WHERE name LIKE '%keyword%';"
```

### Target Month

**Default behavior:** Scripts generate reports for the **previous month**.

**To specify a different month:**

1. Open the script file
2. Find the date range WHERE clause (around line 60)
3. Modify the dates:

```sql
WHERE pick.startdate >= '2026-05-01'  -- First day of target month
  AND pick.startdate < '2026-06-01'   -- First day of NEXT month
```

### Output Directory

**Default:** Files are saved to the current working directory

**To change output location:**

1. Open script file
2. Find the `XLSX.writeFile()` call (near end of script)
3. Modify the file path:

```javascript
XLSX.writeFile(wb, '/path/to/output/mi_kpi_report_2026-05_v6.xlsx');
```

---

## Usage

### Generate Reports

**v6 Report (RECOMMENDED):**
```bash
npm run report:v6
```
Output: `mi_kpi_report_YYYY-MM_v6.xlsx`

**Manual Method (for validation):**
```bash
npm run report:manual
```
Output: `mi_kpi_report_YYYY-MM_MANUAL_METHOD.xlsx`

**Run Validation:**
```bash
npm run validate
```
Compares automated vs manual tracker (requires manual Excel file)

### Alternative: Direct Node Execution

```bash
node scripts/mi_kpi_report_v6.js
node scripts/mi_kpi_report_manual_method.js
node validation/compare_may_v6_vs_manual.js
```

---

## Automated Scheduling

### Linux/Mac (cron)

Add to crontab:
```bash
# Edit crontab
crontab -e

# Add this line to run on 3rd day of month at 6 AM
0 6 3 * * cd /path/to/mi-kpi-tracker && /usr/bin/node scripts/mi_kpi_report_v6.js
```

**Why 3rd day?**
- Allows 2-3 days for inspection validation
- Ensures DC/LC counts are finalized
- Improves accuracy vs manual tracker

### Windows (Task Scheduler)

1. Open Task Scheduler
2. Create Basic Task
3. Trigger: Monthly, 3rd day at 6:00 AM
4. Action: Start a program
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `scripts/mi_kpi_report_v6.js`
   - Start in: `C:\path\to\mi-kpi-tracker`

---

## Troubleshooting

### "Cannot find module 'xlsx'"

**Problem:** Dependencies not installed

**Solution:**
```bash
npm install
```

### "Could not connect to database"

**Problem:** Database connection not configured

**Solutions:**
1. Verify psql works: `psql -d idempiere_replica -c "SELECT 1;"`
2. Check connection string in environment
3. Contact database admin for credentials

### "No data found for month"

**Problem:** No picks in target month OR inspector names don't match

**Solutions:**
1. Verify inspectors exist:
   ```bash
   psql -d idempiere_replica -c "SELECT name FROM adempiere.ad_user WHERE name LIKE '%Mendoza%';"
   ```
2. Check pick dates:
   ```bash
   psql -d idempiere_replica -c "SELECT MIN(startdate), MAX(startdate) FROM adempiere.chuboe_po_userpick;"
   ```
3. Ensure inspector names match exactly (case-sensitive)

### "Permission denied" on database query

**Problem:** User doesn't have SELECT permission

**Solution:**
- Contact database administrator
- Request read-only access to:
  - `adempiere.chuboe_po_userpick`
  - `adempiere.chuboe_insp_mpnlot_v`
  - `adempiere.chuboe_insp_lot_lnk`
  - `adempiere.chuboe_insp`
  - `adempiere.chuboe_insp_datelotcode`
  - `adempiere.ad_user`

### Output file is corrupted

**Problem:** Script interrupted mid-write OR disk full

**Solutions:**
1. Delete partial file and re-run
2. Check disk space: `df -h`
3. Verify write permissions on output directory

### Results don't match manual tracker

**Expected:** 87-95% match (Task 1 uses manual methodology)

**If significantly different:**
1. Run validation script: `npm run validate`
2. Check date range matches manual period
3. Verify inspector list is complete
4. Review DC/LC count differences
5. Check for picks on last day of previous month

---

## Verification Checklist

After installation, verify:

- [ ] Node.js v18+ installed
- [ ] npm packages installed (`npm install` completed)
- [ ] Database connection works (`psql` test successful)
- [ ] v6 script runs without errors (`npm run report:v6`)
- [ ] Output file generated and opens in Excel
- [ ] Summary sheet shows expected KPI totals
- [ ] Inspection Log sheet has detailed rows
- [ ] Inspector names appear correctly

---

## Directory Structure

After installation:

```
mi-kpi-tracker/
├── node_modules/          # npm packages (created by npm install)
├── scripts/
│   ├── mi_kpi_report_v6.js
│   ├── mi_kpi_report_manual_method.js
│   └── README.md
├── docs/
│   ├── database-schema.md
│   └── installation.md    # This file
├── examples/
│   └── dashboard-may-2026.png
├── validation/
│   └── compare_may_v6_vs_manual.js
├── package.json
├── package-lock.json      # Created after npm install
├── README.md
├── PROJECT_SUMMARY.md
└── methodology_comparison.md
```

---

## Deployment Checklist

For production deployment:

- [ ] Install on server with scheduled access to database
- [ ] Set up automated scheduling (cron/Task Scheduler)
- [ ] Configure output directory (shared drive/network location)
- [ ] Test monthly run at least once manually
- [ ] Document any site-specific customizations
- [ ] Add monitoring/alerting for failed runs
- [ ] Set up email notifications (optional)
- [ ] Create backup of manual Excel tracker for validation

---

## Upgrading

To update to a newer version:

```bash
# Pull latest changes
git pull origin main

# Update dependencies
npm install

# Test new version
npm run report:v6
```

---

## Uninstallation

To remove the system:

```bash
# Remove node packages
rm -rf node_modules/
rm package-lock.json

# Remove entire directory
cd ..
rm -rf mi-kpi-tracker/
```

**Note:** This does not affect the database or any generated Excel files.

---

## Support

**Installation Issues:**
- Check Node.js version: `node --version`
- Check npm version: `npm --version`
- Verify database connection: `psql -d idempiere_replica`

**Script Errors:**
- Review script output for specific error messages
- Check `docs/database-schema.md` for table structure
- Consult `scripts/README.md` for usage details

**Access/Permission Issues:**
- Contact database administrator
- Verify user has read-only SELECT permission

**General Questions:**
- Material Inspection Manager
- Analytics Team
- iDempiere Support

---

## Next Steps

After successful installation:

1. **Run first report:** `npm run report:v6`
2. **Review output:** Open generated Excel file
3. **Validate accuracy:** Compare to manual tracker (if available)
4. **Set up automation:** Add to cron/Task Scheduler
5. **Document customizations:** Note any site-specific changes

---

**Last Updated:** June 2026
**Version:** 1.0.0
