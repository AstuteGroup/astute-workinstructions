# VP Daily Brief - Automated Email Distribution

## Setup Instructions

The VP Daily Brief V2 is now configured to automatically email Josh Pucci and Melissa Bojar every weekday morning at 8am.

### Recipients
- josh.pucci@astutegroup.com
- melissa.bojar@astutegroup.com

### Email Details
- **From:** salesanalytics@orangetsunami.com (Sales Analytics)
- **Subject:** VP Daily Brief - Sales Pulse ([Yesterday's Date])
- **Content:** Full HTML report with all 3 sections

### Script Location
`/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/email-vp-daily-brief.js`

### Manual Execution
To send the report manually at any time:
```bash
node "/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/email-vp-daily-brief.js"
```

### Automated Schedule (Cron)

**To set up automated daily emails, add this to your crontab:**

1. Open crontab editor:
   ```bash
   crontab -e
   ```

2. Add this line:
   ```bash
   0 8 * * 1-5 /usr/bin/node "/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/email-vp-daily-brief.js" >> /home/melissa.bojar/workspace/Sales\ Pulse\ Daily/logs/email-cron.log 2>&1
   ```

3. Save and exit

**Cron Schedule Breakdown:**
- `0 8 * * 1-5` = Every weekday (Mon-Fri) at 8:00am
- `1-5` = Monday through Friday only (skips weekends)

### Log File
Create the logs directory if it doesn't exist:
```bash
mkdir -p "/home/melissa.bojar/workspace/Sales Pulse Daily/logs"
```

Cron output will be logged to: `/home/melissa.bojar/workspace/Sales Pulse Daily/logs/email-cron.log`

### Updating Recipients

To add or remove recipients, edit:
`/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/email-vp-daily-brief.js`

Find the `RECIPIENTS` array (around line 17) and modify as needed:
```javascript
const RECIPIENTS = [
  'josh.pucci@astutegroup.com',
  'melissa.bojar@astutegroup.com',
  // Add more recipients here
];
```

### Testing

The report was successfully sent on 2026-06-18 at 19:45 UTC to both recipients covering yesterday's data (June 17, 2026).

### Troubleshooting

If emails aren't being sent:
1. Check the cron log: `tail /home/melissa.bojar/workspace/Sales\ Pulse\ Daily/logs/email-cron.log`
2. Verify crontab is active: `crontab -l`
3. Test manual execution to ensure the script works
4. Check WorkMail credentials in `~/workspace/.env`
