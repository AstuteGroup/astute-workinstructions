#!/usr/bin/env node
/**
 * One-off script to fix RFQs 1142096 and 1142053
 * These were created with Hugo Ogalde (inactive) as seller due to agent hallucination.
 * Correct seller is Spring Tu (who sent the original email).
 *
 * Bug: VQ loading agent hallucinated "Hugo Ogalde" as salesRep when email said
 *      "customer Celestica, contact Jasmine" - Hugo wasn't mentioned anywhere.
 *
 * Created: 2026-08-18
 */

'use strict';

const { apiPut } = require('../shared/api-client');

const SPRING_TU_ID = 1013042;

// RFQ value → chuboe_rfq_id (from database lookup)
const RFQS_TO_FIX = [
  { value: '1142096', id: 1151511 },
  { value: '1142053', id: 1151468 },
];

async function main() {
  console.log('Fixing RFQ sellers: Hugo Ogalde (inactive, 1004760) → Spring Tu (1013042)');
  console.log('='.repeat(70));

  for (const rfq of RFQS_TO_FIX) {
    try {
      console.log(`\nRFQ ${rfq.value} (chuboe_rfq_id: ${rfq.id})`);
      console.log(`  Patching SalesRep_ID to Spring Tu (${SPRING_TU_ID})...`);

      const result = await apiPut('Chuboe_RFQ', rfq.id, {
        SalesRep_ID: SPRING_TU_ID
      });

      if (result && result.id) {
        console.log(`  ✓ SUCCESS - SalesRep_ID now: ${result.SalesRep_ID?.identifier || SPRING_TU_ID}`);
      } else {
        console.log(`  ✗ FAILED - unexpected response:`, result);
      }
    } catch (err) {
      console.error(`  ✗ ERROR: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
