#!/usr/bin/env node
/**
 * Validate mfr-aliases.json against the database
 *
 * Run periodically (recommended: monthly) to ensure alias names still match DB.
 *
 * Usage: node validate-mfr-aliases.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ALIASES_FILE = path.join(__dirname, 'mfr-aliases.json');

// Load aliases
const aliasData = JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8'));
const aliases = aliasData.aliases;

// Get unique canonical names from aliases
const canonicalNames = [...new Set(Object.values(aliases))];

console.log('=== MFR Aliases Validation ===\n');
console.log(`Checking ${canonicalNames.length} unique canonical names against database...\n`);

// Query database for all these names
const namesForQuery = canonicalNames.map(n => n.replace(/'/g, "''")).join("','");
const query = `SELECT name FROM adempiere.chuboe_mfr WHERE name IN ('${namesForQuery}') AND isactive = 'Y'`;

let dbNames;
try {
  const result = execSync(`psql -t -c "${query}"`, { encoding: 'utf8' });
  dbNames = result.split('\n').map(n => n.trim()).filter(n => n);
} catch (err) {
  console.error('Error querying database:', err.message);
  process.exit(1);
}

const dbNameSet = new Set(dbNames);

// Find mismatches
const missing = [];
const found = [];

canonicalNames.forEach(name => {
  if (dbNameSet.has(name)) {
    found.push(name);
  } else {
    missing.push(name);
  }
});

console.log(`✓ Found in DB: ${found.length}`);
console.log(`✗ Missing from DB: ${missing.length}\n`);

if (missing.length > 0) {
  console.log('=== MISSING (need attention) ===\n');
  missing.forEach(name => {
    // Find which aliases use this name
    const usingAliases = Object.entries(aliases)
      .filter(([k, v]) => v === name)
      .map(([k]) => k);
    console.log(`"${name}"`);
    console.log(`  Used by: ${usingAliases.join(', ')}`);

    // Try to find similar names in DB
    try {
      const keyword = name.split(' ')[0];
      const similarQuery = `SELECT name FROM adempiere.chuboe_mfr WHERE name ILIKE '%${keyword}%' AND isactive = 'Y' LIMIT 5`;
      const similar = execSync(`psql -t -c "${similarQuery}"`, { encoding: 'utf8' })
        .split('\n').map(n => n.trim()).filter(n => n);
      if (similar.length > 0) {
        console.log(`  Similar in DB: ${similar.join(', ')}`);
      }
    } catch (e) {}
    console.log('');
  });

  console.log('Action required: Update mfr-aliases.json with correct DB names.\n');
  process.exit(1);
} else {
  console.log('✓ All canonical names found in database.\n');

  // Update last validated date in the JSON
  aliasData._last_validated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliasData, null, 2) + '\n');
  console.log(`Updated _last_validated to ${aliasData._last_validated}`);

  process.exit(0);
}
