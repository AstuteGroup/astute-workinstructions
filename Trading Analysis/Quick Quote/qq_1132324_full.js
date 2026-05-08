// QQ 1132324 (Honeywell PPV) — full-RFQ funnel with MFR-equivalence + restricted-MFR gate
// Stages the count at each filter so we can see what survives.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { computeMfrMatch, canonicalMfr } = require('../../shared/mfr-equivalence');

const RESTRICTED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../shared/restricted-mfrs.json'), 'utf8'
));

// Distributor names that customers sometimes put in their AVL MFR field by mistake.
// When detected, we treat RFQ MFR as "unknown" and trust the supplier MFR.
// Carefully excludes FTDI (Future Technology Devices International — real semi co).
function isDistributorName(mfr) {
  if (!mfr) return false;
  const s = String(mfr).toLowerCase().trim();
  if (/^future technology devices/.test(s)) return false; // FTDI — real chip MFR
  return /^(arrow|future electronics|mouser electronics|mouser$|digi.?key|newark|avnet|farnell|element.?14|tti inc|tti$|premier farnell|rs components|rs pro|verical)\b/.test(s)
      || /\b(electronics inc|electronics ltd|electronics corp|electronics gmbh|electronics uk|electronics international|electronics emg)\b/.test(s) && /^(arrow|future|mouser|avnet|premier|tti)/.test(s);
}

function isRestricted(mfrText) {
  if (!mfrText) return false;
  const lower = String(mfrText).toLowerCase().trim();
  for (const r of RESTRICTED.restricted_mfrs) {
    for (const pat of r.name_patterns) {
      if (new RegExp(pat).test(lower)) return { canonical: r.canonical };
    }
  }
  // Also check via canonicalization (catches ADI↔Maxim↔Linear chains)
  const canon = canonicalMfr(mfrText);
  for (const r of RESTRICTED.restricted_mfrs) {
    if (canon && canon.toLowerCase() === r.canonical.toLowerCase()) {
      return { canonical: r.canonical };
    }
  }
  return false;
}

const SQL = fs.readFileSync(path.join(__dirname, 'qq_1132324.sql'), 'utf8')
  // strip the $3K filter for full-count run
  .replace(/AND \(pv\.rfq_target \* pv\.rfq_qty\) > 3000/, '');

