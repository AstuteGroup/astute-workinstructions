#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPut } = require('./shared/api-client');

const RFQ_ID = 1148927;

async function main() {
  // 1. Fix quantities for split shipment items
  console.log('=== FIXING QUANTITIES ===\n');

  const vqResult = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.qty, vq.cost
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
      AND vq.chuboe_mpn IN ('RG2012P-1961-B-T5', 'SSW-104-06-G-S')
    ORDER BY vq.chuboe_mpn;
  `);

  console.log('Current VQs for split items:');
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn, qty, cost] = row.split('|');
    console.log(`  VQ ${vqId}: ${mpn.trim()} - Qty: ${qty}, Cost: $${cost}`);
  }

  // Update quantities
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn, qty] = row.split('|');
    let newQty;

    if (mpn.trim() === 'RG2012P-1961-B-T5') {
      newQty = 555;  // 516 + 39
    } else if (mpn.trim() === 'SSW-104-06-G-S') {
      newQty = 150;  // 75 + 75
    }

    if (newQty && parseInt(qty) !== newQty) {
      console.log(`\nUpdating VQ ${vqId}: ${mpn.trim()} from ${qty} to ${newQty}`);
      await apiPut('chuboe_vq_line', parseInt(vqId), { Qty: newQty });
      console.log('  ✓ Updated');
    }
  }

  // 2. Check for potential duplicates and which RFQ they're on
  console.log('\n\n=== CHECKING DUPLICATE VQs ===\n');

  const dupeCheck = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.qty,
           r.value as rfq_value, r.chuboe_rfq_id,
           bp.name as vendor_name
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    LEFT JOIN adempiere.c_bpartner bp ON vq.c_bpartner_id = bp.c_bpartner_id
    WHERE vq.isactive = 'Y'
      AND vq.chuboe_mpn IN (
        '428195223', 'SSW10406GS', 'SL120G10', 'SCT3022ALGC11',
        'SRU20132R2Y', 'TNPW120690K9BEEA', 'C0805C102JBRACTU',
        'C1812C224J1RACTU', 'SHV241A8578D3K', 'ECSTXO3225MV160TR',
        'TNPW08051K91BEEN', 'TNPW0402249RBYEP', 'IXFY26N30X3'
      )
    ORDER BY vq.chuboe_mpn, r.value;
  `);

  console.log('VQs with normalized MPNs (potential duplicates):');
  console.log('VQ ID | MPN | Qty | RFQ | Vendor');
  console.log('-'.repeat(80));
  for (const row of (dupeCheck || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn, qty, rfqValue, rfqId, vendor] = row.split('|');
    console.log(`${vqId} | ${mpn?.trim().padEnd(22)} | ${qty?.padStart(5)} | ${rfqValue?.trim()} | ${vendor?.trim() || '(none)'}`);
  }
}

main().catch(console.error);
