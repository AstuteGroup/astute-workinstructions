# LAM Kitting Reorder Workflow

Monitor LAM kitting warehouse inventory levels to trigger reorders and source replenishment.

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL) + W115 (LAM Dead Inventory) — combined |
| Trigger | After Inventory File Cleanup (Monday) or on-demand |
| Threshold Source | `Lam_Kitting_DB.xlsx` → INVENTORY sheet → Column I (MIN QTY) |
| Join Key | MPN (CPC not in source inventory data) |

**Key Design Decisions:**
- **Separate workflow** — Independent of Inventory File Cleanup, but triggered by it
- **Combined inventory** — W111 + W115 quantities summed per part (dead stock counts)
- **Fixed thresholds** — MIN QTY is a fixed value in INVENTORY sheet (no lookup to MIN sheet)
- **MPN is join key** — CPC not available in Infor Item Lots Report; join on MPN only
- **Zero-stock detection** — Items in Excel but not in inventory files flagged as CRITICAL

---

## Inputs

### From Inventory File Cleanup (Trigger)

| File | Description |
|------|-------------|
| `LAM_3PL_chuboe.csv` | Current W111 inventory |
| `LAM_Dead_Inventory_chuboe.csv` | Current W115 inventory |

### From LAM Kitting Database

| File | Sheet | Key Columns |
|------|-------|-------------|
| `Lam_Kitting_DB_*.xlsx` | INVENTORY | Lam P/N (A), MPN (B), MIN QTY (I) |

### From ERP (Historical Data)

| Data | Source | Notes |
|------|--------|-------|
| Previous Supplier | `c_order` + `c_bpartner` | Most recent PO |
| Buyer | `c_order` + `ad_user` | Who created the PO |
| Historical Purchase Price | `c_orderline.priceentered` | Last price paid |
| Last Purchase Date | `c_order.dateordered` | When last ordered |

**Note:** ERP only has rebuy data — initial buys were tracked outside the system.

---

## End-to-End Workflow

### Step 1: Generate Reorder Alerts

Run the reorder detection script:

```bash
cd "Trading Analysis/LAM Kitting Reorder"
node lam-kitting-reorder.js "<inventory-folder>" "<excel-file>"

# Example:
node lam-kitting-reorder.js \
  "../Inventory File Cleanup/Inventory 2026-03-11" \
  "./Lam_Kitting_DB_03132026.xlsx"
```

**What it does:**
1. Loads W111 + W115 inventory from Chuboe CSVs
2. Aggregates quantity by MPN across both warehouses
3. Loads MIN QTY thresholds from Excel INVENTORY sheet
4. Joins on MPN
5. Identifies shortfalls (Current_Qty < MIN_QTY)
6. Detects zero-stock items (in Excel but not in inventory files)
7. Enriches with ERP historical data (supplier, buyer, price, date)

**Output:** `output/LAM_Reorder_Alerts_YYYY-MM-DD.csv`

### Step 2: Review Reorder Alerts

Review the output file. Priority levels:

| Priority | Criteria | Action |
|----------|----------|--------|
| CRITICAL | Zero stock (100% shortfall) | Source immediately |
| HIGH | 75%+ shortfall | Source soon |
| MEDIUM | 50-74% shortfall | Source this week |
| LOW | <50% shortfall | Monitor / source as needed |

### Step 3: Run Franchise Sourcing

Run the integrated sourcing script on reorder alerts:

```bash
cd "Trading Analysis/LAM Kitting Reorder"
node lam-kitting-source.js output/LAM_Reorder_Alerts_YYYY-MM-DD.csv

# Output: output/LAM_Reorder_Alerts_YYYY-MM-DD_sourced.xlsx (+ .csv)
```

**What it does:**
1. Queries franchise APIs (DigiKey, Arrow, Rutronik, Future, Master) at **MOQ quantity**
2. Finds best in-stock option (lowest price with available qty)
3. Finds best lead-time option (for items without immediate stock)
4. Calculates margin vs. LAM Resale Price
5. Outputs Excel with **color-coded margins**:
   - 🟢 Green: >18% margin (good to buy)
   - 🟡 Yellow: 0-18% margin (review)
   - 🔴 Red: Negative margin (needs price review or broker sourcing)

**Output columns added:**
| Column | Description |
|--------|-------------|
| In Stock Supplier | Best franchise with stock |
| In Stock Price | Price at MOQ |
| In Stock Qty | Available quantity |
| In Stock Margin % | (Resale - Price) / Resale |
| Lead Time Supplier | Alternative with lead time |
| Lead Time Price | Price for lead time order |
| Lead Time (Weeks) | Expected wait |
| Lead Time Margin % | Margin for lead time option |

