# Tracking Loading Workflow

**Inbox:** `tracking@orangetsunami.com`
**Handler:** `shared/workflow-actions/tracking-loading.js`
**Cron:** Every 15 minutes via `cron-runner.js --job=tracking-agent`

## Purpose

Process forwarded supplier shipping confirmations and update OT purchase orders with tracking numbers. Operators forward shipping emails from suppliers (FedEx/UPS/DHL notifications, supplier "your order has shipped" emails) to this inbox, and the agent extracts tracking numbers and patches them onto the corresponding `c_order`.

## Email Format

Operators forward shipping confirmations. The agent extracts:

1. **PO Reference** — OT PO number (`PO######`) or Infor POV (`POV#######`)
2. **Tracking Numbers** — carrier tracking tokens (FedEx, UPS, DHL, USPS)
3. **Carrier** — auto-detected from tracking number format

## Tracking Number Detection

### Carrier Patterns

| Pattern | Carrier |
|---------|---------|
| `1Z*` (18 chars) | UPS |
| 12 digits | FedEx Express |
| 15 digits | FedEx Express |
| 20-22 digits | FedEx Ground |
| 10 digits | DHL |
| `EZ*US` or `9` + 19-21 digits | USPS |

### Exclusion Rules

Filter out non-tracking text:
- Contains "sent", "purchased", "visa", "invoice", "payment"
- Fewer than 8 characters
- Non-alphanumeric heavy (not matching `^[A-Z0-9-]{8,30}$`)

## PO Reference Detection

Search email body for either (or both):
- `PO######` — OT purchase order documentno (6 digits) — lookup via `c_order.documentno`
- `POV#######` — Infor POV reference (7 digits) — lookup via `c_orderline.chuboe_po_string`

Both are valid for lookup. If the email only has POV (common for supplier shipping confirmations), that's sufficient — the handler maps POV → OT PO via c_orderline.

Also check for generic patterns:
- `Purchase Order` followed by number
- `Order #` or `Order Number` patterns

## End-to-End Workflow

### Step 1: Poll Inbox

Agent polls `tracking@orangetsunami.com` for unread emails.

### Step 2: Extract References

For each email:
1. Parse body text (plain + HTML fallback)
2. Extract PO references using regex patterns
3. Extract tracking numbers using carrier detection
4. Auto-detect carrier from tracking format

### Step 3: Validate PO Exists

```sql
SELECT c_order_id, documentno, c_bpartner_id, bp.name AS vendor,
       chuboe_trackingnumbers AS existing_tracking
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
WHERE o.issotrx = 'N'  -- Purchase orders only
  AND o.isactive = 'Y'
  AND o.documentno = $1;
```

### Step 4: Patch Tracking Numbers

If PO found:
- Append new tracking to existing (comma-separated, deduped)
- PATCH `c_order.Chuboe_TrackingNumbers`

```javascript
const { patchRecord } = require('../shared/record-updater');

// Merge with existing tracking (avoid duplicates)
const merged = [...new Set([
  ...existingTracking.split(',').map(s => s.trim()).filter(Boolean),
  ...newTracking
])].join(', ');

await patchRecord('c_order', orderId, { Chuboe_TrackingNumbers: merged });
```

### Step 5: Route Email

| Outcome | Folder | Notification |
|---------|--------|--------------|
| Success (tracking patched) | `Processed` | Confirmation email |
| PO not found | `NeedsReview` | Escalation with extracted data |
| No tracking found | `NotTracking` | Silent move (likely not a shipping email) |
| Multiple POs matched | `NeedsReview` | Escalation to disambiguate |

## Actions

### `patch_tracking`

Updates OT with extracted tracking numbers.

**Required payload:** `tracking[]` + at least one of `documentno` or `pov`

```json
{
  "documentno": "PO809588",
  "tracking": ["488289378027", "500361860468"],
  "carrier": "FedEx"
}
```

Or with POV only:
```json
{
  "pov": "POV0075528",
  "tracking": ["488289378027"],
  "carrier": "FedEx"
}
```

**Lookup priority:**
1. `documentno` (OT PO) via `c_order.documentno`
2. `pov` (Infor POV) via `c_orderline.chuboe_po_string`

**Single-line vs Multi-line:**
| Order Lines | MPN Required? | Tracking Applied To |
|-------------|---------------|---------------------|
| 1 line | No | `c_order.Chuboe_TrackingNumbers` (order header) |
| 2+ lines | **Yes** | `c_orderline.Chuboe_TrackingNumbers` (specific line) |

**Side effects:**
- PATCH tracking field (order or line level)
- Breadcrumb: `tracking-loaded`
- Confirmation email to operator

### `needs_review`

Escalates ambiguous cases to operator.

**Required payload:**
```json
{
  "reason": "PO not found",
  "extracted_po": "PO999999",
  "extracted_tracking": ["488289378027"],
  "subject": "FW: Your order has shipped"
}
```

### `not_tracking`

Silent move for emails that don't contain shipping info.

## Confirmation Email

On success:
```
Subject: Tracking loaded: PO809588

Tracking numbers added to PO809588 (Waldom Electronics):
  • 488289378027 (FedEx)
  • 500361860468 (FedEx)

View in OT: https://172.31.7.239/webui/#/form/WF_POLine/...
```

## Idempotency

- Tracking numbers are deduped before merge
- Same tracking number won't be added twice to the same PO
- Message-ID breadcrumb prevents replay of already-processed emails

## Folder Structure

```
tracking@orangetsunami.com/
├── INBOX           ← unprocessed shipping confirmations
├── Processed       ← successfully patched
├── NeedsReview     ← ambiguous (no PO match, multiple matches)
└── NotTracking     ← not a shipping email
```

## Setup Checklist

- [ ] Create `tracking@orangetsunami.com` in AWS WorkMail
- [ ] Add IMAP credentials to `~/workspace/.env`
- [ ] Create IMAP folders: Processed, NeedsReview, NotTracking
- [ ] Add to workflow registry
- [ ] Add cron entry via `cron-jobs.js`
- [ ] Test with forwarded FedEx/UPS confirmation
