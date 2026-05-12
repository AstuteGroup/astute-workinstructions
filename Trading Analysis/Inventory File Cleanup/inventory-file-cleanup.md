# Inventory File Cleanup Workflow

Processes Infor ERP inventory exports (AST Item Lots Report) into formats ready for iDempiere import and industry portal uploads.

---

## Automated Mode (Recommended)

The workflow runs **automatically every Monday at 6 AM EST** via cron job. No manual intervention required.

### How It Works

1. **Infor sends** the AST Item Lots Report via automated task every Monday morning
2. **Email auto-forwards** to `excess@orangetsunami.com` inbox
3. **Cron job runs** at 6 AM EST, fetches the email, downloads attachment
4. **Script processes** the file (clean, dedupe, split, export CSVs)
5. **OT write-back** — for each warehouse group in `WAREHOUSE_WRITEBACK`, the script:
   - Deactivates the prior week's `chuboe_offer` (+ lines) for the same `(BP, OfferType)` pair via the iDempiere REST API
   - Posts a fresh `chuboe_offer` header + one `chuboe_offer_line` per lot
   - Failures are isolated per group (one group failing does not block the others)
6. **Three emails sent** to jake.harris@astutegroup.com:
   - **"Data Upload - Non Authorized Account #1167233"** — `Netcomponents 1167233 MM-DD.csv` attached. All OT-eligible groups EXCEPT Franchise_Stock, with the static carryover lines (Eaton/PH/LAM/GM Stock) appended.
   - **"Data Upload - Franchised account #1126121"** — `Netcomponents 1126121 MM-DD.csv` attached. Franchise_Stock only.
   - **"OT Inventory Write-back — YYYY-MM-DD"** — HTML summary table showing per-group status, lines written, lines deactivated, and any errors. No attachment.
7. **Source email moved** to `Inventory-Processed` folder

> **Migration note (2026-04-09):** The historical "OT Inventory Upload" email — which sent a zipped bundle of `*_chuboe.csv` files for manual import to iDempiere — has been **retired**. Inventory now flows directly into OT via REST API. The per-warehouse Chuboe CSVs are still produced on disk under `Inventory YYYY-MM-DD/` for audit and as a manual recovery path if the API write-back ever needs to be replayed.

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

# Live: full fetch + process + OT write-back
node inventory_cleanup.js fetch

