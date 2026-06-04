# Hong Kong Inspection Queue with Vendor Information

Export active inspection queue lines for Hong Kong warehouse, filtered to MI Queue shelf with no picked user.

## Use Case

Generate a list of items in the Hong Kong MI (Market Intelligence) Queue that are:
- Active (`isactive = 'Y'`)
- Not yet validated (`isvalidate = 'N'`)
- On the "MI QUEUE" warehouse shelf
- Not yet picked by a user (`chuboe_po_pickeduser_id IS NULL`)

## Output

Excel file with all inspection queue columns plus POV Line Vendor Name.

## End-to-End Workflow

### Step 1: Run the Export Query

```sql
COPY (
    SELECT
        q.chuboe_mpnlot_mpn AS "MPN",
        q.chuboe_mpnlot_lot AS "Lot",
        q.chuboe_mpnlot_qty AS "Qty",
        q.chuboe_mpnlot_po AS "PO",
        bp.name AS "POV Line Vendor Name",
        q.chuboe_vq_datepromised AS "Date Promised",
        q.chuboe_vq_quantity AS "VQ Qty",
        q.chuboe_po_weight AS "PO Weight",
        q.chuboe_weightedpriority AS "Weighted Priority",
        q.description AS "Description",
        q.name AS "Name",
        q.chuboe_mpn_clean AS "MPN Clean",
        q.chuboe_otin_search AS "OTIN Search",
        q.chuboe_vq_note_public AS "VQ Note Public",
        q.chuboe_vq_note_private AS "VQ Note Private",
        q.chuboe_vq_note_user AS "VQ Note User",
        q.chuboe_po_receiving_name AS "Receiving",
        q.chuboe_cq_max_datepromised AS "CQ Max Date Promised",
        q.chuboe_cq_min_datepromised AS "CQ Min Date Promised",
        q.processed AS "Processed",
        q.isvalidate AS "Is Validate",
        q.created AS "Created",
        q.updated AS "Updated",
        wg.name AS "Warehouse Group",
        ws.name AS "Warehouse Shelf"
    FROM adempiere.chuboe_insp_mpnlotqueue_v q
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = q.chuboe_vq_bpartner_id
    LEFT JOIN adempiere.chuboe_warehouse_group wg ON wg.chuboe_warehouse_group_id = q.chuboe_warehouse_group_id
    LEFT JOIN adempiere.chuboe_warehouse_shelf ws ON ws.chuboe_warehouse_shelf_id = q.chuboe_warehouse_shelf_id
    WHERE q.chuboe_warehouse_group_id = 1000001  -- Hong Kong
      AND q.isactive = 'Y'
      AND ws.name = 'MI QUEUE'
      AND q.chuboe_po_pickeduser_id IS NULL
      AND q.isvalidate = 'N'
    ORDER BY q.created DESC
) TO STDOUT WITH CSV HEADER;
```

Execute via psql:
```bash
psql -c "<query above>" -o ~/workspace/hk_mi_queue.csv
```

### Step 2: Convert to Excel

Use the xlsx npm package to convert CSV to Excel with proper column widths.

### Step 3: Deliver File

Output file: `~/workspace/HK_MI_Queue_Full.xlsx`

## Key Filters

| Filter | Value | Purpose |
|--------|-------|---------|
| `chuboe_warehouse_group_id` | 1000001 | Hong Kong warehouse group |
| `ws.name` | 'MI QUEUE' | MI Queue shelf only |
| `chuboe_po_pickeduser_id` | IS NULL | Not yet picked |
| `isvalidate` | 'N' | Not yet validated (active) |
| `isactive` | 'Y' | Active records only |

## Reference: Warehouse Groups

| ID | Name |
|----|------|
| 1000000 | AUSTIN |
| 1000001 | HONG KONG |
| 1000005 | GERMANY |
| 1000006 | PHILIPPINES |
| 1000007 | STEVENAGE |
| 1000008 | BROWNSVILLE |
| 1000009 | DROP-SHIP |

## Reference: HK Warehouse Shelves

| Shelf Name | Typical Count |
|------------|---------------|
| SHIPPING QUEUE | ~4600 |
| (blank) | ~2300 |
| SERVICE RETURN | ~370 |
| QI QUEUE | ~200 |
| MI QUEUE | ~80 |
| RMA | ~50 |
| QUERY | ~30 |
| OUT TO SERVICE | ~30 |
| DROP SHIP | ~20 |

## Columns Included

1. **MPN** - Manufacturer Part Number
2. **Lot** - Lot number
3. **Qty** - Quantity in lot
4. **PO** - Purchase Order (POV number)
5. **POV Line Vendor Name** - Vendor name from the PO
6. **Date Promised** - VQ date promised
7. **VQ Qty** - Vendor Quote quantity
8. **PO Weight** - Purchase Order weight/priority
9. **Weighted Priority** - Calculated priority score
10. **Description** - Line description
11. **Name** - Record name
12. **MPN Clean** - Cleaned/normalized MPN
13. **OTIN Search** - OTIN search string
14. **VQ Note Public** - Public notes from VQ
15. **VQ Note Private** - Private notes from VQ
16. **VQ Note User** - User notes from VQ
17. **Receiving** - Receiving location name
18. **CQ Max Date Promised** - Latest CQ date promised
19. **CQ Min Date Promised** - Earliest CQ date promised
20. **Processed** - Processing status (Y/N)
21. **Is Validate** - Validation status (Y/N)
22. **Created** - Record creation timestamp
23. **Updated** - Last update timestamp
24. **Warehouse Group** - Warehouse group name
25. **Warehouse Shelf** - Shelf location name

## Variations

### All HK Inspection Queue (no shelf filter)
Remove the `ws.name = 'MI QUEUE'` filter to get all Hong Kong inspection items.

### Include Validated Lines
Remove `q.isvalidate = 'N'` to include already-validated lines.

### Different Warehouse Group
Change `chuboe_warehouse_group_id` to target a different location (see Reference table above).
