# LAM Kitting Reorder Workflow

Monitor LAM kitting warehouse inventory levels to trigger reorders and source replenishment.

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL) + W115 (LAM Dead Inventory) — combined |
| Trigger | Cron: Mondays at 12:00 PM (after Inventory Cleanup at 11:00 AM) |
| Threshold Source | `Lam_Kitting_DB.xlsx` → INVENTORY sheet → Column H (Reorder Threshold) |
| Join Key | MPN (CPC not in source inventory data) |
| Sourcing | Franchise-only — 8 APIs via `shared/franchise-api.js` |
| LAM bpartner_id | 1000730 |

**Key Design Decisions:**
- **Franchise-only sourcing** — No broker sourcing for this program. Items without API coverage need manual franchise sourcing (checking distributor websites, contacting reps)
- **Combined inventory** — W111 + W115 quantities summed per part (dead stock counts)
- **MPN is join key** — CPC not available in Infor Item Lots Report; join on MPN only
- **Zero-stock detection** — Items in Excel but not in inventory files flagged as CRITICAL
- **LAM-filtered purchase history** — All ERP data filtered to LAM RFQs only (c_bpartner_id = 1000730)
- **Source all parts** — Even parts on order get sourced for current pricing visibility and supplier consolidation opportunities
- **Supplier consolidation** — Fewer suppliers = fewer POs, fewer shipments, lower processing/shipping costs

---

## Automation

**Cron:** Mondays at 12:00 PM
**Runner:** `lam-kitting-runner.js`

```
Inventory Cleanup (Monday 11:00 AM cron)
    ↓
Produces W111_LAM_3PL.csv + W115_LAM_Dead_Inventory.csv
    ↓
LAM Kitting Runner (Monday 12:00 PM cron)
    ↓
Step 1: Find today's inventory folder (or run cleanup if missing)
Step 2: Find latest Lam_Kitting_DB*.xlsx
Step 3: Run lam-kitting-reorder.js --no-email
Step 4: Run lam-kitting-source.js → _sourced.xlsx
Step 5: Email sourced report to jake.harris@astutegroup.com
```

One email with the final sourced Excel (color-coded margins). No intermediate unsourced email.

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
| `Lam_Kitting_DB_*.xlsx` | INVENTORY | Lam P/N (A), MPN (B), Reorder Threshold (H), MOQ (I), Buyer (J), Notes (K) |

### From ERP (LAM Purchases Only)

| Data | LAM Filter | Notes |
|------|------------|-------|
| Previous Supplier | `rfq.c_bpartner_id = 1000730` | Most recent LAM PO supplier |
| Buyer | Same filter | Who created the PO (`c_order.createdby`) |
| Historical Purchase Price | Same filter | Last price paid |
| Last Promise Date | Same filter | Promise date (more useful than order date) |
| Last RFQ | Same filter | LAM RFQ number |
| Infor POV Number | `chuboe_po_string LIKE 'POV%'` | Must start with 'POV' (not 'STOCK') |
| On Order Qty | 90-day window | Open qty on recent POV line |

> **Join Paths:** See [`shared/data-model.md`](../../shared/data-model.md) § Key Join Patterns for the correct RFQ→VQ→Order join chain and common wrong joins.
>
> **POV number:** `c_orderline.chuboe_po_string` (see [`shared/data-model.md`](../../shared/data-model.md) § Order Line).

---

## End-to-End Workflow

### Step 1: Run Automated Pipeline (Cron)

The runner handles everything automatically:

```bash
node lam-kitting-runner.js
```

Or run manually:

```bash
# Reorder detection only
node lam-kitting-reorder.js "<inventory-folder>" "<excel-file>" [--no-email]

# Sourcing only
node lam-kitting-source.js output/LAM_Reorder_Alerts_YYYY-MM-DD.csv
```

### Step 2: Review Sourced Report

Review the color-coded Excel. Priority levels:

| Priority | Criteria | Action |
|----------|----------|--------|
| CRITICAL | Zero stock (100% shortfall) | Source immediately |
| HIGH | 75%+ shortfall | Source soon |
| MEDIUM | 50-74% shortfall | Source this week |
| LOW | <50% shortfall | Monitor / source as needed |

Margin colors:

| Color | Margin | Action |
|-------|--------|--------|
| Green | >18% | Good to buy — proceed with PO |
| Yellow | 0-18% | Review — margin thin but acceptable |
| Red | <0% | Escalate — franchise price > resale, need price review |

### Step 3: Check Recent POV / On Order

Parts with a **Recent POV** (90-day window) already have an open order. Review before re-ordering:
- On Order Qty shows open quantity on that specific POV line
- Still sourced for current pricing / alternative supplier visibility
- Look for supplier consolidation opportunities (same supplier across multiple parts)

### Step 4: Create Purchase Orders

For items needing reorder:
1. Review franchise pricing vs. historical purchase price
2. Consider supplier consolidation (fewer POs = lower processing/shipping costs)
3. Create PO in iDempiere
4. Update LAM Kitting DB as needed

---

## Output Format

### Reorder Alert Columns (22 total)

