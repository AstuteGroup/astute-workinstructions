# LAM Wrong Warehouse Check

**Status:** Spec for integration into LAM workflow
**Created:** 2026-07-10
**Context:** Ad-hoc analysis found roster parts in wrong warehouses; needs to be a recurring check

---

## Purpose

Identify LAM roster parts that exist in non-LAM warehouses. These are either:
1. **Misplaced LAM stock** — should be moved to W111
2. **Other customer stock** — same MPN used by multiple customers (no action needed)

---

## Data Sources

### 1. LAM Master Roster
- **Path:** `astute-workinstructions/Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx`
- **Sheet:** `Master Roster`
- **Key columns:** `MPN`, `CPC`
- **Usage:** Build MPN → CPC lookup (uppercase, trimmed)

### 2. Infor Inventory File
- **Delivery:** Email attachment to `lamkitting@orangetsunami.com`
- **Format:** Excel, sheet `Sheet1`, headers at row 7 (use `{ range: 7 }` in xlsx)
- **Key columns:**
  - `Item` — MPN
  - `Warehouse` — warehouse code (W111, MAIN, etc.)
  - `Warehouse Name` — full name
  - `Location` — bin location (important: may contain "LAM" prefix)
  - `Lot Quantity` — quantity on hand
  - `Lot` — lot number

---

## Warehouse Classification

| Code | Name | Classification |
|------|------|----------------|
| W111 | LAM 3PL | LAM active — **exclude from check** |
| W115 | LAM Dead | LAM stale — **exclude from check** |
| W118 | LAM Consignment | LAM consignment — **exclude from check** |
| W112 | (varies) | Same MPNs, different use — **exclude per business rule** |
| W117 | (varies) | Not relevant — **exclude** |
| W106 | (varies) | Not relevant — **exclude** |
| MAIN, W104, W105, W110 | Various | **Check these** for roster parts |

```javascript
const LAM_WAREHOUSES = ['W111', 'W115', 'W118'];
const EXCLUDE_WAREHOUSES = ['W111', 'W115', 'W118', 'W112', 'W117', 'W106'];
```

---

## Algorithm

### Step 1: Build Roster Lookup
```javascript
const rosterMPNs = new Map(); // MPN (uppercase, trimmed) → CPC
for (const row of rosterData) {
  if (row.MPN && row.CPC) {
    rosterMPNs.set(row.MPN.toUpperCase().trim(), row.CPC);
  }
}
```

### Step 2: Find Roster MPNs in LAM Warehouses
Build a map of which roster MPNs have stock in W111, W115, W118:
```javascript
const inLAMWarehouses = new Map(); // MPN → [{wh, qty}]
for (const row of invData) {
  const mpn = (row['Item'] || '').trim();
  const wh = row['Warehouse'] || '';
  const qty = parseFloat(row['Lot Quantity'] || 0);

  if (mpn && qty > 0 && LAM_WAREHOUSES.includes(wh)) {
    if (!inLAMWarehouses.has(mpn)) inLAMWarehouses.set(mpn, []);
    inLAMWarehouses.get(mpn).push({ wh, qty: Math.round(qty) });
  }
}
```

### Step 3: Find Roster MPNs in Wrong Warehouses
```javascript
const results = [];
for (const row of invData) {
  const mpn = (row['Item'] || '').trim();
  const mpnUpper = mpn.toUpperCase();
  const wh = row['Warehouse'] || '';
  const qty = parseFloat(row['Lot Quantity'] || 0);

  if (mpn && qty > 0 && rosterMPNs.has(mpnUpper) && !EXCLUDE_WAREHOUSES.includes(wh)) {
    const cpc = rosterMPNs.get(mpnUpper);
    const loc = row['Location'] || '';
    const isLAMLoc = loc.toUpperCase().includes('LAM');
    const lamStock = inLAMWarehouses.get(mpn) || [];

    results.push({
      wh,
      whName: row['Warehouse Name'] || '',
      cpc,
      mpn,
      qty: Math.round(qty),
      loc,
      lot: row['Lot'] || '',
      isLAMLoc,
      alsoInW111: lamStock.some(s => s.wh === 'W111'),
      alsoInW115: lamStock.some(s => s.wh === 'W115'),
      alsoInW118: lamStock.some(s => s.wh === 'W118'),
    });
  }
}
```

