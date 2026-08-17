# Brownsville Inspection Validation — Daily Report

**Location:** `reports/brownsville-inspection-report.js`

Automated daily report showing inspections validated at Brownsville (W111) the previous day, delivered via email.

## Schedule

- **When:** Mon-Fri at 8am Eastern (12:00 UTC)
- **Recipients:** justin.oberhofer@astutegroup.com
- **Delivery:** HTML email
- **Weekend gate:** Built-in (automatically skips Sat/Sun)

## Report Contents

### Summary Section

| Metric | Description |
|--------|-------------|
| **Total Validations** | Count of inspections validated in the window |
| **Total Qty** | Sum of all quantities validated |
| **Inspectors** | Count of unique inspectors who validated |

### By Inspector Breakdown

| Column | Description |
|--------|-------------|
| **Inspector** | Name of the person who validated |
| **Validations** | Number of MPN/lot combos validated |
| **Total Qty** | Sum of quantities validated by this inspector |
| **% of Total** | Percentage of total validations (visual bar) |

### Detail Listing

| Column | Description |
|--------|-------------|
| **OTIN** | OT Internal Number (inventory tracking ID) |
| **POV#** | Purchase Order Vendor number |
| **Line** | RFQ line number |
| **MPN Received** | Part number as recorded on inspection form |
| **MFR Received** | Manufacturer as recorded on inspection form |
| **Qty Received** | Quantity as recorded on inspection form |
| **Inspector** | Person who validated |
| **Validated At** | Timestamp of validation (CT-naive) |

## Usage

### Manual Run (Preview)
```bash
node reports/brownsville-inspection-report.js
```

### Manual Run (Send Email)
```bash
node reports/brownsville-inspection-report.js --send
```

### Custom Time Window
```bash
node reports/brownsville-inspection-report.js --since 48    # Last 48 hours
node reports/brownsville-inspection-report.js --since 48 --send
```

## Technical Details

### Data Source
- **Database:** `idempiere_replica` (read-only)
- **View:** `adempiere.chuboe_insp_mpnlotqueue_v`
- **Filters:**
  - `isvalidate = 'Y'` — only validated inspections
  - `chuboe_warehouse_id = 1000015` — W111 Brownsville only

### Key Fields
- `chuboe_otin_search` — OTIN (OT Internal Number)
- `chuboe_mpnlot_po` — POV# (Purchase Order Vendor number)
- `chuboe_rfq_line.line` — RFQ line number (joined via VQ line → RFQ line)
- `m_attributeinstance` (via `chuboe_insprecordasimap`) — Inspection form attributes:
  - `MPN Received` — Part number recorded by inspector
  - `Manufacturer Received` — Manufacturer recorded by inspector
  - `Total QTY Received` — Quantity recorded by inspector
- `updatedby` → `ad_user.name` — Inspector name
- `updated` — When validation occurred (CT-naive timestamp)

### Time Zone
Timestamps are CT-naive per OT convention. The `updated` field reflects when the validation occurred.

## Cron Configuration

**Registry:** `astute-workinstructions/cron-jobs.js`

```javascript
{
  name: 'brownsville-inspection-report',
  owner: 'justin.oberhofer',
  cadence: 'fixed',
  cadenceCron: '0 12 * * 1-5',
  command: `node "${ASTUTE}/reports/brownsville-inspection-report.js" --send`,
  cwd: ASTUTE,
  needsOT: false,
  logFile: '/tmp/brownsville-inspection-report.log',
  description: 'Mon-Fri 8am EDT — Brownsville inspection validation daily digest',
}
```

**Log file:** `/tmp/brownsville-inspection-report.log`

## Dependencies

- `shared/weekend-gate.js` — Skips Sat/Sun
- `shared/notifier.js` — Email delivery

## History

- **2026-08-17** — Initial implementation
  - Summary + inspector breakdown + detail listing
  - Scheduled Mon-Fri 8am Eastern
  - Recipient: justin.oberhofer@astutegroup.com
