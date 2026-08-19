# Brownsville Inspection Validation — Daily Report

**Location:** `Business Ops/tsk-validated-inspections/brownsville-inspection-report.js`

Automated daily report showing inspections validated at Brownsville (W111) the previous day, for transcription to another system.

## Schedule

- **When:** Daily at 8am Eastern (12:00 UTC)
- **Recipients:** justin.oberhofer@astutegroup.com
- **Delivery:** HTML email

## Report Contents

### Detail Listing

| Column | Description |
|--------|-------------|
| **OTIN** | OT Internal Number (inventory tracking ID) |
| **Physical Warehouse** | Warehouse group name (e.g., BROWNSVILLE) |
| **Inv Group** | Inventory group / warehouse name |
| **POV#** | Purchase Order Vendor number |
| **Line** | RFQ line number |
| **MPN Received** | Part number as recorded on inspection form |
| **MFR Received** | Manufacturer as recorded on inspection form |
| **Qty Received** | Quantity as recorded on inspection form |
| **Bin** | Shelf/bin location |
| **Inspector** | Person who validated |
| **Validated At** | Timestamp of validation (CT-naive) |

## Usage

### Manual Run (Preview)
```bash
node Business Ops/tsk-validated-inspections/brownsville-inspection-report.js
```

### Manual Run (Send Email)
```bash
node Business Ops/tsk-validated-inspections/brownsville-inspection-report.js --send
```

### Custom Time Window
```bash
node Business Ops/tsk-validated-inspections/brownsville-inspection-report.js --since 48    # Last 48 hours
node Business Ops/tsk-validated-inspections/brownsville-inspection-report.js --since 48 --send
```

## Technical Details

### Data Source
- **Database:** `idempiere_replica` (read-only)
- **View:** `adempiere.chuboe_insp_mpnlotqueue_v`
- **Filters:**
  - `isvalidate = 'Y'` — only validated inspections
  - `chuboe_warehouse_group_id = 1000008` — Brownsville warehouse group
  - `updated` in window — validation timestamp

### Key Fields
- `chuboe_otin_search` — OTIN (OT Internal Number)
- `chuboe_mpnlot_po` — POV# (Purchase Order Vendor number)
- `chuboe_rfq_line.line` — RFQ line number (joined via VQ line → RFQ line)
- `m_attributeinstance` (via `chuboe_insprecordasimap`) — Inspection form attributes:
  - `MPN Received` — Part number recorded by inspector
  - `Manufacturer Received` — Manufacturer recorded by inspector
  - `Total QTY Received` — Quantity recorded by inspector
- `updatedby` → `ad_user.name` — Inspector name
- `created` — When OTIN was created (CT-naive timestamp)
- `updated` — When validation occurred (CT-naive timestamp)

### Time Window Filter
The report filters by **validation timestamp** (`updated` field). An OTIN created last week but validated yesterday will appear in yesterday's report.

### Time Zone
Timestamps are CT-naive per OT convention.

## Cron Configuration

**Registry:** `astute-workinstructions/cron-jobs.js`

```javascript
{
  name: 'brownsville-inspection-report',
  owner: 'justin.oberhofer',
  cadence: 'fixed',
  cadenceCron: '0 12 * * *',  // 12:00 UTC = 8am EDT, daily
  command: `node "${ASTUTE}/Business Ops/tsk-validated-inspections/brownsville-inspection-report.js" --send`,
  cwd: ASTUTE,
  needsOT: false,  // reads replica only, no OT writes
  logFile: '/tmp/brownsville-inspection-report.log',
  description: 'Daily 8am EDT (12:00 UTC) — Brownsville inspection validation daily digest to justin.oberhofer@',
}
```

**Log file:** `/tmp/brownsville-inspection-report.log`

## Dependencies

- `shared/notifier.js` — Email delivery

## History

- **2026-08-19** — Simplified to detail table only
  - Removed Summary and By Inspector sections
  - Shows only validated inspections (no pending)
  - For transcription to another system
- **2026-08-17** — Initial implementation
  - Scheduled daily 8am Eastern
  - Recipient: justin.oberhofer@astutegroup.com
