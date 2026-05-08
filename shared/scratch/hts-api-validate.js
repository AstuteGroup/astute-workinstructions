/**
 * Validate shared/hts-api.js against real HTS codes from VQ data.
 * Pulls the top N most-traded codes, looks each up, prints duty info.
 */

const { execSync } = require('child_process');
const { lookupHts, parseFootnotes, undottedHtsCode } = require('../hts-api');

function topHtsFromVQ(limit = 12) {
  const sql = `
    SELECT chuboe_hts, COUNT(*) AS rows
    FROM adempiere.chuboe_vq_line
    WHERE chuboe_hts IS NOT NULL AND isactive='Y'
    GROUP BY chuboe_hts
    ORDER BY rows DESC
    LIMIT ${limit};
  `.trim();
  const out = execSync(`psql -t -A -F '|' -c "${sql.replace(/\n\s+/g, ' ')}"`, { encoding: 'utf-8' });
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [code, rows] = line.split('|');
    return { code: code.trim(), rows: parseInt(rows, 10) };
  });
}

function fmt(s) { return s == null || s === '' ? '—' : s; }

async function main() {
  const top = topHtsFromVQ(12);
  console.log(`Validating ${top.length} most-traded HTS codes from chuboe_vq_line\n`);

  for (const { code, rows } of top) {
    let result;
    try { result = await lookupHts(code); }
    catch (err) { console.log(`${code} (${rows} rows) → ERROR: ${err.message}\n`); continue; }

    if (!result) { console.log(`${code} (${rows} rows) → NOT FOUND in USITC schedule\n`); continue; }

    console.log(`${code} (${rows} VQ rows) → ${result.htsno}${result.dutyHtsno && result.dutyHtsno !== result.htsno ? ` (duty from ${result.dutyHtsno})` : ''}`);
    console.log(`  ${result.description}`);
    console.log(`  General (MFN):   ${fmt(result.general)}`);
    console.log(`  Special (FTA):   ${fmt(result.special).slice(0, 90)}${(result.special || '').length > 90 ? '...' : ''}`);
    console.log(`  Other (Col 2):   ${fmt(result.other)}`);
    console.log(`  Units:           ${result.units.join(', ') || '—'}`);
    if (result.sec301Refs.length) console.log(`  Section 301 refs: ${result.sec301Refs.join(', ')}`);
    if (result.sec232Refs.length) console.log(`  Section 232 refs: ${result.sec232Refs.join(', ')}`);
    if (result.antidumpingRefs.length) console.log(`  AD/CVD refs:      ${result.antidumpingRefs.join(', ')}`);
    if (result.otherRefs.length) console.log(`  Other footnotes:  ${result.otherRefs.slice(0, 2).join(' | ')}`);

    // If there's a Sec 301 ref, resolve the supplementary line so we can see the actual duty
    for (const ref of result.sec301Refs.slice(0, 1)) {
      try {
        const sup = await lookupHts(ref);
        if (sup) console.log(`  → ${ref}: ${sup.general || '—'} (${sup.description.slice(0, 80)})`);
      } catch { /* ignore */ }
    }
    console.log('');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
