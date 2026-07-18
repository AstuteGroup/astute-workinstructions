#!/usr/bin/env node
/**
 * Find non-system MFR records
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { psqlQuery } = require('./shared/db-helpers');

const manufacturers = [
  'Molex',
  'Littelfuse',
  'ROHM',
  'TE Connectivity',
  'Susumu',
  'IXYS',
  'Bourns',
  'KEMET',
  'MCC',
  'Micro Commercial',
  'Amphenol',
  'ECS',
];

console.log('Searching for non-system MFR records...\n');

for (const mfr of manufacturers) {
  const result = psqlQuery(`
    SELECT chuboe_mfr_id, name, issystem
    FROM adempiere.chuboe_mfr
    WHERE isactive = 'Y'
      AND UPPER(name) LIKE '%${mfr.toUpperCase()}%'
    ORDER BY issystem, name
    LIMIT 5;
  `);
  console.log(`${mfr}:`);
  console.log(result || '  (none found)');
  console.log('');
}
