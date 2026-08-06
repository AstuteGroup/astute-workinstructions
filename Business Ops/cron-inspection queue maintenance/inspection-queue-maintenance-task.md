# Inspection Queue Maintenance Task

## TOC

- [Summary](#summary)
- [Problem Statement](#problem-statement)
- [Diagnosis Workflow](#diagnosis-workflow)
  - [Step 1: Access the Inspection Queue](#step-1-access-the-inspection-queue)
  - [Step 2: Identify Problem Records](#step-2-identify-problem-records)
  - [Step 3: Diagnose Missing Allocation](#step-3-diagnose-missing-allocation)
- [Fix Workflow](#fix-workflow)
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

> **📝 Note** - This section is incomplete. Next session: document how to allocate an SO Line to an inspection queue record.

TODO:
- [ ] Document the steps to link/allocate an SO Line
- [ ] Document edge cases (missing PO Line, both missing)
- [ ] Document when escalation is needed vs. self-service fix

## Status

**Last updated:** 2026-08-06

**Progress:**
- [x] Problem statement documented
- [x] Diagnosis workflow documented
- [x] Screenshots captured (5 total in uploaded files)
- [ ] Fix workflow — pending next session

**Screenshots reference:**
1. Advanced search filter criteria
2. Inspection Queue results showing Weighted Priority column
3. PO Line tab (healthy record example)
4. SO Line tab (healthy record example)
5. SO Line tab showing "0 Records" (problem state)
