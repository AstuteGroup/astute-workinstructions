#!/usr/bin/env node
/**
 * Parse the 8 HTC Korea drop-in replacement xlsx files into a unified catalog
 * mapping mainstream MFR MPN -> HTC (TAEJIN) replacement MPN.
 *
 * Output: htc-korea-xref/htc_catalog.csv
 * Columns: competitor_mpn, htc_mpn, vendor (the brand HTC replaces),
 *          match_grade, target_pkg, htc_pkg, major_difference, source_file
 */
const fs = require('fs');
const path = require('path');
const NM = path.resolve(process.env.HOME, 'workspace/astute-workinstructions/node_modules');
const XLSX = require(NM + '/xlsx');

const ATT = path.resolve(process.env.HOME, 'workspace/htc-korea-xref/attachments');
const OUT = path.resolve(process.env.HOME, 'workspace/htc-korea-xref/htc_catalog.csv');

// Brand normalization: HTC writes "Analog Device" (singular), "ST Microelectronics", etc.
// Map them to clean display names matching our internal usage.
const BRAND_NORMAL = {
  'analog device':      'Analog Devices',
  'analog devices':     'Analog Devices',
  'infineon':           'Infineon',
  'nxp':                'NXP',
  'nexperia':           'Nexperia',
  'microchip':          'Microchip',
  'st microelectronics':'STMicroelectronics',
  'stmicroelectronics': 'STMicroelectronics',
  'st':                 'STMicroelectronics',
  'texas instruments':  'Texas Instruments',
  'ti':                 'Texas Instruments',
  'on semi':            'ON Semiconductor',
  'on semiconductor':   'ON Semiconductor',
  'onsemi':             'ON Semiconductor',
};

function normalizeBrand(s) {
  if (!s) return '';
  const k = String(s).trim().toLowerCase();
  return BRAND_NORMAL[k] || String(s).trim();
}

// Match-grade column carries "Drop In Replacement", "Conditional P2P", "Functional Match" etc.
function cleanCell(s) {
  if (s == null) return '';
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

function cleanMpn(s) {
  // Preserve case, strip whitespace, drop trailing comments after parentheses
  if (s == null) return '';
  return String(s).replace(/\s+/g, '').trim();
}

const out = [];
out.push([
  'competitor_mpn', 'htc_mpn', 'vendor', 'match_grade',
  'target_pkg', 'htc_pkg', 'major_difference', 'source_file',
].join(','));

const files = fs.readdirSync(ATT).filter(f => /\.xlsx$/i.test(f)).sort();

const stats = { files: 0, rows: 0, blanks: 0 };

for (const f of files) {
  stats.files++;
  const wb = XLSX.readFile(path.join(ATT, f));
  // The catalog sheet is the FIRST sheet (named after the MFR, e.g. "TI", "ADI").
  // Some files have additional sheets ("previous sales", "Sheet1"). For ONSEMI's
  // "Sheet1" (Part Number / Alt) we add a second pass below.
  const catalogSheet = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[catalogSheet], { header: 1, defval: null, blankrows: false });
  if (!rows.length) continue;
  const header = rows[0].map(c => cleanCell(c));
  // Expect: Part Number | Target PKG | Manufacturer | TAEJIN P/N | PKG | PIN-To-PIN | Major Difference | Target Device
  const idx = {
    competitor_mpn:    header.findIndex(c => /^part\s*number$/i.test(c)),
    target_pkg:        header.findIndex(c => /target\s*pkg/i.test(c)),
    manufacturer:      header.findIndex(c => /^manufacturer$/i.test(c)),
    htc_mpn:           header.findIndex(c => /taejin/i.test(c)),
    htc_pkg:           header.findIndex(c => /^pkg$/i.test(c)),
    match_grade:       header.findIndex(c => /pin.?to.?pin/i.test(c)),
    major_difference:  header.findIndex(c => /major.*difference/i.test(c)),
  };
  if (idx.competitor_mpn < 0 || idx.htc_mpn < 0) {
    console.warn(`  ! ${f}: catalog header missing required cols, found: ${header.join(' | ')}`);
    continue;
  }
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const competitor_mpn = cleanMpn(r[idx.competitor_mpn]);
    const htc_mpn = cleanMpn(r[idx.htc_mpn]);
    if (!competitor_mpn || !htc_mpn) { stats.blanks++; continue; }
    const vendor_raw = idx.manufacturer >= 0 ? cleanCell(r[idx.manufacturer]) : '';
    const vendor = normalizeBrand(vendor_raw);
    const target_pkg = idx.target_pkg >= 0 ? cleanCell(r[idx.target_pkg]) : '';
    const htc_pkg = idx.htc_pkg >= 0 ? cleanCell(r[idx.htc_pkg]) : '';
    const match_grade = idx.match_grade >= 0 ? cleanCell(r[idx.match_grade]) : '';
    const major_diff = idx.major_difference >= 0 ? cleanCell(r[idx.major_difference]) : '';
    out.push([
      JSON.stringify(competitor_mpn),
      JSON.stringify(htc_mpn),
      JSON.stringify(vendor),
      JSON.stringify(match_grade),
      JSON.stringify(target_pkg),
      JSON.stringify(htc_pkg),
      JSON.stringify(major_diff),
      JSON.stringify(f),
    ].join(','));
    stats.rows++;
  }

  // ONSEMI has a supplementary "Sheet1" with Part Number / Alt
  if (/onsemi/i.test(f)) {
    const sheet1 = wb.SheetNames.find(n => /sheet1/i.test(n));
    if (sheet1) {
      const sup = XLSX.utils.sheet_to_json(wb.Sheets[sheet1], { header: 1, defval: null, blankrows: false });
      if (sup.length > 1) {
        for (let i = 1; i < sup.length; i++) {
          const competitor_mpn = cleanMpn(sup[i][0]);
          const htc_mpn = cleanMpn(sup[i][1]);
          if (!competitor_mpn || !htc_mpn) { stats.blanks++; continue; }
          out.push([
            JSON.stringify(competitor_mpn),
            JSON.stringify(htc_mpn),
            JSON.stringify('ON Semiconductor'),
            JSON.stringify(''),  // no grade given in Sheet1
            JSON.stringify(''),
            JSON.stringify(''),
            JSON.stringify(''),
            JSON.stringify(`${f}#Sheet1`),
          ].join(','));
          stats.rows++;
        }
      }
    }
  }
}

fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`Parsed ${stats.files} files, ${stats.rows} catalog rows (${stats.blanks} blank-skipped) → ${OUT}`);
