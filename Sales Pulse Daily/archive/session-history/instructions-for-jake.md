# Sales Pulse Daily - Setup Instructions for Jake

Hi Jake,

The Sales Pulse Daily report is ready to go live. I need you to send the first test email since you have the SMTP credentials configured.

## Quick Start - Send Test Email Now

```bash
# 1. Generate today's report
node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/sales-pulse-comprehensive.js"

# 2. Send test email
node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/send-email.js"
```

**Recipients (already configured):**
- melissa.bojar@astutegroup.com
- josh.pucci@astutegroup.com

---

## What the Report Includes

**6 Sections:**
1. **Global Snapshot** - Yesterday vs 5-day rolling avg (Pipeline, Quoting, Wins, System Discipline)
2. **By Region** - USA, MEX, APAC performance breakdown
3. **Yesterday's Wins** - Sales orders closed, grouped by region
4. **Needs Attention** - 5 alert types (High-value quotes, High-probability customers, New customers, Pricing benchmarks, Sourcing stuck)
5. **Week-to-Date** - Monday through yesterday metrics by region
6. **Market Pulse** - Top 10 trending manufacturers & parts

---

## Optional: Set Up Daily Automated Sending

**Business Days Only (Monday-Friday)** - Automatically sends every weekday morning at 6:00 AM EST:

### Option 1: Add to cron-jobs.js registry (recommended)

Add this entry to `~/workspace/scripts/cron-jobs.js`:

```javascript
{
  name: 'sales-pulse-daily',
  schedule: '0 11 * * 1-5',  // 11 UTC = 6am EST, Monday-Friday only (no weekends)
  command: 'node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/sales-pulse-comprehensive.js" && node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/send-email.js"',
  description: 'Generate and email daily Sales Pulse report'
}
```

Then run:
```bash
node ~/workspace/scripts/install-crons.js --apply
```

### Option 2: Manual crontab entry

```bash
crontab -e
# Add this line:
0 11 * * 1-5 node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/sales-pulse-comprehensive.js" && node "/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/send-email.js"
```

---

## File Locations

- Main script: `/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/sales-pulse-comprehensive.js`
- Email sender: `/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/send-email.js`
- Output: `/home/melissa.bojar/workspace/Trading Analysis/Sales Pulse Daily/output/`

---

Thanks!
Melissa
