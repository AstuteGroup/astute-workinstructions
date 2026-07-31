#!/usr/bin/env node
/**
 * Analyze API call volume vs RFQ/VQ volume for the past 30 days
 */

const { psqlQuery } = require('../shared/db-helpers');

function parseRows(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [day, cnt] = line.split('|');
    return { day, cnt: parseInt(cnt) || 0 };
  });
}

function main() {
  // RFQ Lines created
  const rfqRaw = psqlQuery(`
    SELECT to_char(date_trunc('day', created), 'YYYY-MM-DD') as day, count(*) as cnt
    FROM chuboe_rfq_line WHERE created > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  // RFQ Line MPNs (what enrichment processes - each MPN = 10 API calls)
  const mpnRaw = psqlQuery(`
    SELECT to_char(date_trunc('day', rl.created), 'YYYY-MM-DD') as day,
           count(distinct rlm.chuboe_rfq_line_mpn_id) as cnt
    FROM chuboe_rfq_line_mpn rlm
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = rlm.chuboe_rfq_line_id
    WHERE rl.created > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  // VQ Lines created
  const vqRaw = psqlQuery(`
    SELECT to_char(date_trunc('day', created), 'YYYY-MM-DD') as day, count(*) as cnt
    FROM chuboe_vq_line WHERE created > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1
  `);

  const rfqRows = parseRows(rfqRaw);
  const mpnRows = parseRows(mpnRaw);
  const vqRows = parseRows(vqRaw);

  const rfqMap = Object.fromEntries(rfqRows.map(r => [r.day, r.cnt]));
  const mpnMap = Object.fromEntries(mpnRows.map(r => [r.day, r.cnt]));
  const vqMap = Object.fromEntries(vqRows.map(r => [r.day, r.cnt]));

  const days = [...new Set([
    ...rfqRows.map(r => r.day),
    ...mpnRows.map(r => r.day),
    ...vqRows.map(r => r.day)
  ])].sort();

  console.log('Day'.padEnd(12), 'RFQ Lines'.padStart(10), 'MPNs'.padStart(10), 'Est.Calls'.padStart(10), 'VQ Lines'.padStart(10));
  console.log('-'.repeat(55));

  let totalRfq = 0, totalMpn = 0, totalVq = 0;

  days.forEach(day => {
    const rfq = rfqMap[day] || 0;
    const mpn = mpnMap[day] || 0;
    const vq = vqMap[day] || 0;
    totalRfq += rfq;
    totalMpn += mpn;
    totalVq += vq;
    console.log(
      day.padEnd(12),
      String(rfq).padStart(10),
      String(mpn).padStart(10),
      String(mpn * 10).padStart(10),
      String(vq).padStart(10)
    );
  });

  console.log('-'.repeat(55));
  console.log(
    'TOTAL'.padEnd(12),
    String(totalRfq).padStart(10),
    String(totalMpn).padStart(10),
    String(totalMpn * 10).padStart(10),
    String(totalVq).padStart(10)
  );

  console.log('');
  console.log('Est. API Calls = MPNs × 10 distributors =', (totalMpn * 10).toLocaleString());
  console.log('Avg per day =', Math.round(totalMpn * 10 / days.length).toLocaleString());
}

main();
