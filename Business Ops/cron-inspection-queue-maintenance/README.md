# Inspection Queue Maintenance

## Summary

Auto-fix inspection queue records with missing SO Line allocations. Runs daily at 3am CT.

- **Auto-fixes** straightforward cases: exact qty match, single candidate
- **Escalates** ambiguous cases: multiple candidates, qty mismatch
- **Skips** spec buys (no RFQ associated)

## Quick Start

```bash
# Dry-run (report only, no writes)
node inspection-queue-maintenance.js --dry-run --limit 50

# Live run (applies fixes)
node inspection-queue-maintenance.js --limit 100

# Full run (no limit)
node inspection-queue-maintenance.js
```

## CLI Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Report only, no writes |
| `--limit N` | Process max N records (default: no limit) |
| `--verbose` | Print each allocation being processed |
| `--output-dir DIR` | Directory for escalation report (default: `./output`) |

## How It Works

### 1. Find Missing Allocations

Finds `chuboe_alloc_order_lot` records where `c_orderline_id` IS NULL.

```sql
SELECT aol.chuboe_alloc_order_lot_id, aol.qty, lv.chuboe_mpnlot_mpn, lv.chuboe_rfq_id
FROM chuboe_alloc_order_lot aol
JOIN chuboe_insp_mpnlot_v lv ON lv.chuboe_insp_lot_id = aol.chuboe_insp_lot_id
WHERE aol.isactive = 'Y' AND aol.c_orderline_id IS NULL;
```

### 2. Find Candidate SO Lines

For each allocation, finds candidate SO Lines via the CQ chain:
- RFQ → CQ Lines (IsSold='Y') → c_orderline (via chuboe_cq_line_id)

### 3. Classify

| Scenario | Classification | Action |
|----------|----------------|--------|
| 1 candidate, exact qty, not allocated | AUTO_FIX | Link automatically |
| Multiple candidates, same qty | ESCALATE_MULTIPLE | Report with candidates |
| Qty mismatch (lot > available) | ESCALATE_QTY_MISMATCH | Report with recommendation |
| 0 candidates | NO_CANDIDATES | Skip (spec buy) |

### 4. Auto-Fix

For AUTO_FIX cases, PATCHes `chuboe_alloc_order_lot.C_OrderLine_ID` via `alloc-patcher.js`.

### 5. Escalation Report

Generates CSV report for manual review:

```
AllocID,LotID,MPN,LotQty,RFQ,Type,CandidateCount,Recommendation
2130858,1777832,"XE232-1024-FB374-C40",420,1137235,ESCALATE_QTY_MISMATCH,1,"SO507486 Line 10 (avail: 0)"
```

## Output Example

```
=== Inspection Queue Maintenance ===

Mode: LIVE
Limit: 200 records

Found 200 allocations with missing SO Line

AUTO-FIX: Alloc 2130635 → SO Line 1020870 (qty: 11)
AUTO-FIX: Alloc 2130634 → SO Line 1026869 (qty: 1)
ESCALATE: Alloc 2130858 → No candidate has sufficient qty. Best: SO507486 Line 10 (available: 0, need: 420)
ESCALATE: Alloc 2130637 → Multiple candidates with sufficient qty (2 options)

--- Summary ---
Auto-fixed: 6
Escalations: 48
Skipped (spec buys): 146

Escalation report written to: ./output/escalations-2026-08-10T17-02-25.csv
```

## Cron Schedule

```javascript
{
  name: 'inspection-queue-maintenance',
  cadence: 'daily',
  cadenceCron: '0 8 * * *',  // 8 UTC = 3 AM CT
  needsOT: true,
  description: 'Auto-fix inspection queue allocations with missing SO Line links'
}
```

## Setup

**Install the cron:**

```bash
node scripts/install-crons.js --apply
crontab -l | grep inspection-queue
```

The cron runs as `analytics_user`, so it uses the direct API path — no proxy CLI update needed.

See `HANDOFF-analytics-user.md` only if you need manual runs from restricted user sessions.

## Files

| File | Purpose |
|------|---------|
| `inspection-queue-maintenance.js` | Main runner script |
| `README.md` | This documentation |
| `HANDOFF-analytics-user.md` | Optional: proxy CLI setup for manual runs |
| `output/` | Escalation reports |

## Dependencies

- `shared/alloc-patcher.js` — Validation + PATCH wrapper
- `shared/writeback-proxy-client.js` — Proxy for non-analytics_user execution (cron doesn't need this)
- `shared/breadcrumbs.js` — Audit trail

## Manual Workflow Reference

For manual fixes via OT UI, see:
- `Business Ops/cron-inspection queue maintenance/inspection-queue-maintenance-task.md`

## Why This Exists

The inspection queue shows records with blank Weighted Priority when the allocation lacks an SO Line link. This happens when:

1. SO Line was created after PO receipt
2. Allocation record was created without linking to SO
3. Data migration gaps

Without the SO Line link, Weighted Priority cannot be calculated, and the record doesn't sort correctly in the inspection queue.

## Verification

After an auto-fix runs:

1. Refresh the Inspection Queue in OT
2. The fixed record should now show a Weighted Priority value
3. Check the breadcrumb log for audit trail
