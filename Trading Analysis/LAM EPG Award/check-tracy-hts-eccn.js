/**
 * Sweep DigiKey + Mouser + TTI for HTS/ECCN on Tracy's 15 MPNs.
 * Goal: surface anything controlled (3A001, 5A002, ITAR, etc.) before we
 * commit to buying parts that may have export/import restrictions.
 *
 * Output: per-MPN summary with the best HTS/ECCN we found and a flag for
 *         anything that warrants manual review.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { searchAllDistributors } = require('../../shared/franchise-api');

const MPNS = [
  'EPM1270T144C4N',
  'EPM240T100C4N',
  '5M1270ZT144C5N',
  'XCZU4CG-1SFVC784E',
  'XC6SLX100-3FGG484C',
  'LT1499CS#PBF',
  'ADA4891-2ARZ',
  'LT8645SEV#PBF',
  'AD5696RBRUZ',
  'LT1376HVIS#PBF',
  'AD586KRZ',
  'ADG431BRZ',
  'LTC4231HMS-1#PBF',
  'AD5292BRUZ-20',
  '524MILF',
];

// ECCN codes that aren't EAR99 — anything in this list deserves a closer look
// when shipping HK→US or US→HK. Not exhaustive, just a sanity flag.
const CONTROLLED_ECCN_PREFIX = ['3A001', '3A991', '5A002', '5A992', '5D002', '4A003', '0A987'];

function flagEccn(eccn) {
  if (!eccn) return null;
  const u = eccn.toUpperCase().trim();
  if (u === 'EAR99') return null; // common, no concern
  if (CONTROLLED_ECCN_PREFIX.some(p => u.startsWith(p))) return `controlled (${u})`;
  return `non-EAR99 (${u})`;
}

(async () => {
  const results = [];
  for (const mpn of MPNS) {
    process.stdout.write(`[hts-eccn] ${mpn} ... `);
    try {
      const r = await searchAllDistributors(mpn, { qty: 1, includeNoResults: true });
      // Pull HTS/ECCN from any distributor that returned them
      const hts = new Set();
      const eccn = new Set();
      const sources = [];
      for (const d of (r.distributors || [])) {
        const h = d.vqHts || d.raw?.vqHts;
        const e = d.vqEccn || d.raw?.vqEccn;
        if (h) { hts.add(String(h).trim()); sources.push(`${d.name}:HTS`); }
        if (e) { eccn.add(String(e).trim()); sources.push(`${d.name}:ECCN`); }
      }
      results.push({ mpn, hts: [...hts], eccn: [...eccn], sources });
      console.log(`HTS=[${[...hts].join(',')||'∅'}]  ECCN=[${[...eccn].join(',')||'∅'}]`);
    } catch (e) {
      results.push({ mpn, error: e.message.slice(0, 200) });
      console.log(`ERR ${e.message.slice(0, 100)}`);
    }
  }

  console.log('\n=== HTS/ECCN SWEEP RESULTS ===\n');
  console.log('MPN'.padEnd(22), 'HTS'.padEnd(15), 'ECCN'.padEnd(12), 'Flag');
  console.log('-'.repeat(80));
  for (const r of results) {
    const hts = (r.hts?.[0] || '').padEnd(15);
    const eccn = (r.eccn?.[0] || '').padEnd(12);
    const flag = r.eccn?.length ? (flagEccn(r.eccn[0]) || 'OK') : (r.error ? 'ERR' : 'no data');
    console.log(r.mpn.padEnd(22), hts, eccn, flag);
  }

  // Persist for the loader script
  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, 'tracy-hts-eccn.json'), JSON.stringify(results, null, 2));
  console.log(`\nSaved to tracy-hts-eccn.json`);
})().catch(e => { console.error(e); process.exit(1); });
