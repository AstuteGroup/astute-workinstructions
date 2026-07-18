# LAM EPG Order Entry & Processing

## Overview

Processing LAM EPG Kitting RFQ 1132040 — sourcing ~207 awarded lines across franchise and broker vendors, loading VQs into OT, creating approval requests, updating SIPOC, and generating Infor PO upload files.

## Key References

- **RFQ:** 1132040 (internal ID: 1141455)
- **SIPOC:** `Lam_EPG_SIPOC.xlsx` (canonical, local — not in git)
- **Customer:** Lam Research (BP 1000730)
- **Buyer:** Jake Harris (AD_User 1000004)

## End-to-End Workflow

### Step 1: Receive PO/POV Info from Jake

Jake provides: OT PO number, Infor POV, vendor name, and any notes (tariffs, line-specific issues).

### Step 2: Pull PO Details from OT API

```javascript
// Search by DocumentNo
const po = await apiGet('C_Order', { filter: "DocumentNo eq 'PO809XXX'", top: 1 });
// Get lines
const lines = await apiGet('C_OrderLine', { filter: `C_Order_ID eq ${po.records[0].id}`, orderby: 'Line' });
```

Key fields per line: `Chuboe_MPN`, `QtyOrdered`, `PriceActual`, `Chuboe_PO_String` (POV), `DatePromised`.

**Note:** Recent POs may not be in the replica DB yet. Use the REST API (`apiGet`) instead of `psql`.

### Step 3: Update SIPOC

Match PO lines to SIPOC rows by MPN. Update these columns:

| Col | Field | Value |
|-----|-------|-------|
| N (13) | MPN to Purchase | Orderable MPN if different from LAM MPN |
| O (14) | Manufacturer | MFR name |
| P (15) | Source | Vendor name |
| Q (16) | Purchase Price | Unit cost |
| R (17) | Qty | Purchase qty |
| S (18) | Qty Remaining | 0 if fully sourced |
| T (19) | Lead Time (wks) | stock / X weeks |
| U (20) | VQ in OT | Y |
| V (21) | Total Cost | Price × Qty (+ tariff if applicable) |
| X (23) | Margin | (Resale - Price) / Resale |
| Z (25) | RFQ Number | 1132040 |
| AA (26) | POV | POV number |
| AB (27) | Purchased By | Jake Harris |
| AC (28) | PO Sent (date) | Date placed |
| AD (29) | Ship to | Brownsville / W111 or Hong Kong |
| AE (30) | Processed in OT | Y |
| AF (31) | OT Order Number | PO number or R_Request DocNo |
| AH (33) | Notes | Tariffs, tracking, issues |

**Do NOT overwrite formula/calculated fields** — SIPOC is a staging file, formulas live in the master.

**Tariffs:** Add to Total Cost AND note in col AH (e.g. "⚠ TARIFF $31.40").

### Step 3b: Check AVL for Alternates (Do Not Skip)

**Before sourcing any unsourced line**, check the LAM AVL for approved alternates:

**File:** `Trading Analysis/LAM New Parts Pricing/Copy of Lam-Astute_NewParts - 02122026.xlsx`
- **AVL tab** — all approved MPNs per CPC (Material column)
- **EPG New Part Adds tab, col E (MPNs)** — count of approved alternates

Search ALL approved MPNs when running franchise APIs, not just the primary MPN from the SIPOC. A line that looks single-source based on the SIPOC may have 2-3 approved alternates in the AVL.

### Step 4: Load VQs (if not already in OT)

Use `lib-load-vq-row.js` for franchise parts or manual API calls for broker parts.

For each line:
1. Check if VQ already exists (`psql` or API query)
2. If not: POST `Chuboe_RFQ_Line_MPN` (for alt MPNs) then `writeVQFromAPI`
3. **Tick as purchased:** Follow [`shared/vq-purchase-workflow.md`](../../shared/vq-purchase-workflow.md) — use `tickVQForPurchase()` with `program: 'LAM_EPG'`

