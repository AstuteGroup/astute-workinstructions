# Inventory File Cleanup Workflow

Processes Infor ERP inventory exports (AST Item Lots Report) into OT offers and NetComponents portal uploads.

---

## Architecture (2026-07 Refactor)

The workflow uses a **decoupled cache-based architecture**:

```
FOUNDATIONAL (runs first):
  inventory-fetch-and-parse.js → cache.json (ALL warehouses)

SUBORDINATE WORKFLOWS (each pulls what it needs from cache):
  ├── lam-inventory.js          → W111, W115, W118 → OT offers
  ├── free-stock-inventory.js   → W102, W104, W108, W109, etc. → OT offers
  ├── consignment-inventory.js  → W103, W106, W107, W117 → OT offers
  └── nc-listing.js             → NetComponents portal CSVs
```

**Key principle:** Parser is "dumb" (caches everything), workflows are "smart consumers" (each pulls only what it needs).

---

## Schedule (Mondays, Eastern Time)

| Time | Job | Description |
|------|-----|-------------|
| 6:00 AM | `inventory-fetch-and-parse` | Fetch Infor xlsx from email, parse ALL warehouses, cache to JSON |
| 7:15 AM | `lam-inventory` | LAM warehouses (W111, W115, W118) → OT offers + threshold check + wrong warehouse check |
| 7:30 AM | `free-stock-inventory` | Free Stock warehouses → OT offers |
| 7:45 AM | `consignment-inventory` | Consignment warehouses → OT offers (prices blanked) |
| 8:00 AM | `nc-listing` | NetComponents portal CSVs (when enabled) |

---

## Foundational: Fetch and Parse

```bash
# Run manually (normally runs via cron)
node shared/inventory-fetch-and-parse.js

# Check cache status
node shared/inventory-fetch-and-parse.js --status

# Parse existing xlsx without fetching email
node shared/inventory-fetch-and-parse.js --local /path/to/ASTItemLotsReport.xlsx
```

**Cache location:** `~/.inventory-storage/parsed_YYYY-MM-DD.json`

**Cache contents:**
```javascript
{
  metadata: { cachedAt, weekOf, uniqueRows, warehouseSummary },
  byWarehouse: {
    'W102': [{ mpn, mfr, qty, dateCode, lot, location, ... }, ...],
    'W103': [...],
    // ... all warehouses
  }
}
```

---

## Subordinate Workflows

### LAM Inventory
```bash
node workflows/lam-inventory.js              # Write offers + threshold check
node workflows/lam-inventory.js --dry-run    # Preview without writing
node workflows/lam-inventory.js --threshold-only  # Skip OT writes, just threshold check
```

Warehouses: W115 (Dead), W118 (Consignment) → OT. W111 (3PL) internal-only.

### Free Stock Inventory
```bash
node workflows/free-stock-inventory.js
node workflows/free-stock-inventory.js --dry-run
```

Groups:
- Free_Stock_Austin (W104, W112) — excludes Positronic
- Free_Stock_Stevenage (W102)
- Free_Stock_Hong_Kong (W108, W113)
- Free_Stock_Philippines (W109, W114)
- Franchise_Stock (W104 Positronic only)

### Consignment Inventory
```bash
node workflows/consignment-inventory.js
node workflows/consignment-inventory.js --dry-run
node workflows/consignment-inventory.js --include-prices  # Include prices (not recommended)
```

Groups: GE (W103), Taxan (W106), Spartronics (W107), Eaton (W117). Prices blanked by default.

---

## NetComponents Portal Upload

```bash
node "Trading Analysis/Inventory File Cleanup/nc-listing.js"
node "Trading Analysis/Inventory File Cleanup/nc-listing.js" --dry-run
```

Generates two CSVs from cache:
- `Netcomponents 1167233 MM-DD.csv` — Non-authorized account (all except Franchise + carryovers)
- `Netcomponents 1126121 MM-DD.csv` — Franchised account (Positronic only)

---

## Warehouse Groups

| Group | Warehouses | OT Write | Notes |
|-------|-----------|----------|-------|
| Free_Stock_Austin | W104, W112 | Yes | Excludes Positronic |
| Free_Stock_Stevenage | W102 | Yes | |
| Free_Stock_Hong_Kong | W108, W113 | Yes | |
| Free_Stock_Philippines | W109, W114 | Yes | |
| Franchise_Stock | W104 | Yes | Positronic only |
| GE_Consignment | W103 | Yes | Prices blanked |
| Taxan_Consignment | W106 | Yes | Prices blanked |
| Spartronics_Consignment | W107 | Yes | Prices blanked |
| Eaton_Consignment | W117 | Yes | Prices blanked |
| LAM_Dead_Inventory | W115 | Yes | |
| LAM_Consignment | W118 | Yes | |
| LAM_3PL | W111 | No | Internal-only |

---

## Cron Configuration

All jobs are registered in `cron-jobs.js`. To view/update:

```bash
# Preview cron changes
node scripts/install-crons.js

# Apply cron changes
node scripts/install-crons.js --apply

# Check for drift
node scripts/check-cron-drift.js
```

---

## Troubleshooting

### No cache found
```bash
# Check cache status
node shared/inventory-fetch-and-parse.js --status

# If no cache, run fetch-and-parse manually
node shared/inventory-fetch-and-parse.js
```

### Stale cache warning
Cache older than 7 days triggers a warning. All workflows accept stale cache with `allowStale: true`.

### Email not found
Check `excess@orangetsunami.com` inbox for `Task finished: [success] * AST Item Lots Report Inputs`.

---

## Legacy Mode (Deprecated)

The monolithic `inventory_cleanup.js` has been deprecated. It still exists for reference but is no longer scheduled.

If you need to run it for some reason:
```bash
# DEPRECATED - use subordinate workflows instead
node "Trading Analysis/Inventory File Cleanup/inventory_cleanup.js" fetch --dry-run
```

---

## Files

| File | Purpose |
|------|---------|
| `shared/inventory-parser.js` | Pure Infor xlsx parser |
| `shared/inventory-fetch-and-parse.js` | Fetch email + parse + cache |
| `workflows/lam-inventory.js` | LAM warehouse → OT |
| `workflows/free-stock-inventory.js` | Free Stock → OT |
| `workflows/consignment-inventory.js` | Consignment → OT |
| `nc-listing.js` | NetComponents portal CSVs |
| `inventory_cleanup.js` | DEPRECATED monolithic script |
