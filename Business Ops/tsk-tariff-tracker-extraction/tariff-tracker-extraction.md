# Tariff & Oversized Shipment Tracker - PDF Extraction Workflow

## Purpose

The purpose of this workflow is to extract data from FedEx customs invoices (PDF) and populate the Tariff and Oversized Shipment Tracker Excel template.

This is important because it automates the manual process of reading customs invoices, performing OT lookups for POV/MPN/Buyer/Salesperson data, and compiling the tracker — reducing processing time and ensuring consistent data capture.

## Email-Driven Automation

This workflow uses the agent pattern (see `email-workflow-architecture.md`).

### Inbox & Routing

| Field | Value |
|-------|-------|
| **Inbox** | `bizops@orangetsunami.com` |
| **Handler** | `shared/workflow-actions/tariff-tracker.js` |
| **Cron** | Daily at 19:30 UTC (2:30 PM EST) |
| **Output recipient** | `justin.oberhofer@astutegroup.com` |

### How It Works

1. **User sends email** to `bizops@orangetsunami.com` with FedEx customs invoice PDFs attached
2. **Agent extracts** data from all PDFs in a single email → batches into one tracker
3. **Agent performs OT lookups** (POV → MPN/Buyer/Salesperson) per the Processing Rules below
4. **Agent populates tracker** using the template, marking rows for manual review where lookups fail
5. **Agent emails result** to the sender with the completed `.xlsx` attached

### Actions

| Action | Folder | Description |
|--------|--------|-------------|
| `process` | Processed | PDFs extracted successfully; tracker attached to confirmation email |
| `needs_review` | NeedsReview | Extraction failed or PDFs unreadable; operator notified |
| `skip` | Skipped | Email not relevant (no PDFs, wrong document type) |

### Manual Review Flags

When a row cannot be fully populated, the agent:
- **Populates all available fields** from the PDF (Entry No., Entry Date, Duties, MPF, Shipper, Tracking, Invoice)
- **Leaves blank** fields that require failed lookups (MPN, QTY, COV, Buyer, Salesperson)
- **Adds a comment** to the SOURCE column: `[REVIEW: tracking lookup failed]` or `[REVIEW: no POV found]`

The operator can then manually resolve the flagged rows in the output file.

## Source Files

- **Template:** `uploaded files/Tariff and Oversized Shipment Tracker template.xlsx`
- **Output:** `uploaded files/tariff_tracker_claude_YYYY-MM-DD.xlsx`

## Template Columns (DO NOT ADD EXTRA)

| Column | Description |
|--------|-------------|
| Customs Control Number | Entry No. (e.g., 1FX38290623) |
| Entry Date | Customs Entry Date |
| Duties/Taxes | Customs Duty amount |
| MPF | Merchandise Processing Fee |
| Oversized Charges | Transportation charges (only if individual shipment >$1,000) |
| Total Fees | Sum of all fees |
| Shipper | Sender name |
| TR#/Reference Number | Tracking ID |
| Invoice | Invoice Number(s) - comma-separated if multiple |
| SOURCE | POV number(s) only — no descriptions or internal refs |
| MPN | Part number from OT lookup |
| QTY | Quantity from OT lookup |
| COV/Job | Customer order from OT lookup |
| Buyer | PO salesrep from OT lookup |
| Salesperson | SO salesrep from OT lookup |

## Processing Rules

### 1. POV Lookup Priority
1. **Check Cust. Ref. field** in PDF for POV number
2. **If no POV, search tracking number** against `c_orderline.chuboe_trackingnumbers` using wildcards:
   - Try exact match: `ILIKE '%873974347228%'`
   - Try with prefix: `ILIKE '%FedEx # 873974347228%'`
   - Try partial (last 6-8 digits): `ILIKE '%4347228%'`
3. **If COV reference** in Cust. Ref., lookup POV via allocation (see COV Lookup query below)
4. **If still no match**, leave MPN/QTY/COV/Buyer/Salesperson blank

**SOURCE column rules:**
- Only populate with POV numbers (e.g., POV0076977)
- Do NOT include descriptions (e.g., "quartz crystal sample")
- Do NOT include internal references (e.g., "Ref: 232424")
- Leave blank if no POV can be determined

### 2. Transportation Charges (Oversized)
- Only capture **individual shipments** with transportation charges **> $1,000**
- Invoice totals are irrelevant — evaluate each shipment individually
- Put transportation charges in the **Oversized Charges** column
- If same shipment has both customs and transportation invoices AND transportation > $1,000, **merge into one row**
- Record **both invoice numbers** comma-separated in Invoice field
- **Ignore** transportation charges ≤ $1,000 (do not merge, do not add standalone rows)

### 3. Record Merging
- If two records have **same tracking number AND same buyer AND same salesperson**, merge them
- Record **both values** in cells that differ (SOURCE, MPN, QTY, COV)
- Keep records **separate** if buyer or salesperson differ

### 4. Under $250 Threshold
- For customs entries with **total fees < $250**, only populate through SOURCE column
- Leave MPN, QTY, COV, Buyer, Salesperson **blank**
- **Exception**: If the entry shares an Entry No. with a record ≥$250, populate all fields

### 5. MPN Source
- **ONLY use MPN from OT database lookups**
- Do NOT use commodity descriptions from the PDF
- If no POV/tracking match, leave MPN blank

## Lookup Queries

### Find PO and MPN from POV
```sql
SELECT
  order_document_number as po,
  order_line_infor_po_no as infor_po,
  order_line_mpn as mpn,
  order_line_qty_ordered as qty
FROM adempiere.bi_order_line_v
WHERE order_line_infor_po_no = 'POV0076097';
```

