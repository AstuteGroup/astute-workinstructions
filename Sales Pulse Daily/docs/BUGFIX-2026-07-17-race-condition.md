# Bug Fix: Race Condition in Concurrent Daily Brief Execution

**Date:** 2026-07-17
**Severity:** CRITICAL
**Status:** ✅ RESOLVED
**Affected Reports:** USA Daily Brief, Mexico Daily Brief, VP Daily Brief

---

## Symptom

**Manual execution:** Reports generated correctly with proper regional filtering
**Cron execution:** Regional filters crossed over - USA brief showed MEX sellers, Section 3 was empty

**Example of incorrect output (7/17/26 morning cron run):**
- USA Daily Brief Section 1 showed Alex Partida (MEX), Joel Flores (MEX)
- USA Daily Brief Section 3 was completely empty
- These were the EXACT sellers that should have appeared in the Mexico brief

---

## Root Cause

All three daily brief scripts shared the same temporary SQL file for query execution:

```javascript
// BEFORE (all three scripts):
const tempFile = path.join(__dirname, '../output/temp-query.sql');
```

**The Race Condition:**

1. **13:00:00 UTC** - USA script writes USA query to `temp-query.sql`
2. **13:00:00 UTC** - MEX script overwrites with MEX query (same millisecond)
3. **13:00:01 UTC** - USA script executes `psql -f temp-query.sql` → runs MEX query!
4. **Result:** USA brief shows MEX data

All three briefs are scheduled to run at exactly 13:00 UTC (6am PDT) via cron:

```cron
0 13 * * 1-5 /usr/bin/node ".../email-usa-daily-brief.js"
0 13 * * 1-5 /usr/bin/node ".../email-mexico-daily-brief.js"
0 13 * * 1-5 /usr/bin/node ".../email-vp-daily-brief.js"
```

**Why manual runs worked:**
Only one script executed at a time, no temp file collision.

**Why cron runs failed:**
Simultaneous execution caused file overwrites during query execution.

---

## The Fix

Each script now uses a **unique temporary file name**:

```javascript
// USA Daily Brief (sales-pulse-usa-daily.js):
const tempFile = path.join(__dirname, '../output/temp-query-usa.sql');

// Mexico Daily Brief (sales-pulse-mexico-daily.js):
const tempFile = path.join(__dirname, '../output/temp-query-mexico.sql');

// VP Daily Brief (sales-pulse-vp-daily-v2.js):
const tempFile = path.join(__dirname, '../output/temp-query-vp.sql');
```

**Files Modified:**
- `Sales Pulse Daily/scripts/sales-pulse-usa-daily.js`
- `Sales Pulse Daily/scripts/sales-pulse-mexico-daily.js`
- `Sales Pulse Daily/scripts/sales-pulse-vp-daily-v2.js`

---

## Verification

**Test:** Ran all three scripts simultaneously using `&` and `wait`:

```bash
node sales-pulse-usa-daily.js & \
node sales-pulse-mexico-daily.js & \
node sales-pulse-vp-daily-v2.js & \
wait
```

**Result:** All three briefs generated correctly with proper regional filtering:

| Brief | Sellers Shown | Status |
|-------|---------------|--------|
| **USA** | Josh Syre, Jake Mcaloose, Daniel Reiser, Aaron Mendoza (USA) | ✅ Correct |
| **MEX** | Alex Partida, Joel Flores (MEX) | ✅ Correct |
| **VP** | All regions | ✅ Correct |

---

## Impact

**Before Fix:**
- USA Daily Brief recipients (Jeff Wallace, Melissa Bojar) received incorrect data every morning
- MEX sellers appeared in USA brief, causing confusion
- Section 3 (rep activity) was completely missing

**After Fix:**
- Each brief shows only its intended regional data
- Concurrent execution is safe
- No manual intervention needed

---

## Prevention

**Lesson Learned:** When multiple scripts run concurrently, avoid shared file resources.

**Pattern for Future Scripts:**
```javascript
// ❌ BAD - shared temp file
const tempFile = path.join(__dirname, '../output/temp-query.sql');

// ✅ GOOD - unique temp file per script
const tempFile = path.join(__dirname, `../output/temp-query-${scriptName}.sql`);
```

**Recommended Practice:**
- Use `process.pid` or script-specific identifiers in temp file names
- Or use proper temp directory (`os.tmpdir()`) with unique names
- Never assume scripts run sequentially unless enforced by dependency chain

---

## Timeline

- **2026-07-17 06:00 PDT** - Incorrect USA brief sent via cron (MEX sellers shown)
- **2026-07-17 08:23 PDT** - Melissa requests manual run for verification
- **2026-07-17 08:27 PDT** - Manual run generates correctly (no race condition)
- **2026-07-17 08:30 PDT** - Melissa reports pattern: manual correct, cron wrong
- **2026-07-17 08:45 PDT** - Root cause identified (shared temp file)
- **2026-07-17 09:00 PDT** - Fix implemented and tested
- **2026-07-17 09:15 PDT** - Revised USA brief sent to distribution list
- **2026-07-17 09:30 PDT** - Changes committed to git

---

## Related Issues

This pattern has occurred before with regional filters. The issue was always:
- Manual execution: CORRECT regional filtering
- Automated execution: WRONG regional filtering (regions mixed up)

**This fix resolves the root cause** and should prevent all future occurrences of this class of bug.

---

**Next Scheduled Test:** 2026-07-18 06:00 AM PDT (automated cron run)
**Expected Result:** All three briefs generate with correct regional filtering
**Monitoring:** Review tomorrow's automated briefs for correct seller distribution

---

*Last Updated: 2026-07-17*
*Fixed By: Melissa Bojar + Claude Sonnet 4.5*
