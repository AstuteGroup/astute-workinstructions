# Daily Sales Reports - Health Check System

**Created:** 2026-07-15
**Purpose:** Prevent sending incomplete/incorrect reports when system issues occur

## Overview

The health check system validates system health and data quality BEFORE sending any Daily Sales Reports. If issues are detected, an alert email is sent to **Melissa Bojar ONLY** and the distribution is automatically aborted.

## What Gets Checked

### 1. Pre-Flight Health Checks (Before Report Generation)

**Database Connectivity Test:**
- Verifies psql can connect and execute queries
- Tests: `SELECT 1`
- Timeout: 5 seconds

**Sample Data Query:**
- Verifies database has recent order data
- Tests: Count of orders in last 7 days
- Fails if: Zero orders returned (indicates stale/disconnected DB)

### 2. Data Quality Validation (After Report Generation)

**File Existence:**
- Verifies HTML and JSON files were created
- Fails if: Missing output files

**Data Sanity Checks:**
- Detects suspiciously empty reports
- Flags if: BOTH Section 1 (Top Wins) AND Section 3 (Activity) are completely zero
- Rationale: One section being empty is possible, but both suggests DB connection issues

### 3. Regional Filtering Validation (Existing)

**Query File Validation:**
- Verifies Mexico queries filter to Mexico sellers only
- Verifies USA queries filter to USA sellers only
- Checks CASE statements, section headers, filters

## How It Works

### Normal Flow (All Checks Pass):

```
1. Health checks run
2. Regional validation runs
3. Report generates
4. Data validation runs
5. ✅ Report sent to FULL distribution
```

### Failure Flow (Any Check Fails):

```
1. Health checks run → FAIL
2. 🚨 Alert email sent to melissa.bojar@astutegroup.com
3. ❌ Distribution ABORTED
4. Exit with error code 1
```

## Alert Emails

**Sent to:** melissa.bojar@astutegroup.com ONLY
**Never sent to:** Distribution recipients (they won't see broken reports)

**Alert includes:**
- What failed (health check, validation, data quality)
- Specific error details
- List of recipients who did NOT receive the report
- Recommended actions
- Path to manually review files/logs

## Testing the System

**Test health checks manually:**
```bash
node ~/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts/health-checks.js
```

**Test full email flow (sends to melissa.bojar@ only):**
```bash
# Will run all checks and send if healthy
node ~/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts/email-usa-daily-brief.js
```

## Files Modified

**New:**
- `Sales Pulse Daily/scripts/health-checks.js` - Core health check logic

**Updated:**
- `Sales Pulse Daily/scripts/email-usa-daily-brief.js` - Added health + data validation
- `Sales Pulse Daily/scripts/email-mexico-daily-brief.js` - Added health + data validation
- `Sales Pulse Daily/scripts/email-vp-daily-brief.js` - Added health + data validation

## Common Scenarios

### Scenario: Internet Outage

**What happens:**
1. Cron runs at 6am PT
2. Health check: Database connection fails
3. Alert sent to Melissa: "Database connection failed"
4. Recipients (Jeff, Joel, Josh, Aran) never see bad data
5. Melissa can manually re-run when internet restored

### Scenario: Database Replication Lag

**What happens:**
1. Cron runs, database connects OK
2. Sample query: Zero orders in last 7 days (suspicious)
3. Alert sent to Melissa: "No orders found in last 7 days"
4. Recipients never see empty report
5. Melissa can check if truly no activity or DB issue

### Scenario: Partial Data Load

**What happens:**
1. Cron runs, health checks pass
2. Report generates but Section 1 and Section 3 both empty
3. Data validation: "Suspiciously empty data"
4. Alert sent to Melissa with JSON file path for review
5. Recipients never see incomplete report

## Maintenance

**When to update health-checks.js:**
- Add new sanity checks as needed
- Adjust timeout values if network is consistently slow
- Add region-specific validation rules

**When to update email scripts:**
- Add new alert conditions
- Change alert recipient (currently hardcoded to melissa.bojar@)
- Add additional pre-flight checks

## Future Enhancements

**Potential additions:**
1. Retry logic (auto-retry 3 times with 5-min delays if health check fails)
2. Slack notifications in addition to email
3. Historical trend analysis (flag if today's data is drastically different from 7-day avg)
4. Query performance monitoring (alert if queries take >30 seconds)

## Rollback Plan

**If health checks cause false positives:**
1. Temporarily disable by commenting out health check calls in email scripts
2. Investigate root cause (too strict thresholds, flaky DB, etc.)
3. Adjust validation rules
4. Re-enable

**Emergency bypass (use with caution):**
```bash
# Generate report without sending
node ~/workspace/astute-workinstructions/Sales\ Pulse\ Daily/scripts/sales-pulse-usa-daily.js

# Manually review output
cat ~/workspace/astute-workinstructions/Sales\ Pulse\ Daily/output/usa-briefs/usa-daily-brief-YYYY-MM-DD.json

# If data looks good, manually send
# (Create custom send script or use notifier directly)
```