# Dry-run: fetch + process, but skip the API write-back (preview only).
# Source email is left in Inventory Reports so you can replay against it.
node inventory_cleanup.js fetch --dry-run
```

The summary email will be tagged `[DRY RUN]` in the subject and banner when run with `--dry-run`.

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
# CSVs only — no OT write-back
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_XXXXXXX.xlsx"

# CSVs + dry-run write-back (logs what would be written, no API calls)
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_XXXXXXX.xlsx" --writeback --dry-run

# CSVs + live write-back to OT
node inventory_cleanup.js "ASTItemLotsReportInputs_USS_XXXXXXX.xlsx" --writeback
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
- Export Chuboe-formatted CSVs (per warehouse, audit / manual replay path)
- Export NetComponents non-authorized portal file (`Netcomponents 1167233 MM-DD.csv`)
- Export NetComponents franchised portal file (`Netcomponents 1126121 MM-DD.csv`)
- Export cleaned master file
- Export duplicates file (for review)

### Step 3: Review Output

Check the console output for:
- Number of rows processed
- Number of duplicates removed
- Row counts per warehouse group
- Any unmatched rows (not assigned to a warehouse group)

### Step 4: Load to iDempiere

In **automated mode**, the script writes inventory directly to OT via the iDempiere REST API — no manual upload step is required. See the **OT Write-Back** section below for the warehouse → BP/OfferType mapping and per-group flow.

The per-warehouse `{WarehouseCode}_{GroupName}.csv` files are still produced on disk under `Inventory YYYY-MM-DD/` for audit and as a manual recovery path. To replay a single warehouse via the legacy CSV import path, drop that file into the Chuboe import wizard.

### Step 5: Upload to NetComponents

Two CSVs are produced for NetComponents, one per account:

| File | Account | Contents |
|------|---------|----------|
| `Netcomponents 1167233 MM-DD.csv` | Non-Authorized #1167233 | All OT-eligible groups except Franchise_Stock + static carryovers |
| `Netcomponents 1126121 MM-DD.csv` | Franchised #1126121 | Franchise_Stock only |

Both files share the same 5-column structure: `MPN, Description, Manufacturer, Qty, D/C`. They are emailed separately with subjects matching the account label (see Email Configuration above). Manually upload each to its respective NetComponents account.

**IC Source:** Template format TBD — derive from `inventory_cleaned_*.csv` (the full deduped master) once the spec is obtained.

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

### NetComponents (split: non-authorized + franchise)

Two CSVs are produced per run — one per NetComponents account — both with the same column structure:

| Output Header | Source Column |
|---------------|---------------|
| MPN | Item |
| Description | ItemDescription |
| Manufacturer | Name |
| Qty | Lot Quantity |
| D/C | Date Code |

| File | Account | Source Groups |
|------|---------|---------------|
| `Netcomponents 1167233 MM-DD.csv` | Non-Authorized #1167233 | All `WAREHOUSE_WRITEBACK` groups EXCEPT `Franchise_Stock` + static carryovers (Eaton/PH/LAM/GM Stock) appended in Step 5d |
| `Netcomponents 1126121 MM-DD.csv` | Franchised #1126121 | `Franchise_Stock` only |

**Why split:** OT already represents these as separate `chuboe_offer` records (see WAREHOUSE_WRITEBACK in `inventory_cleanup.js` — Franchise_Stock under BP `1000325 = Astute - Franchise Stock`, non-franchise free stock under BP `1000332 = Astute Electronics Inc`). The pre-2026-05-05 single portal CSV lumped these together; the split brings the portal output into line with OT's structure.

**Always excluded from both files:** `HK_Allocated_Warehouse` (W105), `Allocated_Warehouse` (MAIN), and `LAM_3PL` (W111). Internal-only — not posted to OT and not posted to NetComponents.

If you need a different selection for an ad-hoc portal upload, derive it from `inventory_cleaned_*.csv` (the full deduped master) — do not loosen the contract in Step 5.

### IC Source Template (TBD)

Required columns and format to be documented once spec is obtained. Derive from `inventory_cleaned_*.csv` (the full deduped master).

---

## Output Files

All output files are saved to a dated folder: `Inventory YYYY-MM-DD/`

| File | Description |
|------|-------------|
| `{WarehouseCode}_{GroupName}.csv` | Chuboe format for iDempiere (one per warehouse group, audit / manual replay path) |
| `Netcomponents 1167233 MM-DD.csv` | Non-authorized account upload (emailed) — all OT groups except Franchise_Stock + carryovers |
| `Netcomponents 1126121 MM-DD.csv` | Franchised account upload (emailed) — Franchise_Stock only |
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

Step 5: Exporting NetComponents portal files...
  - Saved: Netcomponents 1167233 03-16.csv (5612 rows)
  - Saved: Netcomponents 1126121 03-16.csv (82 rows)

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

## Direct Database Write-Back

The shared `offer-writeback.js` module enables writing inventory directly to the ERP instead of CSV import.

**Module:** `shared/offer-writeback.js` — see `shared/README.md` for full API.

### Warehouse → Offer Mapping (live, 11 groups)

Each warehouse group in the table below produces **one `chuboe_offer` per weekly run**, with the lots posted as `chuboe_offer_line` rows. The prior week's offer for the same `(BP, OfferType)` pair is deactivated (header + lines) before the new write. The live mapping is the `WAREHOUSE_WRITEBACK` constant in `inventory_cleanup.js` — keep this table in sync if it changes.

| Warehouse Group | Offer Type (ID) | Business Partner (ID) | BP Search Key |
|---|---|---|---|
| Free_Stock_Austin | Stock - Austin Warehouse (1000008) | Astute Electronics Inc (1000332) | 1002336 |
| Free_Stock_Stevenage | Stock - Stevenage (1000006) | Astute Electronics Inc (1000332) | 1002336 |
| Free_Stock_Hong_Kong | Stock - Hong Kong Warehouse (1000009) | Astute Electronics Inc (1000332) | 1002336 |
| Free_Stock_Philippines | Stock - Philippines Warehouse (1000014) | Astute Electronics Inc (1000332) | 1002336 |
| Franchise_Stock | Stock - Austin Warehouse (1000008) | Astute Electronics - Franchise Stock (1000325) | 1002329 |
| GE_Consignment | Stock - Austin Warehouse (1000008) | Astute Electronics - GE Aviation Excess (1003236) | 1005235 |
| Taxan_Consignment | Stock - Austin Warehouse (1000008) | Astute Electronics - Taxan Excess (1003621) | 1005619 |
| Spartronics_Consignment | Stock - Austin Warehouse (1000008) | Astute Electronics - Spartronics Excess (1005225) | 1007221 |
| Eaton_Consignment | Stock - Philippines Warehouse (1000014) | Astute Electronics Inc - Eaton Consignment (1010966) | 1012832 |
| LAM_Consignment | Stock - Philippines Warehouse (1000014) | Astute Electronics - LAM Consignment (1011267) | 1013066 |
| LAM_Dead_Inventory | Stock - Austin Warehouse (1000008) | Astute Electronics Inc (1000332) | 1002336 |

**Groups intentionally NOT in the write-back** (per-warehouse audit CSVs still produced under `Inventory YYYY-MM-DD/`, but no OT records are created **and these groups are also excluded from both NetComponents portal CSVs** — internal-only, not marketed externally):
- `LAM_3PL` (W111)
- `Allocated_Warehouse` (MAIN)
- `HK_Allocated_Warehouse` (W105)

**Removed group:** `SPE_ATX` was deleted from `WAREHOUSE_GROUPS` on 2026-04-09. It was dead code — `Free_Stock_Austin` (`['W104','W112']`) appears earlier in the iteration order and matched W112 first, so SPE_ATX never received any rows. W112 inventory still flows into Free_Stock_Austin.

### Implementation

`inventory_cleanup.js` exports `writeInventoryToOT(groupedRows, dateStr, dryRun)` which iterates `WAREHOUSE_WRITEBACK` and, for each group present in the input data:

```javascript
// 1. Deactivate the prior week's offer (header + lines) for this BP+OfferType
await deactivatePriorOffers(mapping.bpartnerId, mapping.offerTypeId);

