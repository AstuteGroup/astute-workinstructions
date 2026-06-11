# RTS (Request to Ship) Lookup

Assembles all fields needed for the Power Apps "Request to Ship" form by pulling from OT, Infor order sync, and inventory files.

## Usage

```bash
node rts-lookup.js 1155861          # by R_Request documentno
node rts-lookup.js SO506724         # by OT Sales Order number
node rts-lookup.js COV0021568       # by Infor COV number
node rts-lookup.js LM358N           # by MPN
```

---

## Cost Sourcing Rules

**CRITICAL: Cost varies by warehouse. Do not use inventory lot cost blindly.**

| Warehouse | Cost Source | Notes |
|-----------|-------------|-------|
| **W111** (LAM 3PL) | LAM SIPOC contractual pricing | See lookup order below |
| **W115** (LAM Dead Stock) | LAM SIPOC contractual pricing | Same as W111 — LAM contract applies |
| **W104** (Austin Free Stock) | Inventory lot cost | Standard broker stock |
| **W102** (Stevenage) | Inventory lot cost | Standard broker stock |
| **W108/W113** (Hong Kong) | Inventory lot cost | Standard broker stock |
| **W103/W106/W107/W117/W118** (Consignment) | Customer-specific | Consignment pricing varies |

### LAM Contract Pricing Lookup (W111 / W115)

Check these files **in order** — first match is authoritative:

1. **LAM Kitting DB** — `Trading Analysis/LAM 3PL/Lam_Kitting_DB_*.xlsx`
   - Sheet: `INVENTORY` → Column: `Base Unit Price`
   - Scope: Steady-state kitting roster (~964 parts)

2. **EPG SIPOC (Phase 1)** — `Trading Analysis/LAM EPG Award/Lam_EPG_SIPOC.xlsx`
   - Sheet1 → Column: `Base Unit Price`
   - Scope: Initial EPG award (~208 parts)

3. **Phase 2 Adds** — `Trading Analysis/LAM 3PL/Astute_New Part ADDS_*.xlsx`
   - Latest `Astute action list <date>` tab → Column: `Base Unit Price`
   - Scope: New parts added post-EPG

If not found in any of the three → **no contract price exists**. Do not guess.

See [`lam-3pl.md`](../LAM%203PL/lam-3pl.md) § Contract Purchase Price for full details.

---

## Output Fields

The lookup returns:

| Field | Source |
|-------|--------|
| Customer | R_Request or c_order |
| Customer # | c_bpartner_location (CXXXXX pattern) |
| COV # | R_Request lastresult or chuboe_infor_order |
| COV Line | chuboe_infor_order or inferred from SO line position |
| MPN | R_Request approval_text or chuboe_infor_order |
| Qty to Ship | R_Request approval_text or chuboe_infor_order.poqtyoutstanding |
| Resale Price | R_Request approval_text or chuboe_infor_order.unit_price |
| Lot # | Inventory file (AST Item Lots Report) |
| Location | Inventory file |
| Warehouse | Inventory file |
| Unit Cost | **See Cost Sourcing Rules above** |

---

## Data Sources

1. **R_Request** — approval text, lastresult (contains COV#/SO#)
2. **c_bpartner_location** — Infor customer code (CXXXXX)
3. **chuboe_infor_order** — COV line details, qty outstanding
4. **Inventory files** — `/tmp/Inventory YYYY-MM-DD/inventory_cleaned_*.csv`

---

*Created: 2026-06-08*
