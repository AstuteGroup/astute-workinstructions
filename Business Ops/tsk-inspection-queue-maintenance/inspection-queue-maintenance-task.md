# Inspection Queue Maintenance Task

## TOC

- [Summary](#summary)
- [Problem Statement](#problem-statement)
- [Skip List](#skip-list)
- [Automated Maintenance](#automated-maintenance)
  - [Quick Start](#quick-start)
  - [CLI Options](#cli-options)
  - [How It Works](#how-it-works)
  - [Cron Schedule](#cron-schedule)
- [Manual Workflow](#manual-workflow)
  - [Step 1: Access the Inspection Queue](#step-1-access-the-inspection-queue)
  - [Step 2: Identify Problem Records](#step-2-identify-problem-records)
  - [Step 3: Diagnose Missing Allocation](#step-3-diagnose-missing-allocation)
  - [Step 4: Navigate to Lot Allocation](#step-4-navigate-to-lot-allocation)
  - [Step 5: Link the SO Line](#step-5-link-the-so-line)
  - [Step 6: Save and Verify](#step-6-save-and-verify)
  - [Edge Cases](#edge-cases)
  - [Alternative Path: Link from SO Line](#alternative-path-link-from-so-line)
  - [Worked Example](#worked-example)
- [Database Reference](#database-reference)
- [Files](#files)
- [Setup](#setup)

## Summary

The purpose of this task is to maintain the Inspection Queue by fixing records that have a blank Weighted Priority score.

This is important because Weighted Priority determines inspection urgency. Records without a score do not appear in the correct priority order, which can delay critical inspections.

**Two approaches:**
- **Automated** — runs daily at 3am CT, auto-fixes straightforward cases, escalates ambiguous ones
- **Manual** — UI workflow for handling escalations or ad-hoc fixes

## Problem Statement

**Weighted Priority** is a composite score calculated from PO and SO line factors. When this field is **blank** (not zero — zero is valid), the record cannot be properly prioritized.

| Weighted Priority | Status |
|-------------------|--------|
| Any number (including 0) | ✓ Valid — record sorts correctly |
| BLANK / NULL | ✗ Problem — no score calculated, incorrect sort order |

**Root cause:** Almost always because the allocation between PO Line and SO Line is missing.

## Skip List

Some records should be **skipped** — they don't need allocation fixes because they follow a different workflow.

### Test House Returns

Parts sent to external test houses for additional testing return on a new PO. These lots have **already been through inspection** before being sent out.

| Vendor | Type |
|--------|------|
| White Horse Laboratories Ltd | Test house |

**How to identify:** Check the vendor on the VQ/PO. If it's a test house, skip the record.

### Consignment Programs

Lam kitting and Flock consignment lots follow a separate workflow and don't require SO Line allocation in the standard queue.

**How to identify:** Customer is Lam Research or vendor notes indicate Flock/consignment program.

### Spec Buys / Stock Purchases

Lots purchased for stock (no customer order behind them) will have no SO Line candidates. This is expected — nothing to fix.

**How to identify:** Lot Allocation pop-up shows 0 candidates and no RFQ/CQ trail exists.

## Automated Maintenance

Auto-fix inspection queue records with missing SO Line allocations.

- **Auto-fixes** straightforward cases: exact qty match, single candidate
- **Escalates** ambiguous cases: multiple candidates, qty mismatch
- **Skips** spec buys (no RFQ associated)

### Quick Start

```bash
# Dry-run (report only, no writes)
node inspection-queue-maintenance.js --dry-run --limit 50

# Live run (applies fixes)
node inspection-queue-maintenance.js --limit 100

# Full run (no limit)
node inspection-queue-maintenance.js
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Report only, no writes |
| `--limit N` | Process max N records (default: no limit) |
| `--verbose` | Print each allocation being processed |
| `--output-dir DIR` | Directory for escalation report (default: `./output`) |

### How It Works

**1. Find Missing Allocations**

Finds `chuboe_alloc_order_lot` records where `c_orderline_id` IS NULL.

**2. Find Candidate SO Lines**

For each allocation, finds candidate SO Lines via the CQ chain:
RFQ → CQ Lines (IsSold='Y') → c_orderline (via chuboe_cq_line_id)

**3. Classify**

| Scenario | Classification | Action |
|----------|----------------|--------|
| 1 candidate, exact qty, not allocated | AUTO_FIX | Link automatically |
| Multiple candidates, same qty | ESCALATE_MULTIPLE | Report with candidates |
| Qty mismatch (lot > available) | ESCALATE_QTY_MISMATCH | Report with recommendation |
| 0 candidates | NO_CANDIDATES | Skip (spec buy) |

**4. Auto-Fix**

For AUTO_FIX cases, PATCHes `chuboe_alloc_order_lot.C_OrderLine_ID` via `alloc-patcher.js`.

**5. Escalation Report**

Generates CSV report for manual review:

```
AllocID,LotID,MPN,LotQty,RFQ,Type,CandidateCount,Recommendation
2130858,1777832,"XE232-1024-FB374-C40",420,1137235,ESCALATE_QTY_MISMATCH,1,"SO507486 Line 10 (avail: 0)"
```

**Output Example:**

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

### Cron Schedule

Runs daily at 3am CT (8 UTC) as `analytics_user`.

```bash
# Verify cron is installed
crontab -l | grep inspection-queue

# Install if needed
node scripts/install-crons.js --apply
```

## Manual Workflow

Use this workflow for handling escalations or when automation is unavailable.

### Step 1: Access the Inspection Queue

1. Navigate to: **Inspection Queue (all)** window
2. Use saved query: **AUSTIN (MI Queue)**
3. Filter criteria:
   - Physical Warehouse = AUSTIN
   - Picked User = Is Null
   - Validated = unchecked
   - Active = checked ✓
   - Processed = unchecked
   - Warehouse Shelf = MI QUEUE

### Step 2: Identify Problem Records

1. Look at the **Weighted Priority** column (second column after checkbox, next to PO Weight)
2. Records with a **blank** Weighted Priority are the problem records
3. Records with **0.0** or any number are fine — they have been evaluated

### Step 3: Diagnose Missing Allocation

1. Select a problem record (blank Weighted Priority)
2. Check the **PO Line** tab in the bottom panel
   - Should show "1 Records" with PO details
3. Check the **SO Line** tab in the bottom panel
   - **Problem state:** Shows "0 Records" / "No Records found"
   - **Healthy state:** Shows "1 Records" with SO details

### Step 4: Navigate to Lot Allocation

1. From the problem Inspection Queue record, zoom to the linked **PO Line**
2. In the Purchase Order window, go to the **PO Line** tab
3. In the bottom panel, select the **Lot Allocation** subtab
4. Confirm the **Sales Order Line** field is blank — this is the missing link

### Step 5: Link the SO Line

1. Click the blank **Sales Order Line** field
2. A pop-up displays available SO Line candidates
3. Select the correct SO Line using these criteria:
   - **Exact quantity match** — preferred
   - **Multiple candidates with same quantity** — use elimination logic (see Edge Cases)
   - **No exact match** — check if partial allocations sum correctly

### Step 6: Save and Verify

1. **Save** the Lot Allocation record manually
2. Weighted Priority calculates immediately upon save
3. Return to Inspection Queue and refresh — the record should now show a Weighted Priority value

### Edge Cases

**No candidates (0 options in pop-up)**

No SO Line exists to allocate. This may be a spec buy or stock purchase. Skip this record.

**Multiple candidates with same quantity**

Use process of elimination:
1. Check which candidates are already allocated to other Lot records — the **unlinked** candidate is likely correct
2. Use date proximity as a secondary indicator
3. If still ambiguous, escalate — do not guess

**No exact quantity match (partial allocation)**

The relationship between PO Lines and SO Lines is **many-to-many**:

| Scenario | Example |
|----------|---------|
| 1 PO Line → Multiple SO Lines | PO 300 pcs fulfills SO lines of 50 + 100 + 150 |
| Multiple PO Lines → 1 SO Line | SO 500 pcs fulfilled by PO lines of 200 + 300 |

Check if unallocated quantities sum correctly. If the math balances, allocate the appropriate SO Line(s).

**When to escalate**

- No SO Line has sufficient remaining qty
- Partial allocations don't sum
- Over-allocated SO Lines need cleanup first
- Ambiguous candidates

### Alternative Path: Link from SO Line

Use when the Lot Allocation pop-up shows no candidates or you need to search more broadly.

**Step 1:** Navigate to **Sales Order Line Advanced Search** window and search by MPN.

**Step 2:** Evaluate candidates by Quantity, Physical Warehouse, Sales Order, and Date.

**Step 3:** Zoom to the correct SO Line.

**Step 4:** In the Sales Order window, go to SO Line → **Lot Allocation** tab. Link the PO Line and **update the Allocated Quantity** (defaults to 0).

**Step 5:** Go back to **PO Line** → **Lot Allocation** subtab. Copy the **Lot ID** from the original record to the new record.

> ⚠️ **Warning** - Without the Lot ID, the allocation won't link to the inspection queue record and Weighted Priority won't calculate.

### Worked Example

**Problem record:** PO810781, Lot 1777832

| Field | Value |
|-------|-------|
| MPN | XE232-1024-FB374-C40 |
| Lot Qty | 420 |
| PO | POV0076703 |
| RFQ | 1137235 (Adamson Systems Engineering INC) |

**Diagnosis:**
1. Lot Allocation subtab shows Sales Order Line = blank
2. CQ Line 1266612 exists (420 pcs) linked to RFQ

**Fix:**
1. Click blank Sales Order Line field
2. Pop-up shows: **SO507486 Line 10** (420 pcs, Adamson Systems Engineering)
3. Quantity matches (420 = 420) — select it
4. Save

**Result:** Weighted Priority calculates immediately.

## Database Reference

**Find lot allocation record:**
```sql
SELECT chuboe_alloc_order_lot_id, chuboe_insp_lot_id,
       c_orderline_id AS so_line_id, qty
FROM chuboe_alloc_order_lot
WHERE chuboe_insp_lot_id = :lot_id AND isactive = 'Y';
```

**Find lot details (MPN, PO, RFQ):**
```sql
SELECT chuboe_insp_lot_id, chuboe_mpnlot_mpn AS mpn,
       chuboe_mpnlot_qty AS qty, chuboe_mpnlot_po AS po,
       chuboe_rfq_id, chuboe_vq_line_id
FROM chuboe_insp_mpnlot_v
WHERE chuboe_insp_lot_id = :lot_id;
```

**Find candidate SO Lines (unallocated):**
```sql
SELECT so.documentno, sol.c_orderline_id, sol.line,
       sol.qtyentered, bp.name AS customer
FROM c_orderline sol
JOIN c_order so ON sol.c_order_id = so.c_order_id
JOIN c_bpartner bp ON so.c_bpartner_id = bp.c_bpartner_id
LEFT JOIN chuboe_alloc_order_lot aol
  ON sol.c_orderline_id = aol.c_orderline_id AND aol.isactive = 'Y'
WHERE so.issotrx = 'Y'
  AND sol.isactive = 'Y'
  AND aol.c_orderline_id IS NULL
  AND sol.qtyentered = :qty;
```

> ⚠️ **Warning** - Use `qtyentered` (what the UI displays), not `qtyordered`. These can differ.

## Files

| File | Purpose |
|------|---------|
| `inspection-queue-maintenance.js` | Automation runner script |
| `inspection-queue-maintenance-task.md` | This documentation |
| `output/` | Escalation reports |

**Dependencies:**
- `shared/alloc-patcher.js` — Validation + PATCH wrapper
- `shared/writeback-proxy-client.js` — Proxy for non-analytics_user execution
- `shared/breadcrumbs.js` — Audit trail

## Setup

**Install the cron:**

```bash
node scripts/install-crons.js --apply
crontab -l | grep inspection-queue
```

The cron runs as `analytics_user` with direct API access.

**Verify:**

```bash
node scripts/cron-runner.js --job=inspection-queue-maintenance --dry-run --force
```
