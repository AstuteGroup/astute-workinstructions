#!/usr/bin/env node
/**
 * Fix remaining VQs with newly created client-level MFR records
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPut } = require('./shared/api-client');

// MPN to correct MFR ID mapping (using newly created client-level records)
const mfrIdMapping = {
  '42819-5223': 1021009,              // Molex LLC
  'RG2012P-2742-B-T5': 1021010,       // Susumu Co Ltd
  'RG2012P-1071-B-T5': 1021010,       // Susumu Co Ltd
  'RG2012P-2101-B-T5': 1021010,       // Susumu Co Ltd
  'RG2012P-1961-B-T5': 1021010,       // Susumu Co Ltd
  'IXFY26N30X3': 1021011,             // IXYS Corp
  'SRU2013-2R2Y': 1021012,            // Bourns Inc
  'C0805C102JBRACTU': 1021013,        // Kemet Electronics Corp
  'C1812C224J1RACTU': 1021013,        // Kemet Electronics Corp
  'SMCJ1.5KE30A-TP': 1021014,         // Micro Commercial Components
  'ECS-TXO-3225MV-160-TR': 1021015,   // Ecs Inc
  'RA73F1J200RBTDF': 1021016,         // TE Connectivity Ltd
};

const RFQ_ID = 1148927;

async function main() {
  // Get VQs that need MFR update
  console.log('Getting VQs that need MFR update...\n');
  const vqResult = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.chuboe_mfr_id, mfr.name as mfr_name
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON vq.chuboe_mfr_id = mfr.chuboe_mfr_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
    ORDER BY vq.chuboe_mpn;
  `);

  const vqsToFix = [];
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn, currentMfrId, currentMfrName] = row.split('|');
    const newMfrId = mfrIdMapping[mpn.trim()];
    if (newMfrId) {
      vqsToFix.push({
        vqId: parseInt(vqId),
        mpn: mpn.trim(),
        currentMfr: currentMfrName?.trim() || '(none)',
        newMfrId
      });
    }
  }

  console.log(`Found ${vqsToFix.length} VQs to fix\n`);

  // Update each VQ
  let successCount = 0;
  for (const vq of vqsToFix) {
    try {
      await apiPut('chuboe_vq_line', vq.vqId, { Chuboe_MFR_ID: vq.newMfrId });
      console.log(`✓ Fixed VQ ${vq.vqId}: ${vq.mpn} (was: ${vq.currentMfr}) → MFR ID ${vq.newMfrId}`);
      successCount++;
    } catch (err) {
      console.log(`✗ VQ ${vq.vqId} (${vq.mpn}): ${err.message}`);
    }
  }

  console.log(`\n=== DONE: ${successCount}/${vqsToFix.length} VQs fixed ===`);

  // Verify final state
  console.log('\n\nVerifying final VQ state...');
  const finalResult = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.chuboe_mfr_id, mfr.name as mfr_name
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON vq.chuboe_mfr_id = mfr.chuboe_mfr_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
      AND (vq.chuboe_mfr_id IS NULL OR vq.chuboe_mfr_id = 0)
    ORDER BY vq.chuboe_mpn;
  `);

  const stillMissingMfr = (finalResult || '').split('\n').filter(r => r.includes('|')).length;
  console.log(`VQs still missing MFR: ${stillMissingMfr}`);
}

main().catch(console.error);
