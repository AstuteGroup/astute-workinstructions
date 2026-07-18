#!/usr/bin/env node
/**
 * Check Phase 3 roster data against RFQ 1139539
 */

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const sql = "SELECT rl.chuboe_cpc, rlm.chuboe_mpn, rlm.chuboe_mfr_text, rl.qty, rl.priceentered FROM chuboe_rfq r JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id WHERE r.value = '1139539' AND rl.isactive = 'Y' ORDER BY rl.chuboe_cpc";

const tmpSql = path.join(os.tmpdir(), 'rfq_full.sql');
const tmpOut = path.join(os.tmpdir(), 'rfq_full.out');
fs.writeFileSync(tmpSql, sql);
execSync('psql -U analytics_user -d idempiere_replica -t -A -F "|" -f ' + tmpSql + ' -o ' + tmpOut, { stdio: 'pipe' });
const out = fs.readFileSync(tmpOut, 'utf-8').trim();
const lines = out.split('\n').filter(l => l.trim());

console.log('RFQ 1139539 - Full data (' + lines.length + ' lines)');
console.log('');

// Parse into objects
const rfqData = [];
for (const line of lines) {
  const [cpc, mpn, mfr, moq, resale] = line.split('|');
  rfqData.push({ cpc, mpn, mfr, moq: parseInt(moq), resale: parseFloat(resale) });
}

// Load roster
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
const leadTimeCol = headers.indexOf('Contractual Lead Time');
const awardCol = headers.indexOf('Award');

console.log('Checking roster vs RFQ...');
console.log('');

let updated = 0;
const issues = [];

for (const rfq of rfqData) {
  // Find matching row in roster
  let matchIdx = -1;
  for (let i = 1; i < roster.length; i++) {
    if (roster[i][cpcCol] === rfq.cpc && roster[i][awardCol] === 'Phase 3') {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    issues.push(`CPC ${rfq.cpc} not in roster as Phase 3`);
    continue;
  }

  const row = roster[matchIdx];
  let rowUpdated = false;

  // Check and fix MOQ
  if (row[moqCol] !== rfq.moq) {
    console.log(`${rfq.cpc}: MOQ ${row[moqCol]} -> ${rfq.moq}`);
    row[moqCol] = rfq.moq;
    rowUpdated = true;
  }

  // Check and fix Resale
  const rosterResale = parseFloat(row[resaleCol]) || 0;
  if (Math.abs(rosterResale - rfq.resale) > 0.001) {
    console.log(`${rfq.cpc}: Resale ${rosterResale} -> ${rfq.resale}`);
    row[resaleCol] = rfq.resale;
    rowUpdated = true;
  }

  // Check and fix MPN
  if (row[mpnCol] !== rfq.mpn) {
    console.log(`${rfq.cpc}: MPN '${row[mpnCol]}' -> '${rfq.mpn}'`);
    row[mpnCol] = rfq.mpn;
    rowUpdated = true;
  }

  // Check and fix MFR
  if (rfq.mfr && row[mfrCol] !== rfq.mfr) {
    console.log(`${rfq.cpc}: MFR '${row[mfrCol]}' -> '${rfq.mfr}'`);
    row[mfrCol] = rfq.mfr;
    rowUpdated = true;
  }

  if (rowUpdated) updated++;
}

console.log('');
console.log('Updated', updated, 'rows');

if (issues.length > 0) {
  console.log('');
  console.log('Issues:');
  for (const i of issues) {
    console.log('  ' + i);
  }
}

// Save
const newWs = XLSX.utils.aoa_to_sheet(roster);
wb.Sheets['Master Roster'] = newWs;
XLSX.writeFile(wb, rosterPath);
console.log('');
console.log('Saved:', rosterPath);
