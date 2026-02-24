# Order/Shipment Tracking Lookup

Find tracking information for orders using any of the search criteria below.

## Search Criteria

| Search By | Field | Table |
|-----------|-------|-------|
| **COV number** | `chuboe_co_string` | `c_orderline` |
| **SO number** | `documentno` | `c_order` |
| **Customer PO** | `poreference` | `c_order` |
| **Part number (MPN)** | `chuboe_mpn` | `c_orderline` |
| **Customer name** | `name` | `c_bpartner` (via `c_order.c_bpartner_id`) |
| **Salesperson** | `name` | `ad_user` (via `c_order.salesrep_id`) |
| **Order date** | `dateordered` | `c_order` |
| **Ship date** | `movementdate` | `m_inout` |

## Tracking Output Fields

Tracking can be stored in multiple places - check all three:

| Field | Table | Notes |
|-------|-------|-------|
| `chuboe_trackingnumbers` | `c_orderline` | Line-level tracking |
| `chuboe_trackingnumbers` | `c_order` | Order header tracking |
| `trackingno` | `m_inout` | Shipment record tracking |

## Key Joins

```
c_order (SO)
  → c_orderline (line items, COV, MPN, line tracking)
  → c_bpartner (customer name)
  → ad_user via salesrep_id (salesperson)
  → m_inoutline via c_orderline_id → m_inout (shipment, ship tracking)
```

## Base Query Template

```sql
SELECT
    o.documentno AS so_number,
    ol.chuboe_co_string AS cov,
    o.poreference AS customer_po,
    ol.chuboe_mpn AS part_number,
    ol.qtyordered,
    bp.name AS customer,
    u.name AS salesperson,
    o.dateordered,
    o.docstatus,
    ol.chuboe_trackingnumbers AS line_tracking,
    o.chuboe_trackingnumbers AS order_tracking,
    i.documentno AS shipment,
    i.trackingno AS shipment_tracking,
    i.movementdate AS ship_date
FROM adempiere.c_order o
JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
LEFT JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id
LEFT JOIN adempiere.m_inoutline il ON ol.c_orderline_id = il.c_orderline_id
LEFT JOIN adempiere.m_inout i ON il.m_inout_id = i.m_inout_id
WHERE o.issotrx = 'Y'  -- Sales orders only
-- Add search criteria below:
```

## Example Searches

### By COV Number
```sql
AND ol.chuboe_co_string = 'COV0020925'
```

### By SO Number
```sql
AND o.documentno = 'SO506141'
```

### By Customer PO
```sql
AND o.poreference = '3380433'
```

### By Part Number (MPN)
```sql
AND ol.chuboe_mpn ILIKE '%IRF8910TRPBF%'
ORDER BY o.dateordered DESC
```

### By Salesperson + Date Range
```sql
AND u.name ILIKE '%Jake%'
AND o.dateordered >= '2026-02-01'
ORDER BY o.dateordered DESC
```

### By Customer + Recent Shipments
```sql
AND bp.name ILIKE '%Abacus%'
AND i.movementdate >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY i.movementdate DESC
```

### Shipped Yesterday (any salesperson)
```sql
AND i.movementdate = CURRENT_DATE - INTERVAL '1 day'
AND u.name ILIKE '%SalespersonName%'
```

## Document Status Codes

| Code | Meaning |
|------|---------|
| DR | Draft |
| IP | In Progress |
| CO | Completed |
| VO | Voided |
| CL | Closed |
