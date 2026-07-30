# Tracking Loading - STEP 3: Per-message decision tree
#
# This file contains the workflow-specific decision logic for Tracking Loading.
# NOTE: This workflow uses a custom full-template format.

## Inbox

tracking@orangetsunami.com

## CLI Primitives

```bash
node shared/email-workflow-poller.js list   --workflow tracking-loading
node shared/email-workflow-poller.js read <uid>   --workflow tracking-loading
node shared/email-workflow-poller.js route <uid> <action>   --workflow tracking-loading --payload '<json>'
```

## Tracking Parser

Use the tracking parser to extract data:

```javascript
const { parseShippingEmail, extractPOReferences, extractTrackingNumbers } = require('../../shared/tracking-parser');

const { tracking, poRefs, summary } = parseShippingEmail(emailBodyText);
// tracking = [{token: '488289378027', carrier: 'FedEx'}, ...]
// poRefs = [{type: 'ot_po', reference: 'PO809588', documentno: 'PO809588'}, ...]
```

## Per-Message Decision Tree

For each unseen message:

### Step 1: Not a shipping email?

Route to `not_tracking` (silent move, no notification) if:
- Subject contains: invoice, payment, quote, rfq, shortage, availability, pricing
- Body has zero tracking numbers AND zero PO references
- Email is OOO / auto-reply / newsletter / marketing

### Step 2: Extract tracking + PO

Parse the email body (prefer plain text, fall back to HTML):
1. Extract tracking numbers using `extractTrackingNumbers(bodyText)`
2. Extract PO references using `extractPOReferences(bodyText)`

**ATTACHMENTS (XLSX, CSV, PDF, images):**

The `read` JSON includes `documents` and `images` arrays. If:
- Any attachment exists (xlsx, csv, pdf, or image with `isLikelyContent: true`), OR
- Body text is sparse (<50 chars of actual content after stripping signatures), OR
- You find a PO/POV reference but NO tracking numbers in the text

Then the tracking data is likely in an attachment. Download and parse:

1. Run: `node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js download-attachments <uid> --workflow tracking-loading --include-images`
2. Parse each attachment by type:

**XLSX/CSV files (Arrow, Avnet, Mouser exports):**
```javascript
node -e "
const XLSX = require('xlsx');
const wb = XLSX.readFile('/path/to/file.xlsx');
const sheet = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet);
data.forEach(row => {
  // Look for tracking column (synonyms: Tracking Number, Tracking, Tracking #, Ship Tracking)
  const tracking = row['Tracking Number'] || row['Tracking'] || row['Tracking #'] || row['Ship Tracking'];
  const mpn = row['Manufacturer Part Number'] || row['Part Number'] || row['MPN'];
  if (tracking) console.log(JSON.stringify({ mpn, tracking }));
});
"
```

**PDF files:** Use the Read tool — Claude can extract text from PDFs. Look for tracking number patterns.

**Image files (PNG/JPG):** Use the Read tool — Claude has vision. Extract tracking numbers, carrier, ship date, and MPNs from screenshots.

3. Extract tracking numbers and MPNs from the parsed data
4. Proceed with the normal routing flow using the extracted data

**Important:** Attachments often contain MPN-to-tracking mappings (e.g., Arrow XLSX shows which parts shipped with which tracking). For multi-line orders, extract BOTH the tracking numbers AND the MPNs to populate the `mpn` field correctly.

### Step 3: Route based on what was found

| Tracking | PO Ref | Action |
|----------|--------|--------|
| Found | Found (1 PO) | `patch_tracking` |
| Found | Found (multiple POs) | `needs_review` — "Multiple PO references, cannot auto-assign" |
| Found | Not found | `needs_review` — "Tracking found but no PO reference" |
| Not found | Found | `needs_review` — "PO reference found but no tracking numbers" |
| Not found | Not found | `not_tracking` |

### Step 4: patch_tracking payload

When you have exactly one PO reference and at least one tracking number:

**Option A — OT PO number (PO######):**
```json
{
  "documentno": "PO809588",
  "tracking": ["488289378027", "500361860468"],
  "carrier": "FedEx"
}
```

**Option B — Infor POV number (POV#######):**
```json
{
  "pov": "POV0075528",
  "tracking": ["488289378027", "500361860468"],
  "carrier": "FedEx"
}
```

**Option C — Both (handler tries documentno first, falls back to pov):**
```json
{
  "documentno": "PO809588",
  "pov": "POV0075528",
  "tracking": ["488289378027"],
  "carrier": "FedEx"
}
```

**Option D — Multi-line order (MPN required):**
```json
{
  "pov": "POV0075528",
  "mpn": "LM358DR",
  "tracking": ["488289378027"],
  "carrier": "FedEx"
}
```

## Single-Line vs Multi-Line Orders

The handler automatically detects if the order has one line or multiple lines:

| Order Lines | MPN Required? | Tracking Applied To |
|-------------|---------------|---------------------|
| 1 line | No | Order header (`c_order.Chuboe_TrackingNumbers`) |
| 2+ lines | **Yes** | Specific line (`c_orderline.Chuboe_TrackingNumbers`) |

If the order has multiple lines and you don't provide `mpn`, the handler returns an error listing the available MPNs on the order. Extract the MPN from the shipping email and include it in the payload.

Notes:
- You need at least ONE of `documentno` or `pov` — the handler looks up the order using whichever is provided
- POV is stored on c_orderline.chuboe_po_string and maps to the OT PO
- `tracking` is an array of tracking number strings (tokens only, no carrier suffix)
- `carrier` is optional but helpful — use the most common carrier detected
- `mpn` is only required for multi-line orders — the handler will tell you if it's needed
- If the email has BOTH PO and POV, include both — provides redundancy if one lookup fails

### Step 5: needs_review payload

When escalating:

```json
{
  "reason": "PO reference found but no tracking numbers",
  "extracted_po": "PO809588",
  "extracted_tracking": [{"token": "488289378027", "carrier": "FedEx"}],
  "subject": "FW: Your order has shipped",
  "from": "shipping@supplier.com"
}
```

## Carrier Detection Reference

| Pattern | Carrier |
|---------|---------|
| `1Z` + 16 chars (18 total) | UPS |
| 12 digits | FedEx |
| 15 digits | FedEx |
| 20-22 digits | FedEx Ground |
| 10 digits | DHL |
| `EZ*US` or `9` + 19-21 digits | USPS |

## Workflow

1. Run `list` to get unseen messages
2. For each UID:
   a. Run `read <uid>` to get the email content
   b. Parse with tracking-parser
   c. Decide the action per the decision tree
   d. Run `route <uid> <action> --payload '<json>'`
3. Continue until inbox is empty

## Example Session

```bash
# List unseen
node shared/email-workflow-poller.js list --workflow tracking-loading

# Read one
node shared/email-workflow-poller.js read 1234 --workflow tracking-loading

# Route it — using OT PO
node shared/email-workflow-poller.js route 1234 patch_tracking --workflow tracking-loading \
  --payload '{"documentno":"PO809588","tracking":["488289378027"],"carrier":"FedEx"}'

# Route it — using Infor POV (when no OT PO in email)
node shared/email-workflow-poller.js route 1234 patch_tracking --workflow tracking-loading \
  --payload '{"pov":"POV0075528","tracking":["488289378027"],"carrier":"FedEx"}'
```

## Important Notes

- Each email should be processed exactly once (idempotent via Message-ID breadcrumbs)
- The handler merges tracking numbers with any existing tracking on the PO (no duplicates)
- If unsure, prefer `needs_review` over `not_tracking` — operator can process manually
- Don't guess PO numbers; only use what's explicitly in the email
