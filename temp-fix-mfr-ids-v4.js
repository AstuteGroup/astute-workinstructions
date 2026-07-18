#!/usr/bin/env node
/**
 * Fix MFR IDs on VQs for POV0075257 - Correct mapping with known client-level records
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPut } = require('./shared/api-client');

// MPN to correct client-level MFR ID mapping
// Only including verified correct matches
const correctMfrMapping = {
  // Littelfuse - correct client-level record exists
  '0505012.MXP': { mfrId: 1020272, name: 'Littelfuse, Inc.' },
  '0216.200MXP': { mfrId: 1020272, name: 'Littelfuse, Inc.' },

  // ROHM - correct client-level record: 1018897 (Rohm Semiconductor)
  'SCT3022ALGC11': { mfrId: 1018897, name: 'Rohm Semiconductor' },

  // Amphenol - Te Amphenol is actually an Amphenol subsidiary, OK to use
  '10139781-122402LF': { mfrId: 1020107, name: 'Te Amphenol' },
};

// VQs that need correct client-level MFR records to be created
const needsNewMfr = {
  '42819-5223': 'Molex',  // Currently set to Simolex (WRONG)
  'RG2012P-2742-B-T5': 'Susumu',  // No client-level record exists
  'RG2012P-1071-B-T5': 'Susumu',  // No client-level record exists
  'RG2012P-2101-B-T5': 'Susumu',  // No client-level record exists
  'RG2012P-1961-B-T5': 'Susumu',  // No client-level record exists
  'IXFY26N30X3': 'IXYS',  // No client-level record exists
  'SRU2013-2R2Y': 'Bourns',  // No client-level record exists
  'C0805C102JBRACTU': 'KEMET',  // No client-level record exists
  'C1812C224J1RACTU': 'KEMET',  // No client-level record exists
  'SMCJ1.5KE30A-TP': 'Micro Commercial Components',  // No client-level record exists
  'ECS-TXO-3225MV-160-TR': 'ECS Inc',  // No client-level record exists
  'RA73F1J200RBTDF': 'TE Connectivity',  // Currently set to KTE (WRONG)
};

const RFQ_ID = 1148927;

async function main() {
  // Get all VQs for this RFQ
  console.log('Getting VQs for RFQ 1139512...\n');
  const vqResult = psqlQuery(`
    SELECT vq.chuboe_vq_line_id, vq.chuboe_mpn, vq.chuboe_mfr_id, mfr.name as mfr_name
    FROM adempiere.chuboe_vq_line vq
    JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON vq.chuboe_mfr_id = mfr.chuboe_mfr_id
    WHERE rl.chuboe_rfq_id = ${RFQ_ID}
      AND vq.isactive = 'Y'
    ORDER BY vq.chuboe_mpn;
  `);

  console.log('Current VQ MFR status:');
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn, mfrId, mfrName] = row.split('|');
    const status = needsNewMfr[mpn.trim()] ? '✗ NEEDS FIX' : '✓';
    console.log(`  ${status} VQ ${vqId}: ${mpn.trim().padEnd(25)} → ${mfrName || '(none)'}`);
  }

  // Fix the ones we can correct
  console.log('\n\nFixing VQs with correct client-level MFR records...\n');
  let fixCount = 0;

  for (const [mpn, mapping] of Object.entries(correctMfrMapping)) {
    // Find the VQ ID for this MPN
    for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
      const [vqId, rowMpn] = row.split('|');
      if (rowMpn.trim() === mpn) {
        try {
          await apiPut('chuboe_vq_line', parseInt(vqId), { Chuboe_MFR_ID: mapping.mfrId });
          console.log(`✓ Fixed VQ ${vqId}: ${mpn} → ${mapping.name} (${mapping.mfrId})`);
          fixCount++;
        } catch (err) {
          console.log(`✗ VQ ${vqId} (${mpn}): ${err.message}`);
        }
      }
    }
  }

  console.log(`\n=== Fixed ${fixCount} VQs ===`);

  // Report what still needs to be done
  console.log('\n=== ACTION REQUIRED ===');
  console.log('The following VQs need client-level MFR records to be created:');
  console.log('(System-level MFR records exist but cannot be used on VQ lines)\n');

  const mfrGroups = {};
  for (const [mpn, mfrName] of Object.entries(needsNewMfr)) {
    if (!mfrGroups[mfrName]) mfrGroups[mfrName] = [];
    mfrGroups[mfrName].push(mpn);
  }

  for (const [mfrName, mpns] of Object.entries(mfrGroups)) {
    console.log(`${mfrName}: ${mpns.join(', ')}`);
  }

  console.log('\nOptions:');
  console.log('1. Create client-level MFR records for these manufacturers');
  console.log('2. Use existing records if acceptable alternatives exist');
}

main().catch(console.error);
