# R_Requests — Reference Guide

**Scope:** How to create, update, and route requests in OT's `r_request` table via the iDempiere REST API. Covers all request types, with detailed focus on **Approve Order** requests (the pattern buyers and the support team see most often).

Sister documents:
- `shared/data-model.md` — table relationships, join patterns
- `shared/api-writeback.md` — auth, general REST patterns
- `shared/record-updater.js` — PATCH helper

---

## Core Concepts

### What is an R_Request?
An entry in OT's internal ticketing / workflow queue. Used for:
- **Approve Order** (buyer → manager approval on vendor quotes)
- **Compliance reviews**
- **Support / query threads**
- **Escalations** on held shipments, cost changes, etc.

Request appears in OT's request UI for the assigned user (`AD_User_ID`). The support team pattern-matches on **Summary** + **Chuboe_Approval_Text** to act.

### Field ↔ UI mapping
| DB Column | OT UI Label | Purpose |
|---|---|---|
| `Summary` | "Summary" | One-liner in the queue list |
| `Chuboe_Approval_Text` | **"Text to Approve"** | What support/manager actually reads to approve |
| `Result` | "Message to User" / "Notes" | Operator-facing context, supplementary notes |
| `R_Status_ID` | "Status" | Submitted / Pending / Answered / Closed etc. |
| `AD_User_ID` | "User/Contact" (assignee) | **Who sees it in their queue** |
| `SalesRep_ID` | "Sales Rep" | Ownership |
| `AD_Table_ID` + `Record_ID` | Linkage | Which business record this request is about (e.g. `chuboe_rfq`) |
| `Priority` | "Priority" | 1 (High) / 5 (Medium) / 9 (Low) |

### AD_Table_ID for record linkage
| Table | AD_Table_ID | Use when approving |
|---|---|---|
| `chuboe_rfq` | `1000002` | RFQ-scoped approvals (VQ → PO) |
| `c_order` | `259` | Order-level queries / cost-up approvals |
| `chuboe_offer` | `1000035` | Offer-level approvals |

### Request Type IDs
| R_RequestType_ID | Name | Use Case |
|---|---|---|
| `1000000` | **Approve Order** | Buyer → manager approval to purchase (most common) |
| `1000001` | General Message | Cross-team messaging |
| `1000006` | Query | Data / support questions |
| `1000010` | Service Request | Internal IT/service |
| `100` | Request for Quotation | Legacy |

### Status IDs (R_Status_ID)
Only a subset are relevant for Approve Order flow:
| ID | Name | When |
|---|---|---|
| `1000000` | **Submitted** | **Set at POST time — required, or status shows blank in queue** |
| `1000001` | Pending | Under review |
| `1000003` | Answered | Approved/responded |
| `1000002` / `1000025` / `1000026` / `1000030` | Closed | Done |

### User IDs (assignment / routing)
| AD_User_ID | Name | Typical Role |
|---|---|---|
| `1000004` | Jake Harris | Trading Manager — **approves most Approve-Order requests** |
| `1049524` | Claude Harris | API-service user (DO NOT route to — requests disappear from human queues) |

---

## Pre-Approval Checklist (MUST do before POSTing R_Request)

**ALWAYS run `shared/vq-purchase-validator.js` before posting an approve-order R_Request or PATCHing `IsPurchased='Y'`.** The validator turns this checklist into an enforced gate — it returns a violations list and you must not proceed if `ok === false`.

```javascript
const { validateVQForPurchase } = require('../shared/vq-purchase-validator');
const report = await validateVQForPurchase(vqId, { program: 'LAM_KITTING' });
if (!report.ok) {
  console.error('VQ cannot be purchased — violations:');
  report.violations.forEach(v => console.error(`  - ${v}`));
  throw new Error(`Aborting approval for VQ ${vqId}`);
}
// safe to PATCH IsPurchased='Y' and POST the R_Request
```

What the validator enforces (expanded from the prose checklist that was repeatedly not walked through):

