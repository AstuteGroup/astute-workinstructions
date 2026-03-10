# Template Candidates

Track high-volume vendors for template development. **Cumulative counts** across all VQ loading sessions.

## When to Create a Template

- **5+ cumulative quotes** → Review email format consistency
- **Consistent format** → Create template
- **Inconsistent format** → Keep as manual extraction

## Existing Templates

| Template | Vendor | Domain | Status |
|----------|--------|--------|--------|
| velocity.js | Velocity Electronics | velocityelec.com | Active |
| chip1.js | Chip 1 Stop | chip1.com | Active |
| j2-sourcing.js | J2 Sourcing | j2sourcing.com | Active |
| semitech.js | Semitech Semiconductor | semitech.net | Active |
| akira-global.js | Akira Global | akiraglobal.com | Active |

## Cumulative Vendor Counts

**Last updated:** 2026-03-10

| Search Key | Vendor | Cumulative Quotes | Priority | Notes |
|------------|--------|-------------------|----------|-------|
| 1002457 | Atlantic Semiconductor | 4 | - | Session 2026-03-10 |
| 1002787 | Hybrid Electronics | 2 | - | Session 2026-03-10 |
| 1002612 | Integrated Electronics | 2 | - | Session 2026-03-10 |
| 1003290 | NetSource Technology | 2 | - | Session 2026-03-10 |
| 1002337 | Select Technology | 2 | - | Session 2026-03-10 |
| 1002842 | Nexus Electronics | 2 | - | Session 2026-03-10 |
| 1004879 | N-tronics GmbH | 2 | - | Session 2026-03-10 |
| 1002948 | Inelco Components | 2 | - | Session 2026-03-10 |

## How to Update

After each VQ loading session (Step 7):

1. Count vendors from session upload CSV:
   ```bash
   cut -d',' -f3 [session]-upload.csv | tail -n +2 | sort | uniq -c | sort -rn
   ```

2. Add counts to existing vendors OR add new rows

3. Mark vendors with 5+ quotes as **PRIORITY**

4. For PRIORITY vendors: pull sample emails, check format consistency
