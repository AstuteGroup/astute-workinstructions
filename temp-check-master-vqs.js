#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

// Check Master VQs from today against base prices
const mpns = ['H11N1SR2M', 'IXFY26N30X3'];

for (const mpn of mpns) {
  console.log(`\n=== ${mpn} ===`);

  // Get roster info
  const rosterResult = psqlQuery(`
    SELECT rl.chuboe_cpc, rl.priceentered as base_price, rl.chuboe_resale as resale
    FROM adempiere.chuboe_rfq_line rl
    JOIN adempiere.chuboe_rfq rfq ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE rfq.c_bpartner_id = 1000730
      AND rlm.chuboe_mpn ILIKE '%${mpn}%'
      AND rfq.isactive = 'Y'
    ORDER BY rfq.created DESC
    LIMIT 1;
  `);

  if (rosterResult && rosterResult.trim()) {
    const [cpc, base, resale] = rosterResult.trim().split('|');
    console.log(`CPC: ${cpc}`);
    console.log(`Base Price: $${parseFloat(base).toFixed(4)}`);
    console.log(`Resale: $${parseFloat(resale).toFixed(4)}`);
  }

  // Get today's VQs for this MPN
  const vqResult = psqlQuery(`
    SELECT vl.chuboe_vq_line_id, vl.qty, vl.cost, bp.name as vendor
    FROM adempiere.chuboe_vq_line vl
    JOIN adempiere.c_bpartner bp ON vl.c_bpartner_id = bp.c_bpartner_id
    WHERE vl.chuboe_mpn ILIKE '%${mpn}%'
      AND vl.created::date = CURRENT_DATE
      AND vl.isactive = 'Y';
  `);

  console.log('\nToday\'s VQs:');
  for (const line of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [id, qty, cost, vendor] = line.split('|').map(s => s.trim());
    console.log(`  VQ ${id}: ${qty} @ $${cost} from ${vendor}`);
  }
}
