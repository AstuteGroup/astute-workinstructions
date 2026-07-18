#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

// Find the OT PO for POV0075254
const result = psqlQuery(`
  SELECT o.c_order_id, o.documentno, o.grandtotal, o.description,
         ol.c_orderline_id, ol.line, ol.qtyordered, ol.priceactual,
         ol.chuboe_mpn, ol.chuboe_trackingnumbers
  FROM adempiere.c_order o
  JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
  WHERE o.issotrx = 'N'
    AND o.isactive = 'Y'
    AND (o.description ILIKE '%POV0075254%' OR o.poreference ILIKE '%POV0075254%')
  ORDER BY ol.line;
`);
console.log('OT PO for POV0075254:');
console.log(result || '(none found)');

// Also search by MPN
const mpnResult = psqlQuery(`
  SELECT o.c_order_id, o.documentno, o.grandtotal,
         ol.c_orderline_id, ol.line, ol.qtyordered, ol.priceactual,
         ol.chuboe_mpn, bp.name as vendor
  FROM adempiere.c_order o
  JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
  JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
  WHERE o.issotrx = 'N'
    AND o.isactive = 'Y'
    AND ol.chuboe_mpn ILIKE '%SHV24-1A85-78D3K%'
    AND bp.name ILIKE '%Arrow%'
  ORDER BY o.created DESC
  LIMIT 5;
`);
console.log('\nOT orders for SHV24-1A85-78D3K from Arrow:');
console.log(mpnResult || '(none found)');
