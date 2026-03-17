# LAM Kitting Reorder Workflow

Monitor LAM kitting warehouse inventory levels to trigger reorders, update lead times, and track historical sourcing.

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL) + W115 (LAM Dead Inventory) — combined |
| Trigger | After Inventory File Cleanup (Monday) or on-demand |
| Threshold Source | `Lam_Kitting_DB.xlsx` → INVENTORY sheet → Column I (MIN QTY) |
| Join Key | LAM CPC (primary), MPN (fallback) |

**Key Design Decisions:**
- **Separate workflow** — Independent of Inventory File Cleanup, but triggered by it
- **Combined inventory** — W111 + W115 quantities summed per part (dead stock counts)
- **Fixed thresholds** — MIN QTY is a fixed value in INVENTORY sheet (no lookup to MIN sheet)

---

## Inputs

### From Inventory File Cleanup (Trigger)

| File | Description |
|------|-------------|
| `W111_LAM_3PL.csv` | Current W111 inventory (Chuboe format) |
| `W115_LAM_Dead_Inventory.csv` | Current W115 inventory (Chuboe format) |

### From LAM Kitting Database

| File | Sheet | Key Columns |
|------|-------|-------------|
| `Lam_Kitting_DB_*.xlsx` | INVENTORY | CPC (Lam P/N), MPN, MIN QTY (Col I) |

**Column Mapping (INVENTORY sheet):**
- **CPC / Lam P/N** — LAM's internal part code (join key primary)
- **MPN** — Manufacturer part number (join key fallback)
- **MIN QTY (Column I)** — Fixed reorder threshold

---

## End-to-End Workflow

### Step 1: Load Inventory Files

Load the latest W111 and W115 files from Inventory File Cleanup output:
```
W111_LAM_3PL.csv
W115_LAM_Dead_Inventory.csv
```

**Output:** Combined inventory list with columns: CPC, MPN, Warehouse, Qty

### Step 2: Aggregate by Part

Combine W111 + W115 quantities per part:
- Group by CPC (primary) or MPN (if no CPC match)
- Sum quantities across both warehouses
- Track which warehouses have stock

**Output:** Aggregated inventory with Total_Qty per CPC/MPN

### Step 3: Load Thresholds

Load `Lam_Kitting_DB_*.xlsx` → INVENTORY sheet:
- Extract CPC, MPN, MIN QTY columns
- MIN QTY is the reorder trigger threshold

**Output:** Threshold lookup table (CPC/MPN → MIN_QTY)

### Step 4: Join Inventory to Thresholds

Match aggregated inventory to thresholds:
1. **Primary match:** Join on CPC (LAM P/N)
2. **Fallback match:** If no CPC match, join on MPN

**Output:** Combined dataset with Current_Qty and MIN_QTY per part

### Step 5: Identify Reorder Candidates

Flag parts where `Current_Qty < MIN_QTY`:
- Calculate shortfall: `MIN_QTY - Current_Qty`
- Prioritize by shortfall size or criticality

**Output:** Reorder candidates list

### Step 6: Enrich with Historical Data (TBD)

For reorder candidates, pull from ERP:
- Last purchase price
- Last supplier
- Average lead time
- Buyer who handled previous orders

**Output:** Enriched reorder list

### Step 7: Generate Reorder Alerts

Output final reorder recommendations.

**Output:** `LAM_Reorder_Alerts_YYYY-MM-DD.csv`

---

## Output Format

### Reorder Alert Columns

| Column | Description |
|--------|-------------|
| CPC | LAM's part code |
| MPN | Manufacturer part number |
| W111_Qty | Quantity in W111 (LAM 3PL) |
| W115_Qty | Quantity in W115 (Dead Inventory) |
| Total_Qty | Combined quantity |
| MIN_QTY | Reorder threshold |
| Shortfall | MIN_QTY - Total_Qty |
| Last_Supplier | Previous supplier (from ERP) |
| Last_Price | Previous purchase price |
| Avg_Lead_Time | Average lead time in days |
| Assigned_Buyer | Buyer to handle reorder |
| Priority | High/Medium/Low based on shortfall % |

---

## Integration with Inventory File Cleanup

```
Inventory Cleanup (Monday 6 AM cron)
    ↓
Produces W111_LAM_3PL.csv + W115_LAM_Dead_Inventory.csv
    ↓
Triggers LAM Kitting Reorder (this workflow)
    ↓
Generates reorder alerts
    ↓
(Optional) Email alerts to buyers
```

---

## Questions Resolved

| Question | Answer |
|----------|--------|
| Join key? | CPC (primary), MPN (fallback) |
| Threshold source? | INVENTORY sheet Column I (MIN QTY) — fixed value |
| Which warehouses? | W111 + W115 combined |
| Dead stock? | Yes, counts toward inventory level |
| Separate workflow? | Yes, triggered by Inventory File Cleanup |

---

## TODO

- [ ] Map Inventory Cleanup output columns to CPC/MPN
- [ ] Build aggregation script (Node.js)
- [ ] Add historical sourcing data from ERP (Step 6)
- [ ] Email notifications for reorder alerts
- [ ] Integrate as cron job after Inventory File Cleanup

---

*Created: 2026-03-16*
*Updated: 2026-03-17*