### Step 5: Post R_Request for Approval

> **Full workflow:** See [`shared/vq-purchase-workflow.md`](../../shared/vq-purchase-workflow.md) for the complete tick + approval process.

**Use the enforced wrapper** — do NOT `apiPost('R_Request', ...)` directly:

```javascript
const { postApproveOrder } = require('../shared/r-request-writer');

await postApproveOrder({
  vqId:         vqLineId,
  program:      'LAM_EPG',
  rfqId:        1141455,
  summary:      'approve order — Vendor MPN (LAM EPG)',
  approvalText: copyTextBlock,  // include RFQ line numbers
});
```

**Requirements:**
- VQ must be ticked (`IsPurchased='Y'`) before posting approval
- `postApproveOrder()` forces routing to Jake Harris (1000004) and status = Submitted
- Include RFQ line numbers in the approval text
- Only include lines for the vendor/POV being approved (filter copy text)

### Step 6: Retrieve PO Copies (when needed)

```javascript
// Print endpoint returns base64 PDF
const data = await apiGet('C_Order', { id: orderId }); // get via /print
// GET /models/C_Order/{id}/print → { exportFile: "base64..." }
// Decode: Buffer.from(data.exportFile, 'base64') → .pdf
```

**Attachments (Document Explorer):** Blocked — AD_Attachment read access pending (deferred-work.md).

### Step 7: Generate Infor PO Upload File

