#!/usr/bin/env python3
"""
Inventory File Cleanup Script
Processes Infor ERP inventory exports for Astute Electronics

Workflow:
1. Clean raw export (remove header rows 1-7, footer rows)
2. Deduplicate based on composite key
3. Split by warehouse group
4. Export to Chuboe format for iDempiere import
5. Create consolidated file for industry portals

Usage:
    python inventory_cleanup.py <input_file.csv> [output_directory]
"""

import csv
import os
import sys
from datetime import datetime
from collections import defaultdict

# =============================================================================
# CONFIGURATION
# =============================================================================

# Rows to skip at start of file (Infor report header)
HEADER_ROWS_TO_SKIP = 7

# Footer patterns to detect and remove
FOOTER_PATTERNS = ['Page ', 'USS,']

# Composite key fields for deduplication (column names from row 8)
DEDUPE_FIELDS = ['Item', 'Lot', 'Location', 'Warehouse Name', 'Site', 'Date Lot']

# Warehouse groupings (group_name, warehouse_codes, special_filter)
# Special filter format: (column_name, value) or None
WAREHOUSE_GROUPS = [
    ('Franchise_Stock', ['W104'], ('Name', 'positronic')),  # W104 + Name = Positronic
    ('Free_Stock_Stevenage', ['W102'], None),
    ('GE_Consignment', ['W103'], None),
    ('Free_Stock_Austin', ['W104', 'W112'], None),  # W104 without Positronic handled by order
    ('Taxan_Consignment', ['W106'], None),
    ('Spartronics_Consignment', ['W107'], None),
    ('Free_Stock_Hong_Kong', ['W108', 'W113'], None),
    ('Free_Stock_Philippines', ['W109', 'W114'], None),
    ('LAM_Dead_Inventory', ['W115'], None),
    ('LAM_Consignment', ['W118'], None),
    ('Eaton_Consignment', ['W117'], None),
    ('LAM_3PL', ['W111'], None),
    ('SPE_ATX', ['W112'], None),
    ('Main_Warehouse', ['MAIN'], None),
    ('HK_Warehouse', ['W105'], None),
]

# Chuboe output column mapping
# Format: (output_column_name, source_column_or_special)
# Special values: '__BLANK__', '__OFFER_ID__', 'col1|col2' for concatenation
CHUBOE_COLUMNS = [
    ('Chuboe_Offer_ID[Value]', '__OFFER_ID__'),
    ('Chuboe_MPN', 'Item'),
    ('Chuboe_MFR_ID[Value]', '__BLANK__'),
    ('Chuboe_MFR_Text', 'Name'),
    ('Qty', 'Lot Quantity'),
    ('Chuboe_Lead_Time', '__BLANK__'),
    ('Chuboe_Package_Desc', 'Lot|Location'),  # Concatenate with semicolon
    ('C_Country_ID[Name]', '__BLANK__'),
    ('Chuboe_Date_Code', 'Date Code'),
    ('C_Currency_ID[ISO_Code]', '__BLANK__'),
    ('Description', 'ItemDescription'),
    ('IsActive', '__BLANK__'),
    ('Chuboe_MPN_Clean', '__BLANK__'),
    ('Chuboe_CPC', '__BLANK__'),
    ('PriceEntered', 'Lot Unit Cost'),  # Blanked for Consignment groups
    ('Chuboe_MOQ', '__BLANK__'),
    ('Chuboe_SPQ', '__BLANK__'),
]

# Groups where PriceEntered should be blanked
CONSIGNMENT_GROUPS = [
    'GE_Consignment', 'Taxan_Consignment', 'Spartronics_Consignment',
    'LAM_Consignment', 'Eaton_Consignment'
]

# Portal export columns (for NetComponents, IC Source, etc.)
PORTAL_COLUMNS = [
    'Item', 'ItemDescription', 'Name', 'Lot Quantity', 'Date Code',
    'Lot Unit Cost', 'Currency', 'Warehouse Name', 'Location'
]


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def clean_numeric(value):
    """Remove commas and quotes from numeric values."""
    if value is None:
        return ''
    # Remove quotes and commas from numbers like "1,820.00000"
    cleaned = str(value).replace('"', '').replace(',', '')
    return cleaned


def is_footer_row(row):
    """Check if row is part of the footer."""
    row_text = ','.join(str(cell) for cell in row)
    return any(pattern in row_text for pattern in FOOTER_PATTERNS)


