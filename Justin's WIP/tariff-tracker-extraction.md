# Tariff & Oversized Shipment Tracker - PDF Extraction Workflow

## Overview

Extracts data from FedEx customs invoices (PDF) and populates the Tariff and Oversized Shipment Tracker Excel template.

## Source Files

- **Template:** `uploaded files/Tariff and Oversized Shipment Tracker template.xlsx`
- **Output:** `uploaded files/tariff_tracker_claude_YYYY-MM-DD.xlsx`

## Data Extraction Mapping

### From FedEx Invoice (PDF)

| Template Column | PDF Location |
|-----------------|--------------|
| Customs Control Number | Entry No. (e.g., 1FX38290623) |
| Entry Date | Customs Entry Date |
| Duties/Taxes | Customs Duty amount |
| MPF | Merchandise Processing Fee |
| Oversized Charges | (if applicable) |
| Total Fees | Total Duties, Tax, Customs, Other Fees |
| Shipper | Sender name |
| TR#/Reference Number | Tracking ID |
| Invoice | Invoice Number |
| SOURCE | Cust. Ref. / PO NO. (POV number) |

### From Database Lookups

| Template Column | Query Path |
|-----------------|------------|
| MPN | `bi_order_line_v` WHERE `order_line_infor_po_no` = POV |
| QTY | `bi_order_line_v.order_line_qty_ordered` |
| Buyer | PO `salesrep_id` → `ad_user.name` |
| COV/Job | SO line `order_line_infor_co_no` (via allocation) |
| Salesperson | SO `salesrep_id` → `ad_user.name` |

## Lookup Chain

```
POV (INFOR PO Number)
  → bi_order_line_v.order_line_infor_po_no
  → PO document number (e.g., PO810169)
  → chuboe_alloc_order_lot (allocation)
  → SO line (e.g., SO507065)
  → order_line_infor_co_no = COV number
```

## Key Queries

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

### Get COV and Salesperson via Allocation
```sql
SELECT
  po.documentno as po,
  cov.documentno as so,
  sol.order_line_infor_co_no as cov,
  sales.name as salesperson
FROM adempiere.c_order po
JOIN adempiere.c_orderline pol ON pol.c_order_id = po.c_order_id
JOIN adempiere.chuboe_alloc_order_lot alloc ON alloc.chuboe_poline_id = pol.c_orderline_id
JOIN adempiere.c_orderline covl ON covl.c_orderline_id = alloc.c_orderline_id
JOIN adempiere.c_order cov ON cov.c_order_id = covl.c_order_id
JOIN adempiere.bi_order_line_v sol ON sol.order_document_number = cov.documentno
LEFT JOIN adempiere.ad_user sales ON sales.ad_user_id = cov.salesrep_id
WHERE po.documentno = 'PO810169';
```

## Field Clarifications

- **Buyer** = `salesrep_id` on the PO (the purchasing agent), NOT `createdby`
- **COV** = INFOR Customer Order number from `order_line_infor_co_no`, NOT the SO document number
- **Salesperson** = `salesrep_id` on the SO (the sales rep for the customer)

## Example Entry

| Field | Value |
|-------|-------|
| Customs Control Number | 1FX38290623 |
| Entry Date | 2026-05-28 |
| Duties/Taxes | $14,400.00 |
| MPF | $498.82 |
| Total Fees | $14,898.82 |
| Shipper | HAOXIN HK ELECTRONIC TECH CO LTD |
| Tracking | 872275863012 |
| Invoice | 2-566-63571 |
| SOURCE | POV0076097 |
| MPN | MT29F64G08AJABAWP-IT:B |
| QTY | 720 |
| COV/Job | COV0021931 |
| Buyer | Feong C. |
| Salesperson | Daniel R. |

---

*Created: 2026-06-23*
