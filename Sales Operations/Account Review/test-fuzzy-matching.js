#!/usr/bin/env node
/**
 * Test script to debug fuzzy matching logic
 */

// Copy the matching functions from generate-account-review.js
function normalizeCompanyName(name) {
  if (!name) return '';

  return name
    .toUpperCase()
    // Remove leading/trailing quotes
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    // Remove parenthetical info
    .replace(/\([^)]*\)/g, '')
    // Remove punctuation FIRST (so "Corp." becomes "Corp")
    .replace(/[.,\-&]/g, ' ')
    // Now remove legal entities as whole words
    .replace(/\bINCORPORATED\b/g, '')
    .replace(/\bCORPORATION\b/g, '')
    .replace(/\bCORP\b/g, '')
    .replace(/\bINC\b/g, '')
    .replace(/\bLLC\b/g, '')
    .replace(/\bLIMITED\b/g, '')
    .replace(/\bLTD\b/g, '')
    .replace(/\bCOMPANY\b/g, '')
    .replace(/\bCO\b/g, '')
    .replace(/\bPTE\b/g, '')
    .replace(/\bULC\b/g, '')
    .replace(/\bTHE\b/g, '')
    .replace(/\bDBA\b/g, '')
    // Collapse spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(normalizedName) {
  // Extract significant words (3+ chars) for matching
  return normalizedName.split(' ').filter(w => w.length >= 3);
}

function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

function fuzzyMatchCustomerDebug(otName, inforName) {
  const normalizedOT = normalizeCompanyName(otName);
  const normalizedInfor = normalizeCompanyName(inforName);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: "${otName}" vs "${inforName}"`);
  console.log(`${'='.repeat(80)}`);
  console.log(`OT normalized:    "${normalizedOT}"`);
  console.log(`Infor normalized: "${normalizedInfor}"`);

  const otKeywords = extractKeywords(normalizedOT);
  const inforKeywords = extractKeywords(normalizedInfor);

  console.log(`\nOT keywords:    [${otKeywords.join(', ')}]`);
  console.log(`Infor keywords: [${inforKeywords.join(', ')}]`);

  // Exact match
  if (normalizedOT === normalizedInfor) {
    console.log(`\n✅ MATCH: exact`);
    return { match: true, confidence: 'exact' };
  }

  // Contains match
  if (normalizedInfor.includes(normalizedOT)) {
    console.log(`\n✅ MATCH: Infor contains OT (substring)`);
    return { match: true, confidence: 'contains' };
  }

  if (normalizedOT.includes(normalizedInfor)) {
    console.log(`\n✅ MATCH: OT contains Infor (substring)`);
    return { match: true, confidence: 'contains' };
  }

  // Keyword matching
  const commonKeywords = otKeywords.filter(k => inforKeywords.includes(k));
  console.log(`\nCommon keywords: [${commonKeywords.join(', ')}]`);

  if (commonKeywords.length > 0) {
    const distinctiveMatches = commonKeywords.filter(k => k.length >= 5);
    console.log(`Distinctive (5+ chars): [${distinctiveMatches.join(', ')}]`);

    const matchPct = commonKeywords.length / otKeywords.length;
    console.log(`Match percentage: ${commonKeywords.length}/${otKeywords.length} = ${(matchPct * 100).toFixed(1)}%`);

    if (distinctiveMatches.length > 0 && matchPct >= 0.5) {
      console.log(`\n✅ MATCH: distinctive keyword (50%+ coverage)`);
      return { match: true, confidence: 'keyword' };
    }

    const minKeywords = Math.min(2, otKeywords.length);
    if (commonKeywords.length >= minKeywords && matchPct >= 0.5) {
      console.log(`\n✅ MATCH: keyword (${commonKeywords.length} >= ${minKeywords}, ${(matchPct * 100).toFixed(1)}% >= 50%)`);
      return { match: true, confidence: 'keyword' };
    }
  }

  // Levenshtein
  const distance = levenshteinDistance(normalizedOT, normalizedInfor);
  const maxLen = Math.max(normalizedOT.length, normalizedInfor.length);
  const similarity = 1 - (distance / maxLen);

  console.log(`\nLevenshtein distance: ${distance}/${maxLen} = ${(similarity * 100).toFixed(1)}% similar`);

  if (similarity >= 0.85) {
    console.log(`\n✅ MATCH: fuzzy (${(similarity * 100).toFixed(1)}% >= 85%)`);
    return { match: true, confidence: 'fuzzy' };
  }

  console.log(`\n❌ NO MATCH`);
  return { match: false, confidence: 'no-match' };
}

// Test cases
console.log(`\n${'#'.repeat(80)}`);
console.log(`FUZZY MATCHING TEST SUITE`);
console.log(`${'#'.repeat(80)}`);

// Test 1: Morey Corporation false positives
fuzzyMatchCustomerDebug('Morey Corporation', 'THE MOREY CORPORATION');
fuzzyMatchCustomerDebug('Morey Corporation', 'Advanced Manufacturing Corporation Pte. Ltd.');
fuzzyMatchCustomerDebug('Morey Corporation', 'Qual-Pro Corporation');

// Test 2: Kodak should match
fuzzyMatchCustomerDebug('Eastman Kodak Company', 'EASTMAN KODAK COMPANY');
fuzzyMatchCustomerDebug('Eastman Kodak Company', 'Kodak Canada ULC');

// Test 3: Alstom variations
fuzzyMatchCustomerDebug('Alstom', 'Alstom Transportation Inc.');
fuzzyMatchCustomerDebug('Alstom', 'Alstom Transport Canada Inc');

// Test 4: GE Healthcare
fuzzyMatchCustomerDebug('GE Healthcare', 'GE Precision Healthcare LLC');

console.log(`\n${'#'.repeat(80)}`);
console.log(`END OF TESTS`);
console.log(`${'#'.repeat(80)}\n`);
