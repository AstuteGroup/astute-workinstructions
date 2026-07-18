#!/usr/bin/env node
/**
 * AMAT RFQ 1147485 Enrichment Analysis (NO WRITES)
 *
 * Runs franchise API enrichment and outputs analysis without writing to OT.
 * Shows coverage breakdown, source distribution, and identifies gaps.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { searchAllDistributors } = require('../shared/franchise-api');
const { Pool } = require('pg');
const fs = require('fs');

const RFQ_ID = 1147485;
const RFQ_DOC_NO = '1138070';

const pool = new Pool({
  host: '/var/run/postgresql',
  database: 'idempiere_replica',
  user: 'analytics_user'
});

async function run() {
  // Get valid-looking MPNs with RFQ line info
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (rlm.chuboe_mpn)
      rl.chuboe_rfq_line_id,
      rlm.chuboe_rfq_line_mpn_id,
      rlm.chuboe_mpn,
      rl.qty::int as qty
    FROM chuboe_rfq_line rl
    JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    WHERE rl.chuboe_rfq_id = $1
      AND rl.isactive = 'Y'
      AND rlm.isactive = 'Y'
      AND rlm.chuboe_mpn IS NOT NULL
      AND LENGTH(rlm.chuboe_mpn) >= 5
      AND rlm.chuboe_mpn ~ '^[A-Z0-9]'
      AND rlm.chuboe_mpn ~ '[0-9]'
      AND rlm.chuboe_mpn ~ '[A-Z]'
    ORDER BY rlm.chuboe_mpn, rl.chuboe_rfq_line_id
  `, [RFQ_ID]);

  console.log(`Analyzing ${rows.length} valid MPNs from RFQ ${RFQ_DOC_NO}...`);
  console.log('');

  // Coverage tracking
  const coverage = { FULL: [], PARTIAL: [], NONE: [] };

  // Source tracking
  const sourceStats = {};

  // Error tracking
  const errors = [];

  // All VQ lines for analysis
  const allVqLines = [];

  // Distributor health
  const distributorHealth = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = await searchAllDistributors(row.chuboe_mpn, row.qty || 1);
      const summary = result.summary;

      // Track coverage
      const mpnData = {
        mpn: row.chuboe_mpn,
        qty: row.qty,
        totalStock: summary.totalStock,
        distributorsWithStock: summary.distributorsWithStock,
        distributorsCarrying: summary.distributorsCarrying,
        vqLines: result.vqLines?.length || 0,
        lowestPrice: summary.lowestStockedPrice
      };
      coverage[summary.coverage || 'NONE'].push(mpnData);

      // Track sources from vqLines
      if (result.vqLines) {
        for (const vq of result.vqLines) {
          const source = vq.channel || vq.vendorName || 'Unknown';
          if (!sourceStats[source]) {
            sourceStats[source] = { count: 0, totalQty: 0, mpns: [] };
          }
          sourceStats[source].count++;
          sourceStats[source].totalQty += vq.qty || 0;
          sourceStats[source].mpns.push(row.chuboe_mpn);

          allVqLines.push({
            mpn: row.chuboe_mpn,
            source,
            qty: vq.qty,
            cost: vq.cost,
            moq: vq.moq,
            dateCode: vq.dateCode
          });
        }
      }

      // Track distributor health
      if (summary.distributorHealth) {
        for (const [name, stats] of Object.entries(summary.distributorHealth)) {
          if (!distributorHealth[name]) {
            distributorHealth[name] = { found: 0, empties: 0, errors: 0, timeouts: 0 };
          }
          distributorHealth[name].found += stats.found || 0;
          distributorHealth[name].empties += stats.empties || 0;
          distributorHealth[name].errors += stats.errors || 0;
          distributorHealth[name].timeouts += stats.timeouts || 0;
        }
      }

      if ((i + 1) % 50 === 0) {
        console.log(`Progress: ${i + 1}/${rows.length}`);
      }
    } catch (err) {
      errors.push({ mpn: row.chuboe_mpn, error: err.message });
    }
  }

  await pool.end();

  // Output analysis
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    ENRICHMENT ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  console.log('COVERAGE SUMMARY');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`FULL coverage:    ${coverage.FULL.length} MPNs (${(coverage.FULL.length / rows.length * 100).toFixed(1)}%)`);
  console.log(`PARTIAL coverage: ${coverage.PARTIAL.length} MPNs (${(coverage.PARTIAL.length / rows.length * 100).toFixed(1)}%)`);
  console.log(`NO coverage:      ${coverage.NONE.length} MPNs (${(coverage.NONE.length / rows.length * 100).toFixed(1)}%)`);
  console.log(`Errors:           ${errors.length} MPNs`);
  console.log('');

  console.log('SOURCE DISTRIBUTION');
  console.log('─────────────────────────────────────────────────────────────────');
  const sortedSources = Object.entries(sourceStats).sort((a, b) => b[1].count - a[1].count);
  for (const [source, stats] of sortedSources) {
    console.log(`${source.padEnd(20)} ${String(stats.count).padStart(4)} lines | ${stats.totalQty.toLocaleString().padStart(12)} pcs | ${stats.mpns.length} MPNs`);
  }
  console.log('');

  console.log('DISTRIBUTOR HEALTH');
  console.log('─────────────────────────────────────────────────────────────────');
  for (const [name, stats] of Object.entries(distributorHealth).sort((a,b) => b[1].found - a[1].found)) {
    const total = stats.found + stats.empties + stats.errors + stats.timeouts;
    const hitRate = total > 0 ? (stats.found / total * 100).toFixed(0) : 0;
    console.log(`${name.padEnd(15)} found: ${String(stats.found).padStart(4)} | empty: ${String(stats.empties).padStart(4)} | errors: ${String(stats.errors).padStart(2)} | hit: ${hitRate}%`);
  }
  console.log('');

  console.log('TOP 20 PARTS WITH COVERAGE (by stock)');
  console.log('─────────────────────────────────────────────────────────────────');
  const topParts = [...coverage.FULL, ...coverage.PARTIAL]
    .sort((a, b) => b.totalStock - a.totalStock)
    .slice(0, 20);
  for (const p of topParts) {
    console.log(`${p.mpn.padEnd(25)} ${p.totalStock.toLocaleString().padStart(12)} pcs | ${p.vqLines} sources | $${(p.lowestPrice || 0).toFixed(4)}`);
  }
  console.log('');

  console.log('SAMPLE OF PARTS WITHOUT COVERAGE (first 20)');
  console.log('─────────────────────────────────────────────────────────────────');
  for (const p of coverage.NONE.slice(0, 20)) {
    console.log(`${p.mpn}`);
  }

  // Write detailed CSV for further analysis
  const csvPath = '/tmp/amat-rfq-enrichment-analysis.csv';
  const csvLines = ['MPN,Qty,Coverage,TotalStock,VQLines,LowestPrice'];
  for (const cat of ['FULL', 'PARTIAL', 'NONE']) {
    for (const p of coverage[cat]) {
      csvLines.push(`${p.mpn},${p.qty},${cat},${p.totalStock || 0},${p.vqLines},${p.lowestPrice || ''}`);
    }
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log('');
  console.log(`Detailed CSV written to: ${csvPath}`);

  // Write VQ lines CSV
  const vqCsvPath = '/tmp/amat-rfq-vqlines.csv';
  const vqCsvLines = ['MPN,Source,Qty,Cost,MOQ,DateCode'];
  for (const vq of allVqLines) {
    vqCsvLines.push(`${vq.mpn},${vq.source},${vq.qty || ''},${vq.cost || ''},${vq.moq || ''},${vq.dateCode || ''}`);
  }
  fs.writeFileSync(vqCsvPath, vqCsvLines.join('\n'));
  console.log(`VQ lines CSV written to: ${vqCsvPath}`);
}

run().catch(e => { console.error(e); process.exit(1); });
