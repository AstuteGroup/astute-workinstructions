#!/usr/bin/env node
/**
 * Fix MFR IDs on VQs for POV0075257
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { apiPut } = require('./shared/api-client');

// MPN to MFR ID mapping - using exact DB IDs based on fuzzy search results
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
  'SMCJ1.5KE30A-TP': 1000227,      // MCC (Micro Commercial Components)
  '10139781-122402LF': 1000061,    // Amphenol Corp
  'ECS-TXO-3225MV-160-TR': 1001979,// Ecs Inc
};

const RFQ_ID = 1148927;

async function main() {
  console.log('Looking up MFR IDs...\n');

  // Get all needed MFRs
  const mfrNames = [...new Set(Object.values(mfrMapping))];
  const mfrResult = psqlQuery(`
    SELECT chuboe_mfr_id, name
    FROM adempiere.chuboe_mfr
    WHERE isactive = 'Y'
      AND UPPER(name) IN (${mfrNames.map(n => `'${n.toUpperCase()}'`).join(', ')})
    ORDER BY name;
  `);

  const mfrIds = {};
  for (const row of (mfrResult || '').split('\n').filter(r => r.includes('|'))) {
    const [id, name] = row.split('|');
    mfrIds[name.trim().toUpperCase()] = parseInt(id);
  }

  console.log('Found MFR IDs:');
  for (const [name, id] of Object.entries(mfrIds)) {
    console.log(`  ${name}: ${id}`);
  }

  // Try fuzzy matching for ones not found exactly
  const notFound = mfrNames.filter(n => !mfrIds[n.toUpperCase()]);
  if (notFound.length > 0) {
    console.log('\nSearching for missing MFRs...');
    for (const name of notFound) {
      const fuzzyResult = psqlQuery(`
        SELECT chuboe_mfr_id, name
        FROM adempiere.chuboe_mfr
        WHERE isactive = 'Y'
          AND UPPER(name) LIKE '%${name.toUpperCase().replace(/[^A-Z0-9]/g, '%')}%'
        LIMIT 5;
      `);
      console.log(`  ${name}: ${fuzzyResult || 'not found'}`);
    }
  }

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

  const vqsToFix = [];
  for (const row of (vqResult || '').split('\n').filter(r => r.includes('|'))) {
    const [vqId, mpn] = row.split('|');
    const mfrName = mfrMapping[mpn.trim()];
    if (mfrName) {
      const mfrId = mfrIds[mfrName.toUpperCase()];
      if (mfrId) {
        vqsToFix.push({ vqId: parseInt(vqId), mpn: mpn.trim(), mfrName, mfrId });
      } else {
        console.log(`  No MFR ID for ${mpn}: ${mfrName}`);
      }
    } else {
      console.log(`  No mapping for ${mpn}`);
    }
  }

  console.log(`\nFound ${vqsToFix.length} VQs to update\n`);

  // Update each VQ
  for (const vq of vqsToFix) {
    try {
      await apiPut('chuboe_vq_line', vq.vqId, { Chuboe_MFR_ID: vq.mfrId });
      console.log(`✓ Updated VQ ${vq.vqId}: ${vq.mpn} → ${vq.mfrName} (${vq.mfrId})`);
    } catch (err) {
      console.log(`✗ VQ ${vq.vqId} (${vq.mpn}): ${err.message}`);
    }
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);
