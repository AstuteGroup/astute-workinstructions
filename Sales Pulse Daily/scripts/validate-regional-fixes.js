#!/usr/bin/env node
/**
 * Validation Script: Regional Filtering Fixes
 *
 * Verifies that USA and Mexico Daily Briefs have correct regional filtering.
 * Run this before automated sends to ensure fixes are in place.
 *
 * Usage: node validate-regional-fixes.js
 * Exit code 0 = all checks passed
 * Exit code 1 = validation failed
 */

const fs = require('fs');
const path = require('path');

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let failures = 0;

function check(condition, passMsg, failMsg) {
  if (condition) {
    console.log(`${PASS} ${passMsg}`);
    return true;
  } else {
    console.log(`${FAIL} ${failMsg}`);
    failures++;
    return false;
  }
}

console.log('='.repeat(70));
console.log('REGIONAL FILTERING VALIDATION');
console.log('='.repeat(70));
console.log();

// ============================================================================
// CHECK 1: Mexico Query File - Section Headers
// ============================================================================
console.log('📋 CHECK 1: Mexico Query File Section Headers');
console.log('-'.repeat(70));

const mexicoQueriesPath = path.join(__dirname, '../queries/mexico-daily-queries.sql');
const mexicoQueries = fs.readFileSync(mexicoQueriesPath, 'utf8');

check(
  mexicoQueries.includes('1.4 CUSTOMERS REACTIVATED YESTERDAY - MEXICO ONLY'),
  'Section 1.4 header says "MEXICO ONLY"',
  'Section 1.4 header still says "USA ONLY" - FIX REQUIRED'
);

check(
  mexicoQueries.includes('2.2A TOP 10 LATE SO LINES (3-31 days past due) - MEXICO ONLY'),
  'Section 2.2A header says "MEXICO ONLY"',
  'Section 2.2A header still says "USA ONLY" - FIX REQUIRED'
);

check(
  mexicoQueries.includes('2.2B TOP 5 SCHEDULED TO SHIP THIS MONTH (by GP) - MEXICO ONLY'),
  'Section 2.2B header says "MEXICO ONLY"',
  'Section 2.2B header still says "USA ONLY" - FIX REQUIRED'
);

check(
  mexicoQueries.includes('2.3 INSIDE SALES REPS ALERT (No RFQ in 3+ days) - MEXICO ONLY'),
  'Section 2.3 header says "MEXICO ONLY"',
  'Section 2.3 header still says "USA ONLY" - FIX REQUIRED'
);

console.log();

// ============================================================================
// CHECK 2: Mexico Query File - No Duplicate CASE Conditions
// ============================================================================
console.log('📋 CHECK 2: Mexico Query File - Section 2.3 CASE Statements');
console.log('-'.repeat(70));

// Extract Section 2.3 seller_list CTE
const section23Match = mexicoQueries.match(/WITH seller_list AS \(([\s\S]+?)\),\s*recent_rfq_activity/);
if (section23Match) {
  const sellerListCTE = section23Match[1];

  // Check for duplicate Mexico ID conditions in region CASE
  const mexicoIdPattern = /1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224/g;
  const matches = sellerListCTE.match(mexicoIdPattern);

  check(
    matches && matches.length === 3,
    'Section 2.3 has exactly 3 Mexico ID references (region CASE, manager CASE, WHERE clause)',
    `Section 2.3 has ${matches ? matches.length : 0} Mexico ID references - should be 3 (may have duplicates)`
  );

  // Check that region CASE has Mexico IDs mapping to 'MEX' (not 'USA')
  const regionCaseMatch = sellerListCTE.match(/CASE[\s\S]+?END as region/);
  if (regionCaseMatch) {
    const regionCase = regionCaseMatch[0];

    // Extract the line with Mexico IDs in region CASE
    const mexIdLineMatch = regionCase.match(/WHEN ad_user_id IN \(1047106[^)]+\) THEN '([^']+)'/);

    check(
      mexIdLineMatch && mexIdLineMatch[1] === 'MEX',
      'Mexico IDs correctly map to region="MEX" in CASE statement',
      'CRITICAL: Mexico IDs do not map to MEX - check for duplicate CASE conditions'
    );
  }
} else {
  console.log(`${WARN} Could not parse Section 2.3 seller_list CTE for validation`);
}

