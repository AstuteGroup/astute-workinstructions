# VQ Purchase Workflow

**Scope:** The complete process for marking a VQ as purchased (`IsPurchased='Y'`) and posting the approve-order R_Request. This is the single source of truth for VQ purchase completion.

**Sister documents:**
- `shared/data-model.md` — VQ field definitions
- `shared/r-requests.md` — R_Request payload template and routing
- `shared/api-writeback.md` — general REST patterns

**Enforcing code:**
- `shared/vq-purchase-validator.js` — validation gate
- `shared/vq-patcher.js` — tick mechanism
- `shared/r-request-writer.js` — approval POST

---

## Anti-Patterns (DO NOT DO THIS)

**These patterns bypass validation and WILL produce broken approvals:**

```javascript
// ❌ WRONG — bypasses validation, VQ may have missing fields
await patchRecord('chuboe_vq_line', vqId, { IsPurchased: 'Y' });

// ❌ WRONG — bypasses validation, R_Request won't link to RFQ
await apiPost('r_request', {
  R_RequestType_ID: 1000000,
  Summary: 'approve order — ...',
  // ... missing AD_Table_ID, Record_ID, validation
});
```

**Use the enforced wrappers instead:**

```javascript
// ✓ CORRECT — validates all required fields, then ticks
const { tickVQForPurchase } = require('../shared/vq-patcher');
await tickVQForPurchase(vqId, { program: 'LAM_KITTING', extra: {...} });

// ✓ CORRECT — validates VQ is ticked, links to RFQ
const { postApproveOrder } = require('../shared/r-request-writer');
await postApproveOrder({ vqId, rfqId, program, summary, approvalText });
```

**Why this matters:** On 2026-07-07, approval 1166798 was posted via direct API calls. Result:
- All 9 VQs had `IsPurchased='N'` (not ticked)
- R_Request had empty `record_id` (not linked to RFQ)
- Multiple required fields missing (Date Code, Traceability, Warehouse, etc.)

---

## End-to-End Workflow

### Step 1: Ensure VQ Exists with Basic Fields

The VQ must exist in OT with all basic fields populated. These are written at VQ Loading time (see `vq-loading.md`).

**Basic VQ fields (populated at creation):**
| Field | Column | Default |
|-------|--------|---------|
| MPN | `chuboe_mpn` | From vendor quote |
| MFR | `chuboe_mfr_id` | Resolved via `mfr-lookup.js` |
| Vendor | `c_bpartner_id` | Supplier BP |
| Cost | `cost` | Vendor price |
| Qty | `qty` | Quoted quantity |
| UOM | `c_uom_id` | 100 (Each) |
| COO | `c_country_id` | 1000001 (PENDING) if not provided |
| RoHS | `chuboe_rohs` | Y unless otherwise noted |
| Traceability | `chuboe_traceability_id` | Derived from vendor type |
| Vendor Type | `chuboe_vendortype_id` | From BP record |

---

### Step 2: Populate Required Fields Before Purchase (Do Not Skip)

Before ticking, ALL fields below must be populated. **The validator (`vq-purchase-validator.js`) will reject incomplete VQs.**

**⚠️ CRITICAL: These three fields are frequently missed and WILL block PO processing:**
- **MFR** (`chuboe_mfr_id`) — manufacturer must be resolved
- **COO** (`c_country_id`) — country of origin (use PENDING=1000001 if unknown)
- **Partner Location** (`c_bpartner_location_id`) — vendor's ship-from address

**Fields required before purchase:**

| Field | Column | Source / Default | Notes |
|-------|--------|------------------|-------|
| **MFR** | `chuboe_mfr_id` | **REQUIRED** | Must be a non-system MFR record. Resolve via `mfr-lookup.js`. |
| **COO** | `c_country_id` | **REQUIRED** | Country of origin. Use PENDING (1000001) if vendor didn't provide. |
| **Partner Location** | `c_bpartner_location_id` | **REQUIRED** | Vendor's ship-from address. Look up via `c_bpartner_location`. |
| **Date Code** | `chuboe_date_code` | Vendor quote | e.g., "24+", "2023", "2 years" — see defaults below |
| **Lead Time** | `chuboe_lead_time` | Vendor quote | e.g., "STOCK", "3 WEEKS" — see defaults below |

**Date Code / Lead Time Defaults (from `shared/vq-writer.js`):**

For **franchise/authorized vendors** (Mouser, DigiKey, TTI, Master, etc.) when the vendor quote doesn't specify:

| Row Type | Date Code Default | Lead Time Default |
|----------|-------------------|-------------------|
| Stock (in-stock parts) | `(current year - 2)+` e.g., "24+" | "STOCK" |
| Lead time (ordered parts) | `(current year)+` e.g., "26+" | Specific time from vendor |

**Do NOT confuse these fields:**
- **Date Code** = manufacturing date stamp (e.g., "24+", "2023", "2 years")
- **Lead Time** = availability (e.g., "STOCK", "3 WEEKS", "IN STOCK")
| **Promise Date** | `datepromised` | Calculated | See derivation rules below |
| **Due Date** | `duedate` | Same as promise date | |
| **Packaging** | `chuboe_packaging_id` | Vendor quote | REEL, CUT TAPE, BULK, TRAY, etc. |
| **Traceability** | `chuboe_traceability_id` | From vendor type | Franchise (1000001) or Non-Traceable (1000003) |
| **Warehouse** | `chuboe_warehouse_id` | Deal-specific | See program defaults |
| **Warehouse Group** | `chuboe_warehouse_group_id` | Deal-specific | See program defaults |
| **Shipper** | `m_shipper_id` | 1000003 | FedEx Ground (default) |
| **Incoterm** | `chuboe_inco_term_id` | 1000000 | EXW (default) |

**Partner Location Lookup:**
```sql
SELECT bpl.c_bpartner_location_id, bpl.name
FROM c_bpartner_location bpl
WHERE bpl.c_bpartner_id = <vendor_bp_id>
  AND bpl.isactive = 'Y'
ORDER BY bpl.c_bpartner_location_id
LIMIT 1;
```

**Promise Date Derivation Rules:**
- Lead time = "stock" or "in stock" → today + 5 business days
- Lead time = numeric (e.g., "12 weeks") → calculate from today
- Lead time = blank → MUST be provided at PO time (validator will reject)

---

### Step 3: Verify Note Field Split (Do Not Skip)

The validator checks that buyer-internal content does NOT appear in vendor-facing fields.

**Three note fields on `chuboe_vq_line`:**

| Field | Column | Audience | What Goes Here |
|-------|--------|----------|----------------|
| **Public Vendor Order Notes** | `chuboe_note_public` | Vendor (on POV) | Vendor-safe shipping/handling notes ONLY |
| **Notes to Inspector** | `chuboe_note_private` | QC/Receiving | Inspection instructions, not buyer narrative |
| **Buyer Internal Notes** | `chuboe_note_user` | Internal only | Sourcing enrichment, stock counts, MOQ, MFR tags, auto-purchase rationale |

**Patterns that trigger rejection in public/private notes:**
- `\w+ stock:` (e.g., "Master stock: 619")
- `MOQ:`
- `Mfr:`
- `Lead time:` (vendor already knows)

If you see these patterns in `chuboe_note_public` or `chuboe_note_private`, move the content to `chuboe_note_user`.

---

### Step 4: Tick the VQ as Purchased

**REQUIRED:** Use `tickVQForPurchase()` — do NOT PATCH `IsPurchased='Y'` directly.

```javascript
const { tickVQForPurchase } = require('../shared/vq-patcher');

await tickVQForPurchase(vqId, {
  program: 'LAM_KITTING',  // or 'LAM_EPG', or null for non-program VQs
  extra: {
    // Fill any missing required fields at tick time:
    Chuboe_Lead_Time: 'STOCK - 1 WEEK',
    DatePromised: '2026-04-24',
    DueDate: '2026-04-24',
  },
});
```

**What `tickVQForPurchase()` does:**
1. Checks current buyer — if Claude Harris (API user), auto-corrects to Jake Harris (or `opts.buyerId` if specified)
2. Applies `extra` fields (+ buyer correction) via PATCH so validator sees final state
3. Runs `validateVQForPurchase()` — aborts with violation list if any check fails
4. Auto-unticks competing VQs on the same RFQ line (unless `skipUntickCompeting: true`)
5. PATCHes `IsPurchased='Y'` only after all validations pass

**Return value:** `{ vqId, ticked: true, untickedCompeting: [ids...], buyerCorrected: boolean }`

**Buyer correction (2026-07-08):** Claude Harris (1049524) is the API user and should not be a buyer on VQs. This allows tracking opportunities Claude created while assigning the physical buyer correctly.

---

### Step 5: Post Approve-Order R_Request

**REQUIRED:** Use `postApproveOrder()` — do NOT `apiPost('r_request', ...)` directly.