def is_blank_row(row):
    """Check if row is entirely blank."""
    return all(not str(cell).strip() for cell in row)


def get_dedupe_key(row, headers):
    """Generate composite key for deduplication."""
    key_parts = []
    for field in DEDUPE_FIELDS:
        if field in headers:
            idx = headers.index(field)
            key_parts.append(str(row[idx]).strip().lower() if idx < len(row) else '')
        else:
            key_parts.append('')
    return '|'.join(key_parts)


def matches_warehouse_group(row, headers, group_config):
    """Check if row matches a warehouse group configuration."""
    group_name, warehouse_codes, special_filter = group_config

    # Get warehouse value
    if 'Warehouse' not in headers:
        return False
    warehouse_idx = headers.index('Warehouse')
    warehouse = str(row[warehouse_idx]).strip().upper() if warehouse_idx < len(row) else ''

    # Check warehouse code
    if warehouse not in [wc.upper() for wc in warehouse_codes]:
        return False

    # Check special filter if present
    if special_filter:
        filter_col, filter_val = special_filter
        if filter_col in headers:
            col_idx = headers.index(filter_col)
            col_val = str(row[col_idx]).strip().lower() if col_idx < len(row) else ''
            if col_val != filter_val.lower():
                return False
        else:
            return False

    return True


def transform_to_chuboe(row, headers, group_name):
    """Transform a row to Chuboe format."""
    output = []
    is_consignment = group_name in CONSIGNMENT_GROUPS

    for out_col, source in CHUBOE_COLUMNS:
        if source == '__BLANK__':
            output.append('')
        elif source == '__OFFER_ID__':
            output.append('')  # Left blank - will be filled later or via direct write
        elif '|' in source:
            # Concatenate multiple columns with semicolon
            parts = source.split('|')
            values = []
            for part in parts:
                if part in headers:
                    idx = headers.index(part)
                    val = str(row[idx]).strip() if idx < len(row) else ''
                    if val:
                        values.append(val)
            output.append(';'.join(values))
        elif source == 'Lot Unit Cost' and is_consignment:
            output.append('')  # Blank price for consignment
        else:
            if source in headers:
                idx = headers.index(source)
                val = str(row[idx]).strip() if idx < len(row) else ''
                # Clean numeric values
                if source in ['Lot Quantity', 'Lot Unit Cost', 'Lot Cost']:
                    val = clean_numeric(val)
                output.append(val)
            else:
                output.append('')

    return output


# =============================================================================
# MAIN PROCESSING
# =============================================================================

