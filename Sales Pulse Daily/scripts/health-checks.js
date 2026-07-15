#!/usr/bin/env node
/**
 * Health Checks for Daily Sales Reports
 *
 * Validates system health before sending reports:
 * 1. Database connectivity
 * 2. Sample data query (verify DB returns data)
 * 3. Data sanity checks (detect suspiciously empty results)
 *
 * Returns: { healthy: boolean, errors: string[] }
 */

const { execSync } = require('child_process');

/**
 * Check database connectivity
 */
function checkDatabaseConnection() {
  try {
    const result = execSync('psql -c "SELECT 1 as test;"', {
      encoding: 'utf8',
      timeout: 5000
    });
    return result.includes('1 row') ? null : 'Database query returned unexpected result';
  } catch (error) {
    return `Database connection failed: ${error.message}`;
  }
}

/**
 * Check that we can read actual order data from yesterday
 */
function checkSampleDataQuery() {
  try {
    const query = `
      SELECT COUNT(*) as order_count
      FROM adempiere.c_order
      WHERE created::date >= CURRENT_DATE - INTERVAL '7 days'
        AND isactive = 'Y'
        AND issotrx = 'Y';
    `;

    const result = execSync(`psql -t -A -c "${query}"`, {
      encoding: 'utf8',
      timeout: 10000
    });

    const count = parseInt(result.trim());
    if (isNaN(count)) {
      return 'Sample query returned non-numeric result';
    }

    // Sanity check: should have SOME orders in the last 7 days
    if (count === 0) {
      return 'WARNING: No orders found in last 7 days (database may be stale or disconnected)';
    }

    return null; // healthy
  } catch (error) {
    return `Sample data query failed: ${error.message}`;
  }
}

/**
 * Validate report data for sanity
 * Checks if the data looks suspiciously empty/wrong
 */
function validateReportData(reportData, reportName) {
  const errors = [];

  // Check if report data exists
  if (!reportData) {
    errors.push(`${reportName}: Report data is null/undefined`);
    return errors;
  }

  // Check Section 1: If ALL subsections are 0, something is likely wrong
  const section1Empty = (
    reportData.top5Orders && reportData.top5Orders.length === 0 &&
    reportData.newCustomers && reportData.newCustomers.length === 0 &&
    reportData.strategicAccounts && reportData.strategicAccounts.length === 0 &&
    reportData.reactivatedCustomers && reportData.reactivatedCustomers.length === 0
  );

  // Check Section 3: Activity metrics
  const section3Empty = (
    reportData.repTotals &&
    reportData.repTotals.rfq_lines === 0 &&
    reportData.repTotals.cq_lines === 0 &&
    reportData.repTotals.so_lines === 0
  );

  // If BOTH Section 1 and Section 3 are completely empty, flag it
  // (It's OK if one section is empty, but not both)
  if (section1Empty && section3Empty) {
    errors.push(`${reportName}: Suspiciously empty data - both Section 1 and Section 3 have zero activity. This may indicate a database connection issue or query error.`);
  }

  return errors;
}

/**
 * Run all health checks
 * Returns: { healthy: boolean, errors: string[] }
 */
function runHealthChecks() {
  const errors = [];

  console.log('🔍 Running health checks...\n');

  // Check 1: Database connection
  console.log('1️⃣  Checking database connection...');
  const dbError = checkDatabaseConnection();
  if (dbError) {
    errors.push(dbError);
    console.log(`   ❌ FAILED: ${dbError}`);
  } else {
    console.log('   ✅ Database connection OK');
  }

  // Check 2: Sample data query
  console.log('2️⃣  Checking sample data query...');
  const dataError = checkSampleDataQuery();
  if (dataError) {
    errors.push(dataError);
    console.log(`   ❌ FAILED: ${dataError}`);
  } else {
    console.log('   ✅ Sample data query OK');
  }

  console.log('');

  return {
    healthy: errors.length === 0,
    errors
  };
}

module.exports = {
  runHealthChecks,
  validateReportData
};

// Allow running as standalone script
if (require.main === module) {
  const result = runHealthChecks();
  console.log('============================================================');
  if (result.healthy) {
    console.log('✅ ALL HEALTH CHECKS PASSED');
    console.log('System is healthy and ready to generate reports.');
    process.exit(0);
  } else {
    console.log('❌ HEALTH CHECKS FAILED');
    console.log('\nErrors:');
    result.errors.forEach((err, i) => {
      console.log(`  ${i + 1}. ${err}`);
    });
    console.log('\n⚠️  DO NOT send reports until issues are resolved.');
    process.exit(1);
  }
  console.log('============================================================');
}
