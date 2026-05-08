// Audit the MFR mismatches we dropped — are any of them aliases / acquisitions
// that shared/mfr-equivalence.js failed to catch?

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { computeMfrMatch, canonicalMfr } = require('../../shared/mfr-equivalence');

const SQL = fs.readFileSync(path.join(__dirname, 'qq_1132324.sql'), 'utf8')
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

  const under = rows.filter(r => r['vs Target'] === 'UNDER');
  const dropped = under.filter(r => computeMfrMatch(r['RFQ MFR'], r['Supplier MFR']) === 'MISMATCH');

  // Group by unique (RFQ MFR, Supplier MFR) pair
  const pairs = new Map();
  for (const r of dropped) {
    const k = `${(r['RFQ MFR']||'').trim()} || ${(r['Supplier MFR']||'').trim()}`;
    if (!pairs.has(k)) pairs.set(k, { rfqMfr: r['RFQ MFR'], supMfr: r['Supplier MFR'], cpcs: new Set(), examples: [] });
    pairs.get(k).cpcs.add(r['CPC']);
    if (pairs.get(k).examples.length < 2) pairs.get(k).examples.push(r['CPC']);
  }

  console.log(`\n=== MFR pairs dropped as MISMATCH (${dropped.length} VQ rows, ${pairs.size} unique pairs) ===\n`);
  console.log(`${'RFQ MFR'.padEnd(35)} ${'Supplier MFR'.padEnd(30)} ${'Canon RFQ'.padEnd(20)} ${'Canon Sup'.padEnd(20)} CPCs Example`);
  console.log('-'.repeat(140));
  for (const [k, v] of [...pairs.entries()].sort((a, b) => b[1].cpcs.size - a[1].cpcs.size)) {
    const canonR = canonicalMfr(v.rfqMfr) || '(blank)';
    const canonS = canonicalMfr(v.supMfr) || '(blank)';
    console.log(
      `${(v.rfqMfr||'(blank)').padEnd(35).slice(0,35)} ` +
      `${(v.supMfr||'(blank)').padEnd(30).slice(0,30)} ` +
      `${canonR.padEnd(20).slice(0,20)} ` +
      `${canonS.padEnd(20).slice(0,20)} ` +
      `${String(v.cpcs.size).padStart(4)} ${v.examples[0]}`
    );
  }
})().catch(err => { console.error(err); process.exit(1); });
