#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

const result = psqlQuery(`
  SELECT vl.chuboe_vq_line_id as vq_id, vl.chuboe_mpn, vl.qty, vl.cost,
         vl.datepromised::date as promise_date,
         bp.name as vendor, vl.created::timestamp as created,
         COALESCE(vl.description, '') as notes
  FROM adempiere.chuboe_vq_line vl
  JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
  JOIN adempiere.chuboe_rfq rfq ON vl.chuboe_rfq_id = rfq.chuboe_rfq_id
  WHERE rfq.c_bpartner_id = 1000730  -- Lam Research
    AND vl.created::date = CURRENT_DATE
    AND vl.isactive = 'Y'
  ORDER BY vl.created DESC;
`);

console.log('VQs created today for LAM Kitting:');
console.log('='.repeat(120));
for (const line of (result || '').split('\n').filter(r => r.includes('|'))) {
  const [vqId, mpn, qty, cost, promise, vendor, created, notes] = line.split('|').map(s => s.trim());
  console.log(`VQ ${vqId}: ${mpn}`);
  console.log(`  ${qty} pcs @ $${cost} from ${vendor}`);
  console.log(`  Promise: ${promise || '(none)'}`);
  if (notes) console.log(`  Notes: ${notes.substring(0, 80)}`);
  console.log('');
}