1. **VQ is active** and has a valid MPN, vendor BP, cost > 0, qty > 0
2. **Date fields populated:** `Chuboe_Date_Code`, `Chuboe_Lead_Time`, `DatePromised` — all three required (most-missed trio)
3. **Packaging + traceability populated:** `Chuboe_Packaging_ID` (REEL / CUT TAPE / BULK / TRAY / etc.), `Chuboe_Traceability_ID` (Franchise=1000001 / Non-Traceable=1000003)
4. **Notes split correctly (three fields on `chuboe_vq_line`):**
   - `Chuboe_Note_Public` → "Public Vendor Order Notes" — flows to the POV that the vendor receives. Must be vendor-safe or empty.
   - `Chuboe_Note_Private` → "Notes to Inspector" — QC / receiving team sees this on intake. Not a buyer-internal dump.
   - `Chuboe_Note_User` → "Buyer Internal Notes" — this is where our sourcing enrichment (stock counts, MOQ, MFR tags, auto-purchase rationale, etc.) goes.
   The validator regex-sweeps `Chuboe_Note_Public` AND `Chuboe_Note_Private` for internal markers and rejects either if they leak the sourcing narrative.
5. **Program-specific ship-to matches:** `Chuboe_Warehouse_ID`, `Chuboe_Warehouse_Group_ID`, `M_Shipper_ID`, `Chuboe_Inco_Term_ID` must hit the values encoded for the program (e.g., LAM Kitting → warehouse 1000015 W111 + **group 1000008 BROWNSVILLE**, FedEx Ground shipper, EXW incoterm). Warehouse alone doesn't determine ship-to; the group ID is the actual location pointer (don't confuse 1000000 AUSTIN with 1000008 BROWNSVILLE).
6. **Competing VQs unticked:** any other `IsPurchased='Y'` on the same RFQ line must be flipped back to `N` before the new winner is ticked.

**Then** POST the R_Request per the template below.

### History — why this gate exists

Before the validator, we repeatedly posted approvals with: missing promise date, missing lead time, "Master stock: 619 | MOQ: 5 | Mfr: RECOM" in the vendor-facing public note, wrong warehouse_group_id (Austin vs Brownsville), and — after the first fix — the same enrichment note mistakenly routed to `Chuboe_Note_Private` (Notes to Inspector) instead of `Chuboe_Note_User` (Buyer Internal Notes). Each mistake required a manual fix in OT by the buyer. The prose checklist existed in this file; it wasn't followed. The validator is the forcing function.

### Domestic shipping flag (`ischuboedomesticshipping`)

Defaults to `N` in OT. Should be `Y` when both supplier and ship-to warehouse are in the same country. For LAM Kitting (ship-to W111 Brownsville TX):
- US franchise distributors (Master, TTI, DigiKey, Mouser, Sager, Arrow, Waldom, Future US, Newark) → `Y`
- APAC brokers (SMARTEL, Chip Energy, HK Firsttop, Dragon Core, etc.) → `N`

The validator doesn't auto-enforce this because the inference is supplier-dependent. Auto-purchase flows that only target franchise stock (e.g., `Trading Analysis/LAM Kitting Reorder/lam-kitting-rfq-writer.js`) set it explicitly.

---

## Approve-Order Payload Template (canonical)

```javascript
const { apiPost } = require('../shared/api-client');

const approvalText =
  'Line <N>  <MPN>   <qty>pcs @ $<price>   DC <dc>   <MFR>\n' +
  'Vendor: <BP name>\n' +
  '<optional context: qty note, compliance, etc.>';

const r = await apiPost('r_request', {
  // Linkage
  AD_Table_ID:      1000002,        // chuboe_rfq
  Record_ID:        <rfq_id>,       // e.g. 1141455 for RFQ '1132040'

  // Type + status — set at POST; some are non-updateable
  R_RequestType_ID: 1000000,        // Approve Order
  R_Status_ID:      1000000,        // Submitted (REQUIRED — else blank status in queue)

  // Routing — WHO sees it
  AD_User_ID:       1000004,        // Jake Harris
  SalesRep_ID:      1000004,        // Jake Harris
  Priority:         '5',            // 1 High / 5 Medium / 9 Low

  // Body
  Summary:              'approve order — <Vendor> <MPN/subject>',
  Chuboe_Approval_Text: approvalText,  // "Text to Approve"
  Result:               approvalText,  // "Message to User" — usually mirrors the approval text
});

console.log(r.id, r.DocumentNo);
```

