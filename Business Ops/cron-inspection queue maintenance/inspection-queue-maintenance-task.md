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

## Status

**Last updated:** 2026-08-10

**Progress:**
- [x] Problem statement documented
- [x] Diagnosis workflow documented
- [x] Screenshots captured (6 total in uploaded files)
- [x] Fix workflow documented

**Screenshots reference:**
1. Advanced search filter criteria
2. Inspection Queue results showing Weighted Priority column
3. PO Line tab (healthy record example)
4. SO Line tab (healthy record example)
5. SO Line tab showing "0 Records" (problem state)
6. Lot Allocation subtab showing blank Sales Order Line field
