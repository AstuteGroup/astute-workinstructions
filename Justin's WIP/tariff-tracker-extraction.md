# Tariff & Oversized Shipment Tracker - PDF Extraction Workflow

## Overview

Extracts data from FedEx customs invoices (PDF) and populates the Tariff and Oversized Shipment Tracker Excel template.

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
| Oversized Charges | Transportation charges (if >$1000) |
| Total Fees | Sum of all fees |
| Shipper | Sender name |
| TR#/Reference Number | Tracking ID |
| Invoice | Invoice Number(s) - comma-separated if multiple |
| SOURCE | POV number(s) from Cust. Ref. / PO NO. |
| MPN | Part number from OT lookup |
| QTY | Quantity from OT lookup |
| COV/Job | Customer order from OT lookup |
| Buyer | PO salesrep from OT lookup |
| Salesperson | SO salesrep from OT lookup |

## Processing Rules

### 1. POV Lookup Priority
1. **Check Cust. Ref. field** in PDF for POV number
2. **If no POV, check tracking number** against `c_orderline.chuboe_trackingnumbers`
3. **If still no match**, leave MPN/QTY/COV/Buyer/Salesperson blank

### 2. Transportation Charges (Oversized)
- Only capture transportation-only invoices if **total > $1,000**
- Put transportation charges in the **Oversized Charges** column
- If same shipment has both customs and transportation invoices, **merge into one row**
- Record **both invoice numbers** comma-separated in Invoice field

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

*Created: 2026-06-23*
*Updated: 2026-07-16 - Added processing rules for merging, thresholds, and transportation charges*