```javascript
const { postApproveOrder } = require('../shared/r-request-writer');

const { id, documentNo } = await postApproveOrder({
  vqId:         2134052,
  program:      'LAM_KITTING',
  rfqId:        1142189,               // chuboe_rfq_id (Record_ID for linkage)
  summary:      'approve order — Master R-78C3.3-1.0 (LAM Kitting)',
  approvalText: copyTextBlock,         // OT Copy Text — non-updateable after POST
  message:      'Auto-approved: margin 26.8% >= 18%',  // optional context
  priority:     '5',                   // 1 High / 5 Medium / 9 Low
});
```

**What `postApproveOrder()` does:**
1. Validates `vqId` is purchase-ready (re-runs validator)
2. Validates VQ is already ticked (`IsPurchased='Y'`)
3. Forces routing to Jake Harris (1000004) and status = Submitted (1000000)
4. POSTs with `Chuboe_Approval_Text` (non-updateable after POST)

**Approval Text format:** See "Copy Text" section below.

---

## Copy Text (Approval Text Source)

### What Is Copy Text?

OT's RFQ window has a **Copy Text** button that emits a structured, multi-section block. Support pattern-matches on this exact format. **We must synthesize it ourselves from DB data**, matching OT's format exactly for the specific line being approved.

### Why This Matters

- Support/managers scan these blocks using muscle memory
- Wrong field order, missing fields, or different formatting breaks their workflow
- The format must match what OT's Copy Text button produces — exactly

### Two Scenarios: VQ with CQ vs VQ-Only

| Scenario | When | Sections Included |
|----------|------|-------------------|
| **VQ with CQ** | Most cases — VQ is linked to a Customer Quote | RFQ → RFQ Line → Customer Quote → Customer Quote Reference → Vendor Quote |
| **VQ-Only** | No CQ exists (stock buy, spec buy, pre-positioning) | RFQ → RFQ Line → Vendor Quote |

---

### Format A: VQ with CQ (Full Format)

Use when a Customer Quote exists for the VQ being approved:

```
RFQ
  Customer: <c_bpartner.name from rfq>
  Total Revenue: <rfq-level total sale price>
  Total Cost: <rfq-level total cost>
  Gross Profit: <revenue - cost>
  Profit Margin: <profit/revenue>%

RFQ Line
  RFQ Line #: <line number>
  Purchase Qty: <qty buying from vendor>
  Sold Qty: <qty selling to customer>
  MPN: <chuboe_rfq_line_mpn.mpn>
  MFR: <chuboe_mfr.name>
  Sales Rep: <ad_user.name>
  Public Customer Notes: <or blank>
  Private Customer Notes: <or blank>

Customer Quote
  MPN: <chuboe_customer_quote.mpn>
  Customer PO#: <po number>
  Customer Part Code: <cpc or blank>
  Quantity: <qty>
  Sale Price: <price> USD
  Date Code: <dc>
  Packaging: <packaging name>
  Shipper: <m_shipper.name>
  Inco Term: <incoterm name>
  Ship-From Warehouse: <warehouse group name>
  Lead Time: <lead time text>

Customer Quote Reference
  COO: <country name or PENDING>
  UOM: Each
  Product Code: <product category>
  MFR: <manufacturer name>
  RoHS: Y|N
  Hazardous: Y|N

Vendor Quote
  Vendor: <c_bpartner.name>
  Vendor Type: <chuboe_vendortype.name>
  Traceability: <chuboe_traceability.name>
  Contact: <ad_user.name>
  MPN: <vq mpn>
  MFR: <vq mfr name>
  Quantity: <qty>
  Cost: <cost> USD
  Date Code: <dc>
  COO: <country name or PENDING>
  Lead Time: <lead time>
```

---

### Format B: VQ-Only (No CQ)

Use when no Customer Quote exists — omit Customer Quote and Customer Quote Reference sections:

```
RFQ
  Customer: <c_bpartner.name from rfq>
  Total Revenue: <n/a or $0.00>
  Total Cost: <rfq-level total cost>
  Gross Profit: <n/a>
  Profit Margin: <n/a>

RFQ Line
  RFQ Line #: <line number>
  Purchase Qty: <qty buying from vendor>
  Sold Qty: <0 or blank>
  MPN: <chuboe_rfq_line_mpn.mpn>
  MFR: <chuboe_mfr.name>
  Sales Rep: <ad_user.name>
  Public Customer Notes: <or blank>
  Private Customer Notes: <or blank>

Vendor Quote
  Vendor: <c_bpartner.name>
  Vendor Type: <chuboe_vendortype.name>
  Traceability: <chuboe_traceability.name>
  Contact: <ad_user.name>
  MPN: <vq mpn>
  MFR: <vq mfr name>
  Quantity: <qty>
  Cost: <cost> USD
  Date Code: <dc>
  COO: <country name or PENDING>
  Lead Time: <lead time>
```