**Note:** Uses `Trading Analysis/RFQ Sourcing/franchise_check/` API modules — no duplicate logic.

### Step 4: Review Sourcing Results

Review the color-coded Excel:

| Margin Color | Action |
|--------------|--------|
| 🟢 Green (>18%) | Good to buy — proceed with PO |
| 🟡 Yellow (0-18%) | Review — margin thin but acceptable |
| 🔴 Red (<0%) | Escalate — franchise price > resale, need broker or price review |

For items **without franchise coverage** (5 typical):
- Flag for manual broker sourcing (NetComponents) if critical
- Or wait for next reorder cycle

### Step 5: Create Purchase Orders

For items with acceptable margins:
1. Review franchise pricing vs. historical purchase price
2. Create PO in iDempiere for selected supplier
3. Update LAM Kitting DB as needed

### Step 6: Email Alerts

Email sourced report to buyers:

```bash
# Subject: LAM Kitting Reorder Alerts - Sourced (YYYY-MM-DD)
# To: jake.harris@astutegroup.com
# Attachment: LAM_Reorder_Alerts_YYYY-MM-DD_sourced.xlsx
```

---

## Output Format

### Reorder Alert Columns (17 total)

| # | Column | Source |
|---|--------|--------|
| 1 | Lam P/N | Excel (CPC) |
| 2 | MPN | Excel |
| 3 | Manufacturer | Excel |
| 4 | Item Description | Excel |
| 5 | Lead Time | Excel |
| 6 | QTY ON HAND | Inventory Files (calculated) |
| 7 | Base Unit Price | Excel |
| 8 | Resale Price | Excel |
| 9 | MIN QTY | Excel |
| 10 | MOQ | Excel |
| 11 | Lam Owned Inventory? | Calculated (YES if W115 > 0) |
| 12 | Previous Supplier | ERP |
| 13 | Buyer | ERP |
| 14 | Historical Purchase Price | ERP |
| 15 | Last Purchase Date | ERP |
| 16 | Shortfall | Calculated (MIN - QTY) |
| 17 | Priority | Calculated |

---

## Integration Flow

```
Inventory Cleanup (Monday 6 AM cron)
    ↓
Produces LAM_3PL_chuboe.csv + LAM_Dead_Inventory_chuboe.csv
    ↓
Step 1: Run lam-kitting-reorder.js → LAM_Reorder_Alerts_*.csv
    ↓
Step 2: Review reorder alerts (34 items typical)
    ↓
Step 3: Run lam-kitting-source.js → LAM_Reorder_Alerts_*_sourced.xlsx
    ↓
Step 4: Review margins (green=buy, yellow=review, red=escalate)
    ↓
Step 5: Create POs for available items
    ↓
Step 6: Email summary to buyers
```

---

## Questions Resolved

| Question | Answer |
|----------|--------|
| Join key? | **MPN only** — CPC not in Infor Item Lots Report |
| Threshold source? | INVENTORY sheet Column I (MIN QTY) — fixed value |
| Which warehouses? | W111 + W115 combined |
| Dead stock? | Yes, counts toward inventory level |
| Zero stock detection? | Yes, items in Excel but not in inventory = CRITICAL |
| Sourcing workflow? | **Follow Franchise Screening** (`Trading Analysis/RFQ Sourcing/franchise_check/`) |
| NetComponents? | Only if specifically tasked — not default |

---

## Files

| File | Description |
|------|-------------|
| `lam-kitting-reorder.js` | Detection script — generates reorder alerts |
| `lam-kitting-source.js` | Sourcing script — runs franchise APIs, adds margins |
| `output/LAM_Reorder_Alerts_*.csv` | Generated reorder alerts |
| `output/LAM_Reorder_Alerts_*_sourced.xlsx` | Sourced alerts with color-coded margins |
| `Lam_Kitting_DB_*.xlsx` | Source Excel with thresholds |

---

## TODO

- [x] Map columns — MPN is join key (CPC not in source)
- [x] Build reorder script (Node.js) — detection + ERP enrichment
- [x] Zero-stock detection (CRITICAL priority)
- [x] Historical data from ERP (supplier, buyer, price, date)
- [x] Email report to jake.harris@astutegroup.com
- [x] Add franchise sourcing with margin analysis
- [x] Excel output with color-coded margins (green/yellow/red)
- [x] Query at MOQ for accurate bulk pricing
- [ ] Integrate as cron job after Inventory File Cleanup

---

*Created: 2026-03-16*
*Updated: 2026-03-17* — Added integrated sourcing script with MOQ pricing and margin color coding
