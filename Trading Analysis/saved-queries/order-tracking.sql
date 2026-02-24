-- Order Tracking by COV Number
-- Looks up sales order details and tracking information using the COV reference number
--
-- Usage: Replace 'COV0020925' with the COV number you're searching for
--
-- Fields returned:
--   cov_number        - The COV reference from ERP
--   sales_order       - iDempiere sales order number (SOxxxxxx)
--   dateordered       - Order date
--   customer          - Customer name
--   customer_po       - Customer's PO reference
--   part_number       - MPN on the order line
--   line_tracking     - Tracking number stored on order line
--   order_tracking    - Tracking number stored on order header
--   shipment_tracking - Tracking number from shipment record

SELECT ol.chuboe_co_string AS cov_number,
       o.documentno AS sales_order,
       o.dateordered,
       o.docstatus,
       bp.name AS customer,
       o.poreference AS customer_po,
       ol.chuboe_mpn AS part_number,
       ol.qtyordered,
       ol.chuboe_trackingnumbers AS line_tracking,
       o.chuboe_trackingnumbers AS order_tracking,
       i.documentno AS shipment_doc,
       i.trackingno AS shipment_tracking,
       i.movementdate AS ship_date
FROM adempiere.c_orderline ol
JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
LEFT JOIN adempiere.m_inoutline il ON ol.c_orderline_id = il.c_orderline_id
LEFT JOIN adempiere.m_inout i ON il.m_inout_id = i.m_inout_id
WHERE ol.chuboe_co_string = 'COV0020925';  -- Replace with your COV number
