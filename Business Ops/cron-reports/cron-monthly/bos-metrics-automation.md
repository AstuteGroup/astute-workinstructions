# BOS Metrics Report - Automated Monthly Email

**Status:** ✅ Complete and Running
**Created:** 2026-07-06
**Owner:** Justin Oberhofer

## Overview

Automated monthly report tracking CSE (Customer Service Engineer) queue activity. Generates Excel report on the 1st of each month at noon EST and emails it to justin.oberhofer@astutegroup.com.

## What It Tracks

Three key metrics for CSE queue management:

1. **Claims** - How many times a user claims a request from the CSE queue (detected when AD_Role_ID changes FROM 1000006)
2. **Answered** - How many times requests are set to "Answered" status (R_Status_ID = 1000003)
3. **Closed** - How many times requests are set to "Closed" status (R_Status_ID IN 1000002, 1000025, 1000026, 1000030, 102)

**Filtered to 7 CSE users:**
- Bhuvan
- Vimal
- Mohan
- Julie White
- Haritharan
- Ricky Atajar
- Rosalyn Cana

## Report Structure

**Filename:** `BOS Metrics - {Month Year}.xlsx` (e.g., `BOS Metrics - June 2026.xlsx`)

**4 sheets:**

| Sheet | Name | Description |
|-------|------|-------------|
| 1 | {Month Year} | Previous month summary by user with totals |
| 2 | User Monthly Detail | 12-month pivot table showing Answered+Closed by user |
| 3 | Requests Ans-Cls by User | Detailed breakdown by month and user |
| 4 | Requests Ans-Cls prev 12 Mo | Monthly aggregate totals for trailing 12 months |

**Total column** = Answered + Closed only (excludes Claims)

## Automation Setup

### Cron Schedule

**Registry:** `cron-jobs.js` (managed via `scripts/install-crons.js`)

```javascript
{
  name: 'bos-metrics-report',
  cadence: 'monthly',
  cadenceCron: '0 17 1 * *',  // 1st of month at 17:00 UTC (12pm EST)
  command: `node "${WORKSPACE}/scripts/generate-bos-metrics.js"`,
  ...
}
```

**Runs:** 1st of every month at 12:00 PM EST (17:00 UTC)
**Log file:** `/tmp/bos-metrics.log`

### Email Configuration

**Sender:** bizops@orangetsunami.com
**Recipients:** justin.oberhofer@astutegroup.com, leah.griffin@astutegroup.com
**SMTP:** AWS WorkMail (smtp.mail.us-east-1.awsapps.com:465)

Credentials stored in `~/workspace/.env`:
```
SMTP_HOST=smtp.mail.us-east-1.awsapps.com
SMTP_PORT=465
SMTP_PASS=A$tuteu$a
```

## Files

| File | Location | Purpose |
|------|----------|---------|
| Script | `~/workspace/scripts/generate-bos-metrics.js` | Main generation script |
| Docs | `~/workspace/bos-metrics-report.md` | Full technical documentation |
| Config | `~/workspace/.env` | SMTP credentials |
| Log | `~/workspace/logs/bos-metrics.log` | Cron execution log |
| Output | `~/workspace/BOS Metrics - {Month}.xlsx` | Generated reports |

## Data Source

- **Database:** idempiere_replica (read-only)
- **Table:** `adempiere.ad_changelog` (75M+ rows)
- **Filters:**
  - `ad_table_id = 417` (R_Request table)
  - `ad_column_id = 13488` (AD_Role_ID) - for Claims
  - `ad_column_id = 13484` (R_Status_ID) - for Answered/Closed
- **Time range:** Rolling 12 months ending with previous month (excludes current month)

## How It Works

1. **Calculate previous month** - If today is July 6, 2026 → report covers June 2026
2. **Query changelog** - 3 parallel queries for Claims, Answered, Closed (12-month rolling window)
3. **Filter to CSE users** - Only include the 7 designated CSE users
4. **Generate Excel** - 4 sheets with formatting, column widths, totals
5. **Email via notifier** - Uses `shared/notifier.js` with AWS WorkMail SMTP
6. **Log results** - All output captured in `logs/bos-metrics.log`

## Testing

To generate report manually:
```bash
node ~/workspace/scripts/generate-bos-metrics.js --email justin.oberhofer@astutegroup.com
```

To test without email:
```bash
node ~/workspace/scripts/generate-bos-metrics.js
# Report saved to ~/workspace/BOS Metrics - {Month}.xlsx
```

## Maintenance

### To change recipients
Edit `scripts/generate-bos-metrics.js`:
```javascript
const DEFAULT_EMAIL = 'justin.oberhofer@astutegroup.com,leah.griffin@astutegroup.com';
```

### To change CSE user list
Edit `scripts/generate-bos-metrics.js`:
```javascript
const CSE_USERS = ['Bhuvan', 'Vimal', 'Mohan', ...];
```

### To view logs
```bash
tail -50 ~/workspace/logs/bos-metrics.log
```

### To check next run time
```bash
crontab -l | grep BOS
```

## Technical Notes

- Uses `xlsx-populate` for Excel generation (no external dependencies on Excel)
- Queries are optimized with date filters and group-by aggregation
- Email uses `shared/notifier.js` (standardized across all workflows)
- CSE role ID: 1000006
- Answered status ID: 1000003
- Closed status IDs: 1000002, 1000025, 1000026, 1000030, 102

## Success Criteria

✅ Report generates correctly with 4 sheets
✅ Email sends successfully via AWS WorkMail
✅ Cron job installed and scheduled
✅ Only includes 7 designated CSE users
✅ Total column = Answered + Closed (excludes Claims)
✅ Covers 12 months ending with previous month
✅ Report filename includes month name

## Recent Run

**Last test:** 2026-07-15 14:00:55 UTC
**Report:** BOS Metrics - June 2026.xlsx
**Status:** ✅ Email sent successfully
**Recipients:** justin.oberhofer@astutegroup.com, leah.griffin@astutegroup.com

Log excerpt:
```
[2026-07-15T14:00:55.548Z] INFO: Email with attachment sent to justin.oberhofer@astutegroup.com,leah.griffin@astutegroup.com: BOS Metrics - June 2026 (TEST)
```

## Related Work

- Initial request: Track CSE queue claims, answered, and closed metrics
- Iterations: Added filtering to CSE users only, excluded current month, moved previous month sheet to front
- Chart requests: Initially added charts, then removed per user request (kept data tables only)
