#!/usr/bin/env node
/**
 * MPN Substitution Analysis
 *
 * Analyzes historical VQ data to find cases where we bought a different MPN
 * than originally requested (same base, different packaging suffix).
 * This mines our own transaction history to discover packaging variant patterns.
 *
 * Approach:
 *   1. Query VQ lines where VQ MPN differs from RFQ Line MPN
 *   2. Filter to cases where the MPNs share a common base
 *   3. Extract the differing suffixes
 *   4. Group by manufacturer to find patterns
 *
 * Usage:
 *   node scripts/analyze-mpn-substitutions.js
 */

'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const OUTPUT_FILE = path.resolve(__dirname, '../shared/data/mpn-substitution-patterns.json');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'idempiere_replica',
  user: process.env.DB_USER || 'analytics_user',
  password: process.env.DB_PASSWORD,
});

/**
 * Find the longest common prefix between two strings
 */
function commonPrefix(a, b) {
  const maxLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < maxLen && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Normalize MPN for comparison
 */
function normalize(mpn) {
  if (!mpn) return '';
  return mpn.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Check if two MPNs are packaging variants (same base, different suffix)
 */
function arePackagingVariants(mpn1, mpn2) {
  const n1 = normalize(mpn1);
  const n2 = normalize(mpn2);

  if (n1 === n2) return null; // Same MPN
  if (Math.abs(n1.length - n2.length) > 6) return null; // Too different

  const prefix = commonPrefix(n1, n2);

  // Base must be at least 60% of the shorter MPN
  const minLen = Math.min(n1.length, n2.length);
  if (prefix.length < minLen * 0.6) return null;

  // Base must be at least 5 chars
  if (prefix.length < 5) return null;

  return {
    base: prefix,
    suffix1: n1.slice(prefix.length),
    suffix2: n2.slice(prefix.length),
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       MPN SUBSTITUTION PATTERN ANALYSIS                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Querying historical VQ data...\n');

  // Query VQ lines joined to RFQ lines to find substitutions
  const query = `
    SELECT
      vq.mpn AS vq_mpn,
      rlm.mpn AS rfq_mpn,
      m.name AS mfr_name,
      vq.created,
      r.value AS rfq_value
    FROM chuboe_vq_line vq
    JOIN chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
      AND rlm.isactive = 'Y'
    LEFT JOIN chuboe_mfr m ON vq.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE vq.isactive = 'Y'
      AND vq.mpn IS NOT NULL
      AND vq.mpn != ''
      AND rlm.mpn IS NOT NULL
      AND rlm.mpn != ''
      AND UPPER(REPLACE(vq.mpn, '-', '')) != UPPER(REPLACE(rlm.mpn, '-', ''))
    ORDER BY vq.created DESC
    LIMIT 5000
  `;

  const result = await pool.query(query);
  console.log(`Found ${result.rows.length} VQ lines with different MPNs than RFQ\n`);

  // Analyze for packaging variants
  const byMfr = {};
  const substitutions = [];

  for (const row of result.rows) {
    const variant = arePackagingVariants(row.rfq_mpn, row.vq_mpn);
    if (!variant) continue;

    const mfr = row.mfr_name || 'UNKNOWN';

    substitutions.push({
      rfqMpn: row.rfq_mpn,
      vqMpn: row.vq_mpn,
      mfr,
      base: variant.base,
      rfqSuffix: variant.suffix1,
      vqSuffix: variant.suffix2,
      rfqValue: row.rfq_value,
      created: row.created,
    });

    // Aggregate by manufacturer
    if (!byMfr[mfr]) {
      byMfr[mfr] = {
        substitutions: [],
        suffixPairs: {},
        suffixCounts: {},
      };
    }

    byMfr[mfr].substitutions.push({
      rfqMpn: row.rfq_mpn,
      vqMpn: row.vq_mpn,
      base: variant.base,
    });

    // Track suffix pairs
    const pairKey = `${variant.suffix1} → ${variant.suffix2}`;
    byMfr[mfr].suffixPairs[pairKey] = (byMfr[mfr].suffixPairs[pairKey] || 0) + 1;

    // Track individual suffixes
    byMfr[mfr].suffixCounts[variant.suffix1] = (byMfr[mfr].suffixCounts[variant.suffix1] || 0) + 1;
    byMfr[mfr].suffixCounts[variant.suffix2] = (byMfr[mfr].suffixCounts[variant.suffix2] || 0) + 1;
  }

  console.log(`Found ${substitutions.length} packaging variant substitutions\n`);

  // Build summary
  const mfrSummaries = {};
  for (const [mfr, data] of Object.entries(byMfr)) {
    // Sort suffix pairs by frequency
    const sortedPairs = Object.entries(data.suffixPairs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    // Sort individual suffixes by frequency
    const sortedSuffixes = Object.entries(data.suffixCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    mfrSummaries[mfr] = {
      totalSubstitutions: data.substitutions.length,
      topSuffixPairs: sortedPairs.map(([pair, count]) => ({ pair, count })),
      topSuffixes: sortedSuffixes.map(([suffix, count]) => ({ suffix, count })),
      examples: data.substitutions.slice(0, 5).map(s => ({
        rfq: s.rfqMpn,
        vq: s.vqMpn,
        base: s.base,
      })),
    };
  }

  // Sort manufacturers by substitution count
  const sortedMfrs = Object.entries(mfrSummaries)
    .sort((a, b) => b[1].totalSubstitutions - a[1].totalSubstitutions);

  // Output
  const output = {
    generatedAt: new Date().toISOString(),
    totalSubstitutions: substitutions.length,
    manufacturerCount: Object.keys(mfrSummaries).length,
    byManufacturer: Object.fromEntries(sortedMfrs),
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ Results written to: ${OUTPUT_FILE}\n`);

  // Print summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TOP MANUFACTURERS BY SUBSTITUTION COUNT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const [mfr, data] of sortedMfrs.slice(0, 15)) {
    console.log(`${mfr}: ${data.totalSubstitutions} substitutions`);

    if (data.topSuffixPairs.length > 0) {
      console.log('  Top suffix transitions:');
      for (const { pair, count } of data.topSuffixPairs.slice(0, 5)) {
        console.log(`    ${pair.padEnd(25)} (${count}x)`);
      }
    }

    if (data.examples.length > 0) {
      console.log('  Examples:');
      for (const ex of data.examples.slice(0, 2)) {
        console.log(`    ${ex.rfq} → ${ex.vq}`);
      }
    }
    console.log('');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
