# Part Details Performance Findings

## Test Results (2026-06-18)

### What We Tested
1. **Hybrid approach (Top 3 parts via subquery)**: >30 seconds (timeout)
2. **CTE with ROW_NUMBER()**: >60 seconds (timeout)
3. **Current approach (no parts)**: <1 second ✓

### Root Cause
The performance bottleneck is **not** the query structure—it's the volume of data:
- Yesterday's ~20 orders have hundreds of order lines
- Each orderline → rfq_line_mpn → product join multiplies rows
- STRING_AGG must process all these rows
- Even with good indexes (confirmed: `c_orderline_order` exists), this takes 30+ seconds

## Viable Solutions

### ✅ Option A: Materialized View (RECOMMENDED)
**Setup once, instant queries forever**

**Pros:**
- Daily email query runs in <1 second (no timeout risk)
- Shows ALL parts, not just top 3
- Zero ongoing maintenance

**Cons:**
- Requires database permissions (CREATE MATERIALIZED VIEW)
- Initial setup effort (one-time)

**Implementation:**
1. Create materialized view with pre-aggregated order→parts data
2. Add cron job to refresh at 7:00am daily (before 8am email)
3. Update daily brief queries to join to materialized view instead of orderline

**Setup script**: See `PERFORMANCE-OPTIMIZATION.md` Option 2

**Check permissions:**
```sql
SELECT has_table_privilege('adempiere', 'CREATE');
```

---

### ✅ Option B: On-Demand Detailed Report
**Keep daily email fast, provide details separately**

**Concept:**
- Daily email shows summary (no part details) - stays <1 second
- Create separate script for detailed drill-down when needed
- Detailed report can take 30-60 seconds since it's run manually

**Pros:**
- No schema changes or permissions needed
- Daily email remains fast and reliable
- Details still available when users need them

**Cons:**
- Not automated (must run manually)
- Two separate reports to maintain

**Implementation:**
Create `vp-daily-brief-detailed.js`:
- Same structure as daily brief
- Includes full part details (accepts 30-60 second runtime)
- Run on-demand via command line
- Could email on request (not automated)

**Usage:**
```bash
# When Josh wants to see full part details for yesterday:
node "Sales Pulse Daily/scripts/vp-daily-brief-detailed.js" --email josh.pucci@astutegroup.com
```

---

### ❌ Option C: Real-time Optimization
**What we tested—doesn't work**

We tested multiple SQL optimization techniques:
- LATERAL JOIN with LIMIT
- CTE with ROW_NUMBER() window function
- Subquery approach

**Result:** All approaches still timeout (30-60+ seconds)

**Conclusion:** The data volume makes real-time aggregation infeasible for daily automation.

---

## Recommendation

**Best path forward depends on your database permissions:**

### If you CAN create materialized views:
→ **Go with Option A** (materialized view)
   - Best of both worlds: fast AND complete
   - One-time setup, permanent solution

### If you CANNOT create materialized views:
→ **Go with Option B** (on-demand detailed report)
   - Keep daily email fast and reliable
   - Provide detailed drill-down when needed
   - No risk of email delays from query timeouts

---

## Next Steps

1. **Check materialized view permissions:**
   ```bash
   psql -c "SELECT has_table_privilege('melissa.bojar', 'adempiere.c_order', 'SELECT');"
   ```

2. **If permissions exist:**
   - Implement materialized view (I can create the setup script)
   - Add refresh to cron (7:00am daily)
   - Update VP Daily Brief queries

3. **If no permissions:**
   - Create on-demand detailed report script
   - Document usage in AUTOMATION-SETUP.md
   - Keep daily email as-is (fast, no parts)

Which option would you prefer to pursue?
