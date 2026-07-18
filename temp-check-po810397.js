#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

const result = psqlQuery(`
  SELECT ol.c_orderline_id, ol.line, ol.chuboe_mpn,
         ol.qtyordered, ol.qtydelivered, ol.qtyinvoiced,
         o.docstatus, o.documentno,
         ol.chuboe_trackingnumbers
  FROM adempiere.c_orderline ol
  JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
  WHERE o.documentno = 'PO810397'
    AND ol.isactive = 'Y'
  ORDER BY ol.line;
`);
console.log('PO810397 lines:');
console.log('Line | MPN | Ordered | Delivered | Invoiced | Tracking');
console.log('-'.repeat(80));
for (const row of (result || '').split('\n').filter(r => r.includes('|'))) {
  const [lineId, line, mpn, ordered, delivered, invoiced, status, docno, tracking] = row.split('|');
  console.log(`${line?.trim()} | ${mpn?.trim()?.substring(0,20)} | ${ordered?.trim()} | ${delivered?.trim()} | ${invoiced?.trim()} | ${tracking?.trim() || '(none)'}`);
}