def process_inventory_file(input_file, output_dir=None):
    """Main processing function."""

    if not os.path.exists(input_file):
        print(f"Error: Input file not found: {input_file}")
        sys.exit(1)

    # Set output directory
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(input_file), 'output')
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

    print(f"Processing: {input_file}")
    print(f"Output directory: {output_dir}")
    print("-" * 60)

    # ==========================================================================
    # STEP 1: Read and clean the file
    # ==========================================================================
    print("Step 1: Reading and cleaning file...")

    all_rows = []
    headers = None

    with open(input_file, 'r', encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)

        for i, row in enumerate(reader):
            # Skip header rows
            if i < HEADER_ROWS_TO_SKIP:
                continue

            # Row 8 (index 7) is the header row
            if i == HEADER_ROWS_TO_SKIP:
                # Clean header names (remove blank columns but keep positions)
                headers = [str(h).strip() for h in row]
                continue

            # Skip blank rows
            if is_blank_row(row):
                continue

            # Stop at footer
            if is_footer_row(row):
                break

            all_rows.append(row)

    print(f"  - Headers found: {len([h for h in headers if h])} columns")
    print(f"  - Data rows read: {len(all_rows)}")

    # ==========================================================================
    # STEP 2: Deduplicate
    # ==========================================================================
    print("\nStep 2: Deduplicating...")

    seen_keys = {}
    unique_rows = []
    duplicate_rows = []

    for row in all_rows:
        key = get_dedupe_key(row, headers)
        if key not in seen_keys:
            seen_keys[key] = row
            unique_rows.append(row)
        else:
            duplicate_rows.append(row)

    print(f"  - Unique rows: {len(unique_rows)}")
    print(f"  - Duplicate rows removed: {len(duplicate_rows)}")

    # Save duplicates for review
    if duplicate_rows:
        dup_file = os.path.join(output_dir, f'duplicates_{timestamp}.csv')
        with open(dup_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            writer.writerows(duplicate_rows)
        print(f"  - Duplicates saved to: {dup_file}")

    # ==========================================================================
    # STEP 3: Split by warehouse group
    # ==========================================================================
    print("\nStep 3: Splitting by warehouse group...")

    grouped_rows = defaultdict(list)
    unmatched_rows = []

    for row in unique_rows:
        matched = False
        for group_config in WAREHOUSE_GROUPS:
            group_name = group_config[0]
            if matches_warehouse_group(row, headers, group_config):
                # Special handling for W104: check if it's Franchise Stock (Positronic)
                if group_name == 'Free_Stock_Austin':
                    # Skip if already matched to Franchise Stock
                    if 'Name' in headers:
                        name_idx = headers.index('Name')
                        name_val = str(row[name_idx]).strip().lower() if name_idx < len(row) else ''
                        if name_val == 'positronic':
                            continue  # Let Franchise Stock handle it

                grouped_rows[group_name].append(row)
                matched = True
                break

        if not matched:
            unmatched_rows.append(row)

    for group_name, rows in sorted(grouped_rows.items()):
        print(f"  - {group_name}: {len(rows)} rows")

    if unmatched_rows:
        print(f"  - Unmatched (Other): {len(unmatched_rows)} rows")

    # ==========================================================================
    # STEP 4: Export Chuboe format files
    # ==========================================================================
    print("\nStep 4: Exporting Chuboe format files...")

    chuboe_headers = [col[0] for col in CHUBOE_COLUMNS]

    for group_name, rows in grouped_rows.items():
        if not rows:
            continue

        out_file = os.path.join(output_dir, f'{group_name}_chuboe.csv')
        with open(out_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(chuboe_headers)
            for row in rows:
                transformed = transform_to_chuboe(row, headers, group_name)
                writer.writerow(transformed)

        print(f"  - Saved: {group_name}_chuboe.csv ({len(rows)} rows)")

    # ==========================================================================
    # STEP 5: Export consolidated portal file
    # ==========================================================================
    print("\nStep 5: Exporting consolidated portal file...")

    # Get indices for portal columns
    portal_indices = []
    portal_header_out = []
    for col in PORTAL_COLUMNS:
        if col in headers:
            portal_indices.append(headers.index(col))
            portal_header_out.append(col)

    portal_file = os.path.join(output_dir, f'consolidated_portal_{timestamp}.csv')
    with open(portal_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(portal_header_out)
        for row in unique_rows:
            out_row = []
            for idx in portal_indices:
                val = str(row[idx]).strip() if idx < len(row) else ''
                # Clean numeric values
                if portal_header_out[portal_indices.index(idx)] in ['Lot Quantity', 'Lot Unit Cost']:
                    val = clean_numeric(val)
                out_row.append(val)
            writer.writerow(out_row)

    print(f"  - Saved: consolidated_portal_{timestamp}.csv ({len(unique_rows)} rows)")

    # ==========================================================================
    # STEP 6: Save cleaned master file
    # ==========================================================================
    print("\nStep 6: Saving cleaned master file...")

    master_file = os.path.join(output_dir, f'inventory_cleaned_{timestamp}.csv')
    with open(master_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(unique_rows)

    print(f"  - Saved: inventory_cleaned_{timestamp}.csv ({len(unique_rows)} rows)")

    # ==========================================================================
    # SUMMARY
    # ==========================================================================
    print("\n" + "=" * 60)
    print("PROCESSING COMPLETE")
    print("=" * 60)
    print(f"Input file: {input_file}")
    print(f"Output directory: {output_dir}")
    print(f"Total rows processed: {len(all_rows)}")
    print(f"Unique rows: {len(unique_rows)}")
    print(f"Duplicates removed: {len(duplicate_rows)}")
    print(f"Warehouse groups: {len(grouped_rows)}")
    print(f"Unmatched rows: {len(unmatched_rows)}")

    return {
        'total_rows': len(all_rows),
        'unique_rows': len(unique_rows),
        'duplicates': len(duplicate_rows),
        'groups': dict(grouped_rows),
        'unmatched': len(unmatched_rows),
        'output_dir': output_dir
    }


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python inventory_cleanup.py <input_file.csv> [output_directory]")
        print("\nExample:")
        print("  python inventory_cleanup.py ASTItemLotsReportInputs_USS_4516285.csv ./output")
        sys.exit(1)

    input_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None

    process_inventory_file(input_file, output_dir)
