#!/usr/bin/env node
/**
 * LAM Master Roster Validator
 *
 * Cross-checks roster data against OT (RFQ lines) to catch data errors
 * before any output is sent.
 *
 * MUST be called after any roster modification, before sending output.
 *
 * Usage (as module):
 *   const { validateRoster } = require('../shared/roster-validator');
 *   const result = await validateRoster({ award: 'Phase 3', rfqValue: '1139539' });
 *   if (!result.valid) {
 *     console.error('Validation failed:', result.issues);
 *     process.exit(1);
 *   }
 *
 * Usage (standalone):
 *   node shared/roster-validator.js --award "Phase 3" --rfq 1139539
 */

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const ROSTER_PATH = path.join(__dirname, '../Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');

/**
 * Query RFQ data from OT
 */
function queryRFQ(rfqValue) {
  const sql = `SELECT rl.chuboe_cpc, rlm.chuboe_mpn, rlm.chuboe_mfr_text, rl.qty, rl.priceentered FROM chuboe_rfq r JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id WHERE r.value = '${rfqValue}' AND rl.isactive = 'Y' ORDER BY rl.chuboe_cpc`;

  const tmpSql = path.join(os.tmpdir(), 'roster_validate.sql');
  const tmpOut = path.join(os.tmpdir(), 'roster_validate.out');
  fs.writeFileSync(tmpSql, sql);

  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F "|" -f ${tmpSql} -o ${tmpOut}`, { stdio: 'pipe' });
    const out = fs.readFileSync(tmpOut, 'utf-8').trim();
    const lines = out.split('\n').filter(l => l.trim());

    const data = [];
    for (const line of lines) {
      const [cpc, mpn, mfr, moq, resale] = line.split('|');
      data.push({
        cpc,
        mpn,
        mfr,
        moq: parseInt(moq) || 0,
        resale: parseFloat(resale) || 0
      });
    }
    return data;
  } catch (e) {
    console.error('Failed to query RFQ:', e.message);
    return [];
  }
}

/**
 * Load roster data filtered by award
 */
function loadRoster(award) {
  const wb = XLSX.readFile(ROSTER_PATH);
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Master Roster']);

  if (award) {
    return data.filter(r => r['Award'] === award);
  }
  return data;
}

/**
 * Validate roster against RFQ
 *
 * @param {Object} opts - { award, rfqValue }
 * @returns {Object} - { valid: boolean, issues: string[], checked: number }
 */
async function validateRoster(opts) {
  const { award, rfqValue } = opts;

  if (!rfqValue) {
    return { valid: false, issues: ['No RFQ value provided for validation'], checked: 0 };
  }

  console.log(`Validating roster (Award: ${award || 'all'}) against RFQ ${rfqValue}...`);

  // Get RFQ data from OT
  const rfqData = queryRFQ(rfqValue);
  if (rfqData.length === 0) {
    return { valid: false, issues: [`RFQ ${rfqValue} not found or has no lines`], checked: 0 };
  }

  // Build lookup by CPC
  const rfqByCpc = {};
  for (const r of rfqData) {
    rfqByCpc[r.cpc] = r;
  }

  // Load roster
  const roster = loadRoster(award);

  const issues = [];
  let checked = 0;

  for (const row of roster) {
    const cpc = row['CPC'];
    if (!cpc) continue;

    const rfq = rfqByCpc[cpc];
    if (!rfq) {
      // CPC not in this RFQ - might be from a different source, skip
      continue;
    }

    checked++;

    // Check MPN
    if (row['MPN'] !== rfq.mpn) {
      issues.push(`${cpc}: MPN mismatch - roster='${row['MPN']}' vs RFQ='${rfq.mpn}'`);
    }

    // Check MFR (normalize for comparison)
    const rosterMfr = (row['Manufacturer'] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rfqMfr = (rfq.mfr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (rosterMfr && rfqMfr && !rosterMfr.includes(rfqMfr.slice(0, 10)) && !rfqMfr.includes(rosterMfr.slice(0, 10))) {
      issues.push(`${cpc}: MFR mismatch - roster='${row['Manufacturer']}' vs RFQ='${rfq.mfr}'`);
    }

    // Check MOQ
    const rosterMoq = parseInt(row['MOQ']) || 0;
    if (rosterMoq !== rfq.moq) {
      issues.push(`${cpc}: MOQ mismatch - roster=${rosterMoq} vs RFQ=${rfq.moq}`);
    }

    // Check Resale (allow small float variance)
    const rosterResale = parseFloat(row['Resale Price']) || 0;
    if (Math.abs(rosterResale - rfq.resale) > 0.001) {
      issues.push(`${cpc}: Resale mismatch - roster=${rosterResale} vs RFQ=${rfq.resale}`);
    }
  }

  const valid = issues.length === 0;

  console.log(`  Checked ${checked} rows against RFQ ${rfqValue}`);
  if (valid) {
    console.log('  ✓ Validation PASSED');
  } else {
    console.log(`  ✗ Validation FAILED - ${issues.length} issues found`);
  }

  return { valid, issues, checked };
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);
  let award = null;
  let rfqValue = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--award' && args[i + 1]) {
      award = args[++i];
    } else if (args[i] === '--rfq' && args[i + 1]) {
      rfqValue = args[++i];
    }
  }

  if (!rfqValue) {
    console.error('Usage: node roster-validator.js --award "Phase 3" --rfq 1139539');
    process.exit(1);
  }

  validateRoster({ award, rfqValue }).then(result => {
    if (!result.valid) {
      console.log('\nIssues:');
      for (const issue of result.issues) {
        console.log('  - ' + issue);
      }
      process.exit(1);
    }
  });
}

module.exports = { validateRoster, queryRFQ, loadRoster };
