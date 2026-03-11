# Inventory File Cleanup Workflow

Processes Infor ERP inventory exports (AST Item Lots Report) into formats ready for iDempiere import and industry portal uploads.

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

Upload the `*_chuboe.csv` files via Chuboe import process (one file per warehouse group).

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

| Group | Warehouse Code(s) | Notes |
|-------|-------------------|-------|
| LAM_Dead_Inventory | W115 | LAM dead stock |
| LAM_3PL | W111 | LAM 3PL managed |
| SPE_ATX | W112 | SPE Austin |
| Main_Warehouse | MAIN | Main warehouse |
| HK_Warehouse | W105 | Hong Kong warehouse |

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
| `{Group}_chuboe.csv` | Chuboe format for iDempiere (one per warehouse group) |
| `consolidated_portal_{timestamp}.csv` | All inventory for portal upload |
| `inventory_cleaned_{timestamp}.csv` | Full cleaned/deduped master file |
| `duplicates_{timestamp}.csv` | Removed duplicates (for audit/review) |

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
Processing: ASTItemLotsReportInputs_USS_4544132.xlsx
Output directory: Inventory 2026-03-11
------------------------------------------------------------
Step 1: Reading and cleaning file...
  - Headers found: 15 columns
  - Data rows read: 12847

Step 2: Deduplicating...
  - Unique rows: 12803
  - Duplicate rows removed: 44
  - Duplicates saved to: ./output/duplicates_20260224_173444.csv

Step 3: Splitting by warehouse group...
  - Franchise_Stock: 156 rows
  - Free_Stock_Austin: 892 rows
  - GE_Consignment: 3421 rows
  ...

Step 4: Exporting Chuboe format files...
  - Saved: Franchise_Stock_chuboe.csv (156 rows)
  ...

Step 5: Exporting consolidated portal file...
  - Saved: consolidated_portal_20260224_173444.csv (12803 rows)

Step 6: Saving cleaned master file...
  - Saved: inventory_cleaned_20260224_173444.csv (12803 rows)

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
- [ ] Add email notification on completion
- [ ] Add scheduling for automated runs
