#!/usr/bin/env node
/**
 * Fix MFR IDs on VQs for POV0075257 - Using proper lookupMfr
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');
const { lookupMfr, clearCache } = require('./shared/mfr-lookup');
const { apiPut } = require('./shared/api-client');

// MPN to expected MFR text from invoice data
const mfrTextMapping = {
  '42819-5223': 'Molex',
  '0505012.MXP': 'Littelfuse',
  '0216.200MXP': 'Littelfuse',
  'SCT3022ALGC11': 'ROHM',
  'RA73F1J200RBTDF': 'TE Connectivity',
  'RG2012P-2742-B-T5': 'Susumu',
  'RG2012P-1071-B-T5': 'Susumu',
  'RG2012P-2101-B-T5': 'Susumu',
  'RG2012P-1961-B-T5': 'Susumu',
  'IXFY26N30X3': 'IXYS',
  'SRU2013-2R2Y': 'Bourns',
  'C0805C102JBRACTU': 'KEMET',
  'C1812C224J1RACTU': 'KEMET',
  'SMCJ1.5KE30A-TP': 'Micro Commercial Components',
  '10139781-122402LF': 'Amphenol',
  'ECS-TXO-3225MV-160-TR': 'ECS Inc',
};

const RFQ_ID = 1148927;

async function main() {
  // Clear cache to ensure fresh lookups
  console.log('Clearing MFR cache...');
  clearCache();

  // Look up MFR IDs using the proper lookup function
  console.log('\nLooking up non-system MFR IDs...');
  const mfrIds = {};

  for (const [mpn, mfrText] of Object.entries(mfrTextMapping)) {
    const result = lookupMfr(mfrText);
    console.log(`  ${mfrText}: id=${result.id}, isSystem=${result.isSystem}, source=${result.source}`);

    if (result.id && !result.isSystem) {
      mfrIds[mpn] = result.id;
    } else if (result.isSystem) {
      console.log(`    ⚠ System MFR - need to find client-level record`);
    }
  }

  // For system MFRs, search for client-level versions
  const systemMfrs = Object.entries(mfrTextMapping).filter(([mpn]) => !mfrIds[mpn]);
  if (systemMfrs.length > 0) {
    console.log('\nSearching for client-level MFR records...');
    for (const [mpn, mfrText] of systemMfrs) {
      const result = psqlQuery(`
        SELECT chuboe_mfr_id, name, ad_client_id
        FROM adempiere.chuboe_mfr
        WHERE isactive = 'Y'
          AND ad_client_id != 0
          AND UPPER(name) LIKE '%${mfrText.toUpperCase().split(' ')[0]}%'
        ORDER BY LENGTH(name)
        LIMIT 5;
      `);
      console.log(`  ${mfrText} (${mpn}):`);
      if (result) {
        for (const line of result.split('\n').filter(l => l.includes('|'))) {
          const [id, name, client] = line.split('|');
          console.log(`    ${id}: ${name} (client ${client})`);
        }
        // Use the first non-system match
        const firstLine = result.split('\n').find(l => l.includes('|'));
        if (firstLine) {
          const [id] = firstLine.split('|');
          mfrIds[mpn] = parseInt(id);
        }
      } else {
        console.log('    (none found)');
      }
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
    const parts = row.split('|');
    const vqId = parseInt(parts[0]);
    const mpn = parts[1]?.trim();
    const mfrId = mfrIds[mpn];

    if (mfrId) {
      vqsToFix.push({ vqId, mpn, mfrId });
    } else {
      console.log(`  No MFR ID for MPN: ${mpn}`);
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