(async () => {
  const client = new Client({
    database: 'idempiere_replica',
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
    host: '/var/run/postgresql'
  });
  await client.connect();

  const { rows } = await client.query(SQL);
  await client.end();

  console.log(`\n=== Honeywell RFQ 1132324 — full opportunity funnel ===\n`);
  console.log(`Stage 0 — raw QQ rows (any opp size, all MFRs):  ${rows.length}`);

  // Stage 1: drop OVER target
  const under = rows.filter(r => r['vs Target'] === 'UNDER');
  console.log(`Stage 1 — UNDER target only:                     ${under.length}`);

  // Stage 2a: rescue rows where RFQ MFR is actually a distributor name
  // (Honeywell AVL feed has 13% of lines with distributors in the MFR field)
  let rescued = 0;
  for (const r of under) {
    if (isDistributorName(r['RFQ MFR'])) {
      r['_rfq_mfr_was_distributor'] = r['RFQ MFR'];
      r['RFQ MFR'] = ''; // treat as unknown, trust supplier MFR
      rescued++;
    }
  }
  console.log(`Stage 2a — rescued rows with distributor RFQ MFR:  ${rescued}`);

  // Stage 2b: drop true MFR mismatch (MISMATCH flag from mfr-equivalence)
  // — keep '' (match or now-blanked from rescue) and '?' (one side blank)
  const mfrFiltered = under.filter(r => {
    const flag = computeMfrMatch(r['RFQ MFR'], r['Supplier MFR']);
    return flag !== 'MISMATCH';
  });
  console.log(`Stage 2b — MFR equivalence passes (drop MISMATCH): ${mfrFiltered.length}`);

  // Stage 3: drop restricted MFRs (ADI/Maxim/Linear/TI on RFQ side)
  // We check RFQ MFR — if the customer is asking for a restricted MFR, we can't fulfill it franchise.
  // Also check Supplier MFR for completeness (a supplier offering a restricted-equivalent sub).
  const nonRestricted = mfrFiltered.filter(r => {
    const rfqRest = isRestricted(r['RFQ MFR']);
    const supRest = isRestricted(r['Supplier MFR']);
    return !rfqRest && !supRest;
  });
  console.log(`Stage 3 — drop restricted MFRs (ADI/Max/LT/TI):  ${nonRestricted.length}`);

  // Stage 4: dedupe to one row per CPC (best GP$)
  const byCpc = new Map();
  for (const r of nonRestricted) {
    const cpc = r['CPC'];
    const gp = parseFloat(r['Quoted GP']) || 0;
    const cur = byCpc.get(cpc);
    if (!cur || gp > parseFloat(cur['Quoted GP'])) byCpc.set(cpc, r);
  }
  const dedup = [...byCpc.values()];
  console.log(`Stage 4 — dedupe to best-GP row per CPC:         ${dedup.length}`);

  // Bucket by opp size
  const buckets = { '$10K+': 0, '$3K-10K': 0, '$1K-3K': 0, '<$1K': 0 };
  let totalOpp = 0, totalGP = 0;
  for (const r of dedup) {
    const opp = parseFloat(r['Opp Amount']) || 0;
    const gp = parseFloat(r['Quoted GP']) || 0;
    totalOpp += opp;
    totalGP += gp;
    if (opp >= 10000) buckets['$10K+']++;
    else if (opp >= 3000) buckets['$3K-10K']++;
    else if (opp >= 1000) buckets['$1K-3K']++;
    else buckets['<$1K']++;
  }
  console.log(`\n=== Final survivors (${dedup.length} CPCs) by opp size ===`);
  for (const [bucket, n] of Object.entries(buckets)) {
    console.log(`  ${bucket.padEnd(10)} ${n}`);
  }
  console.log(`\nTotal opp $:  $${totalOpp.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`);
  console.log(`Total GP $:   $${totalGP.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`);

  // Top 20 by GP$
  const top = dedup.sort((a, b) => parseFloat(b['Quoted GP']) - parseFloat(a['Quoted GP'])).slice(0, 20);
  console.log(`\n=== Top 20 by GP$ ===`);
  console.log(`${'CPC'.padEnd(28)} ${'RFQ MFR'.padEnd(28)} ${'Supplier'.padEnd(22)} ${'Cost'.padStart(10)} ${'Resale'.padStart(10)} ${'GP $'.padStart(12)} ${'Opp $'.padStart(12)}`);
  for (const r of top) {
    console.log(
      `${(r['CPC']||'').padEnd(28).slice(0,28)} ` +
      `${(r['RFQ MFR']||'').padEnd(28).slice(0,28)} ` +
      `${(r['Supplier']||'').padEnd(22).slice(0,22)} ` +
      `$${parseFloat(r['VQ Cost (USD)']).toFixed(4).padStart(9)} ` +
      `$${parseFloat(r['Suggested Resale']).toFixed(4).padStart(9)} ` +
      `$${parseFloat(r['Quoted GP']).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).padStart(11)} ` +
      `$${parseFloat(r['Opp Amount']).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).padStart(11)}`
    );
  }

  // Save AVL+non-restricted full survivor list to CSV
  const outPath = path.join(__dirname, 'output', 'Quick Quote 1132324 2026-04-27 Honeywell AVL.csv');
  const cols = Object.keys(dedup[0]);
  const csv = [
    cols.map(c => `"${c}"`).join(','),
    ...dedup
      .sort((a, b) => parseFloat(b['Quoted GP']) - parseFloat(a['Quoted GP']))
      .map(r => cols.map(c => {
        const v = r[c];
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
  ].join('\n');
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote AVL-filtered CSV: ${outPath}`);
})().catch(err => { console.error(err); process.exit(1); });
