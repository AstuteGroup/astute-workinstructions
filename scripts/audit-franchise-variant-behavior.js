#!/usr/bin/env node
/**
 * Franchise API Variant Behavior Audit
 *
 * Tests each franchise API to determine whether they return packaging variants
 * in a single search (Type A) or only exact matches (Type B).
 *
 * Type A ("Discovery APIs"): Return related MPNs - one call gets all variants
 * Type B ("Exact Match APIs"): Only return searched MPN - need multiple calls
 *
 * Run quarterly or when adding new franchise APIs to detect behavior changes.
 *
 * Usage:
 *   node scripts/audit-franchise-variant-behavior.js [--franchise digikey]
 *
 * Output:
 *   shared/data/franchise-variant-audit.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Load env
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const OUTPUT_FILE = path.resolve(__dirname, '../shared/data/franchise-variant-audit.json');

// ─── TEST CASES ─────────────────────────────────────────────────────────────
// Known MPNs with packaging variants. We search a BASE or one variant,
// then check if other variants are returned.

const TEST_CASES = [
  {
    name: 'TI_REEL_SIZE',
    description: 'Texas Instruments R/T reel size variants',
    manufacturer: 'Texas Instruments',
    // Search for one variant, expect to see others
    searchMpn: 'SN74LVC1G04DBVR',
    expectedVariants: ['SN74LVC1G04DBVR', 'SN74LVC1G04DBVT'],
    // Also test searching the base (without suffix)
    baseMpn: 'SN74LVC1G04DBV',
  },
  {
    name: 'ADI_REEL',
    description: 'Analog Devices REEL/RZ variants',
    manufacturer: 'Analog Devices',
    searchMpn: 'AD8605ARTZ-REEL7',
    expectedVariants: ['AD8605ARTZ-REEL7', 'AD8605ARTZ-REEL', 'AD8605ARTZ-R2'],
    baseMpn: 'AD8605ARTZ',
  },
  {
    name: 'MICROCHIP_TAPE',
    description: 'Microchip T/CT tape variants',
    manufacturer: 'Microchip',
    searchMpn: 'ATMEGA328P-AU',
    expectedVariants: ['ATMEGA328P-AU', 'ATMEGA328P-AUR'],
    baseMpn: 'ATMEGA328P',
  },
  {
    name: 'INFINEON_PBF',
    description: 'Infineon/IR PBF/TRPBF lead-free variants',
    manufacturer: 'Infineon',
    searchMpn: 'IRFZ44NPBF',
    expectedVariants: ['IRFZ44NPBF', 'IRFZ44NTRPBF'],
    baseMpn: 'IRFZ44N',
  },
];

// ─── FRANCHISE TESTERS ──────────────────────────────────────────────────────

const franchiseTesters = {
  /**
   * DigiKey - uses keyword search, expected to return variants
   */
  async digikey(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/digikey');

    // We need to access the raw response, not the filtered one
    // For now, use the existing searchPart and check allMatches/allSkus
    const result = await searchPart(searchMpn, 100);

    const returnedMpns = [];

    // Collect MPNs from allMatches (legacy summary)
    if (result.allMatches) {
      for (const m of result.allMatches) {
        if (m.mpn) returnedMpns.push(m.mpn.toUpperCase());
      }
    }

    // Collect MPNs from allSkus (full extraction)
    if (result.allSkus) {
      for (const sku of result.allSkus) {
        if (sku.mpn) returnedMpns.push(sku.mpn.toUpperCase());
      }
    }

    // Also include the primary match
    if (result.vqMpn) returnedMpns.push(result.vqMpn.toUpperCase());

    return {
      searchMpn,
      found: result.found,
      returnedMpns: [...new Set(returnedMpns)],
      rawMatchCount: result.allMatches?.length || 0,
      skuCount: result.allSkus?.length || 0,
    };
  },

  /**
   * Mouser - test both exact and non-exact modes
   */
  async mouser(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/mouser');

    const results = {
      exactMode: null,
      broadMode: null,
    };

    // Test exact mode (default)
    try {
      const exactResult = await searchPart(searchMpn, 100, { exact: true });
      const exactMpns = [];
      if (exactResult.allMatches) {
        for (const m of exactResult.allMatches) {
          if (m.ManufacturerPartNumber) exactMpns.push(m.ManufacturerPartNumber.toUpperCase());
        }
      }
      if (exactResult.vqMpn) exactMpns.push(exactResult.vqMpn.toUpperCase());

      results.exactMode = {
        found: exactResult.found,
        returnedMpns: [...new Set(exactMpns)],
        matchCount: exactResult.matchCount || 0,
      };
    } catch (err) {
      results.exactMode = { error: err.message };
    }

    // Test broad mode (exact: false)
    try {
      const broadResult = await searchPart(searchMpn, 100, { exact: false });
      const broadMpns = [];
      if (broadResult.allMatches) {
        for (const m of broadResult.allMatches) {
          if (m.ManufacturerPartNumber) broadMpns.push(m.ManufacturerPartNumber.toUpperCase());
        }
      }
      if (broadResult.vqMpn) broadMpns.push(broadResult.vqMpn.toUpperCase());

      results.broadMode = {
        found: broadResult.found,
        returnedMpns: [...new Set(broadMpns)],
        matchCount: broadResult.matchCount || 0,
      };
    } catch (err) {
      results.broadMode = { error: err.message };
    }

    return {
      searchMpn,
      ...results,
    };
  },

  /**
   * Arrow - check PartList for multiple MPNs
   */
  async arrow(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/arrow');

    const result = await searchPart(searchMpn, 100);

    const returnedMpns = [];

    // Arrow returns allSources with MPN info
    if (result.allSources) {
      for (const src of result.allSources) {
        if (src.mpn) returnedMpns.push(src.mpn.toUpperCase());
      }
    }
    if (result.vqMpn) returnedMpns.push(result.vqMpn.toUpperCase());

    return {
      searchMpn,
      found: result.found,
      returnedMpns: [...new Set(returnedMpns)],
      sourceCount: result.allSources?.length || 0,
    };
  },

  /**
   * TTI
   */
  async tti(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/tti');

    const result = await searchPart(searchMpn, 100);

    const returnedMpns = [];
    if (result.vqMpn) returnedMpns.push(result.vqMpn.toUpperCase());
    // TTI may have additional matches in raw response

    return {
      searchMpn,
      found: result.found,
      returnedMpns: [...new Set(returnedMpns)],
    };
  },

  /**
   * Future Electronics
   */
  async future(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/future');

    const result = await searchPart(searchMpn, 100);

    const returnedMpns = [];
    if (result.vqMpn) returnedMpns.push(result.vqMpn.toUpperCase());

    return {
      searchMpn,
      found: result.found,
      returnedMpns: [...new Set(returnedMpns)],
    };
  },

  /**
   * Newark/Farnell
   */
  async newark(searchMpn, testCase) {
    const { searchPart } = require('../Trading Analysis/RFQ Sourcing/franchise_check/newark');

    const result = await searchPart(searchMpn, 100);

    const returnedMpns = [];
    if (result.vqMpn) returnedMpns.push(result.vqMpn.toUpperCase());

    return {
      searchMpn,
      found: result.found,
      returnedMpns: [...new Set(returnedMpns)],
    };
  },
};

