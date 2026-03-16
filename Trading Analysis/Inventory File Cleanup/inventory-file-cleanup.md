# Inventory File Cleanup Workflow

Processes Infor ERP inventory exports (AST Item Lots Report) into formats ready for iDempiere import and industry portal uploads.

---

## Automated Mode (Recommended)

The workflow runs **automatically every Monday at 6 AM EST** via cron job. No manual intervention required.

### How It Works

1. **Infor sends** the AST Item Lots Report via automated task every Monday morning
2. **Email auto-forwards** to `excess@orangetsunami.com` inbox
3. **Cron job runs** at 6 AM EST, fetches the email, downloads attachment
4. **Script processes** the file (clean, dedupe, split, export)
5. **Two emails sent** to jake.harris@astutegroup.com:
   - **"Netcomponents Upload"** — consolidated portal CSV attached
   - **"OT Inventory Upload"** — zipped Chuboe files for iDempiere
6. **Source email moved** to `Inventory-Processed` folder

### Email Configuration

| Setting | Value |
|---------|-------|
| Source Inbox | `excess@orangetsunami.com` |
| Subject Pattern | `Task finished: [success] NNNNNN AST Item Lots Report Inputs` |
| Recipient | jake.harris@astutegroup.com |
| Schedule | Every Monday, 6 AM EST (11:00 UTC) |
| Processed Folder | `Inventory-Processed` |

### Failure Notification

If processing fails (no email found, attachment missing, processing error), a failure notification is sent to jake.harris@astutegroup.com with error details.

### Manual Fetch

To run the automated fetch manually (e.g., to test or reprocess):

```bash
cd ~/workspace/astute-workinstructions/Trading\ Analysis/Inventory\ File\ Cleanup
node inventory_cleanup.js fetch
```

### Cron Job

```
0 11 * * 1 cd /home/analytics_user/workspace/astute-workinstructions/Trading\ Analysis/Inventory\ File\ Cleanup && /usr/bin/node inventory_cleanup.js fetch >> /tmp/inventory-cleanup.log 2>&1
```

### Logs

Check `/tmp/inventory-cleanup.log` for cron execution history.

---

## Manual Mode

For processing files manually (e.g., ad-hoc reports, testing):

```bash
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_XXXXXXX.xlsx"
```

---

## Background

This workflow replaces the Excel VBA macros previously used to clean and split inventory files. The original macros performed:

1. **Header/Footer Removal** - Delete rows 1-7 (Infor report header) and footer rows (Page x of y, username)
2. **Deduplication** - Remove duplicate rows based on composite key
3. **Warehouse Splitting** - Separate inventory by warehouse code into individual worksheets
4. **Chuboe Formatting** - Transform columns to match iDempiere import template
5. **Consignment Handling** - Blank out pricing for consignment inventory

The Node.js script `inventory_cleanup.js` replicates this logic and adds the consolidated portal export. (Python version also available but requires Python environment.)

---

## Input Requirements

**Source:** Infor ERP → AST Item Lots Report
**Format:** Excel (.xlsx) or CSV
**Filename Pattern:** `ASTItemLotsReportInputs_*.xlsx` or `ASTItemLotsReportInputs_*.csv`

### Expected Input Structure

| Row | Content |
|-----|---------|
| 1-7 | Report header (title, date, parameters) - **deleted** |
| 8 | Column headers |
| 9+ | Data rows |
| Last rows | Footer (Page x of y, username) - **deleted** |

### Required Input Columns

| Column | Description | Used For |
|--------|-------------|----------|
| Item | Part number (MPN) | Chuboe_MPN, dedup key |
| ItemDescription | Part description | Description |
| Name | Manufacturer name | Chuboe_MFR_Text |
| Lot | Lot identifier | Chuboe_Package_Desc, dedup key |
| Lot Quantity | Quantity on hand | Qty |
| Lot Unit Cost | Unit cost | PriceEntered (blanked for consignment) |
| Date Code | Date code | Chuboe_Date_Code |
| Location | Bin location | Chuboe_Package_Desc, dedup key |
| Warehouse | Warehouse code (W102, W103, etc.) | Splitting logic |
| Warehouse Name | Warehouse description | Dedup key |
| Site | Site identifier | Dedup key |
| Date Lot | Lot date | Dedup key |
| Currency | Currency code | Portal export |