### Step 4: Classify Each Result
```javascript
function classifyStatus(r) {
  if (r.isLAMLoc) {
    return 'MISPLACED LAM STOCK - LAM bin location';
  } else if (r.alsoInW111 || r.alsoInW118) {
    return 'Has LAM stock in W111/W118 - likely other customer';
  } else if (r.alsoInW115) {
    return 'Has LAM dead stock (W115) - needs review';
  } else {
    return 'No LAM warehouse stock - likely other customer';
  }
}
```

---

## Status Categories

| Status | Action Required |
|--------|-----------------|
| **MISPLACED LAM STOCK - LAM bin location** | **YES** — Part is in LAM-labeled bin (e.g., "LAM7.11.22") but wrong warehouse. Needs physical move to W111. |
| **Has LAM stock in W111/W118** | No — Same MPN exists in active LAM. Stock elsewhere is for other customers. |
| **Has LAM dead stock (W115) - needs review** | Maybe — Same MPN in dead inventory. Could be duplicate or consolidation opportunity. |
| **No LAM warehouse stock** | No — MPN only appears outside LAM warehouses. Likely other customer stock sharing the MPN. |

---

## Key Indicator: LAM Bin Location

The most reliable signal for misplaced LAM stock is the **Location** field containing "LAM":

```javascript
const isLAMLoc = loc.toUpperCase().includes('LAM');
```

Examples of LAM bin locations: `LAM7.11.22`, `LAM-SHELF-3`, etc.

If a part is in a LAM-labeled bin but NOT in a LAM warehouse, it is almost certainly misplaced.

---

## Output Format

| Column | Description |
|--------|-------------|
| Warehouse | Warehouse code (MAIN, W104, etc.) |
| Warehouse Name | Full warehouse name |
| LAM CPC | Customer part code from roster |
| MPN | Manufacturer part number |
| Qty | Quantity on hand |
| Location | Bin location |
| Lot | Lot number |
| LAM Bin? | "YES" if location contains "LAM" |
| Also in LAM WH | Comma-separated list of LAM warehouses where MPN also exists (W111, W115, W118) |
| Status | Classification per table above |

---

## Sorting Priority

1. LAM bin locations first (highest priority — definite misplacement)
2. Parts also in W115 (potential consolidation)
3. Alphabetical by warehouse

```javascript
results.sort((a, b) => {
  if (a.isLAMLoc && !b.isLAMLoc) return -1;
  if (!a.isLAMLoc && b.isLAMLoc) return 1;
  if (a.alsoInW115 && !b.alsoInW115) return -1;
  if (!a.alsoInW115 && b.alsoInW115) return 1;
  return a.wh.localeCompare(b.wh);
});
```

---

## Integration Notes

### Suggested Trigger
- Run when new Infor inventory file arrives (attachment to lamkitting inbox)
- Or run on schedule (daily/weekly) if inventory file is stored in a known location

### Email Notification
- Send to: `jake.harris@astutegroup.com`
- From: `lamkitting@orangetsunami.com`
- Subject: `LAM Roster Warehouse Review - {date}`
- Attach: Excel file with results
- Body: Summary counts by status category

### Dependencies
- `xlsx` — Excel parsing
- `shared/notifier.js` — Email with attachment
- `shared/email-fetcher.js` — If pulling attachment from lamkitting inbox (account: `lamkitting`)

---

## Reference Implementation

**Production script:** `lam-wrong-warehouse-check.js`

**Integrated into runner:** Runs as Step 0 of `lam-kitting-runner.js` (before reorder detection)

**Usage:**
```bash
# Run the check
node lam-wrong-warehouse-check.js <inventory-folder> [--dry-run]

# Mark an item as not LAM (excludes from future checks)
node lam-wrong-warehouse-check.js --mark-non-lam <mpn> <lot> [reason]

# Remove an exclusion
node lam-wrong-warehouse-check.js --clear-exclusion <mpn> <lot>

# List all exclusions
node lam-wrong-warehouse-check.js --list-exclusions
```

**Exclusion persistence:**
- Items confirmed as "not LAM" are stored in `lam-wrong-warehouse-exclusions.json`
- Key is `MPN|Lot` (both are required since same MPN can have LAM and non-LAM lots)
- Exclusions persist across runs and prevent repeated flagging

**Output:**
- `output/LAM_Wrong_Warehouse_YYYY-MM-DD.xlsx` — Results file with status classification
- Email sent to `jake.harris@astutegroup.com` if any "MISPLACED LAM STOCK" items found