console.log();

// ============================================================================
// CHECK 3: Mexico Script - Section 3 Search String
// ============================================================================
console.log('📋 CHECK 3: Mexico Script - Section 3 Search String');
console.log('-'.repeat(70));

const mexicoScriptPath = path.join(__dirname, 'sales-pulse-mexico-daily.js');
const mexicoScript = fs.readFileSync(mexicoScriptPath, 'utf8');

check(
  mexicoScript.includes("'3.2 ACTIVITY BY MEXICO SALES REP'"),
  'Mexico script searches for "3.2 ACTIVITY BY MEXICO SALES REP"',
  'Mexico script still searches for "3.2 ACTIVITY BY USA SALES REP" - FIX REQUIRED'
);

check(
  mexicoScript.includes('Section 3: Mexico Sales Rep Activity'),
  'Mexico script comment says "Mexico Sales Rep Activity"',
  'Mexico script comment still says "USA Sales Rep Activity" - FIX REQUIRED'
);

console.log();

// ============================================================================
// CHECK 4: Mexico Query File - Section 3.2 Header
// ============================================================================
console.log('📋 CHECK 4: Mexico Query File - Section 3.2 Header');
console.log('-'.repeat(70));

check(
  mexicoQueries.includes('3.2 ACTIVITY BY MEXICO SALES REP'),
  'Section 3.2 query header says "MEXICO SALES REP"',
  'Section 3.2 query header still says "USA SALES REP" - FIX REQUIRED'
);

console.log();

// ============================================================================
// CHECK 5: Actual Query Filters (Spot Check)
// ============================================================================
console.log('📋 CHECK 5: Query Filters - Spot Check Mexico IDs');
console.log('-'.repeat(70));

const mexicoIds = '1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224';

// Count occurrences of Mexico ID list (with or without comment)
const mexicoFilterMatches = mexicoQueries.match(/1047106, 1026393, 1042653, 1038225, 1026394, 1010361, 1012788, 1038224/g);

// Also check for "MEXICO ONLY" comments
const mexicoCommentMatches = mexicoQueries.match(/--\s*MEXICO ONLY/g);

check(
  mexicoFilterMatches && mexicoFilterMatches.length >= 6,
  `Found ${mexicoFilterMatches ? mexicoFilterMatches.length : 0} Mexico ID filter references (expected 6+ across all sections)`,
  'Missing Mexico ID filters in queries - check sections 1.1, 1.2, 1.4, 2.2A, 2.2B, 2.3, 3.2'
);

check(
  mexicoCommentMatches && mexicoCommentMatches.length >= 6,
  `Found ${mexicoCommentMatches ? mexicoCommentMatches.length : 0} "MEXICO ONLY" comments in section headers`,
  'Section headers missing "MEXICO ONLY" labels - some may still say "USA ONLY"'
);

console.log();

// ============================================================================
// SUMMARY
// ============================================================================
console.log('='.repeat(70));
if (failures === 0) {
  console.log(`${PASS} ALL CHECKS PASSED - Regional fixes are in place`);
  console.log();
  console.log('✅ Safe to run automated daily briefs');
  console.log('✅ Mexico sellers will correctly show region="MEX"');
  console.log('✅ USA sellers will correctly show region="USA"');
  console.log();
  process.exit(0);
} else {
  console.log(`${FAIL} ${failures} CHECK(S) FAILED - DO NOT RUN AUTOMATED BRIEFS`);
  console.log();
  console.log('⚠️  Regional filtering fixes are NOT in place');
  console.log('⚠️  Reports will show incorrect region labels');
  console.log();
  console.log('ACTION REQUIRED:');
  console.log('1. Review failed checks above');
  console.log('2. Apply fixes to mexico-daily-queries.sql and sales-pulse-mexico-daily.js');
  console.log('3. Commit changes to git');
  console.log('4. Re-run this validation script');
  console.log();
  process.exit(1);
}
