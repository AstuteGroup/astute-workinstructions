# Inspection Queue Maintenance Task

## TOC

- [Summary](#summary)
- [Problem Statement](#problem-statement)
- [Diagnosis Workflow](#diagnosis-workflow)
  - [Step 1: Access the Inspection Queue](#step-1-access-the-inspection-queue)
  - [Step 2: Identify Problem Records](#step-2-identify-problem-records)
  - [Step 3: Diagnose Missing Allocation](#step-3-diagnose-missing-allocation)
- [Fix Workflow](#fix-workflow)
  - [Step 1: Navigate to Lot Allocation](#step-1-navigate-to-lot-allocation)
  - [Step 2: Link the SO Line](#step-2-link-the-so-line)
  - [Step 3: Save and Verify](#step-3-save-and-verify)
  - [Edge Cases](#edge-cases)
  - [Alternative Path: Link from SO Line](#alternative-path-link-from-so-line)
  - [Worked Example](#worked-example)
- [Database Reference](#database-reference)
- [Status](#status)

## Summary

The purpose of this task is to maintain the Inspection Queue by fixing records that have a blank Weighted Priority score.

This is important because the Weighted Priority determines inspection urgency. Records without a score do not appear in the correct priority order, which can delay critical inspections.

## Problem Statement

**Weighted Priority** is a composite score calculated from PO and SO line factors. When this field is **blank** (not zero — zero is valid), the record cannot be properly prioritized.

| Weighted Priority | Status |
|-------------------|--------|
| Any number (including 0) | ✓ Valid — record sorts correctly |
| BLANK / NULL | ✗ Problem — no score calculated, incorrect sort order |

**Root cause:** Almost always because the allocation between PO Line and SO Line is missing.

## Diagnosis Workflow

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

**Example of healthy record (W7, Inspection 1,768,362):**
- PO Line: ✓ POV0076108, NPI Solutions, Inc.
- SO Line: ✓ COV0021952, SO507085, Applied Materials

**Example of problem record (E4, Inspection 1,634,179):**
- PO Line: ✓ POV0073868 (has PO data)
- SO Line: ✗ 0 Records (missing allocation)

## Fix Workflow

The purpose of this workflow is to link missing SO Line allocations to PO Lines so that Weighted Priority can be calculated.

### Step 1: Navigate to Lot Allocation

1. From the problem Inspection Queue record, zoom to the linked **PO Line**
2. In the Purchase Order window, go to the **PO Line** tab
3. In the bottom panel, select the **Lot Allocation** subtab
4. Confirm the **Sales Order Line** field is blank — this is the missing link

### Step 2: Link the SO Line

1. Click the blank **Sales Order Line** field
2. A pop-up displays available SO Line candidates
3. Select the correct SO Line using these criteria:
   - **Exact quantity match** — preferred; select the SO Line with matching quantity
   - **Multiple candidates with same quantity** — use elimination logic (see Edge Cases)
   - **No exact match** — check if partial allocations sum correctly (see Edge Cases)

### Step 3: Save and Verify

1. **Save** the Lot Allocation record manually
2. Weighted Priority calculates immediately upon save
3. Return to Inspection Queue and refresh — the record should now show a Weighted Priority value

### Edge Cases

**No candidates (0 options in pop-up)**

No SO Line exists to allocate. This may be a spec buy or stock purchase with no customer order behind it. Skip this record — nothing to fix.

**Multiple candidates with same quantity**

Use process of elimination:
1. Check which candidates are already allocated to other Lot records — the **unlinked** candidate is likely correct
2. Use date proximity as a secondary indicator (closer dates = more likely match)
3. If still ambiguous, escalate — do not guess

**No exact quantity match (partial allocation)**

The relationship between PO Lines and SO Lines is **many-to-many**:

| Scenario | Example |
|----------|---------|
| 1 PO Line → Multiple SO Lines | PO 300 pcs fulfills SO lines of 50 + 100 + 150 |
| Multiple PO Lines → 1 SO Line | SO 500 pcs fulfilled by PO lines of 200 + 300 |

Check if unallocated quantities sum correctly in either direction. If the math balances, allocate the appropriate SO Line(s).

### Alternative Path: Link from SO Line

Use this path when the Lot Allocation pop-up shows no candidates or you need to search more broadly.

**Step 1: Search for SO Lines by MPN**

1. Navigate to **Sales Order Line Advanced Search** window
2. Search by MPN (the part number from the problem record)
3. Results show all SO Lines with that MPN

**Step 2: Evaluate candidates**

Review the results using these columns:

| Column | What to check |
|--------|---------------|
| Quantity | Should match or sum to the Lot qty |
| Physical Warehouse | AUSTIN vs DROP-SHIP — match the PO warehouse |
| Sales Order | Note the SO number for reference |
| Date | More recent = more likely match |

**Step 3: Zoom to the correct SO Line**

1. Select the candidate SO Line that matches
2. Zoom to the Sales Order window

**Step 4: Link from the SO Allocation tab**

1. In the Sales Order window, go to the SO Line
2. In the bottom panel, select the **Lot Allocation** tab
3. Link the PO Line from this side
4. **Update the Allocated Quantity** — it defaults to 0, so enter the correct qty
5. **Save** manually

**Step 5: Add the Lot ID (required for received POs)**

When linking from the SO side, the system creates a new Lot Allocation record **without the Lot ID**. Since the PO is already received (it's in the inspection queue), you must manually add the Lot ID:

1. Go back to the **PO Line** → **Lot Allocation** subtab
2. You will see two records:
   - Original record: has Lot ID, no Sales Order Line
   - New record: has Sales Order Line, **no Lot ID**
3. Copy the **Lot ID** from the original record to the new record
4. **Save** manually

> ⚠️ **Warning** - Without the Lot ID, the allocation won't link to the inspection queue record and Weighted Priority won't calculate.

**When to use this path:**
- Lot Allocation pop-up shows 0 candidates but you know an SO exists
- Multiple candidates require deeper investigation
- You want to verify allocation status across all SO Lines for an MPN

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

Use these queries to diagnose allocation issues via SQL.

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
  AND aol.c_orderline_id IS NULL  -- Not allocated
  AND sol.qtyentered = :qty;
```

> ⚠️ **Warning** - Use `qtyentered` (what the UI displays), not `qtyordered`. These can differ — `qtyordered` may be 0 while `qtyentered` shows the actual quantity.

## Status

**Last updated:** 2026-08-10

**Progress:**
- [x] Problem statement documented
- [x] Diagnosis workflow documented
- [x] Screenshots captured (10 total in uploaded files)
- [x] Fix workflow documented
- [x] Alternative path documented (link from SO Line)
- [x] Worked example added (PO810781)
- [x] Database reference queries added

**Screenshots reference:**
1. Advanced search filter criteria
2. Inspection Queue results showing Weighted Priority column
3. PO Line tab (healthy record example)
4. SO Line tab (healthy record example)
5. SO Line tab showing "0 Records" (problem state)
6. Lot Allocation subtab showing blank Sales Order Line field
7. Sales Order Line Advanced Search showing MPN candidates
8. SO Line Lot Allocation tab showing completed allocation (qty 420, PO Line linked)
9. PO Line Lot Allocation showing new record without Lot ID (before fix)
10. PO Line Lot Allocation showing Lot ID added to new record (after fix)
