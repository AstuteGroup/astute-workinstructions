#!/usr/bin/env node
/**
 * Dump merge ranges and dataValidation XML from a CRMA form.
 * Re-run when the form revs to see if cell coords or dropdown ranges shifted.
 *
 * Usage:
 *   node inspect-form.js --src /path/to/CRMA*.xlsx
 */
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const src = arg('--src');
if (!src) {
  console.error('Usage: node inspect-form.js --src /path/to/CRMA.xlsx');
  process.exit(1);
}

const wb = XLSX.readFile(src, { cellDates: true, cellStyles: true });
const ws = wb.Sheets['Sheet1'];

console.log('=== Merges ===');
for (const m of (ws['!merges'] || [])) {
  console.log(`  ${XLSX.utils.encode_cell(m.s)}:${XLSX.utils.encode_cell(m.e)}`);
}

console.log('\n=== Cell text (non-empty) ===');
const range = XLSX.utils.decode_range(ws['!ref']);
for (let R = range.s.r; R <= range.e.r; R++) {
  const cells = [];
  for (let C = range.s.c; C <= range.e.c; C++) {
    const a = XLSX.utils.encode_cell({ r: R, c: C });
    const cell = ws[a];
    if (cell && cell.v !== '' && cell.v != null) {
      cells.push(`${a}=${JSON.stringify(cell.v)}`);
    }
  }
  if (cells.length) console.log(`R${R + 1}: ${cells.join(' | ')}`);
}

console.log('\n=== DataValidations ===');
const zip = new AdmZip(src);
for (const e of zip.getEntries()) {
  if (!e.entryName.startsWith('xl/worksheets/sheet')) continue;
  const xml = e.getData().toString('utf-8');
  const m = xml.match(/<dataValidations[\s\S]*?<\/dataValidations>/);
  if (m) console.log(m[0]);
  const m2 = xml.match(/<x14:dataValidations[\s\S]*?<\/x14:dataValidations>/);
  if (m2) console.log(m2[0]);
}