// 2. Write fresh inventory as a single offer with one line per lot
await writeOffer({
  bpartnerId:  mapping.bpartnerId,
  offerTypeId: mapping.offerTypeId,
  description: `Weekly inventory ${dateStr} — ${groupName}`,
  lines: rows.map(row => ({
    mpn:         row['Item'],
    mfrText:     row['Name'],
    qty:         parseFloat(row['Lot Quantity']),
    price:       isConsignment ? null : parseFloat(row['Lot Unit Cost']),
    dateCode:    row['Date Code'],
    packageDesc: `${row['Lot']};${row['Location']}`,
    description: row['ItemDescription'],
  })),
});
```

Failures are isolated per group: a single bad line is reported in the email summary; a whole-group failure (e.g., API timeout during deactivation) is logged and the script continues with the next group.

### Static Carryovers (manual-add inventory)

Some inventory lives outside the weekly Infor export but still needs to be marketed in OT and on NetComponents — open POs awaiting receipt, won lot bids being staged, gifted/consigned stock not tracked in Infor warehouses. The `STATIC_CARRYOVER_OFFERS` constant in `inventory_cleanup.js` is the registry for these. Each weekly run **deactivates the prior carryover offer and writes a fresh copy** so the Created date stays current (consumers like Vortex Matches filter on age).

**Live entries (verified 2026-05-07):**

| Label | Bootstrap ID | Paired Infor Warehouse(s) | Notes |
|---|---|---|---|
| `Eaton Consignment` | 1024798 | W117 | Auto-retire as Eaton stock arrives. Infor's W117 MFR tag is unreliable — `reconcileCarryover` treats MFR mismatches as informational, not blocking. See `project_chuboe_warehouse_group_unreliable.md`. |
| `Free Stock - Philippines` | 1025258 | W109, W114 | W109/W114 currently empty in Infor (verified 2026-05-07). Carryover holds 195 lines as a manual-add. Pairing is in place so when stock physically returns to W109/W114, matching MPNs auto-retire from carryover at the 95% qty threshold. |
| `LAM Consignment` | 1026158 | W118 | Seeded 2026-04-22 from POV0071878 master static (103 MPNs / $2.14M). Auto-retire as LAM stock arrives in W118. |
| `GM Stock` | 1026173 | *(none — no Infor pairing)* | Bootstrapped 2026-04-28 from Josh Pucci's `Ready To Ship - GM GP 11.14.25.xlsx` (19 MPNs / 2,628,000 pcs Nexperia + Onsemi). Posted under Astute Electronics Inc → Stock - Austin Warehouse. Propagates forward as-is until manually retired. |

**Lifecycle per carryover (Step 5b):**

1. **Bootstrap** — first ever load is a manual `apiPost` against `chuboe_offer` + lines, capturing the new `chuboe_offer_id` as `bootstrapId` in the registry. After the first weekly refresh lands, `bootstrapId` becomes irrelevant — subsequent runs find the offer by description prefix `[Carryover] {label}`.
2. **Weekly refresh** — `refreshStaticCarryoverOffers` reads the prior week's lines, deactivates the offer, posts a fresh `chuboe_offer` with description `[Carryover] {label} — refreshed YYYY-MM-DD` and the same lines (minus any retired in step 3 below).
3. **Paired-warehouse reconciliation** — for entries with `pairedWarehouses`, `reconcileCarryover` compares each carryover MPN against this week's qty in the paired warehouse(s):
   - `infoQty ≥ 0.95 × carryoverQty` → MPN **retired** from next week's carryover (assumed received). Threshold absorbs minor lot drift.
   - `0 < infoQty < 0.95 × carryoverQty` → MPN **flagged** for operator review (partial receipt, surfaced in `carryover_overlap_*.csv`).
   - `infoQty = 0` or MPN absent from paired warehouse → kept on carryover unchanged.
4. **Portal append** — Step 5d appends the (post-reconciliation) carryover lines to `Netcomponents 1167233 MM-DD.csv` so the non-authorized portal CSV reflects total marketable stock = OT live offers + carryovers.

**MFR comparison during reconciliation** uses `shared/mfr-equivalence.js` (alias + acquisition aware), but Infor warehouse-tag MFR is known unreliable across the consignment warehouses, so a MFR mismatch alone never blocks retirement — it only annotates the overlap CSV.

**Carryover lifecycle CLI (canonical entry point):** `manage-carryover.js` — one tool for bootstrap, add, retire, and list across any label. CSV-driven for bulk operations, label-agnostic, audit-logged.

```bash
# Bootstrap a brand-new carryover (replaces per-label bootstrap_*.js scripts)
node manage-carryover.js bootstrap --label "GE Consignment" \
     --csv ge-bootstrap.csv --bp 1003001 --offer-type 1000004 \
     --paired W103 --portal "Astute Electronics Inc. - GE (Carryover)" \
     [--dry-run]

