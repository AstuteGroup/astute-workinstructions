#!/usr/bin/env node
/**
 * LAM Roster Source Validator
 *
 * Validates roster data against original source files.
 * MUST be run before any roster-based output is sent.
 *
 * Checks:
 *   1. Each roster line has a Source File reference
 *   2. The source file exists
 *   3. CPC→MPN mapping in roster matches source file
 *
 * Usage:
 *   node shared/roster-source-validator.js --award "Phase 3"
 *   node shared/roster-source-validator.js --all
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { readCSVFile } = require('./csv-utils');

const ROSTER_PATH = path.join(__dirname, '../Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const SOURCE_FILES_DIR = path.join(__dirname, '../Trading Analysis/LAM 3PL/source-files');

function loadRoster(award) {
  const wb = XLSX.readFile(ROSTER_PATH);
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Master Roster']);

  if (award) {
    return data.filter(r => r['Award'] === award);
  }
  return data;
}

function loadSourceFile(filename) {
  const fullPath = path.join(SOURCE_FILES_DIR, path.basename(filename));

  if (!fs.existsSync(fullPath)) {
    // Try relative path from roster
    const altPath = path.join(__dirname, '../Trading Analysis/LAM 3PL', filename);
    if (fs.existsSync(altPath)) {
      return loadSourceFileByPath(altPath);
    }
    return null;
  }

  return loadSourceFileByPath(fullPath);
}

function loadSourceFileByPath(fullPath) {
  if (fullPath.endsWith('.csv')) {
    const csv = readCSVFile(fullPath);
    const data = {};
    const cpcIdx = csv.headers.findIndex(h => h.toLowerCase() === 'cpc' || h.toLowerCase() === 'part number');
    const mpnIdx = csv.headers.findIndex(h => h.toLowerCase() === 'mpn');
    const mfrIdx = csv.headers.findIndex(h => h.toLowerCase() === 'mfr' || h.toLowerCase().includes('manufacturer'));

    for (const row of csv.rows) {
      const cpc = (row[cpcIdx] || '').trim();
      if (cpc) {
        data[cpc] = {
          mpn: (row[mpnIdx] || '').trim(),
          mfr: (row[mfrIdx] || '').trim()
        };
      }
    }
    return data;
  } else if (fullPath.endsWith('.xlsx')) {
    const wb = XLSX.readFile(fullPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    const data = {};

    for (const row of rows) {
      const cpc = (row['CPC'] || row['Part Number'] || '').toString().trim();
      if (cpc) {
        data[cpc] = {
          mpn: (row['MPN'] || '').toString().trim(),
          mfr: (row['MFR'] || row['Manufacturer'] || '').toString().trim()
        };
      }
    }
    return data;
  }

  return null;
}

function validateRosterAgainstSource(opts = {}) {
  const { award, verbose } = opts;

  console.log('LAM Roster Source Validator');
  console.log('===========================');
  console.log('');

  const roster = loadRoster(award);
  console.log(`Checking ${roster.length} roster lines` + (award ? ` (Award: ${award})` : ''));
  console.log('');

  const issues = [];
  const sourceCache = {};
  let checked = 0;
  let noSourceFile = 0;
  let sourceNotFound = 0;

  for (const row of roster) {
    const cpc = row['CPC'];
    const rosterMpn = row['MPN'];
    const sourceFile = row['Source File'];

    if (!cpc) continue;

    // Check 1: Has source file reference?
    if (!sourceFile || sourceFile === 'N/A' || sourceFile === '') {
      noSourceFile++;
      if (verbose) {
        issues.push(`${cpc}: No source file reference`);
      }
      continue;
    }

    // Load source file (cached)
    if (!sourceCache[sourceFile]) {
      sourceCache[sourceFile] = loadSourceFile(sourceFile);
    }

    const sourceData = sourceCache[sourceFile];

    // Check 2: Source file exists?
    if (!sourceData) {
      sourceNotFound++;
      issues.push(`${cpc}: Source file not found: ${sourceFile}`);
      continue;
    }

    // Check 3: CPC→MPN matches?
    const sourceEntry = sourceData[cpc];
    if (!sourceEntry) {
      issues.push(`${cpc}: Not found in source file ${sourceFile}`);
      continue;
    }

    checked++;

    if (rosterMpn !== sourceEntry.mpn) {
      issues.push(`${cpc}: MPN MISMATCH - roster='${rosterMpn}' vs source='${sourceEntry.mpn}'`);
    }
  }

  console.log('Results:');
  console.log(`  Checked against source: ${checked}`);
  console.log(`  No source file ref: ${noSourceFile}`);
  console.log(`  Source file missing: ${sourceNotFound}`);
  console.log(`  Issues found: ${issues.length}`);
  console.log('');

  if (issues.length > 0) {
    console.log('ISSUES:');
    for (const issue of issues.slice(0, 20)) {
      console.log('  - ' + issue);
    }
    if (issues.length > 20) {
      console.log(`  ... and ${issues.length - 20} more`);
    }
  } else if (checked > 0) {
    console.log('✓ All checked lines match source files');
  }

  return {
    valid: issues.length === 0,
    issues,
    checked,
    noSourceFile,
    sourceNotFound
  };
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);
  let award = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--award' && args[i + 1]) {
      award = args[++i];
    } else if (args[i] === '--all') {
      award = null;
    } else if (args[i] === '-v' || args[i] === '--verbose') {
      verbose = true;
    }
  }

  const result = validateRosterAgainstSource({ award, verbose });
  process.exit(result.valid ? 0 : 1);
}

module.exports = { validateRosterAgainstSource, loadSourceFile };
