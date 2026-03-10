# Template Candidates

Track high-volume vendors for template development. **Cumulative counts** across all VQ loading sessions.

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

**Last updated:** 2026-03-10 (includes sessions: 2026-03-02, 2026-03-10)

| Search Key | Vendor | Cumulative | Priority | Sessions |
|------------|--------|------------|----------|----------|
| 1002948 | Inelco Components | 23 | **PRIORITY** | Mar 2 (21), Mar 10 (2) |
| 1004482 | Cynosure | 23 | **PRIORITY** | Mar 2 (23) |
| 1003646 | Ozdisan Elektronik | 16 | **PRIORITY** | Mar 2 (16) |
| 1003040 | Data Device Corp | 13 | **PRIORITY** | Mar 2 (13) |
| 1007730 | Puking Electronics | 12 | **PRIORITY** | Mar 2 (12) |
| 1009938 | RioSH Technologies | 10 | **PRIORITY** | Mar 2 (10) |
| 1005154 | Micros sp j | 10 | **PRIORITY** | Mar 2 (10) |
| 1005599 | Green Chips | 9 | **PRIORITY** | Mar 2 (9) |
| 1004912 | PKS Electronic | 8 | **PRIORITY** | Mar 2 (8) |
| 1002495 | Cyclops Electronics | 8 | **PRIORITY** | Mar 2 (8) |
| 1002457 | Atlantic Semiconductor | 4 | - | Mar 10 (4) |
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
