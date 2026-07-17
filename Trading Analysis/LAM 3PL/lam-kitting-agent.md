# LAM Kitting Email Agent Workflow

Process LAM approval emails, new award notifications, and related correspondence on the `lamkitting@orangetsunami.com` inbox.

---

## Overview

| Setting | Value |
|---------|-------|
| **Inbox** | `lamkitting@orangetsunami.com` |
| **Cron** | Every 1h (`:15` past) |
| **Master Roster** | `Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx` |
| **Flagged Review** | `Trading Analysis/LAM 3PL/data/lam-flagged-review.json` |
| **Handler** | `shared/workflow-actions/lam-kitting.js` |

---

## APPROVAL + FLAGGING PATTERN

This workflow uses a hybrid approval pattern:

1. **Explicit approvals** (price, lead time) → **APPLIED immediately**
2. **Other field discrepancies** detected in email → **FLAGGED for review**
3. **Status = "Additional Review"** set on parts with flagged items
4. **Summary email** sent: "Applied X, please review Y"
5. **Operator replies** APPROVE/SKIP for flagged items
6. **Downstream visibility** — parts with "Additional Review" status appear in reorder alerts

### Why This Pattern?

- Explicit approvals don't wait — price approved → update immediately
- Implicit/detected changes get human review — prevents cascading errors
- Nothing falls through the cracks — Status flag ensures visibility
- Other workflows see pending reviews — reorder alerts show parts needing attention

---

## CRITICAL: All Outreach is INTERNAL-ONLY

**NEVER email LAM contacts directly.** All clarification emails go to Jake (operator) only.

---

## Request Types Handled

| Type | Description | Action | Auto-Apply? |
|------|-------------|--------|-------------|
| **Price approvals (batch)** | LAM approves multiple CPCs | `approve_prices` | Yes (ONE email) |
| **Price approval** | LAM approves proposed resale price | `approve_price` | Yes |
| **Lead time approval** | LAM approves contractual lead time | `approve_leadtime` | Yes |
| **Other field mentions** | MOQ, threshold, base price in email | Flagged | No — operator decides |
| **New award** | LAM adds new CPC to contract | `add_award` | Yes (after MFR validation) |
| **Rejection** | LAM rejects proposal | `reject` | N/A |
| **Flagged item reply** | Operator approves/skips flagged item | `approve_flagged` / `skip_flagged` | Per operator |

---

## Discrepancy Detection

When processing an approval email, the agent should:

### 1. Extract the Explicit Approval
- **Price approval:** CPC + approved resale price
- **Lead time approval:** CPC + new lead time

### 2. Scan for Other Field Mentions
Look for mentions of:
- **Lead Time:** "16 weeks", "8 week lead time", "stock"
- **MOQ:** "minimum order 100", "MOQ: 50"
- **Reorder Threshold:** "reorder at 25", "threshold 100"
- **Base Price:** "cost $8.50", "unit cost"

### 3. Build emailMentions Object
```json
{
  "leadTime": "16 WEEKS",
  "moq": 100,
  "reorderThreshold": 50,
  "basePrice": 8.50
}
```

### 4. Handler Compares Against Roster
The handler automatically:
- Applies the explicit approval
- Compares emailMentions to current roster values
- If different → flags as discrepancy
- Sets Status = "Additional Review"
- Sends summary email with both sections

---

## Summary Email Format

When discrepancies are detected:

```
LAM Approval Applied + Review Needed: 608-096583-504

✓ APPLIED CHANGES
| Field        | Previous | New Value |
|--------------|----------|-----------|
| Resale Price | $10.00   | $12.50    |

⚠️ FLAGGED FOR REVIEW
| Field     | Current Roster | Email Mentions |
|-----------|----------------|----------------|
| Lead Time | 8 WEEKS        | 16 WEEKS       |

Reply to lamkitting@ with:
  APPROVE LEADTIME — update to 16 WEEKS
  SKIP LEADTIME — leave as-is
  SKIP ALL — skip all flagged items

Part Status set to "Additional Review" until resolved.
```

---

## Reply Handling for Flagged Items

When operator replies with APPROVE/SKIP:

### APPROVE Commands
- `APPROVE LEADTIME` → Update Lead Time to email value
- `APPROVE MOQ` → Update MOQ to email value
- `APPROVE REORDERTHRESHOLD` → Update Reorder Threshold
- `APPROVE BASEPRICE` → Update Base Unit Price

### SKIP Commands
- `SKIP LEADTIME` → Leave Lead Time unchanged, remove flag
- `SKIP ALL` → Skip all flagged items for this CPC

### After Processing
- Remaining flagged count decremented
- When count reaches 0 → Status = "Additional Review" cleared
- Part returns to normal status in reorder workflows

---

## Downstream Workflow Visibility

### Reorder Alerts (`lam-kitting-reorder.js`)
Should check for Status = "Additional Review" and include in output:

```javascript
const { getFlaggedCPCs } = require('../shared/workflow-actions/lam-kitting');
const flaggedCPCs = getFlaggedCPCs();

// In output, add section:
// "Parts with Additional Review Pending"
// - Shows CPCs with flagged items
// - Links to flagged-review.json for details
```

### Pending Approvals Report
Parts with Status = "Additional Review" appear separately from "Pending Approval"

---

## Actions

### approve_prices (PREFERRED for multiple CPCs)
Apply multiple price approvals in ONE call, send ONE consolidated email.

