#!/usr/bin/env node
/**
 * Fix MFR IDs on VQs for POV0075257 - Direct update version
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPut } = require('./shared/api-client');

// MPN to MFR ID mapping - using exact DB IDs from fuzzy search results
const mfrIdMapping = {
  '42819-5223': 1000038,           // Molex LLC
  '0505012.MXP': 1000069,          // Littelfuse Inc
  '0216.200MXP': 1000069,          // Littelfuse Inc
  'SCT3022ALGC11': 1000090,        // Rohm Co Ltd
  'RA73F1J200RBTDF': 1000009,      // TE Connectivity Ltd
  'RG2012P-2742-B-T5': 1013457,    // Susumu Co Ltd
  'RG2012P-1071-B-T5': 1013457,    // Susumu Co Ltd
  'RG2012P-2101-B-T5': 1013457,    // Susumu Co Ltd
  'RG2012P-1961-B-T5': 1013457,    // Susumu Co Ltd
  'IXFY26N30X3': 1000048,          // IXYS Corp
  'SRU2013-2R2Y': 1000178,         // Bourns Inc
  'C0805C102JBRACTU': 1000020,     // Kemet Electronics Corp
  'C1812C224J1RACTU': 1000020,     // Kemet Electronics Corp
  'SMCJ1.5KE30A-TP': 1000227,      // MCC (Micro Commercial Components) - need to verify
  '10139781-122402LF': 1000061,    // Amphenol Corp
  'ECS-TXO-3225MV-160-TR': 1001979,// Ecs Inc
};

const RFQ_ID = 1148927;

async function main() {
  // First find MCC ID
  console.log('Looking up MCC...');
  const mccResult = psqlQuery(`
    SELECT chuboe_mfr_id, name
    FROM adempiere.chuboe_mfr
    WHERE isactive = 'Y'
      AND (UPPER(name) LIKE '%MICRO COMMERCIAL%' OR name = 'MCC')
    LIMIT 5;
  `);
  console.log('MCC search results:', mccResult);

  // Get VQs that need MFR update
  console.log('\nGetting VQs missing MFR...');
  const vqResult = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.chuboe_mfr_id
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
      AND (vq.chuboe_mfr_id IS NULL OR vq.chuboe_mfr_id = 0)
    ORDER BY vq.chuboe_mpn;
  `);

  console.log('VQs missing MFR:');
  console.log(vqResult);

  const vqsToFix = [];
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const parts = row.split('|');
    const vqId = parseInt(parts[0]);
    const mpn = parts[1]?.trim();
    const mfrId = mfrIdMapping[mpn];

    if (mfrId) {
      vqsToFix.push({ vqId, mpn, mfrId });
    } else {
      console.log(`  No MFR mapping for MPN: ${mpn}`);
    }
  }

  console.log(`\nFound ${vqsToFix.length} VQs to update\n`);

  // Update each VQ
  let successCount = 0;
  for (const vq of vqsToFix) {
    try {
      await apiPut('chuboe_vq_line', vq.vqId, { Chuboe_MFR_ID: vq.mfrId });
      console.log(`✓ Updated VQ ${vq.vqId}: ${vq.mpn} → MFR ID ${vq.mfrId}`);
      successCount++;
    } catch (err) {
      console.log(`✗ VQ ${vq.vqId} (${vq.mpn}): ${err.message}`);
    }
  }

  console.log(`\n=== DONE: ${successCount}/${vqsToFix.length} VQs updated ===`);
}

main().catch(console.error);
