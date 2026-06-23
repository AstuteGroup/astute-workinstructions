#!/usr/bin/env node
/**
 * Market Pulse Performance Testing
 *
 * Tests 3 representative queries to establish performance baseline:
 * 1. Trending Manufacturers (simplest - basic aggregation)
 * 2. Multi-Customer Parts (medium - constraint indicator)
 * 3. Regional Demand Divergence (most complex - geographic joins)
 *
 * Run: node test-market-pulse-performance.js
 */

const { execSync } = require('child_process');

/**
 * Execute PostgreSQL query with timing
 */
function execQueryWithTiming(sql, label) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing: ${label}`);
  console.log(`${'='.repeat(70)}`);

  const startTime = Date.now();

  try {
    // Add EXPLAIN ANALYZE to see query plan
    const explainSql = `EXPLAIN ANALYZE ${sql}`;

    console.log('Running query...');
    const output = execSync(
      `psql idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    const lines = output.trim().split('\n');
    const rowCount = lines.length;

    console.log(`✅ Query completed successfully`);
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log(`📊 Rows returned: ${rowCount}`);

    // Show first 3 rows as sample
    if (rowCount > 0) {
      console.log(`\nSample results (first 3 rows):`);
      lines.slice(0, 3).forEach((line, i) => {
        console.log(`  ${i + 1}. ${line}`);
      });
      if (rowCount > 3) {
        console.log(`  ... (${rowCount - 3} more rows)`);
      }
    }

    return {
      success: true,
      duration,
      rowCount,
      output: output.trim()
    };

  } catch (error) {
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.error(`❌ Query failed`);
    console.error(`⏱️  Duration before failure: ${duration} seconds`);
    console.error(`Error: ${error.message}`);

    return {
      success: false,
      duration,
      error: error.message
    };
  }
}

/**
 * Parse multi-row query results
 */
function parseRows(output, columnNames) {
  if (!output) return [];
  return output.split('\n').map(line => {
    const values = line.split('|');
    const result = {};
    columnNames.forEach((name, i) => {
      result[name] = values[i] || null;
    });
    return result;
  });
}

/**
 * Format currency
 */