// ─── ANALYSIS ───────────────────────────────────────────────────────────────

/**
 * Analyze results to determine API type
 */
function analyzeResults(franchiseResults, testCase) {
  const searchedUpper = testCase.searchMpn.toUpperCase();
  const expectedUpper = testCase.expectedVariants.map(v => v.toUpperCase());

  // Check how many expected variants were returned
  const returnedMpns = franchiseResults.returnedMpns || [];
  const variantsFound = expectedUpper.filter(v => returnedMpns.includes(v));
  const otherVariantsFound = variantsFound.filter(v => v !== searchedUpper);

  let apiType;
  let confidence;

  if (otherVariantsFound.length > 0) {
    // Found variants beyond the searched MPN - this is a Type A (Discovery) API
    apiType = 'TYPE_A_DISCOVERY';
    confidence = otherVariantsFound.length / (expectedUpper.length - 1); // exclude searched
  } else if (returnedMpns.length === 1 && returnedMpns[0] === searchedUpper) {
    // Only returned the exact searched MPN - Type B (Exact Match)
    apiType = 'TYPE_B_EXACT';
    confidence = 1.0;
  } else if (returnedMpns.length === 0) {
    // No results
    apiType = 'NO_RESULTS';
    confidence = 0;
  } else {
    // Returned something, but not expected variants
    apiType = 'UNKNOWN';
    confidence = 0;
  }

  return {
    apiType,
    confidence,
    searchedMpn: testCase.searchMpn,
    returnedMpns,
    expectedVariants: testCase.expectedVariants,
    variantsFound,
    otherVariantsFound,
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  let targetFranchise = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--franchise' && args[i + 1]) {
      targetFranchise = args[i + 1].toLowerCase();
      i++;
    }
  }

  const franchises = targetFranchise
    ? [targetFranchise]
    : Object.keys(franchiseTesters);

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       FRANCHISE API VARIANT BEHAVIOR AUDIT                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log(`Testing ${franchises.length} franchise(s) with ${TEST_CASES.length} test case(s)\n`);
  console.log('Type A = Returns variants in one call (discovery API)');
  console.log('Type B = Only returns exact match (need multiple calls)\n');

  const auditResults = {
    auditDate: new Date().toISOString(),
    nextAuditDue: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
    franchises: {},
  };

  for (const franchise of franchises) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Testing: ${franchise.toUpperCase()}`);
    console.log('═'.repeat(60));

    const tester = franchiseTesters[franchise];
    if (!tester) {
      console.log(`  ⚠ No tester implemented for ${franchise}`);
      auditResults.franchises[franchise] = { error: 'No tester implemented' };
      continue;
    }

    const franchiseResult = {
      testResults: [],
      overallType: null,
      testedAt: new Date().toISOString(),
    };

    for (const testCase of TEST_CASES) {
      console.log(`\n  Test: ${testCase.name}`);
      console.log(`  Search MPN: ${testCase.searchMpn}`);
      console.log(`  Expected variants: ${testCase.expectedVariants.join(', ')}`);

      try {
        const result = await tester(testCase.searchMpn, testCase);
        const analysis = analyzeResults(result, testCase);

        console.log(`  Returned MPNs: ${result.returnedMpns?.join(', ') || 'none'}`);
        console.log(`  API Type: ${analysis.apiType} (confidence: ${(analysis.confidence * 100).toFixed(0)}%)`);

        if (analysis.otherVariantsFound.length > 0) {
          console.log(`  ✓ Found other variants: ${analysis.otherVariantsFound.join(', ')}`);
        }

        franchiseResult.testResults.push({
          testCase: testCase.name,
          ...result,
          analysis,
        });

        // Rate limiting between calls
        await new Promise(r => setTimeout(r, 1500));

      } catch (err) {
        console.log(`  ✗ Error: ${err.message}`);

        if (err.message.includes('429') || err.message.includes('rate limit')) {
          console.log(`  Stopping ${franchise} tests due to rate limit`);
          franchiseResult.testResults.push({
            testCase: testCase.name,
            error: err.message,
            rateLimited: true,
          });
          break;
        }

        franchiseResult.testResults.push({
          testCase: testCase.name,
          error: err.message,
        });
      }
    }

    // Determine overall type for this franchise
    const successfulTests = franchiseResult.testResults.filter(t => t.analysis && !t.error);
    if (successfulTests.length > 0) {
      const typeACounts = successfulTests.filter(t => t.analysis.apiType === 'TYPE_A_DISCOVERY').length;
      const typeBCounts = successfulTests.filter(t => t.analysis.apiType === 'TYPE_B_EXACT').length;

      if (typeACounts > typeBCounts) {
        franchiseResult.overallType = 'TYPE_A_DISCOVERY';
        franchiseResult.recommendation = 'Use single search - API returns variants automatically';
      } else if (typeBCounts > typeACounts) {
        franchiseResult.overallType = 'TYPE_B_EXACT';
        franchiseResult.recommendation = 'Generate variants from MFR rules, query each separately';
      } else {
        franchiseResult.overallType = 'MIXED';
        franchiseResult.recommendation = 'Inconsistent behavior - test with more MPNs';
      }
    }

    auditResults.franchises[franchise] = franchiseResult;
  }

  // Load previous audit for comparison
  let previousAudit = null;
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      previousAudit = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    } catch {}
  }

  // Check for behavior changes
  if (previousAudit) {
    console.log('\n\n' + '═'.repeat(60));
    console.log('COMPARISON WITH PREVIOUS AUDIT');
    console.log('═'.repeat(60));
    console.log(`Previous audit: ${previousAudit.auditDate}\n`);

    for (const [franchise, current] of Object.entries(auditResults.franchises)) {
      const previous = previousAudit.franchises?.[franchise];
      if (previous && previous.overallType && current.overallType) {
        if (previous.overallType !== current.overallType) {
          console.log(`⚠ BEHAVIOR CHANGE: ${franchise}`);
          console.log(`  Was: ${previous.overallType}`);
          console.log(`  Now: ${current.overallType}`);
          auditResults.franchises[franchise].behaviorChanged = true;
          auditResults.franchises[franchise].previousType = previous.overallType;
        } else {
          console.log(`✓ ${franchise}: No change (${current.overallType})`);
        }
      }
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write results
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(auditResults, null, 2));
  console.log(`\n✓ Audit results written to: ${OUTPUT_FILE}`);

  // Print summary
  console.log('\n\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60) + '\n');

  console.log('API Type Classification:');
  console.log('─'.repeat(40));

  for (const [franchise, result] of Object.entries(auditResults.franchises)) {
    if (result.overallType) {
      const icon = result.overallType === 'TYPE_A_DISCOVERY' ? '🔍' : '🎯';
      console.log(`${icon} ${franchise.padEnd(15)} ${result.overallType}`);
      console.log(`   ${result.recommendation}`);
    } else if (result.error) {
      console.log(`❌ ${franchise.padEnd(15)} ERROR: ${result.error}`);
    }
  }

  console.log('\n' + '─'.repeat(40));
  console.log(`Next audit due: ${auditResults.nextAuditDue.split('T')[0]}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
