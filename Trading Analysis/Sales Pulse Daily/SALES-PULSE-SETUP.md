# Sales Pulse Daily - Setup & Deployment

**Status:** ✅ READY FOR DEPLOYMENT
**Date:** May 29, 2026

---

## Quick Start

### 1. Configure Email Settings

Copy the example environment file and configure SMTP:

```bash
cp .env.example .env
nano .env  # Edit with your SMTP credentials
```

**For Gmail:**
1. Enable 2-factor authentication on your Google account
2. Generate an App Password: https://myaccount.google.com/apppasswords
3. Use the App Password in `.env` as `SMTP_PASS`

**Testing Recipients (Current):**
- Josh Pucci (josh.pucci@astutegroup.com)
- Melissa Bojar (melissa.bojar@astutegroup.com)

**Full Recipient List (After Josh's Feedback):**
- Josh Pucci (SVP Sales)
- Melissa Bojar
- Jeff Wallace (Director, USA)
- Joel Marquez (Manager, MEX)
- Laurel Kee (Manager, Singapore)
- Kris Munoz (Manager, Philippines/China)
- Lavanya Manohar (Manager, India)

### 2. Test the Script

Run manually to verify output:

```bash
node sales-pulse-daily.js
```

This will:
- Collect all metrics from database
- Generate HTML email
- Save output to `output/sales-pulse-YYYY-MM-DD.html`
- Save metrics JSON to `output/sales-pulse-YYYY-MM-DD.json`
- Send email (if SMTP configured)

### 3. Schedule Daily Execution

**Schedule:** 6:00am PT daily, Monday-Friday

**Option A: Using crontab (Linux/Mac)**

```bash
# Edit crontab
crontab -e

# Add this line (adjust path as needed):
# Run at 6am PT (9am ET, 2pm UTC) Mon-Fri
0 6 * * 1-5 cd /home/melissa.bojar/workspace && /usr/bin/node sales-pulse-daily.js >> logs/sales-pulse.log 2>&1
```

**Option B: Using pm2 (Node.js process manager)**

```bash
# Install pm2
npm install -g pm2

# Start the scheduler
pm2 start sales-pulse-daily.js --cron "0 6 * * 1-5" --no-autorestart

# Save pm2 configuration
pm2 save

# Set pm2 to start on system boot
pm2 startup
```

### 4. Monitor Logs

```bash
# View today's output
cat output/sales-pulse-$(date +%Y-%m-%d).json

# View cron log
tail -f logs/sales-pulse.log

# Or if using pm2
pm2 logs sales-pulse-daily
```

---

## File Structure

```
workspace/
├── sales-pulse-daily.js          # Main script
├── sales-pulse-queries-final.sql # SQL queries (reference)
├── .env                           # Email configuration (create from .env.example)
├── .env.example                   # Template for .env
├── output/                        # Generated emails & data
│   ├── sales-pulse-2026-05-29.html
│   └── sales-pulse-2026-05-29.json
└── logs/                          # Cron logs (create if needed)
    └── sales-pulse.log
```

---

## Troubleshooting

### Email Not Sending

1. Check SMTP credentials in `.env`
2. Verify Gmail App Password is correct (not your regular password)
3. Check for errors in output:
   ```bash
   node sales-pulse-daily.js
   ```

### Database Connection Issues

The script uses `psql` to connect to `idempiere_replica`. Ensure:
- You're running as a user with database access
- `psql idempiere_replica` works from command line

### Cron Not Running

1. Check cron is running: `systemctl status cron`
2. Check crontab is configured: `crontab -l`
3. Check logs: `grep CRON /var/log/syslog`
4. Verify paths are absolute in crontab

### No Data in Output

If metrics are all 0:
- The script looks at `CURRENT_DATE - 1` (yesterday)
- Run on a weekday to see previous business day data
- Check database has activity for yesterday

---

## Testing Checklist

- [ ] `.env` file created with valid SMTP credentials
- [ ] Script runs successfully: `node sales-pulse-daily.js`
- [ ] HTML email generated in `output/`
- [ ] Email received by Josh Pucci
- [ ] Email received by Melissa Bojar
- [ ] Email renders correctly in Gmail
- [ ] Email renders correctly in Outlook
- [ ] All metrics display correctly
- [ ] Daily breakdown table shows 3 days
- [ ] Insights calculate correctly

---

## Post-Testing: Production Deployment

After Josh's feedback and approval:

1. **Update Recipients**
   ```bash
   nano .env
   # Uncomment and use full recipient list
   ```

2. **Verify Schedule**
   - Confirm 6am PT works for all regions
   - Adjust timezone if needed

3. **Enable Monitoring**
   - Set up email alerts for script failures
   - Monitor logs for first week
   - Create dashboard for tracking delivery

4. **Document Feedback Loop**
   - How to report issues
   - Who maintains the script
   - How to request changes

---

## Maintenance

### Updating Recipients

Edit `.env` file and update `RECIPIENTS` line:

```bash
nano .env
# Then restart cron or pm2
```

### Changing Schedule

Edit crontab:

```bash
crontab -e
# Update the time in the cron expression
```

### Updating Metrics or Design

1. Edit `sales-pulse-daily.js`
2. Test locally: `node sales-pulse-daily.js`
3. Review output HTML in browser
4. Deploy changes (cron will pick up on next run)

### Adding New Sections

1. Add SQL query to `sales-pulse-queries-final.sql`
2. Add metric collection in `collectMetrics()` function
3. Update HTML template in `buildEmail()` function
4. Test and deploy

---

## Support

**Script Owner:** Melissa Bojar
**Business Owner:** Josh Pucci
**Database:** idempiere_replica (read-only)

**For Issues:**
1. Check logs first
2. Run script manually to reproduce
3. Review error messages
4. Contact analytics_user for database issues
