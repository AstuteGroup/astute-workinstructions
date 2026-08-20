#!/usr/bin/env node
/**
 * Identify Packaging Variant Coverage Gaps
 *
 * Analyzes historical enrichment data to find:
 * 1. MPNs where franchise APIs returned no results
 * 2. Which manufacturers those belong to
 * 3. Priority ranking for suffix rule research
 *
 * This tells us which manufacturers we should focus on for scraping
 * ordering guides or building suffix rules - data-driven prioritization.
 *
 * Data sources:
 * - Negative cache (api-negative-cache.js records)
 * - RFQ line data (what we've tried to source)
 * - VQ data (what actually got results)
 *
 * Usage:
 *   node scripts/identify-variant-coverage-gaps.js
 *
 * Output:
 *   shared/data/variant-coverage-gaps.json
 */

'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.resolve(__dirname, '../shared/data/variant-coverage-gaps.json');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       PACKAGING VARIANT COVERAGE GAP ANALYSIS                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // ─── QUERY 1: RFQ Lines without VQ coverage ───────────────────────────────
  // These are parts we tried to source but couldn't find franchise coverage for
  console.log('Querying RFQ lines without VQ coverage...\n');

  const noVqQuery = `
    WITH rfq_mpns AS (
      -- All RFQ line MPNs from last 6 months
      SELECT DISTINCT
        rlm.chuboe_mpn,
        m.name AS mfr_name,
        r.chuboe_rfq_id,
        r.value AS rfq_value,
        r.created AS rfq_created
      FROM chuboe_rfq_line_mpn rlm
      JOIN chuboe_rfq_line rl ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      LEFT JOIN chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
      WHERE rlm.isactive = 'Y'
        AND rlm.chuboe_mpn IS NOT NULL
        AND rlm.chuboe_mpn != ''
        AND r.created > NOW() - INTERVAL '6 months'
    ),
    vq_mpns AS (
      -- MPNs that got VQ coverage (franchise hit)
      SELECT DISTINCT UPPER(REPLACE(chuboe_mpn, '-', '')) AS mpn_norm
      FROM chuboe_vq_line
      WHERE isactive = 'Y'
        AND chuboe_mpn IS NOT NULL
        AND created > NOW() - INTERVAL '6 months'
    )
    SELECT
      rm.mfr_name,
      COUNT(DISTINCT rm.chuboe_mpn) AS mpns_without_vq,
      COUNT(DISTINCT rm.chuboe_rfq_id) AS rfqs_affected,
      ARRAY_AGG(DISTINCT rm.chuboe_mpn ORDER BY rm.chuboe_mpn) FILTER (WHERE rm.chuboe_mpn IS NOT NULL) AS sample_mpns
    FROM rfq_mpns rm
    LEFT JOIN vq_mpns vm ON UPPER(REPLACE(rm.chuboe_mpn, '-', '')) = vm.mpn_norm
    WHERE vm.mpn_norm IS NULL  -- No VQ coverage
    GROUP BY rm.mfr_name
    HAVING COUNT(DISTINCT rm.chuboe_mpn) >= 3  -- At least 3 uncovered MPNs
    ORDER BY COUNT(DISTINCT rm.chuboe_mpn) DESC
    LIMIT 50
  `;

  const noVqResult = await pool.query(noVqQuery);
  console.log(`Found ${noVqResult.rows.length} manufacturers with uncovered MPNs\n`);

  // ─── QUERY 2: Compare RFQ line MFRs to our suffix rules ───────────────────
  // Which manufacturers appear in our RFQs but aren't in our suffix rules?
  console.log('Checking manufacturers against existing suffix rules...\n');

  const { loadSuffixRules, findMfrRules } = require('../shared/packaging-variants');
  const rules = loadSuffixRules();

  const mfrCoverageQuery = `
    SELECT
      m.name AS mfr_name,
      COUNT(DISTINCT rlm.chuboe_mpn) AS total_mpns,
      COUNT(DISTINCT r.chuboe_rfq_id) AS total_rfqs
    FROM chuboe_rfq_line_mpn rlm
    JOIN chuboe_rfq_line rl ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    JOIN chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
    JOIN chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
    WHERE rlm.isactive = 'Y'
      AND r.created > NOW() - INTERVAL '6 months'
    GROUP BY m.name
    HAVING COUNT(DISTINCT rlm.chuboe_mpn) >= 10
    ORDER BY COUNT(DISTINCT rlm.chuboe_mpn) DESC
    LIMIT 100
  `;

  const mfrResult = await pool.query(mfrCoverageQuery);

  const mfrsWithRules = [];
  const mfrsWithoutRules = [];

  for (const row of mfrResult.rows) {
    const hasRules = findMfrRules(row.mfr_name, rules) !== null;
    const entry = {
      mfr: row.mfr_name,
      totalMpns: parseInt(row.total_mpns),
      totalRfqs: parseInt(row.total_rfqs),
    };

    if (hasRules) {
      mfrsWithRules.push(entry);
    } else {
      mfrsWithoutRules.push(entry);
    }
  }

  console.log(`Manufacturers WITH suffix rules: ${mfrsWithRules.length}`);
  console.log(`Manufacturers WITHOUT suffix rules: ${mfrsWithoutRules.length}\n`);

  // ─── QUERY 3: Identify potential suffix patterns in uncovered MPNs ────────
  // Look for common endings that might be packaging suffixes
  console.log('Analyzing potential suffix patterns in uncovered MPNs...\n');

  const suffixPatternQuery = `
    WITH uncovered_mpns AS (
      SELECT DISTINCT
        rlm.chuboe_mpn,
        m.name AS mfr_name
      FROM chuboe_rfq_line_mpn rlm
      JOIN chuboe_rfq_line rl ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      JOIN chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      LEFT JOIN chuboe_mfr m ON rlm.chuboe_mfr_id = m.chuboe_mfr_id
      LEFT JOIN chuboe_vq_line vq ON rl.chuboe_rfq_line_id = vq.chuboe_rfq_line_id
        AND vq.isactive = 'Y'
      WHERE rlm.isactive = 'Y'
        AND r.created > NOW() - INTERVAL '6 months'
        AND vq.chuboe_vq_line_id IS NULL  -- No VQ
        AND LENGTH(rlm.chuboe_mpn) > 5
    )
    SELECT
      mfr_name,
      -- Extract last 1-4 characters as potential suffix
      UPPER(RIGHT(chuboe_mpn, 1)) AS suffix_1,
      UPPER(RIGHT(chuboe_mpn, 2)) AS suffix_2,
      COUNT(*) AS occurrences
    FROM uncovered_mpns
    WHERE mfr_name IS NOT NULL
    GROUP BY mfr_name, UPPER(RIGHT(chuboe_mpn, 1)), UPPER(RIGHT(chuboe_mpn, 2))
    HAVING COUNT(*) >= 5
    ORDER BY mfr_name, COUNT(*) DESC
  `;

  const suffixResult = await pool.query(suffixPatternQuery);

  // Group by manufacturer
  const suffixByMfr = {};
  for (const row of suffixResult.rows) {
    const mfr = row.mfr_name;
    if (!suffixByMfr[mfr]) suffixByMfr[mfr] = [];
    suffixByMfr[mfr].push({
      suffix1: row.suffix_1,
      suffix2: row.suffix_2,
      count: parseInt(row.occurrences),
    });
  }

  // ─── BUILD OUTPUT ─────────────────────────────────────────────────────────

  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      mfrsWithSuffixRules: mfrsWithRules.length,
      mfrsWithoutSuffixRules: mfrsWithoutRules.length,
      mfrsWithUncoveredMpns: noVqResult.rows.length,
    },

    // Priority 1: High-volume manufacturers without suffix rules
    priorityMfrsForRules: mfrsWithoutRules
      .sort((a, b) => b.totalMpns - a.totalMpns)
      .slice(0, 20)
      .map(m => ({
        ...m,
        potentialSuffixes: suffixByMfr[m.mfr]?.slice(0, 10) || [],
      })),

    // Priority 2: Manufacturers with most uncovered MPNs
    mfrsWithUncoveredMpns: noVqResult.rows.map(row => ({
      mfr: row.mfr_name || 'UNKNOWN',
      uncoveredMpnCount: parseInt(row.mpns_without_vq),
      rfqsAffected: parseInt(row.rfqs_affected),
      sampleMpns: (row.sample_mpns || []).slice(0, 10),
      hasSuffixRules: findMfrRules(row.mfr_name, rules) !== null,
    })),

    // Manufacturers that already have rules (for reference)
    coveredMfrs: mfrsWithRules.slice(0, 20),

    // Potential suffix patterns discovered
    discoveredSuffixPatterns: Object.entries(suffixByMfr)
      .filter(([mfr]) => !findMfrRules(mfr, rules))  // Only MFRs without rules
      .slice(0, 20)
      .map(([mfr, suffixes]) => ({
        mfr,
        topSuffixes: suffixes.slice(0, 5),
      })),
  };

  // ─── WRITE OUTPUT ─────────────────────────────────────────────────────────

  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ Results written to: ${OUTPUT_FILE}\n`);

  // ─── PRINT SUMMARY ────────────────────────────────────────────────────────

  console.log('═'.repeat(60));
  console.log('PRIORITY MANUFACTURERS FOR SUFFIX RULES');
  console.log('═'.repeat(60));
  console.log('(High-volume manufacturers without existing rules)\n');

  for (const mfr of output.priorityMfrsForRules.slice(0, 15)) {
    console.log(`${mfr.mfr}`);
    console.log(`  MPNs: ${mfr.totalMpns}  |  RFQs: ${mfr.totalRfqs}`);
    if (mfr.potentialSuffixes.length > 0) {
      const suffixStr = mfr.potentialSuffixes
        .slice(0, 5)
        .map(s => `${s.suffix2}(${s.count})`)
        .join(', ');
      console.log(`  Common endings: ${suffixStr}`);
    }
    console.log('');
  }

  console.log('═'.repeat(60));
  console.log('MANUFACTURERS WITH MOST UNCOVERED MPNS');
  console.log('═'.repeat(60));
  console.log('(Parts we searched but got no franchise hits)\n');

  for (const mfr of output.mfrsWithUncoveredMpns.slice(0, 10)) {
    const ruleStatus = mfr.hasSuffixRules ? '✓ has rules' : '✗ NO RULES';
    console.log(`${mfr.mfr} [${ruleStatus}]`);
    console.log(`  Uncovered: ${mfr.uncoveredMpnCount} MPNs across ${mfr.rfqsAffected} RFQs`);
    if (mfr.sampleMpns.length > 0) {
      console.log(`  Samples: ${mfr.sampleMpns.slice(0, 3).join(', ')}`);
    }
    console.log('');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
