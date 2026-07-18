#!/usr/bin/env node
/**
 * extract-dedup-ids.js — Extract duplicate IDs for a specific offer type
 *
 * Usage:
 *   node scripts/extract-dedup-ids.js "Customer Excess"
 *   node scripts/extract-dedup-ids.js "Broker Stock Offer" --limit=10000
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = require('pg');

const args = process.argv.slice(2);
const offerType = args.find(a => !a.startsWith('--'));
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

if (!offerType) {
  console.log('Usage: node scripts/extract-dedup-ids.js "Offer Type Name" [--limit=N]');
  console.log('');
  console.log('Types: "Customer Excess", "Broker Stock Offer", "Franchise Stock Offers"');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    host: '/var/run/postgresql',
    database: 'idempiere_replica',
  });

  console.log(`Extracting duplicate IDs for: ${offerType}`);

  const sql = `
    WITH ranked AS (
      SELECT
        olm.chuboe_offer_line_mpn_id,
        ol.chuboe_offer_line_id,
        olm.chuboe_mpn_clean,
        ROW_NUMBER() OVER (PARTITION BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean ORDER BY olm.chuboe_offer_line_mpn_id) AS rn,
        COUNT(*) OVER (PARTITION BY ol.chuboe_offer_line_id, olm.chuboe_mpn_clean) AS cnt
      FROM chuboe_offer_line_mpn olm
      JOIN chuboe_offer_line ol ON olm.chuboe_offer_line_id = ol.chuboe_offer_line_id
      JOIN chuboe_offer o ON ol.chuboe_offer_id = o.chuboe_offer_id
      JOIN chuboe_offer_type ot ON o.chuboe_offer_type_id = ot.chuboe_offer_type_id
      WHERE olm.isactive = 'Y' AND ol.isactive = 'Y' AND o.isactive = 'Y'
        AND olm.created >= NOW() - INTERVAL '9 months'
        AND ot.name = $1
    )
    SELECT r2.chuboe_offer_line_mpn_id as deactivate_id
    FROM ranked r1
    JOIN ranked r2 ON r1.chuboe_offer_line_id = r2.chuboe_offer_line_id
      AND r1.chuboe_mpn_clean = r2.chuboe_mpn_clean AND r1.rn = 1 AND r2.rn = 2
    WHERE r1.cnt = 2
    ORDER BY r2.chuboe_offer_line_mpn_id
    ${limit ? `LIMIT ${limit}` : ''};
  `;

  const result = await pool.query(sql, [offerType]);
  const ids = result.rows.map(r => r.deactivate_id);

  const safeName = offerType.toLowerCase().replace(/\s+/g, '-');
  const outFile = `/tmp/dedup-${safeName}-ids.txt`;

  fs.writeFileSync(outFile, ids.join('\n') + '\n');
  console.log(`Wrote ${ids.length} IDs to ${outFile}`);

  await pool.end();
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