**Payload:**
```json
{
  "approvals": [
    {"cpc": "660-345766-001", "approvedResale": 16.65, "mpn": "LTM4632EV#PBF", "emailMentions": {}},
    {"cpc": "630-210849-001", "approvedResale": 10.51, "emailMentions": {"leadTime": "8 WEEKS"}}
  ],
  "investigation_summary": "4 CPCs approved per Josh's email."
}
```

**Behavior:**
1. Apply all resale prices to roster
2. Detect discrepancies for each CPC (emailMentions vs roster)
3. Send ONE consolidated email with:
   - Table showing all CPCs with green/amber/gray status per field
   - Green = match, Amber = mismatch (needs review), Gray = not mentioned
4. CC original sender if different from Jake
5. Set "Additional Review" on any parts with discrepancies

### approve_price
Apply price approval + detect discrepancies.

**Payload:**
```json
{
  "cpc": "608-096583-504",
  "approvedResale": 12.50,
  "approvalDate": "2026-07-17",
  "emailMentions": {
    "leadTime": "16 WEEKS",
    "moq": 100
  },
  "investigation_summary": "Matched CPC, price matches proposed..."
}
```

**Behavior:**
1. Apply Resale Price = 12.50
2. Clear Pending/Proposed Resale/Submitted Date
3. Compare emailMentions to roster
4. If discrepancies → Set Status = "Additional Review"
5. Write to flagged-review.json
6. Send summary email

### approve_leadtime
Apply lead time approval + detect discrepancies.

**Payload:**
```json
{
  "cpc": "608-096583-504",
  "newLeadTime": "16 WEEKS",
  "emailMentions": { "moq": 100 },
  "investigation_summary": "..."
}
```

### approve_flagged
Apply a flagged discrepancy item.

**Payload:**
```json
{
  "cpc": "608-096583-504",
  "field": "leadTime",
  "newValue": "16 WEEKS"
}
```

**field values:** `leadTime`, `moq`, `reorderThreshold`, `basePrice`

### skip_flagged
Skip a flagged item without applying.

**Payload:**
```json
{
  "cpc": "608-096583-504",
  "field": "leadTime"
}
```

### add_award
Add new CPC to roster (after MFR validation).

**Payload:**
```json
{
  "cpc": "630-A12345-001",
  "mpn": "LM7805ACT",
  "manufacturer": "Texas Instruments",
  "awardQty": 500,
  "basePrice": 1.25,
  "resalePrice": 1.87,
  "reorderThreshold": 100,
  "moq": 50,
  "contractualLeadTime": "8 WEEKS",
  "investigation_summary": "MFR exists in chuboe_mfr..."
}
```

### reject
Record LAM rejection, set Status = "Rejected".

**Payload:**
```json
{
  "cpc": "608-096583-504",
  "reason": "Price too high - find alternate",
  "rejectedBy": "LAM Procurement"
}
```

### need_info
Internal clarification (writes sidecar for reply stitching).

### needs_review
Operator triage for unparseable emails.

### not_approval
Not a LAM approval email.

---

## Files

| File | Description |
|------|-------------|
| `shared/workflow-actions/lam-kitting.js` | Handler module |
| `lam-kitting-agent-prompt.txt` | Agent prompt |
| `lam-kitting-agent.md` | This document |
| `LAM_Master_Roster.xlsx` | Source of truth |
| `data/lam-flagged-review.json` | Pending flagged items |
| `lam-3pl.md` | LAM 3PL program documentation |

---

## IMAP Folders

| Folder | Purpose |
|--------|---------|
| `INBOX` | Source folder |
| `Processed` | Approvals applied (including flagged items resolved) |
| `Rejected` | LAM rejections |
| `NeedInfo` | Awaiting clarification |
| `NeedsReview` | Operator triage |
| `NotApproval` | General correspondence |

---

## CLI Commands

### List Unseen Messages
```bash
node shared/email-workflow-poller.js list --workflow lam-kitting
```

### Read a Message
```bash
node shared/email-workflow-poller.js read <uid> --workflow lam-kitting
```

### Route with Discrepancy Detection
```bash
node shared/email-workflow-poller.js route <uid> approve_price --workflow lam-kitting \
  --payload '{"cpc": "608-096583-504", "approvedResale": 12.50, "emailMentions": {"leadTime": "16 WEEKS"}}'
```

### Approve a Flagged Item
```bash
node shared/email-workflow-poller.js route <uid> approve_flagged --workflow lam-kitting \
  --payload '{"cpc": "608-096583-504", "field": "leadTime", "newValue": "16 WEEKS"}'
```

---

## Status Values

| Status | Meaning |
|--------|---------|
| `Pending Approval` | Awaiting LAM approval (from reorder workflow) |
| `Additional Review` | Approval applied, flagged items need operator review |
| `Rejected` | LAM rejected the proposal |
| *(empty)* | Normal — no pending actions |

---

## Error Handling

| Scenario | Action |
|----------|--------|
| CPC not found | `needs_review` with reason "CPC not found" |
| MFR not in chuboe_mfr (add_award) | `needs_review` — NEVER create MFR |
| Flagged field not recognized | `needs_review` |
| Parse error | `needs_review` with details |

---

## Related Workflows

- **LAM Reorder Alerts** — Check `getFlaggedCPCs()` for Additional Review visibility
- **LAM Pending Approvals** — Parts with Status = "Pending Approval"
- **LAM Customer Offer** — Uses roster data for customer-facing pricing