### Summary style
Short and consistent. Support scans the queue — the first 80 chars are what gets read.

Good:
- `approve order — Smartel LAM EPG (3 lines)`
- `approve order — NAC 551SCMGI (LAM EPG)`
- `approve order — XJH LAM EPG (2 lines)`

Bad:
- `APPROVAL — SMARTEL XCZU4CG-1SFVC784E (Compliance Cleared: ECCN 5A992.c / HTS 8542390090) — LAM EPG` (too long, custom prose)
- `Please approve the following...` (unclear)

### Chuboe_Approval_Text format

**MUST match OT's "Copy Text" output.** OT's RFQ view has a Copy Text feature that emits a structured, multi-section block (RFQ → RFQ Line → Customer Quote → Customer Quote Reference → Vendor Quote) containing every field support/managers need to approve. Support and managers pattern-match on this exact structure — custom shorthand formats break their scan.

**How to use it:**
1. Buyer pastes the full OT copy text into the conversation.
2. Script/agent extracts ONLY the lines relevant to the vendor/part being approved (copy text contains ALL lines on the RFQ, not just the new ones — see `feedback_copy_text_context.md`).
3. The extracted block becomes the `Chuboe_Approval_Text` body.
4. ONE-OFF context (auto-approval disclosure, compliance note, excess-qty caveat) gets appended AFTER the block, not woven into it.

**DO NOT synthesize the block from raw DB queries.** Walking the RFQ tree to reproduce OT's format introduces drift (field ordering, whitespace, nested indentation) that support will notice. Always source from an actual OT copy-text paste.

**Canonical block shape (from OT copy text, reproduced verbatim):**

```
RFQ
  Customer: <name>
  Total Revenue: <amount>
  Total Cost: <amount>
  Gross Profit: <amount>
  Profit Margin: <pct>%

RFQ Line
  RFQ Line #: <n>
  Purchase Qty: <n>
  Sold Qty: <n>
  ...
  Sales Rep: <name>
  Public Customer Notes:
  Private Customer Notes:

Customer Quote
  MPN: <mpn>
  Customer PO#: <po>
  Customer Part Code: <cpc>
  Quantity: <n>
  Sale Price: <amount> USD
  ...
  Packaging: <type>
  Shipper: <carrier>
  Inco Term: <term>
  Ship-From Warehouse: <group>
  Lead Time: <text>

Customer Quote Reference
  COO: <country or PENDING>
  UOM: Each
  Product Code: <category>
  MFR: <mfr>
  RoHS: Y|N
  Hazardous: Y|N

Vendor Quote
  Vendor: <name>
  Vendor Type: <type>
  Traceability: <tier>
  Contact: <name>
  ...
```

