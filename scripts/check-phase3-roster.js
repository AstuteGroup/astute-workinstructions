#!/usr/bin/env node
/**
 * Check Phase 3 roster data against RFQ 1139539 — COMPARISON ONLY
 *
 * CRITICAL: The Master Roster is the SOURCE OF TRUTH.
 *           OT (RFQs) is DERIVED from the roster.
 *           This script COMPARES and REPORTS discrepancies.
 *           It does NOT auto-fix anything.
 *
 * If discrepancies are found:
 *   - Roster is assumed CORRECT
 *   - OT is assumed WRONG and needs manual correction
 *
 * To fix OT data: Use the API or run a targeted fix script that
 *                 updates OT to match the roster (NOT the reverse).
 *
 * Usage:
 *   node check-phase3-roster.js                    # Report discrepancies
 *   node check-phase3-roster.js --fix-ot           # Fix OT to match roster
 *   node check-phase3-roster.js --dry-run          # Show what --fix-ot would do
 */

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const fixOt = args.includes('--fix-ot');
const dryRun = args.includes('--dry-run');

// Load Master Roster FIRST (it's the source of truth)
const rosterPath = path.join(__dirname, '../Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx');
const wb = XLSX.readFile(rosterPath);
const ws = wb.Sheets['Master Roster'];
const roster = XLSX.utils.sheet_to_json(ws, { header: 1 });
const headers = roster[0];

const cpcCol = headers.indexOf('CPC');
const mpnCol = headers.indexOf('MPN');
const mfrCol = headers.indexOf('Manufacturer');
const moqCol = headers.indexOf('MOQ');
const resaleCol = headers.indexOf('Resale Price');
const awardCol = headers.indexOf('Award');

// Build Phase 3 roster lookup (AUTHORITATIVE)
const phase3Roster = {};
for (let i = 1; i < roster.length; i++) {
  const row = roster[i];
  if (row[awardCol] === 'Phase 3') {
    const cpc = row[cpcCol];
    phase3Roster[cpc] = {
      cpc,
      mpn: row[mpnCol],
      mfr: row[mfrCol],
      moq: parseInt(row[moqCol]) || 0,
      resale: parseFloat(row[resaleCol]) || 0,
      rowIndex: i,
    };
  }
}

console.log('Phase 3 Roster vs OT Comparison');
console.log('================================');
console.log('');
console.log(`Phase 3 items in roster: ${Object.keys(phase3Roster).length}`);
console.log('');

// Query OT for RFQ 1139539 line MPNs
const sql = `
SELECT
  rl.chuboe_rfq_line_id,
  rl.chuboe_cpc,
  rlm.chuboe_rfq_line_mpn_id,
  rlm.chuboe_mpn,
  rlm.chuboe_mfr_text,
  rl.qty,
  rl.priceentered
FROM chuboe_rfq r
JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id
JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
WHERE r.value = '1139539'
  AND rl.isactive = 'Y'
  AND rlm.isactive = 'Y'
ORDER BY rl.chuboe_cpc, rlm.chuboe_rfq_line_mpn_id
`;

const tmpSql = path.join(os.tmpdir(), 'rfq_phase3.sql');
const tmpOut = path.join(os.tmpdir(), 'rfq_phase3.out');
fs.writeFileSync(tmpSql, sql);
execSync('psql -U analytics_user -d idempiere_replica -t -A -F "|" -f ' + tmpSql + ' -o ' + tmpOut, { stdio: 'pipe' });
const out = fs.readFileSync(tmpOut, 'utf-8').trim();
const lines = out.split('\n').filter(l => l.trim());

console.log(`RFQ 1139539 active line MPNs: ${lines.length}`);
console.log('');

// Parse OT data and group by CPC
const otByCpc = {};
for (const line of lines) {
  const [rfqLineId, cpc, rfqLineMpnId, mpn, mfr, moq, resale] = line.split('|');
  if (!otByCpc[cpc]) otByCpc[cpc] = [];
  otByCpc[cpc].push({
    rfqLineId,
    rfqLineMpnId,
    mpn,
    mfr,
    moq: parseInt(moq),
    resale: parseFloat(resale),
  });
}

// Find discrepancies
const discrepancies = [];
const multiMpnIssues = [];