function formatCurrency(amount) {
  if (!amount || amount === '0' || amount === 0) return '$0';
  const num = parseFloat(amount);
  if (num >= 1000000) return '$' + (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return '$' + (num / 1000).toFixed(0) + 'K';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ============================================================================
// TEST 1: Trending Manufacturers (Simplest)
// ============================================================================

const trendingManufacturersQuery = `
WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
),
prior_window AS (
  SELECT CURRENT_DATE - INTERVAL '60 days' as start_date,
         CURRENT_DATE - INTERVAL '30 days' as end_date
),
current_period AS (
  SELECT
    m.name as manufacturer,
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfq.c_bpartner_id) as customers,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
    COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
    COUNT(DISTINCT CASE WHEN cq.issold = 'Y' THEN cq.chuboe_cq_line_id END) as sold_count,
    SUM(CASE WHEN cq.issold = 'Y' THEN cq.priceentered * cq.qty ELSE 0 END) as booked_sales
  FROM adempiere.chuboe_mfr m
  CROSS JOIN current_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
  LEFT JOIN adempiere.chuboe_cq_line cq ON rfqm.chuboe_rfq_line_id = cq.chuboe_rfq_line_id AND cq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
  GROUP BY m.name, m.chuboe_mfr_id
),
prior_period AS (
  SELECT
    m.chuboe_mfr_id,
    COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count
  FROM adempiere.chuboe_mfr m
  CROSS JOIN prior_window
  JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
  JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
  WHERE rfq.created::date BETWEEN prior_window.start_date AND prior_window.end_date
  GROUP BY m.chuboe_mfr_id
)
SELECT
  cp.manufacturer,
  cp.customers,
  cp.rfq_count,
  cp.quoted_count,
  cp.sold_count,
  CASE
    WHEN cp.quoted_count > 0 THEN ROUND((cp.sold_count::numeric / cp.quoted_count::numeric) * 100, 1)
    ELSE 0
  END as win_pct,
  COALESCE(cp.booked_sales, 0) as booked_sales_30d,
  CASE
    WHEN COALESCE(pp.rfq_count, 0) > 0
    THEN ROUND(((cp.rfq_count::numeric - pp.rfq_count::numeric) / pp.rfq_count::numeric) * 100, 1)
    WHEN cp.rfq_count > 0 THEN 100.0
    ELSE 0
  END as wow_velocity_pct
FROM current_period cp
LEFT JOIN prior_period pp ON cp.chuboe_mfr_id = pp.chuboe_mfr_id
ORDER BY cp.sold_count DESC, cp.rfq_count DESC
LIMIT 10;
`;

// ============================================================================
// TEST 2: Multi-Customer Parts (Medium Complexity)
// ============================================================================

const multiCustomerPartsQuery = `
WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
)
SELECT
  rfqm.chuboe_mpn as mpn,
  m.name as manufacturer,
  COUNT(DISTINCT rfq.c_bpartner_id) as customer_count,
  COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as rfq_count,
  COUNT(DISTINCT vq.chuboe_vq_line_id) as quoted_count,
  CASE
    WHEN COUNT(DISTINCT vq.chuboe_vq_line_id) > 0
    THEN ROUND((COUNT(DISTINCT vq.chuboe_vq_line_id)::numeric /
                COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id)::numeric) * 100, 1)
    ELSE 0
  END as quote_rate_pct
FROM adempiere.chuboe_rfq_line_mpn rfqm
CROSS JOIN current_window
JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
JOIN adempiere.chuboe_mfr m ON rfqm.chuboe_mfr_id = m.chuboe_mfr_id
LEFT JOIN adempiere.chuboe_vq_line vq ON rfqm.chuboe_rfq_line_id = vq.chuboe_rfq_line_id AND vq.isactive = 'Y'
WHERE rfqm.isactive = 'Y'
  AND rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
GROUP BY rfqm.chuboe_mpn, m.name
HAVING COUNT(DISTINCT rfq.c_bpartner_id) >= 5
ORDER BY COUNT(DISTINCT rfq.c_bpartner_id) DESC
LIMIT 10;
`;

// ============================================================================
// TEST 3: Regional Demand Divergence (Most Complex - Geographic Joins)
// ============================================================================

const regionalDemandQuery = `
WITH current_window AS (
  SELECT CURRENT_DATE - INTERVAL '30 days' as start_date,
         CURRENT_DATE as end_date
)
SELECT
  m.name as manufacturer,
  COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) as total_rfqs,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as apac_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'US' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as usa_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode = 'MX' THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as mex_pct,
  ROUND((COUNT(DISTINCT CASE WHEN c.countrycode NOT IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN', 'US', 'MX') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) * 100, 1) as other_pct,
  CASE
    WHEN (COUNT(DISTINCT CASE WHEN c.countrycode IN ('CN', 'TW', 'HK', 'SG', 'JP', 'KR', 'MY', 'TH', 'PH', 'VN', 'ID', 'IN') THEN rfqm.chuboe_rfq_line_mpn_id END)::numeric / NULLIF(COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id), 0)) > 0.70
    THEN 'APAC_CONCENTRATION'
    ELSE ''
  END as signal
FROM adempiere.chuboe_mfr m
CROSS JOIN current_window
JOIN adempiere.chuboe_rfq_line_mpn rfqm ON m.chuboe_mfr_id = rfqm.chuboe_mfr_id AND rfqm.isactive = 'Y'
JOIN adempiere.chuboe_rfq rfq ON rfqm.chuboe_rfq_id = rfq.chuboe_rfq_id AND rfq.isactive = 'Y'
JOIN adempiere.c_bpartner bp ON rfq.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
LEFT JOIN adempiere.c_bpartner_location bpl ON bp.c_bpartner_id = bpl.c_bpartner_id AND bpl.isactive = 'Y'
LEFT JOIN adempiere.c_location loc ON bpl.c_location_id = loc.c_location_id
LEFT JOIN adempiere.c_country c ON loc.c_country_id = c.c_country_id
WHERE rfq.created::date BETWEEN current_window.start_date AND current_window.end_date
GROUP BY m.name
HAVING COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) >= 10
ORDER BY COUNT(DISTINCT rfqm.chuboe_rfq_line_mpn_id) DESC
LIMIT 15;
`;

// ============================================================================
// RUN TESTS
// ============================================================================

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║        Market Pulse Performance Testing - 3 Baseline Queries       ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log('\nTesting 3 queries with different complexity levels:');
  console.log('  1. Trending Manufacturers (simplest - basic aggregation)');
  console.log('  2. Multi-Customer Parts (medium - constraint indicator)');
  console.log('  3. Regional Demand Divergence (complex - geographic joins)');
  console.log('\nThis will help us understand performance characteristics before');
  console.log('implementing all 8 sections.\n');

  const results = [];

  // Test 1: Trending Manufacturers
  const test1 = execQueryWithTiming(
    trendingManufacturersQuery,
    'TEST 1: Trending Manufacturers (Simplest)'
  );
  results.push({ name: 'Trending Manufacturers', ...test1 });

  // Test 2: Multi-Customer Parts
  const test2 = execQueryWithTiming(
    multiCustomerPartsQuery,
    'TEST 2: Multi-Customer Parts (Medium)'
  );
  results.push({ name: 'Multi-Customer Parts', ...test2 });

  // Test 3: Regional Demand Divergence
  const test3 = execQueryWithTiming(
    regionalDemandQuery,
    'TEST 3: Regional Demand Divergence (Most Complex)'
  );
  results.push({ name: 'Regional Demand', ...test3 });

  // ============================================================================
  // SUMMARY REPORT
  // ============================================================================

  console.log('\n\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                         PERFORMANCE SUMMARY                         ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log('Query Performance:');
  console.log('─'.repeat(70));
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    const timing = r.success ? `${r.duration}s` : `FAILED after ${r.duration}s`;
    const rows = r.success ? `${r.rowCount} rows` : 'N/A';
    console.log(`${i + 1}. ${status} ${r.name.padEnd(30)} ${timing.padStart(10)}  ${rows}`);
  });
  console.log('─'.repeat(70));

  if (successful.length > 0) {
    const totalTime = successful.reduce((sum, r) => sum + parseFloat(r.duration), 0).toFixed(2);
    const avgTime = (totalTime / successful.length).toFixed(2);
    const maxTime = Math.max(...successful.map(r => parseFloat(r.duration))).toFixed(2);

    console.log(`\nSuccessful: ${successful.length}/${results.length}`);
    console.log(`Total time: ${totalTime}s`);
    console.log(`Average time: ${avgTime}s per query`);
    console.log(`Slowest query: ${maxTime}s`);
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach(r => {
      console.log(`   - ${r.name}: ${r.error}`);
    });
  }

  // ============================================================================
  // RECOMMENDATIONS
  // ============================================================================

  console.log('\n\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                          RECOMMENDATIONS                            ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  if (failed.length > 0) {
    console.log('⚠️  QUERIES FAILED - Need optimization before proceeding');
    console.log('   Recommendation: Fix failed queries before implementing full report\n');
  } else {
    const totalTime = successful.reduce((sum, r) => sum + parseFloat(r.duration), 0);
    const estimatedFullTime = (totalTime / 3) * 8; // Estimate for all 8 sections

    console.log(`Based on these 3 queries:`);
    console.log(`  - Projected time for all 8 sections: ~${estimatedFullTime.toFixed(1)}s\n`);

    if (estimatedFullTime < 120) {
      console.log('✅ PROCEED WITH FULL IMPLEMENTATION');
      console.log('   All queries fast enough for on-demand manual report');
      console.log('   Expected total runtime: <2 minutes (acceptable for manual use)\n');
    } else if (estimatedFullTime < 300) {
      console.log('🟡 PROCEED WITH CAUTION');
      console.log('   Queries may take 2-5 minutes total');
      console.log('   Acceptable for manual on-demand use');
      console.log('   Consider optimizations if planning automation\n');
    } else {
      console.log('🔴 OPTIMIZATION NEEDED');
      console.log('   Projected runtime >5 minutes');
      console.log('   Recommend pre-computation strategy for automation');
      console.log('   Manual on-demand may still be acceptable if user is patient\n');
    }
  }

  console.log('Next steps:');
  if (failed.length === 0 && estimatedFullTime < 300) {
    console.log('  1. Implement remaining 5 sections with real SQL queries');
    console.log('  2. Build full HTML report with all data');
    console.log('  3. Test complete end-to-end report generation');
    console.log('  4. Add email delivery option (--email flag)\n');
  } else {
    console.log('  1. Optimize slow/failed queries');
    console.log('  2. Consider adding indexes to frequently-joined columns');
    console.log('  3. Re-test performance after optimizations');
    console.log('  4. Evaluate pre-computation strategy if still slow\n');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