---

## Workflow Steps

### Step 1: Obtain the Export

1. Run AST Item Lots Report in Infor
2. Export to Excel (.xlsx)
3. Commit and push to: `Trading Analysis/Inventory File Cleanup/`

### Step 2: Run the Cleanup Script

```bash
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_XXXXXXX.xlsx"
```

Output folder is automatically created as `Inventory YYYY-MM-DD/` (today's date).

The script will:
- Remove header rows 1-7
- Remove footer rows (Page x of y, username patterns)
- Deduplicate based on composite key: `Item|Lot|Location|Warehouse Name|Site|Date Lot`
- Split into warehouse groups
- Export Chuboe-formatted CSVs
- Export consolidated portal file
- Export cleaned master file
- Export duplicates file (for review)

### Step 3: Review Output

Check the console output for:
- Number of rows processed
- Number of duplicates removed
- Row counts per warehouse group
- Any unmatched rows (not assigned to a warehouse group)

### Step 4: Load to iDempiere

Upload the `{WarehouseCode}_{GroupName}.csv` files via Chuboe import process (one file per warehouse group).

In automated mode, these files are zipped and emailed as "OT Inventory Upload".

### Step 5: Upload to Portals (TBD)

The `consolidated_portal_*.csv` file needs to be transformed to match portal-specific templates:
- **NetComponents:** Template format TBD
- **IC Source:** Template format TBD

---

## Warehouse Groups

The script splits inventory into these groups based on Warehouse code and optional filters:

### Free Stock (Available for Sale)

| Group | Warehouse Code(s) | Filter | Notes |
|-------|-------------------|--------|-------|
| Free_Stock_Austin | W104, W112 | Name ≠ Positronic | Main US inventory |
| Free_Stock_Stevenage | W102 | — | UK inventory |
| Free_Stock_Hong_Kong | W108, W113 | — | HK inventory |
| Free_Stock_Philippines | W109, W114 | — | PH inventory |

### Franchise Stock

| Group | Warehouse Code(s) | Filter | Notes |
|-------|-------------------|--------|-------|
| Franchise_Stock | W104 | Name = Positronic | Positronic franchise parts |

### Consignment (Prices Blanked)

| Group | Warehouse Code(s) | Notes |
|-------|-------------------|-------|
| GE_Consignment | W103 | GE consignment inventory |
| Taxan_Consignment | W106 | Taxan consignment |
| Spartronics_Consignment | W107 | Spartronics consignment |
| LAM_Consignment | W118 | LAM Research consignment |
| Eaton_Consignment | W117 | Eaton consignment |

**Note:** Consignment groups have `PriceEntered` blanked in output to protect confidential pricing.

### Other

| Group | Warehouse Code(s) | Output Filename | Notes |
|-------|-------------------|-----------------|-------|
| LAM_Dead_Inventory | W115 | W115_LAM_Dead_Inventory.csv | LAM dead stock |
| LAM_3PL | W111 | W111_LAM_3PL.csv | LAM 3PL managed |
| SPE_ATX | W112 | W112_SPE_ATX.csv | SPE Austin |
| Allocated_Warehouse | MAIN | MAIN_Allocated_Warehouse.csv | Main allocated warehouse |
| HK_Allocated_Warehouse | W105 | W105_HK_Allocated_Warehouse.csv | Hong Kong allocated warehouse |

### Excluded (Intentionally Unmatched)

| Warehouse Code | Reason |
|----------------|--------|
| W110 | Not used for Chuboe import |
| W116 | Not used for Chuboe import |

Rows with these warehouse codes appear in "Unmatched" count but are intentionally excluded.

---

## Chuboe Column Mapping

The Chuboe format is used for iDempiere Market Offer import. Column mapping:

| Chuboe Column | Source | Notes |
|---------------|--------|-------|
| Chuboe_Offer_ID[Value] | (blank) | Generated by iDempiere |
| Chuboe_MPN | Item | Part number |
| Chuboe_MFR_ID[Value] | (blank) | Matched by iDempiere |
| Chuboe_MFR_Text | Name | Manufacturer name |
| Qty | Lot Quantity | Quantity (commas removed) |
| Chuboe_Lead_Time | (blank) | — |
| Chuboe_Package_Desc | Lot;Location | Concatenated with semicolon |
| C_Country_ID[Name] | (blank) | — |
| Chuboe_Date_Code | Date Code | — |
| C_Currency_ID[ISO_Code] | (blank) | — |
| Description | ItemDescription | — |
| IsActive | (blank) | — |
| Chuboe_MPN_Clean | (blank) | — |
| Chuboe_CPC | (blank) | — |
| PriceEntered | Lot Unit Cost | **Blanked for consignment groups** |
| Chuboe_MOQ | (blank) | — |
| Chuboe_SPQ | (blank) | — |

---

## Portal Export Format

### Current Output (Generic)

The `consolidated_portal_*.csv` contains all deduplicated inventory with these columns:

| Column | Source |
|--------|--------|
| Item | Item |
| ItemDescription | ItemDescription |
| Name | Name |
| Lot Quantity | Lot Quantity |
| Date Code | Date Code |
| Lot Unit Cost | Lot Unit Cost |
| Currency | Currency |
| Warehouse Name | Warehouse Name |
| Location | Location |

### NetComponents Template (TBD)

Required columns and format to be documented once spec is obtained.

### IC Source Template (TBD)

Required columns and format to be documented once spec is obtained.

---

## Output Files

All output files are saved to a dated folder: `Inventory YYYY-MM-DD/`

| File | Description |
|------|-------------|
| `{WarehouseCode}_{GroupName}.csv` | Chuboe format for iDempiere (one per warehouse group) |
| `OT_Chuboe_Files_YYYY-MM-DD.zip` | Zipped archive of all Chuboe CSVs (emailed) |
| `consolidated_portal_{timestamp}.csv` | All inventory for portal upload (emailed) |
| `inventory_cleaned_{timestamp}.csv` | Full cleaned/deduped master file |
| `duplicates_{timestamp}.csv` | Removed duplicates (for audit/review) |

### File Naming Convention

Output files use the format `{WarehouseCode}_{GroupName}.csv`:

| Example Filename | Warehouse | Group |
|------------------|-----------|-------|
| W102_Free_Stock_Stevenage.csv | W102 | Free_Stock_Stevenage |
| W103_GE_Consignment.csv | W103 | GE_Consignment |
| W104_Franchise_Stock.csv | W104 | Franchise_Stock |
| W104_W112_Free_Stock_Austin.csv | W104, W112 | Free_Stock_Austin |
| W105_HK_Allocated_Warehouse.csv | W105 | HK_Allocated_Warehouse |
| W106_Taxan_Consignment.csv | W106 | Taxan_Consignment |
| W107_Spartronics_Consignment.csv | W107 | Spartronics_Consignment |
| W108_W113_Free_Stock_Hong_Kong.csv | W108, W113 | Free_Stock_Hong_Kong |
| W109_W114_Free_Stock_Philippines.csv | W109, W114 | Free_Stock_Philippines |
| W111_LAM_3PL.csv | W111 | LAM_3PL |
| W115_LAM_Dead_Inventory.csv | W115 | LAM_Dead_Inventory |
| W117_Eaton_Consignment.csv | W117 | Eaton_Consignment |
| W118_LAM_Consignment.csv | W118 | LAM_Consignment |
| MAIN_Allocated_Warehouse.csv | MAIN | Allocated_Warehouse |

---

## File Retention Policy

**Weekly cleanup after output approval:**

1. **Delete input file** - Remove the `ASTItemLotsReportInputs_*.xlsx` after outputs are approved
2. **Delete previous output folder** - When creating a new `Inventory YYYY-MM-DD/` folder, delete the previous week's folder
3. **Keep only current week** - Only one dated output folder should exist at a time

This keeps the repo clean and avoids accumulating large inventory files.

---

## Deduplication Logic

Rows are considered duplicates if all of these fields match (case-insensitive):

1. Item (part number)
2. Lot
3. Location
4. Warehouse Name
5. Site
6. Date Lot

The first occurrence is kept; subsequent duplicates are written to `duplicates_*.csv` for review.

---

## Usage Examples

### Basic Usage (Node.js - recommended)
```bash
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_4544132.xlsx"
```

Output automatically goes to `Inventory YYYY-MM-DD/` folder.

### With Custom Output Directory
```bash
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_4544132.xlsx" ./custom-output
```

### Sample Console Output
```
Processing: ASTItemLotsReportInputs_USS_4557834.xlsx
Output directory: Inventory 2026-03-16
------------------------------------------------------------
Step 1: Reading and cleaning file...
  - Headers found: 31 columns
  - Data rows read: 5712

Step 2: Deduplicating...
  - Unique rows: 5694
  - Duplicate rows removed: 18

Step 3: Splitting by warehouse group...
  - Allocated_Warehouse: 427 rows
  - Eaton_Consignment: 4 rows
  - Franchise_Stock: 82 rows
  - Free_Stock_Austin: 483 rows
  - GE_Consignment: 1496 rows
  - HK_Allocated_Warehouse: 631 rows
  ...

Step 4: Exporting Chuboe format files...
  - Saved: MAIN_Allocated_Warehouse.csv (427 rows)
  - Saved: W117_Eaton_Consignment.csv (4 rows)
  - Saved: W104_Franchise_Stock.csv (82 rows)
  - Saved: W104_W112_Free_Stock_Austin.csv (483 rows)
  - Saved: W103_GE_Consignment.csv (1496 rows)
  - Saved: W105_HK_Allocated_Warehouse.csv (631 rows)
  ...

Step 5: Exporting consolidated portal file...
  - Saved: consolidated_portal_20260316194633.csv (5694 rows)

Step 6: Saving cleaned master file...
  - Saved: inventory_cleaned_20260316194633.csv (5694 rows)

============================================================
PROCESSING COMPLETE
============================================================
```

---

## Troubleshooting

### "Headers found: 0 columns"
The input file structure doesn't match expected format. Check that:
- File is CSV (not Excel)
- Row 8 contains column headers
- Rows 1-7 are the Infor report header

### Unmatched Rows
Rows not assigned to any warehouse group appear in console output as "Unmatched (Other)". Check the Warehouse column value - it may be a new warehouse code not yet configured.

### Missing Price Data
Consignment groups intentionally have prices blanked. If free stock is missing prices, check the source data.

---

## Original VBA Logic Reference

The Python script replicates these Excel VBA macro operations:

1. **DeleteHeaderRows** - `Rows("1:7").Delete`
2. **DeleteFooterRows** - Find/delete rows containing "Page " or "USS,"
3. **RemoveDuplicates** - `Range.RemoveDuplicates` on key columns
4. **SplitByWarehouse** - Filter by Warehouse column, copy to new sheets
5. **ApplyChuboeFormat** - Column reordering and renaming
6. **BlankConsignmentPrices** - Clear price column for consignment warehouses

---

## Future Enhancements

- [ ] Define and implement NetComponents upload template
- [ ] Define and implement IC Source upload template
- [ ] Add direct iDempiere write-back (bypass CSV import)
- [x] ~~Add email notification on completion~~ ✓ Implemented 2026-03-16
- [x] ~~Add scheduling for automated runs~~ ✓ Cron job added 2026-03-16