for (const cpc of Object.keys(phase3Roster)) {
  const rosterItem = phase3Roster[cpc];
  const otItems = otByCpc[cpc] || [];

  if (otItems.length === 0) {
    discrepancies.push({
      type: 'MISSING_IN_OT',
      cpc,
      rosterMpn: rosterItem.mpn,
      otMpn: '(not in OT)',
      message: `CPC ${cpc} is in roster but not in RFQ 1139539`,
    });
    continue;
  }

  if (otItems.length > 1) {
    // Multiple MPNs for same CPC - this is row mismatch corruption
    multiMpnIssues.push({
      cpc,
      rosterMpn: rosterItem.mpn,
      otMpns: otItems.map(o => ({ mpn: o.mpn, id: o.rfqLineMpnId })),
    });
  }

  // Check each OT MPN against roster
  for (const otItem of otItems) {
    if (otItem.mpn !== rosterItem.mpn) {
      discrepancies.push({
        type: 'MPN_MISMATCH',
        cpc,
        rosterMpn: rosterItem.mpn,
        otMpn: otItem.mpn,
        rfqLineMpnId: otItem.rfqLineMpnId,
        message: `CPC ${cpc}: Roster MPN '${rosterItem.mpn}' ≠ OT MPN '${otItem.mpn}'`,
      });
    }
  }
}

// Report findings
if (multiMpnIssues.length > 0) {
  console.log('=== ROW MISMATCH CORRUPTION ===');
  console.log('These CPCs have multiple MPNs attached in OT (should have exactly 1):');
  console.log('');
  for (const issue of multiMpnIssues) {
    console.log(`  ${issue.cpc}:`);
    console.log(`    Roster (CORRECT): ${issue.rosterMpn}`);
    for (const o of issue.otMpns) {
      const marker = o.mpn === issue.rosterMpn ? '✓' : '✗';
      console.log(`    OT ${marker}: ${o.mpn} (ID: ${o.id})`);
    }
  }
  console.log('');
}

if (discrepancies.length > 0) {
  console.log('=== MPN DISCREPANCIES ===');
  console.log('(Roster is correct; OT needs to be fixed)');
  console.log('');
  for (const d of discrepancies) {
    console.log(`  ${d.message}`);
  }
  console.log('');
}

if (multiMpnIssues.length === 0 && discrepancies.length === 0) {
  console.log('✓ No discrepancies found. OT matches roster.');
}

// Summary
console.log('');
console.log('Summary:');
console.log(`  Phase 3 items in roster:  ${Object.keys(phase3Roster).length}`);
console.log(`  CPCs with multi-MPN:      ${multiMpnIssues.length}`);
console.log(`  MPN discrepancies:        ${discrepancies.length}`);

// Fix OT if requested
if (fixOt || dryRun) {
  console.log('');
  console.log(dryRun ? '=== DRY RUN: Would fix OT ===' : '=== FIXING OT ===');
  console.log('');

  // For multi-MPN issues: deactivate wrong MPNs, keep only correct one
  for (const issue of multiMpnIssues) {
    const correctMpn = issue.rosterMpn;
    for (const o of issue.otMpns) {
      if (o.mpn !== correctMpn) {
        console.log(`  Deactivate RFQ Line MPN ${o.id}: ${o.mpn} (wrong)`);
        if (!dryRun) {
          // TODO: Call API to deactivate
          // const { apiPut } = require('../shared/api-client');
          // await apiPut('chuboe_rfq_line_mpn', o.id, { IsActive: false });
        }
      }
    }
  }

  // For MPN mismatches where there's only one MPN: update it
  for (const d of discrepancies) {
    if (d.type === 'MPN_MISMATCH' && d.rfqLineMpnId) {
      console.log(`  Update RFQ Line MPN ${d.rfqLineMpnId}: '${d.otMpn}' -> '${d.rosterMpn}'`);
      if (!dryRun) {
        // TODO: Call API to update MPN
        // const { apiPut } = require('../shared/api-client');
        // await apiPut('chuboe_rfq_line_mpn', d.rfqLineMpnId, { Chuboe_MPN: d.rosterMpn });
      }
    }
  }

  if (!dryRun) {
    console.log('');
    console.log('NOTE: API calls not yet implemented. Edit script to enable.');
  }
}

// IMPORTANT: We do NOT modify the roster. The roster is the source of truth.
console.log('');
console.log('NOTE: Roster is the source of truth. This script does NOT modify the roster.');
console.log('      To fix discrepancies, correct OT to match the roster.');
