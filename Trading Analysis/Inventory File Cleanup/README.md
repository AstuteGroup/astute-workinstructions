# Inventory File Cleanup

Processes Infor ERP inventory exports (AST Item Lots Report) for Astute Electronics.

## Workflow

1. **Input**: CSV export from Infor (`ASTItemLotsReportInputs_*.csv`)
2. **Clean**: Removes header rows (1-7) and footer (Page x of y, username)
3. **Dedupe**: Removes duplicates based on Item+Lot+Location+Warehouse Name+Site+Date Lot
4. **Split**: Groups by warehouse (W103, W104, W105, etc.)
5. **Output**:
   - Chuboe-formatted CSVs for iDempiere import
   - Consolidated portal file for industry search engines
   - Cleaned master file

## Usage

```bash
python inventory_cleanup.py <input_file.csv> [output_directory]
```

**Example:**
```bash
python inventory_cleanup.py "Copy of ASTItemLotsReportInputs_USS_4516285.csv" ./output
```

## Output Files

| File | Description |
|------|-------------|
| `*_chuboe.csv` | Chuboe format for iDempiere import (one per warehouse group) |
| `consolidated_portal_*.csv` | Combined file for NetComponents/IC Source upload |
| `inventory_cleaned_*.csv` | Full cleaned/deduped master file |
| `duplicates_*.csv` | Duplicate rows removed (for review) |

## Warehouse Groups

| Group | Warehouse Code(s) | Notes |
|-------|-------------------|-------|
| Franchise_Stock | W104 | Where Name = "Positronic" |
| Free_Stock_Stevenage | W102 | |
| GE_Consignment | W103 | Price blanked |
| Free_Stock_Austin | W104, W112 | |
| Taxan_Consignment | W106 | Price blanked |
| Spartronics_Consignment | W107 | Price blanked |
| Free_Stock_Hong_Kong | W108, W113 | |
| Free_Stock_Philippines | W109, W114 | |
| LAM_Dead_Inventory | W115 | |
| LAM_Consignment | W118 | Price blanked |
| Eaton_Consignment | W117 | Price blanked |
| LAM_3PL | W111 | |
| SPE_ATX | W112 | |
| Main_Warehouse | MAIN | |
| HK_Warehouse | W105 | |

## Future Enhancement

Once write-back to iDempiere is available, this script will be updated to create market offers directly in the database instead of generating CSV files.