| # | Group | Column | Source |
|---|-------|--------|--------|
| 1 | Part ID | Lam P/N | Excel (CPC) |
| 2 | Part ID | MPN | Excel |
| 3 | Part ID | Manufacturer | Excel |
| 4 | Part ID | Item Description | Excel |
| 5 | Inventory | QTY ON HAND | Inventory Files (W111+W115) |
| 6 | Inventory | Lam Owned Inventory? | YES if W115 > 0 |
| 7 | Inventory | Reorder Threshold | Excel (Column H) |
| 8 | Inventory | Shortfall | Threshold - QTY ON HAND |
| 9 | Inventory | Priority | CRITICAL/HIGH/MEDIUM/LOW |
| 10 | Inventory | On Order Qty | ERP (90-day, specific POV line) |
| 11 | Inventory | Recent POV | ERP (90-day, Infor POV number) |
| 12 | Inventory | Last Promise Date | ERP (LAM purchases only) |
| 13 | Inventory | Last RFQ | ERP (LAM RFQ number + customer) |
| 14 | Pricing | Base Unit Price | Excel |
| 15 | Pricing | Resale Price | Excel |
| 16 | Pricing | Historical Purchase Price | ERP (LAM purchases only) |
| 17 | History | OT Previous Supplier | ERP (LAM purchases only) |
| 18 | History | OT Buyer | ERP (who created PO) |
| 19 | History | Historical Buyer | Excel (Column J) |
| 20 | Kitting | Lead Time | Excel |
| 21 | Kitting | MOQ | Excel |

### Sourced Columns (added by lam-kitting-source.js)

| Column | Description |
|--------|-------------|
| In Stock Supplier | Best franchise with stock (lowest price) |
| In Stock Price | Price at MOQ |
| In Stock Qty | Available quantity |
| In Stock Margin % | (Resale - Price) / Resale |
| Lead Time Supplier | Alternative with lead time |
| Lead Time Price | Price for lead time order |
| Lead Time (Weeks) | Expected wait |
| Lead Time Margin % | Margin for lead time option |

---

## Franchise APIs (via shared/franchise-api.js)

All 8 active distributors, queried at MOQ quantity:

| API | Module |
|-----|--------|
| DigiKey | `franchise_check/digikey.js` |
| Arrow | `franchise_check/arrow.js` |
| Rutronik | `franchise_check/rutronik.js` |
| Future | `franchise_check/future.js` |
| Master | `franchise_check/master.js` |
| TTI | `franchise_check/tti.js` |
| Newark/Farnell | `franchise_check/newark.js` |
| Mouser | `franchise_check/mouser.js` |

**Important:** Sourcing uses `shared/franchise-api.js` — adding a new API there automatically includes it in LAM sourcing.

---

## Architecture Notes

### Single buildAlert() Function
All output columns are defined in one place (`ALERT_COLUMNS` array + `buildAlert()` function). Both code paths (inventory items and zero-stock CRITICAL items) call the same function. To add/remove/reorder columns, update `ALERT_COLUMNS` and `buildAlert()` — no other changes needed.

### SQL Execution in rbash
The rbash environment causes non-zero exit codes even on successful queries. The script writes SQL to temp files and uses `psql -o` for file-based output to avoid stdout issues.

---

## Questions Resolved

| Question | Answer |
|----------|--------|
| Join key? | **MPN only** — CPC not in Infor Item Lots Report |
| Threshold source? | INVENTORY sheet Column H (Reorder Threshold) |
| Which warehouses? | W111 + W115 combined |
| Dead stock? | Yes, counts toward inventory level |
| Zero stock detection? | Yes, items in Excel but not in inventory = CRITICAL |
| Sourcing? | **Franchise-only** via `shared/franchise-api.js` (8 APIs) |
| Broker sourcing? | No — manual franchise sourcing for items without API coverage |
| Source parts on order? | Yes — for pricing visibility and supplier consolidation |
| ERP join path? | See `shared/data-model.md` § Key Join Patterns |
| Infor POV number? | `c_orderline.chuboe_po_string` — see `shared/data-model.md` § Order Line |
| Promise date vs order date? | **Promise date** (`c_orderline.datepromised`) |
| LAM filter? | `rfq.c_bpartner_id = 1000730` (Lam Research only) |
| CMs (Naprotek, etc)? | Filtered out of Last RFQ — those are sales TO CMs, not supplier purchases |

---

## Files

| File | Description |
|------|-------------|
| `lam-kitting-runner.js` | Cron runner — chains cleanup → reorder → sourcing → email |
| `lam-kitting-reorder.js` | Reorder detection + ERP enrichment |
| `lam-kitting-source.js` | Franchise sourcing via shared API module |
| `lam-kitting-dashboard.js` | Dashboard generator |
| `output/LAM_Reorder_Alerts_*.csv` | Generated reorder alerts |
| `output/LAM_Reorder_Alerts_*_sourced.xlsx` | Sourced alerts with color-coded margins |
| `Lam_Kitting_DB_*.xlsx` | Source Excel with thresholds and buyer data |
| `SIPOC FOR BUYER ADDITION.xlsx` | Original buyer reference (data now in Kitting DB Column J) |

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
- [x] Integrate as cron job (Monday 12pm, after Inventory Cleanup at 11am)
- [x] LAM-only purchase history filter (chuboe_vq_line → chuboe_rfq join)
- [x] Infor POV numbers (chuboe_po_string)
- [x] Recent POV with on-order qty (90-day window)
- [x] Use shared/franchise-api.js (all 8 APIs)
- [x] Single buildAlert() function (prevents column sync issues)
- [x] Excel number formatting (currency/integers)
- [ ] Auto-load RFQ for reorder lines (via shared/rfq-writer.js)
- [ ] Add Mouser API to shared/franchise-api.js distributor list (module exists, needs BP verification)

---

*Created: 2026-03-16*
*Updated: 2026-03-24* — Major overhaul: LAM-filtered ERP data, correct RFQ join path, 8 franchise APIs, cron automation, column reorganization, single buildAlert() architecture