**Template:** `POV0075252 POV Lines.xlsx` (from Jake's team)

**Column B (Item) = LAM approved MPN** (SIPOC col C). NOT the CPC, NOT the orderable variant.

Key populated fields:
- A: Line number
- B: **LAM MPN** (SIPOC col C)
- C: Line Status (Ordered)
- D: Due Date (Excel date serial, formatted mm/dd/yyyy)
- E: Promise Date (= Due Date)
- F: Ordered qty
- G: Received (0)
- H: Item Cost
- I: POV number
- J: Vendor code (e.g. V000086 for DigiKey)
- K: Vendor Name
- M: PO Status (Ordered)
- O: PO Order Date
- Q: Item Description
- S: U/M (EA)
- T: Extended Cost (H × F)
- W: Warehouse (W111)
- Cols 33/37/43: Plan Cost / Material / Item Cost = **unit price** (not flag 1)
- All other defaults from template (currency, delivery terms, S/N prefix, etc.)

**MPN Variants:** Where the orderable MPN differs from LAM MPN, send a separate Excel to Jake for receiving/logistics to handle manually.

## Vendor Reference

| Vendor | BP ID | Search Key | Location ID | Type |
|--------|-------|------------|-------------|------|
| DigiKey | 1000327 | 1002331 | 1000240 | Catalog |
| Mouser | 1000334 | 1002338 | 1000683 | Catalog |
| Master | 1000405 | 1002409 | 1001349 | Franchise |
| Arrow | 1000386 | 1002390 | 1001110 | Franchise |
| TTI | 1000326 | 1002330 | 1000239 | Catalog |
| Sager | 1000335 | 1002339 | 1006612 | Franchise |
| Newark | 1000390 | 1002394 | 1000619 | Catalog |
| Waldom | 1000644 | 1002648 | 1002857 | Catalog |
| TI Store | 1003257 | 1005256 | 1005677 | Franchise |
| Fuses Unlimited | 1001960 | — | — | Catalog |
| Avnet EM (web orders) | 1000336 | 1002340 | — | — | **Default for Avnet.** Use this for web ordering, NOT Avnet (1001051) |
| Avnet (legacy) | 1000051 | 1001051 | 1004762 | — | Do NOT use for new VQs |
| Amatom | 1001955 | — | — | Broker |
| SMARTEL | 1004861 | — | — | Global Sourcing |
| CHIP ENERGY | 1010640 | — | — | Global Sourcing |
| Dragon Core | 1004251 | — | — | Suspended |
| HK Firsttop | 1003256 | — | — | Global Sourcing |

Infor vendor codes: DigiKey = V000086 (others TBD as needed).

## Current Status (as of 2026-04-10)

### Completed (OT PO assigned):
| OT PO | Vendor | Lines | POV | Date |
|-------|--------|-------|-----|------|
| PO809583 | Fuses Unlimited | 4 | POV0075524 | 2026-04-09 |
| PO809585 | SMARTEL | 8 | POV0075525 | 2026-04-09 |
| PO809588 | Waldom | 3 | POV0075528 | 2026-04-09 |
| PO809589 | Sager | 1 | POV0075530 | 2026-04-09 |
| PO809590 | TTI | 1 | POV0075531 | 2026-04-09 |
| PO809591 | CHIP ENERGY | 2 | POV0075529 | 2026-04-09 |
| PO809592 | Dragon Core | 3 | POV0075532 | 2026-04-09 |
| PO809593 | HK Firsttop | 1 | POV0075533 | 2026-04-09 |
| PO809594 | Master | 2 | POV0075534 | 2026-04-09 |
| PO809596 | DigiKey batch 1 | 4 | POV0075536 | 2026-04-09 |
| PO809603 | DigiKey batch 2 | 5 | POV0075542 | 2026-04-10 |
| PO809604 | TI Store | 2 | POV0075543 | 2026-04-10 |
| **Total** | | **36** | | |

### Pending R_Requests:
- **1155873** — DigiKey rebuy (39 lines, POV0075252, updated pricing)
- **1155875** — Avnet (1 line, 535032-4)
- **1155882** — Sager (4 lines, POV0075301, fully processed in Infor, 2 shipped)

### Still needs OT processing (127 lines):
| POV | Vendor | Lines | VQs Loaded |
|-----|--------|-------|------------|
| POV0075252 | DigiKey (rebuy pending) | 39 | 2026-04-07 |
| POV0075254 | Arrow | 11 | 2026-04-07 |
| POV0075257 | Mouser | 28 | 2026-04-07 |
| POV0075258 | Newark | 8 | 2026-04-07 |
| POV0075260 | TTI | 3 | 2026-04-07 |
| POV0075266 | Waldom | 8 | 2026-04-07 |
| POV0075267 | Master | 20 | 2026-04-07 |
| POV0075296 | TI Store | 3 | 2026-04-07 |
| POV0075301 | Sager | 4 | 2026-04-07 |
| — | Amatom (no POV) | 2 | 2026-04-09 |
| Avnet Pend. | Avnet | 1 | 2026-04-07 |

### Still needs sourcing (40 lines):
See `EPG_Pending_Lines_20260410.xlsx` for full list. Key items:
- 2 TI parts (REF3012AIDBZR, TLK110PTR)
- 172043-0302 (dropped from Avnet, needs re-source)
- 74HCT7541PW118 (removed from DigiKey, no stock)
- Xilinx XCZU4CG on compliance hold

### DigiKey consolidation needed:
Batch 2 lines (rows 29, 129, 162, 165) currently show POV0075542/PO809603 but need to be consolidated under POV0075536 (what was submitted to DigiKey). Jake handling on his side.

### Tariffs recorded on SIPOC:
- DLS2XS4AA35X / DLS 3XP4AA35X (Waldom PO809588 lines 1-2) — amount TBD
- DLS1XS4AA35X (Master PO809594 line 20) — $107.18
- X-1569 (TTI PO809590) — $176.71
- C0603C333K5RAC (DigiKey) — est $1.16
- Y14870R01000B9W — $31.40
- 0ADEC9250-BE — $22.36
- CKG57NX7R1H106M500JH — $21.25
- 0477.800MXP — $50.45
- RK73H2HTTE80R6F — $8.48
- 0791091019 — $84.83
- DRR7016C — $21.74
