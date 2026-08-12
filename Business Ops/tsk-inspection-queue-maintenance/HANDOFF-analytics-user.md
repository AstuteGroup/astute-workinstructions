# Inspection Queue Maintenance CLI Handoff

**Date:** 2026-08-12
**From:** justin.oberhofer
**To:** analytics_user (Tyler Dennis)

---

## Current State

| Component | Status |
|-----------|--------|
| Cron job | ✅ Working — runs daily at 3 PM CT from justin.oberhofer's crontab |
| Email notifications | ✅ Working — HTML email with Queue, Rcvd, Customer, Vendor columns |
| Auto-fix writes | ❌ Blocked — `link-alloc-so` subcommand not in `/opt/writeback/cli.js` |

**Error when auto-fix is attempted:**
```
ERROR: Lot 1781396 → Unknown subcommand: link-alloc-so
```

---

## Summary

The inspection queue maintenance automation needs one step that requires analytics_user access: adding the `link-alloc-so` subcommand to `/opt/writeback/cli.js`.

Without this subcommand, the script can **detect** auto-fixable allocations but cannot **write** the fix.

---

## What You Need To Do

### Step 1: Install the CLI subcommand

```bash
# Preview first
node /home/justin.oberhofer/workspace/astute-workinstructions/scripts/add-link-alloc-so-to-cli.js

# Then apply
node /home/justin.oberhofer/workspace/astute-workinstructions/scripts/add-link-alloc-so-to-cli.js --apply
```

This will:
1. Add `link-alloc-so` subcommand to `/opt/writeback/cli.js`
2. Copy `alloc-patcher.js` to `/opt/writeback/`
3. Copy dependencies (`record-updater.js`, `breadcrumbs.js`) if not already present
4. Create a backup at `/opt/writeback/cli.js.bak`

### Step 2: Test the CLI

```bash
# Dry-run test (won't write anything)
echo '{"allocId":12345,"soLineId":67890,"opts":{"dryRun":true}}' | /opt/writeback/cli link-alloc-so
```

Expected output: JSON with validation result or error (the IDs above are fake, so expect "not found" errors — that's fine, it proves the subcommand is wired up).

### Step 3: Verify the automation works

```bash
node "/home/justin.oberhofer/workspace/astute-workinstructions/Business Ops/tsk-inspection-queue-maintenance/inspection-queue-maintenance.js" --dry-run --verbose
```

If any lots are classified as AUTO_FIX, they should now show the proper dry-run message instead of "Unknown subcommand".

---

## What the Subcommand Does

`link-alloc-so` PATCHes `chuboe_alloc_order_lot.C_OrderLine_ID` to link a lot allocation to a Sales Order Line.

**Validation performed:**
1. Allocation exists and is active
2. Allocation is not already linked to an SO Line
3. SO Line exists and is active
4. SO Line has sufficient remaining qty (unless `skipQtyCheck: true`)

**API call:** `PATCH /api/v1/models/chuboe_alloc_order_lot/{id}` with `{ C_OrderLine_ID: <soLineId> }`

---

## Files

| File | Purpose |
|------|---------|
| `shared/alloc-patcher.js` | Writer module with `linkAllocSOLine()` |
| `scripts/add-link-alloc-so-to-cli.js` | CLI installer |
| `Business Ops/tsk-inspection-queue-maintenance/inspection-queue-maintenance.js` | Automation script |
| `Business Ops/tsk-inspection-queue-maintenance/inspection-queue-maintenance-task.md` | Workflow documentation |

---

## How to Run as analytics_user

**Option 1: SSH directly**
```bash
ssh analytics_user@<server>
node /home/justin.oberhofer/workspace/astute-workinstructions/scripts/add-link-alloc-so-to-cli.js --apply
```

**Option 2: Contact Tyler Dennis** (analytics_user maintainer)
- Email: tyler.dennis@plantos.co
- Ask him to run the script above

**Option 3: From justin.oberhofer's session** (if passwordless sudo is configured later)
```bash
sudo -u analytics_user node ~/workspace/astute-workinstructions/scripts/add-link-alloc-so-to-cli.js --apply
```

---

## Questions?

Contact justin.oberhofer@astutegroup.com