**Short single-line shorthand (fallback ONLY for edge cases where copy text isn't available — e.g., back-dated approvals, data-quality fixes):**

```
Line 60    XCZU4CG-1SFVC784E   5pcs @ $342.00   DC 22+   Xilinx (ECCN 5A992.c / HTS 8542390090)
Vendor: SMARTEL ELECTRONICS (ASIA) CO LTD
```

Use this only when explicitly confirmed by the buyer that copy text isn't available for the specific context. For all routine approvals (auto-purchase flow included), the full copy-text block is the standard.

---

## Non-Updateable Fields (iDempiere bean-callouts)

These fields **can only be set at POST time**. PATCH returns `500 "Cannot update column <X>"`:

| Column | Workaround |
|---|---|
| `Chuboe_Approval_Text` | Set in initial POST. If wrong, POST a new request and close the old one. |
| `Chuboe_CPC` (on `chuboe_offer_line`) | Same pattern — set at create time only. |

**Other silently-dropped cases:** some columns accept a PATCH but don't reflect in UI. If you see a write succeed but the UI stays stale, verify via direct `SELECT` and suspect a callout.

---

## Column Case Gotcha

PATCH payloads must use the **PascalCase iDempiere column name**, not the Postgres lowercase form:

| Postgres (lowercase) | API payload key |
|---|---|
| `chuboe_eccn` | `Chuboe_ECCN` |
| `chuboe_hts` | `Chuboe_HTS` |
| `chuboe_approval_text` | `Chuboe_Approval_Text` |
| `r_status_id` | `R_Status_ID` |
| `ad_user_id` | `AD_User_ID` |

Check `adempiere.ad_column.columnname` for the authoritative case:
```sql
SELECT columnname FROM adempiere.ad_column
WHERE ad_table_id=(SELECT ad_table_id FROM adempiere.ad_table WHERE tablename='R_Request');
```

---

## Updating (PATCH) an existing request

```javascript
const { patchRecord } = require('../shared/record-updater');

// Reroute to Jake, bump status, re-prioritize — all updateable
await patchRecord('r_request', <r_request_id>, {
  AD_User_ID:   1000004,
  SalesRep_ID:  1000004,
  R_Status_ID:  1000001,   // Pending
  Priority:     '1',       // High
});

// DO NOT try to PATCH Chuboe_Approval_Text — returns 500
```

### Closing a request
**NEVER deactivate requests (`IsActive=N`).** Always close via the status workflow:
```javascript
await patchRecord('r_request', <id>, { R_Status_ID: 1000002 });  // Closed
```

---

## Common Pitfalls (log of mistakes we've hit)

1. **Writing approval body into `Result` instead of `Chuboe_Approval_Text`** — Result shows in the "Message to User" panel; support looks at the Approval Text panel and sees blank.
2. **Forgetting `R_Status_ID: 1000000`** — request lands with null status; UI queue shows it but not as "Submitted".
3. **Not setting `AD_User_ID` + `SalesRep_ID` to 1000004** — API defaults both to Claude (1049524), request goes to a queue Jake doesn't watch.
4. **Custom prose in Summary** — support team pattern-matches on `approve order — ...` format; verbose summaries break that scan.
5. **Trying to PATCH `Chuboe_Approval_Text`** — non-updateable; must recreate the request with corrected text.
6. **Deactivating instead of closing** — requests become invisible but aren't truly closed; audit trail breaks.

---

## Querying Requests

### All approve-order requests for an RFQ
```sql
SELECT r.r_request_id, r.documentno, r.summary, s.name as status,
       r.chuboe_approval_text, r.created::timestamp(0)
FROM adempiere.r_request r
LEFT JOIN adempiere.r_status s ON s.r_status_id=r.r_status_id
WHERE r.ad_table_id=1000002
  AND r.record_id=(SELECT chuboe_rfq_id FROM adempiere.chuboe_rfq WHERE value='<rfq_search_key>')
  AND r.r_requesttype_id=1000000
ORDER BY r.created DESC;
```

### Jake's open approval queue
```sql
SELECT r.r_request_id, r.documentno, r.summary, s.name as status, r.created::timestamp(0)
FROM adempiere.r_request r
LEFT JOIN adempiere.r_status s ON s.r_status_id=r.r_status_id
WHERE r.ad_user_id=1000004
  AND r.r_requesttype_id=1000000
  AND COALESCE(s.name,'') NOT ILIKE '%closed%'
  AND r.isactive='Y'
ORDER BY r.created DESC;
```

---

## Minimal Test — "Is everything wired correctly?"

After posting, verify via SELECT that all five required fields are populated:
```sql
SELECT r_request_id,
       summary,
       LENGTH(chuboe_approval_text) AS approval_text_len,
       ad_user_id, salesrep_id, r_status_id
FROM adempiere.r_request
WHERE r_request_id=<id>;
```

Expected:
- `approval_text_len` > 0
- `ad_user_id` = 1000004
- `salesrep_id` = 1000004
- `r_status_id` = 1000000