---

### Building It (Do Not Skip)

1. **Check if CQ exists** — if yes, use Format A; if no, use Format B
2. **Query the specific line's data** — RFQ, RFQ Line, (CQ, CQ Reference if exists), VQ
3. **Format each section** in the exact order above
4. **Use 2-space indentation** for fields within each section
5. **Include blank lines** between sections
6. **Format numbers properly** — `$1,234.56` for currency, `20.0%` for percentages
6. **Append one-off context AFTER** the block (auto-approval rationale, compliance notes)

### Common Mistakes

| Mistake | Result |
|---------|--------|
| Wrong field order | Support notices immediately — they pattern-match |
| Missing sections | Incomplete approval — CQ Reference often forgotten |
| Including ALL RFQ lines | Should be ONLY the line being approved |
| Wrong number formatting | `1234.56` instead of `$1,234.56` |
| Skipping Vendor Quote section | Incomplete — vendor info is required |

### TODO: Helper Function

Need `shared/copy-text-builder.js` that queries the DB and builds properly formatted copy text. Until then, build manually following the format above.

---

## Program-Specific Defaults

The validator enforces program-specific ship-to requirements. All four fields must match exactly.

### LAM_KITTING

| Field | Value | Label |
|-------|-------|-------|
| `chuboe_warehouse_id` | 1000015 | W111: LAM KITTING |
| `chuboe_warehouse_group_id` | 1000008 | BROWNSVILLE |
| `m_shipper_id` | 1000003 | FedEx Ground |
| `chuboe_inco_term_id` | 1000000 | EXW |

### LAM_EPG

| Field | Value | Label |
|-------|-------|-------|
| `chuboe_warehouse_id` | 1000015 | W111: LAM KITTING |
| `chuboe_warehouse_group_id` | 1000008 | BROWNSVILLE |
| `m_shipper_id` | 1000003 | FedEx Ground |
| `chuboe_inco_term_id` | 1000000 | EXW |

### Non-Program (Stock RFQs, etc.)

Pass `program: null` to skip program-specific validation. The VQ still needs valid warehouse/group, but no specific values are enforced.

---

## Common Validation Errors and Fixes

### Date Trio (Most Common)

| Error | Fix |
|-------|-----|
| `Chuboe_Date_Code is blank` | Add date code from vendor quote (e.g., "24+", "2023") |
| `Chuboe_Lead_Time is blank` | Add lead time (e.g., "STOCK", "3 WEEKS") |
| `DatePromised is blank` | Calculate from lead time: stock = +5 biz days |

### Packaging / Traceability

| Error | Fix |
|-------|-----|
| `Chuboe_Packaging_ID is blank` | Set packaging: REEL (1000001), CUT TAPE (1000003), BULK (1000002), TRAY (1000004) |
| `Chuboe_Traceability_ID is blank` | Franchise vendor → 1000001 (Auth Dist Certs); Others → 1000003 (Non-Traceable) |

### Program-Specific

| Error | Fix |
|-------|-----|
| `chuboe_warehouse_group_id is 1000000 — expected 1000008 (BROWNSVILLE)` | Wrong warehouse group. AUSTIN (1000000) ≠ BROWNSVILLE (1000008). Check program requirements. |
| `chuboe_warehouse_id is 1000006 — expected 1000015 (W111)` | Wrong warehouse. Update to match program. |

### Note Field Leaks

| Error | Fix |
|-------|-----|
| `Chuboe_Note_Public contains buyer-internal content (pattern /\b\w+ stock\s*:/i)` | Move "Master stock: 619" etc. to `chuboe_note_user` |
| `Chuboe_Note_Private contains buyer-internal content` | Same — `chuboe_note_private` is for QC, not sourcing narrative |

### Competing VQs

| Error | Fix |
|-------|-----|
| `Competing VQ(s) on the same RFQ line already ticked IsPurchased=Y: 2145678` | Previous winner still ticked. `tickVQForPurchase()` auto-unticks by default. If legitimate split-POV, pass `allowCompetingTicked: true`. |

---

## Complete Code Example

