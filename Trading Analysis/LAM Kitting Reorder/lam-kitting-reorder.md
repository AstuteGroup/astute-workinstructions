# LAM Kitting Reorder Workflow

Monitor LAM kitting warehouse inventory levels to trigger reorders, update lead times, and track historical sourcing and buyer data.

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL), W115 (LAM Dead Inventory) |
| Trigger | After Inventory File Cleanup (Monday) or on-demand |
| Inputs | Inventory files, historical sourcing, buyer data |
| Outputs | Reorder alerts, lead time updates |

---

## Inputs

### From Inventory File Cleanup

| File | Description |
|------|-------------|
| `W111_LAM_3PL.csv` | Current W111 inventory |
| `W115_LAM_Dead_Inventory.csv` | Current W115 inventory |

### Historical Data (TBD)

| Input | Source | Format | Description |
|-------|--------|--------|-------------|
| Historical Sourcing | ? | ? | Past purchase history for lead time estimation |
| Buyer Data | ? | ? | Buyer assignments, preferences |
| Reorder Thresholds | ? | ? | Min/max levels per MPN |

---

## Workflow Steps

### Step 1: Load Current Inventory

Load the latest inventory files from the Inventory File Cleanup output:
- `W111_LAM_3PL.csv`
- `W115_LAM_Dead_Inventory.csv`

### Step 2: Load Reorder Thresholds (TBD)

Load target inventory levels per MPN:
- Minimum quantity (reorder trigger)
- Maximum quantity (target after reorder)
- Safety stock days

### Step 3: Compare Inventory to Thresholds

For each MPN:
1. Current qty vs. minimum threshold
2. If current < minimum → flag for reorder
3. Calculate reorder quantity: `max_qty - current_qty`

### Step 4: Pull Historical Sourcing Data (TBD)

For reorder items, pull:
- Last purchase price
- Last supplier
- Average lead time
- Buyer who handled previous orders

### Step 5: Generate Reorder Alerts

Output reorder recommendations with:
- MPN
- Current quantity
- Reorder quantity
- Suggested supplier (from history)
- Estimated lead time
- Assigned buyer

### Step 6: Update Lead Times (TBD)

Based on recent sourcing history:
- Calculate average lead time per MPN/supplier
- Update lead time data for planning

---

## Outputs

| File | Description |
|------|-------------|
| `LAM_Reorder_Alerts_YYYY-MM-DD.csv` | Parts below minimum threshold needing reorder |
| `LAM_Lead_Time_Updates_YYYY-MM-DD.csv` | Updated lead times based on historical data |

### Reorder Alert Columns (Draft)

| Column | Description |
|--------|-------------|
| Warehouse | W111 or W115 |
| MPN | Part number |
| Current_Qty | Current inventory quantity |
| Min_Threshold | Minimum inventory level |
| Reorder_Qty | Quantity to order (max - current) |
| Last_Supplier | Previous supplier from history |
| Last_Price | Previous purchase price |
| Avg_Lead_Time | Average lead time in days |
| Assigned_Buyer | Buyer to handle reorder |
| Priority | High/Medium/Low based on urgency |

---

## Questions to Resolve

Before implementation, need to clarify:

1. **Reorder Thresholds**
   - Where are min/max inventory levels defined?
   - Is this per MPN or per MPN+Warehouse?
   - Who maintains these thresholds?

2. **Historical Sourcing Data**
   - What system/file contains purchase history?
   - What fields are available (price, supplier, lead time, buyer)?
   - How far back should we look?

3. **Buyer Assignment**
   - Are buyers assigned per MPN, per supplier, or per warehouse?
   - Where is this mapping stored?

4. **Lead Time Calculation**
   - Simple average of past orders?
   - Weighted by recency?
   - Per supplier or overall?

5. **Notification**
   - Email alerts like Inventory File Cleanup?
   - Who should receive reorder alerts?

6. **W115 (Dead Inventory)**
   - Should dead inventory trigger reorders?
   - Or is this for analysis/disposition only?

---

## Integration with Inventory File Cleanup

This workflow can be triggered automatically after Inventory File Cleanup:

```
Inventory Cleanup completes
    ↓
Check if W111/W115 files exist
    ↓
Run LAM Kitting Reorder
    ↓
Email reorder alerts
```

Alternatively, run on-demand when needed.

---

## Future Enhancements

- [ ] Define reorder threshold source
- [ ] Integrate historical sourcing data
- [ ] Add buyer assignment logic
- [ ] Add lead time calculation
- [ ] Email notifications for reorder alerts
- [ ] Dashboard/summary view of inventory health

---

*Created: 2026-03-16*
