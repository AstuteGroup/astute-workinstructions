# LAM Kitting Workflow Specification

## Data Sources

| Source | Refresh Cadence | What It Provides |
|--------|-----------------|------------------|
| **Master Roster** | Ongoing (source of truth) | CPCs, approved MPNs (AVL), thresholds, pricing, lead times |
| **Inventory (Infor)** | Weekly (Monday cache) | Stock levels by MPN for W111/W115 |
| **OT Database** | Always live | POVs, tracking numbers, orders, promise dates, purchase history |
| **Franchise APIs** | On-demand (cached) | Digi-Key, Mouser, Arrow pricing and availability |

## Keys and Relationships

- **CPC** (Customer Part Code) is the primary key
- **MPN** is secondary - one CPC can have multiple approved MPNs (AVL)
- **Purchased MPN** drives output, but must be on the AVL for that CPC
- MPN discrepancies should be flagged, not cause parts to be skipped

## Output Format

**All outputs use identical column format.** Base CSV includes API columns (empty until sourced).

Columns:
- Lam P/N (CPC), MPN, Purchased MPN, Manufacturer, Description
- QTY ON HAND, W115 Stale Inventory, Reorder Threshold, Shortfall, Priority
- On Order Qty, OT PO, Recent POV, Tracking, Last Promise Date, PO Created Date, Last Updated
- Last RFQ, Base Unit Price, Resale Price, Historical Purchase Price
- OT Previous Supplier, OT Buyer, Historical Buyer, Lead Time, LAM MOQ
- Available Stock (Other WH), Available Qty (Other WH), Stock Detail
- In Stock Supplier, In Stock Price, In Stock Qty, In Stock Margin %
- Lead Time Supplier, Lead Time Price, Lead Time (Weeks), Lead Time Margin %
- Sourcing Status, Selected MPN, AVL Count

## Commands

### `refresh`
Re-pull live OT data, preserve cached API pricing.

**Inputs:**
- Master Roster (source of truth)
- Inventory cache (weekly)
- OT live queries (POVs, tracking, orders)
- Existing sourced CSV (for cached API pricing)

**Logic:**
1. Load roster (determines what CPCs to include)
2. Load inventory from cache
3. Query OT live for POVs, tracking, orders
4. For each CPC in roster:
   - Calculate priority based on inventory + POV status
   - Populate OT columns with fresh data
   - Preserve API columns from existing sourced file (if exists)
5. Handle additions/removals (see below)

**Output:** Updated sourced CSV with fresh OT data + cached API pricing

### `source`
Run franchise APIs to refresh pricing data.

**Inputs:**
- Current CSV (base or sourced)
- Franchise API calls

**Logic:**
1. For each part needing sourcing (based on priority/status)
2. Query APIs for pricing and availability
3. Update API columns

**Output:** Sourced CSV with fresh API pricing

### `full`
Fresh OT data + fresh API pricing (weekly run).

### `excel`
Rebuild xlsx from existing CSV. No data refresh.

## Addition/Removal Handling

### New Parts (CPC in roster, not in previous output)
- Add to output with empty API columns
- Flag as "NEW" in output
- Will be sourced on next `source` or `full` run

### Removed Parts (CPC in previous output, not in roster)
- **Do NOT silently remove**
- Send notification email to Jake AND Josh
- Include list of removed CPCs with acknowledgement request
- Remove from output only after notification sent

### MPN Discrepancies
- If Purchased MPN ≠ Roster MPN:
  - Validate Purchased MPN is on AVL for that CPC
  - If on AVL: use Purchased MPN, flag discrepancy
  - If NOT on AVL: escalate, do not proceed

## Email Content

### Audit Trail (required in every email)
```
Data Sources:
  Inventory: 2026-07-27 (weekly cache)
  API Pricing: 2026-07-28 14:30 CT (cached)
  OT Data: 2026-07-30 14:33 CT (live)
```

### Stats
Must be computed from the exact file being attached. Same source = same numbers.

```
Total items: 193

Breakdown:
  Critical: 65
  VQ Ticked - Need PO: 6
  Pending Receipt: 120
  Low: 2
```

### Recipients
- `full` (automated weekly): Jake + Josh
- Manual runs: Jake only (unless otherwise specified)
- Removal notifications: Jake + Josh (always)

## Error Handling

### OT Database Unavailable
1. Send notice: "OT unavailable - cannot pull fresh data"
2. Do NOT use stale data silently
3. Request retry at later time

### API Failures
1. Log which APIs failed
2. Mark affected parts with "API ERROR" status
3. Continue with available data
4. Note failures in email

### Inventory Cache Stale (>7 days)
1. Warn in email: "Inventory cache is X days old"
2. Proceed but make staleness visible

## Validation Before Send

1. Verify OT pull timestamp is within last 10 minutes
2. Verify inventory cache is ≤7 days old
3. Verify stats match between calculation and attachment
4. Verify row count is reasonable (not 0, not drastically different from previous)

If validation fails: warn, do not send automatically, request confirmation.