# Extend an existing carryover with new lines (idempotent on MPN+DateCode)
node manage-carryover.js add --label "Eaton Consignment" --csv additions.csv [--dry-run]

# Retire one or more MPNs (defense-in-depth: also retires on bootstrap offer if registry has the label)
node manage-carryover.js retire --label "Eaton Consignment" \
     --mpns PMV450ENEAR,XYZ123 --reason "physical in Austin" [--dry-run]

# Inspect current state
node manage-carryover.js list --label "Eaton Consignment"
```

CSV schema (bootstrap & add, headers case-insensitive): required `MPN, MFR, Qty`; optional `DateCode, PackageDesc, Price, MOQ, SPQ, LineDescription`.

Audit log: every bootstrap/add/retire appends to `carryover-audit.csv` (this folder). Git-tracked record of what changed when, by whom, and why.

**Adding a carryover entry:**

1. Drop a CSV with the initial lines.
2. Run `manage-carryover.js bootstrap --label … --csv … --bp … --offer-type … [--paired W103,W117] --dry-run` to preview.
3. Re-run without `--dry-run` to commit. The CLI prints the resulting `bootstrapId` and a copy-pasteable registry block.
4. Paste the block into `STATIC_CARRYOVER_OFFERS` in `inventory_cleanup.js`.
5. Run `node inventory_cleanup.js <fresh_export>.xlsx --writeback --dry-run` to verify it resolves before next Monday's cron.

**Retiring a single MPN (today's pattern for stale lines):** `manage-carryover.js retire --label "…" --mpns MPN1,MPN2 --reason "…"`. Deactivates the matching lines on the current `[Carryover]` offer (and on the registry's `bootstrapId` offer as defense-in-depth). Next weekly refresh's `IsActive eq true` filter then skips them — permanent removal.

**Removing an entire carryover label:** delete the entry from `STATIC_CARRYOVER_OFFERS`. The existing OT offer stays active but stops being refreshed — manually deactivate via the OT UI when ready. (Removing only stops the auto-refresh; it does NOT deactivate the current offer.)

**Historical one-off scripts** (`bootstrap_gm_carryover.js`, `lam_static_bootstrap.js`, `eaton_carryover_patch.js`, `philippines_carryover_patch.js`, `retire-pmv450enear-carryover.js`) are superseded by `manage-carryover.js` but left in place for git history. Do not extend them — add to the CLI instead.

**Historical:** `Incoming Lot bid from Marvell` (bootstrap 1024030, 2025-07-17) was removed 2026-05-07. The slot was placeholder-only — never seeded with any lines, so 10 months of weekly refresh ran as no-ops on an empty source. Open business question (see `deferred-work.md`): should won-lot bids be tracked as static carryovers at all, or as something else?

**Long-term replacement:** Roadmap B4 (open-PO inventory loader) — once the loader can pull from Infor's open-PO data, the static carryover mechanism becomes redundant for the Eaton/LAM cases and the registry should empty out.

### Routing invariant tripwire (Step 5e)

After Step 5d completes, `assertRoutingInvariants` runs as a hard tripwire to guard against drift between the NetComponents portal CSVs and the OT write-back as new warehouses or carryovers get added over time.

**Hard-throws (aborts the run, fires `sendFailureNotice`):**

1. A data-bearing group is in `result.groups` but is neither in `WAREHOUSE_WRITEBACK` nor in `KNOWN_INTERNAL_GROUPS` (`HK_Allocated_Warehouse` / `Allocated_Warehouse` / `LAM_3PL`). Whoever added the group has to consciously route it to one side or the other.
2. Per-group portal vs OT-attempted row counts disagree for any `WAREHOUSE_WRITEBACK` group. Both sides should attempt the same rows.

**Soft-warns (emits a red banner in the summary email, does NOT abort):**

- A static carryover's Step 5d portal append succeeded but its Step 5b OT refresh failed/partial. The portal CSV advertises stock OT does not actually hold this week. The carryover label, line gap, and underlying error get rendered in a "Carryover divergence" callout near the top of the email.

**Reconciliation table** is rendered at the top of the OT Inventory Write-back email on every run, showing portal vs OT-attempted vs OT-written totals for both Main routing and Carryover sources. On a clean run the totals match in green; on shortfall the OT-written cell goes red.

The same routing check runs in manual mode (`node inventory_cleanup.js <file> --writeback`), minus the carryover side which only fires in fetch mode. A clean manual run prints `✓ Routing OK · portal=N, ot-attempted=N, ot-written=N` to the console.

### MFR placeholder scrubbing

Source rows with `Name` matching `/^(not known( yet)?)$/i` (case-insensitive) are written to OT with `Chuboe_MFR_Text = NULL` rather than the literal placeholder string. This avoids junk MFR text in OT and prevents the MFR resolver from canonicalizing nonsense values. Real MFR strings pass through unchanged. Roughly 3% of rows in a typical weekly export carry this placeholder, concentrated in consignment groups (notably GE_Consignment).

---

## Future Enhancements

- [x] ~~Define and implement NetComponents upload template~~ ✓ Implemented 2026-05-05. Two CSVs (non-auth #1167233 + franchise #1126121), 5 user-friendly columns (`MPN, Description, Manufacturer, Qty, D/C`).
- [ ] Define and implement IC Source upload template
- [x] ~~Add direct iDempiere write-back (bypass CSV import)~~ ✓ Module built: `shared/offer-writeback.js` (2026-03-23). Wired into inventory_cleanup.js + zipped CSV email retired (2026-04-09).
- [x] ~~Add email notification on completion~~ ✓ Implemented 2026-03-16
- [x] ~~Add scheduling for automated runs~~ ✓ Cron job added 2026-03-16