```javascript
const { tickVQForPurchase } = require('../shared/vq-patcher');
const { postApproveOrder } = require('../shared/r-request-writer');

// Tick the VQ (validates + auto-unticks competitors)
const tickResult = await tickVQForPurchase(2134052, {
  program: 'LAM_KITTING',
  extra: {
    Chuboe_Lead_Time: 'STOCK - 1 WEEK',
    DatePromised: '2026-04-24',
    DueDate: '2026-04-24',
    Chuboe_Packaging_ID: 1000001,  // REEL
  },
});
console.log(`Ticked VQ ${tickResult.vqId}, unticked: ${tickResult.untickedCompeting}`);

// Build copy text from DB data (must match OT format exactly)
const copyText = `RFQ
  Customer: Lam Research Corporation
  Total Revenue: $52.50
  Total Cost: $41.90
  Gross Profit: $10.60
  Profit Margin: 20.2%

RFQ Line
  RFQ Line #: 270
  Purchase Qty: 5
  Sold Qty: 5
  MPN: R-78C3.3-1.0
  MFR: RECOM
  Sales Rep: Jake Harris
  Public Customer Notes:
  Private Customer Notes:

Customer Quote
  MPN: R-78C3.3-1.0
  Customer PO#: 4500987654
  Customer Part Code: 630-009876-001
  Quantity: 5
  Sale Price: $10.50 USD
  Date Code: 24+
  Packaging: REEL
  Shipper: FedEx Ground
  Inco Term: EXW
  Ship-From Warehouse: BROWNSVILLE
  Lead Time: STOCK

Customer Quote Reference
  COO: PENDING
  UOM: Each
  Product Code: Power Management
  MFR: RECOM
  RoHS: Y
  Hazardous: N

Vendor Quote
  Vendor: Master Electronics
  Vendor Type: Franchise
  Traceability: Auth Dist Certs
  Contact: Master Sales
  MPN: R-78C3.3-1.0
  MFR: RECOM
  Quantity: 5
  Cost: $8.38 USD
  Date Code: 24+
  COO: PENDING
  Lead Time: STOCK`;

// Post approval (re-validates, routes to Jake)
const { id, documentNo } = await postApproveOrder({
  vqId: 2134052,
  program: 'LAM_KITTING',
  rfqId: 1142189,
  summary: 'approve order — Master R-78C3.3-1.0 (LAM Kitting)',
  approvalText: copyText,
  message: 'Auto-approved — in-stock margin 26.8% >= 18%, stock 619 >= LAM MOQ 100',
});
console.log(`R_Request created: ${documentNo} (ID: ${id})`);
```

---

## Edge Cases

### Split-POV (Multiple Vendors per Line)

When an RFQ line is legitimately split across multiple vendors (each with their own POV):

```javascript
await tickVQForPurchase(vqId, {
  program: 'LAM_KITTING',
  allowCompetingTicked: true,  // Skip the competing-VQ check
});
```

### Domestic Shipping Flag

Set `ischuboedomesticshipping` when both supplier and ship-to are in the same country:
- US franchise (Master, TTI, DigiKey, Mouser, Sager, Arrow, Waldom, Future US, Newark) → `Y`
- APAC brokers (SMARTEL, Chip Energy, HK Firsttop, Dragon Core) → `N`

The validator does NOT auto-enforce this — set explicitly in auto-purchase flows.

---

## History

**2026-04-20:** Three manually-caught approval bugs (blank lead time, blank promise date, internal content in public note, wrong warehouse_group) led to creation of `vq-purchase-validator.js`. Before the validator, we repeatedly posted approvals that required manual fixes in OT.

**2026-04-21:** Second wave — same enrichment note routed to `chuboe_note_private` (Notes to Inspector) instead of `chuboe_note_user` (Buyer Internal Notes). Validator expanded to sweep both public and private note fields.

**2026-04-22:** `vq-patcher.js` created as enforced wrapper to ensure validator is never bypassed.

**2026-07-08:** Approval 1166798 (Mouser POV0075257, 9 VQ lines for RFQ 1131217) posted via direct `apiPost('r_request')` instead of `postApproveOrder()`. Result: all VQs had `IsPurchased='N'`, R_Request not linked to RFQ, DATE_CODE incorrectly set to "STOCK" (lead time value). Added Anti-Patterns section to this document and North Star principle to CLAUDE.md to enforce wrapper usage.

---

## Related

- `shared/data-model.md` § VQ Field Requirements
- `shared/r-requests.md` — full R_Request reference
- `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md` — VQ creation
- `Trading Analysis/LAM EPG Award/lam-epg-order-processing.md` — LAM EPG order workflow
