# RFQ Creation — Daily Digest

**Location:** `reports/daily-rfq-report.js`

Automated daily report showing RFQ creation activity, delivered via email to track data entry workload and automation efficiency.

## Schedule

- **When:** Mon-Fri at 8am Eastern (12:00 UTC)
- **Recipients:** justin.oberhofer@astutegroup.com
- **Delivery:** HTML email
- **Weekend gate:** Built-in (automatically skips Sat/Sun)

## Report Contents

### Table 1: Activity by Creator

Shows **who is creating RFQs** in the system (data entry attribution):

| Column | Description |
|--------|-------------|
| **Creator** | Person who physically created the RFQ in OT |
| **Role** | Classification: (Claude) / Support / Buyer / Untagged |
| **RFQs** | Count of RFQs created |
| **Lines** | Count of RFQ lines created |
| **MPNs** | Count of MPN records created |
| **% of Total** | Percentage of total lines (visual blue bar) |
| **Salespeople** | Which salespeople those RFQs were assigned to, with line counts |

**Role Color Coding:**
- ⚫ **(Claude)** — Automation (black)
- 🔘 **Support** — Support staff (gray)
- 🟢 **Buyer** — Procurement team (black)
- 🔴 **Untagged** — Needs role assignment (red)

**Example Row:**
```
Claude Harris | (Claude) | 63 RFQs | 92 lines | 92 MPNs | 30% | Jake Harris (90), Edgar Santana (2)
```

### Table 2: Seller Activity Breakdown

Shows **how each salesperson's RFQs were created** (workload support analysis):

| Column | Description |
|--------|-------------|
| **Salesperson** | The salesperson who owns the RFQs |
| **By Claude** | Lines created by automation (green) |
| **By Support** | Lines created by support staff (blue) |
| **By Self** | Lines created by the salesperson themselves (orange) |
| **Total Lines** | Sum of all three categories |
| **Mix** | Visual bar showing breakdown percentages |

**Example Rows:**
- **Jake Harris**: 90 by Claude, 1 by support → 99% automated
- **James Diaz**: 60 by self → 100% self-service
- **Silvia Munoz**: 17 by support → 100% support-assisted

## Key Insights

### Creator Attribution
- Tracks who is doing data entry (Claude automation vs human users)
- Shows role classification to identify untagged users
- Reveals which salespeople benefit from automation

### Workload Distribution
- Percentage based on lines (not RFQs) for accurate workload measure
- Shows automation efficiency per salesperson
- Identifies support-heavy vs self-service sellers

### Support Analysis
- Highlights salespeople who create their own RFQs vs rely on support
- Shows support staff workload (Gopalakrishnan, Lathis)
- Reveals automation gaps (high "By Self" might indicate training need)

## Usage

### Manual Run (Preview)
```bash
node reports/daily-rfq-report.js
```

### Manual Run (Send Email)
```bash
node reports/daily-rfq-report.js --send
```

### Custom Time Window
```bash
node reports/daily-rfq-report.js --since 48    # Last 48 hours
node reports/daily-rfq-report.js --since 48 --send
```

## Technical Details

### Data Source
- **Database:** `idempiere_replica` (read-only)
- **Tables:**
  - `adempiere.chuboe_rfq` (header)
  - `adempiere.chuboe_rfq_line` (CPC level)
  - `adempiere.chuboe_rfq_line_mpn` (MPN level)
- **Filters:** Active records only (`isactive='Y'`)

### Key Fields
- `createdby` — Who physically created the RFQ (Creator column)
- `salesrep_id` — Salesperson assigned to the RFQ (Salespeople column)
- `chuboe_rfq_line_id` — Line count (workload metric)

### Role Classification
Uses `shared/partner-lookup.js` registry:
- `isKnownBuyer()` → Buyer
- `isKnownSupport()` → Support
- `createdby = 1049524` → (Claude)
- All others → Untagged

### Creator Type Logic (Seller Breakdown)
```javascript
CASE
  WHEN createdby = 1049524 THEN 'claude'        // Claude automation
  WHEN createdby = salesrep_id THEN 'self'      // Salesperson created their own
  ELSE 'support'                                 // Support staff created for them
END
```

## Cron Configuration

**Registry:** `astute-workinstructions/cron-jobs.js`

```javascript
{
  name: 'rfq-creation-digest',
  cadence: 'fixed',
  cadenceCron: '0 12 * * 1-5',
  command: `node "${WORKSPACE}/reports/daily-rfq-report.js" --send`,
  cwd: WORKSPACE,
  needsOT: false,
  logFile: '/tmp/rfq-creation-digest.log',
  description: 'Mon-Fri 8am EDT — RFQ Creation digest',
}
```

**Log file:** `/tmp/rfq-creation-digest.log`

## Dependencies

- `shared/weekend-gate.js` — Skips Sat/Sun
- `shared/notifier.js` — Email delivery
- `shared/partner-lookup.js` — Role classification
- `shared/time-format.js` — CT timestamp formatting

## Metrics Explained

### Why Lines (Not RFQs)?
Percentages are based on **line count** rather than RFQ count because:
- Some RFQs have 1 line, others have 60+ lines
- Lines represent actual workload better than RFQ count
- A creator with 4 RFQs × 60 lines = 240 lines (20% of workload)
- A creator with 63 RFQs × 1 line each = 63 lines (30% of workload)

### Counting Logic: Creator Table
- Aggregates by creator (who pressed the button)
- Shows total lines created
- Lists all salespeople assigned to those RFQs with line breakdown
- Sorted by total line count descending

### Counting Logic: Seller Table
- Aggregates by salesperson (who owns the RFQ)
- Categorizes each line by who created it (Claude/Support/Self)
- Shows mix as visual bar for quick assessment
- Top 20 salespeople by line volume shown

## Example Use Cases

### Identify Automation Opportunities
If a salesperson shows high "By Self" percentage, they might benefit from:
- RFQ loading automation setup
- Support staff training
- Email forwarding workflow

### Track Support Workload
Support staff (Gopalakrishnan, Lathis) line counts show:
- Which salespeople they're supporting
- How many lines they're creating daily
- Distribution across multiple sellers

### Monitor Automation Health
Claude's line count shows:
- Stock RFQ automation volume
- Which salespeople benefit most from automation
- Automation coverage percentage

### Spot Untagged Users
Red "Untagged" roles indicate users who need:
- Role assignment in `shared/partner-lookup.js`
- Addition to buyer or support registry
- Investigation if unknown user

## History

- **2026-07-14** — Initial implementation
  - Two-table structure: Creator + Seller breakdown
  - Line-based percentages for accurate workload measurement
  - Role classification with color coding
  - Scheduled Mon-Fri 8am Eastern
  - Recipient: justin.oberhofer@astutegroup.com