### Get Buyer from PO
```sql
SELECT
  po.documentno as po,
  buyer.name as buyer
FROM adempiere.c_order po
LEFT JOIN adempiere.ad_user buyer ON buyer.ad_user_id = po.salesrep_id
WHERE po.documentno = 'PO810169';
```

### Search by Tracking Number
```sql
SELECT
  o.documentno as doc,
  ol.chuboe_trackingnumbers as tracking,
  bol.order_line_infor_po_no as pov,
  bol.order_line_mpn as mpn,
  bol.order_line_qty_ordered as qty,
  u.name as buyer
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
LEFT JOIN adempiere.bi_order_line_v bol ON bol.order_line_id = ol.c_orderline_id
LEFT JOIN adempiere.ad_user u ON u.ad_user_id = o.salesrep_id
WHERE ol.chuboe_trackingnumbers ILIKE '%872892678556%';
```

### Get COV and Salesperson via Allocation
```sql
SELECT DISTINCT
  po.documentno as po,
  sol.order_line_infor_co_no as cov,
  sales.name as salesperson
FROM adempiere.c_order po
JOIN adempiere.c_orderline poline ON poline.c_order_id = po.c_order_id
JOIN adempiere.chuboe_alloc_order_lot alloc ON alloc.chuboe_poline_id = poline.c_orderline_id
JOIN adempiere.c_orderline covline ON covline.c_orderline_id = alloc.c_orderline_id
JOIN adempiere.c_order cov ON cov.c_order_id = covline.c_order_id
JOIN adempiere.bi_order_line_v sol ON sol.order_line_id = covline.c_orderline_id
LEFT JOIN adempiere.ad_user sales ON sales.ad_user_id = cov.salesrep_id
WHERE po.documentno = 'PO810169';
```

### Lookup POV/MPN/Buyer/Salesperson from COV Reference
Use when transportation invoice has COV in Cust. Ref. field:
```sql
SELECT DISTINCT
  sol.order_line_infor_co_no as cov,
  pol.order_line_infor_po_no as pov,
  pol.order_line_mpn as mpn,
  pol.order_line_qty_ordered as qty,
  buyer.name as buyer,
  sales.name as salesperson
FROM adempiere.bi_order_line_v sol
JOIN adempiere.c_orderline covline ON covline.c_orderline_id = sol.order_line_id
JOIN adempiere.c_order cov ON cov.c_order_id = covline.c_order_id
LEFT JOIN adempiere.chuboe_alloc_order_lot alloc ON alloc.c_orderline_id = covline.c_orderline_id
LEFT JOIN adempiere.c_orderline poline ON poline.c_orderline_id = alloc.chuboe_poline_id
LEFT JOIN adempiere.c_order po ON po.c_order_id = poline.c_order_id
LEFT JOIN adempiere.bi_order_line_v pol ON pol.order_line_id = poline.c_orderline_id
LEFT JOIN adempiere.ad_user buyer ON buyer.ad_user_id = po.salesrep_id
LEFT JOIN adempiere.ad_user sales ON sales.ad_user_id = cov.salesrep_id
WHERE sol.order_line_infor_co_no IN ('COV0022333', 'COV0022464');
```

## Field Clarifications

- **Buyer** = `salesrep_id` on the PO (the purchasing agent), NOT `createdby`
- **COV** = INFOR Customer Order number from `order_line_infor_co_no`, NOT the SO document number
- **Salesperson** = `salesrep_id` on the SO (the sales rep for the customer)

## Example Merged Entry

When same tracking has multiple POVs with same buyer/salesperson:

| Field | Value |
|-------|-------|
| Customs Control Number | 1FX56744907 |
| Entry Date | 2026-06-12 |
| Duties/Taxes | $3,699.50 |
| MPF | $33.58 |
| Total Fees | $3,733.08 |
| SOURCE | POV0076521, POV0076442 |
| MPN | SDINBDA4-256G, MPQ79500FSGQE-010C-AEC1-Z |
| QTY | 50, 24 |
| COV | COV0022230, COV0022174 |
| Buyer | Elaine Liang |
| Salesperson | James Diaz |

## Example Combined Customs + Transportation

| Field | Value |
|-------|-------|
| Customs Control Number | 1FX66454349 |
| Entry Date | 2026-06-19 |
| Duties/Taxes | $2,079.60 |
| MPF | $72.04 |
| Oversized Charges | $2,650.26 |
| Total Fees | $4,801.90 |
| Invoice | 2-576-93169, 2-577-44572 |
| SOURCE | POV0073302 |

---

## CLI Commands

```bash
# List unseen emails in bizops@ inbox
node shared/email-workflow-poller.js list --workflow tariff-tracker

# Read a specific email
node shared/email-workflow-poller.js read <uid> --workflow tariff-tracker

# Process and route
node shared/email-workflow-poller.js route <uid> process --workflow tariff-tracker --payload '{"invoices": [...]}'
```

---

*Created: 2026-06-23*
*Updated: 2026-07-16 - Added processing rules for merging, thresholds, and transportation charges*
*Updated: 2026-07-22 - Clarified transportation >$1,000 threshold applies per shipment (not invoice); added wildcard tracking search; added COV lookup query; SOURCE column POVs only*
*Updated: 2026-08-12 - Added email-driven automation via agent pattern (bizops@ inbox, batch PDFs per email, email results to justin.oberhofer); daily cron at 9 AM CT*
