# Template Candidates

Track high-volume vendors for template development. **Cumulative counts** across manual extraction sessions only.

**Note:** Historical data from rigid parser sessions (pre-Mar 10) excluded due to bad vendor assignments.

**When a template is created:** Remove vendor from this list and add to Existing Templates.

## When to Create a Template

- **5+ cumulative quotes** → Mark as PRIORITY, review email format
- **Consistent format** → Create template, remove from candidates
- **Inconsistent format** → Keep tracking, note in comments

## Existing Templates

| Template | Vendor | Search Key | Domain | Added |
|----------|--------|------------|--------|-------|
| velocity.js | Velocity Electronics | 1001036 | velocityelec.com | - |
| chip1.js | Chip 1 Stop | - | chip1.com | - |
| j2-sourcing.js | J2 Sourcing | 1002946 | j2sourcing.com | - |
| semitech.js | Semitech Semiconductor | 1006806 | semitech.net | - |
| akira-global.js | Akira Global | 1007942 | akiraglobal.com | - |

## Cumulative Vendor Counts

**Baseline:** 2026-03-10 (manual extraction sessions only)

| Search Key | Vendor | Cumulative | Priority | Sessions |
|------------|--------|------------|----------|----------|
| 1002457 | Atlantic Semiconductor | 4 | - | Mar 10 (4) |
| 1002948 | Inelco Components | 2 | - | Mar 10 (2) |
| 1002787 | Hybrid Electronics | 2 | - | Mar 10 (2) |
| 1002612 | Integrated Electronics | 2 | - | Mar 10 (2) |
| 1003290 | NetSource Technology | 2 | - | Mar 10 (2) |
| 1002337 | Select Technology | 2 | - | Mar 10 (2) |
| 1002842 | Nexus Electronics | 2 | - | Mar 10 (2) |
| 1004879 | N-tronics GmbH | 2 | - | Mar 10 (2) |

## How to Update (Step 7)

After each VQ loading session:

1. Count vendors from session upload CSV:
   ```bash
   cut -d',' -f3 [session]-upload.csv | tail -n +2 | sort | uniq -c | sort -rn
   ```

2. Add session counts to existing vendors OR add new rows

3. Update cumulative totals and mark 5+ as **PRIORITY**

4. When template created: move vendor to Existing Templates table
