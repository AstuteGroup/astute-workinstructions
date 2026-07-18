#!/usr/bin/env node
/**
 * Search for correct client-level MFR records
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

const manufacturers = [
  { name: 'Molex', search: 'molex' },
  { name: 'Littelfuse', search: 'littelfuse' },
  { name: 'ROHM', search: 'rohm' },
  { name: 'TE Connectivity', search: 'te conn' },
  { name: 'Susumu', search: 'susumu' },
  { name: 'IXYS', search: 'ixys' },
  { name: 'Bourns', search: 'bourns' },
  { name: 'KEMET', search: 'kemet' },
  { name: 'MCC', search: 'micro commercial' },
  { name: 'Amphenol', search: 'amphenol corp' },
  { name: 'ECS', search: 'ecs inc' },
];

console.log('Searching for MFR records (both system and client)...\n');

for (const mfr of manufacturers) {
  console.log(`=== ${mfr.name} ===`);
  const result = psqlQuery(`
    SELECT chuboe_mfr_id, name, ad_client_id,
           CASE WHEN ad_client_id = 0 THEN 'SYSTEM' ELSE 'CLIENT' END as level
    FROM adempiere.chuboe_mfr
    WHERE isactive = 'Y'
      AND UPPER(name) LIKE '%${mfr.search.toUpperCase()}%'
    ORDER BY ad_client_id, LENGTH(name)
    LIMIT 10;
  `);
  console.log(result || '  (none found)');
  console.log('');
}
