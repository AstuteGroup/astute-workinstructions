#!/usr/bin/env node
/**
 * Convert /tmp/vq-8376-u48suV/mcmaster_sourcing_file (1).csv into the
 * quotes.json shape expected by load-bulk-summary-cli.js.
 *
 * Header: MPN, Description, Pack Size / UOM, Base Price,
 *         Price Break 1 Qty Range, Price Break 1 Price,
 *         Price Break 2 Qty Range, Price Break 2 Price,
 *         Price Break 3 Qty Range, Price Break 3 Price, Lead Time
 *
 * Output written to /tmp/mcmaster-quotes-1134421.json
 */

'use strict';

const fs = require('fs');
const { readCSVFile } = require('/home/analytics_user/workspace/astute-workinstructions/shared/csv-utils');

const SRC = '/tmp/vq-8376-u48suV/mcmaster_sourcing_file (1).csv';
const DST = '/tmp/mcmaster-quotes-1134421.json';

const csv = readCSVFile(SRC);
const idx = {
  MPN: csv.colIndex('MPN'),
  Description: csv.colIndex('Description'),
  Pack: csv.colIndex('Pack Size / UOM'),
  Base: csv.colIndex('Base Price'),
  PB1Range: csv.colIndex('Price Break 1 Qty Range'),
  PB1Price: csv.colIndex('Price Break 1 Price'),
  PB2Range: csv.colIndex('Price Break 2 Qty Range'),
  PB2Price: csv.colIndex('Price Break 2 Price'),
  PB3Range: csv.colIndex('Price Break 3 Qty Range'),
  PB3Price: csv.colIndex('Price Break 3 Price'),
  Lead: csv.colIndex('Lead Time'),
};
const get = (row, key) => (row[idx[key]] || '').trim();

function parseUnitFromBase(baseStr, packStr) {
  // baseStr examples: "$11.51 per pack of 10", "$35.45 each", "$0.76 per ft.", "$0.00 each"
  // packStr examples: "Pack of 10", "Each", "Pack of 100"
  if (!baseStr) return null;
  const m = baseStr.match(/\$([\d,]+\.?\d*)/);
  if (!m) return null;
  const baseNum = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(baseNum)) return null;

  // Pack-of-N → unit = base / N
  const packMatch = (packStr || '').match(/Pack of\s+(\d+)/i);
  if (packMatch) {
    const n = parseInt(packMatch[1], 10);
    if (n > 0) return Math.round((baseNum / n) * 10000) / 10000;
  }
  // Each, per ft., 1 → use base as-is
  return Math.round(baseNum * 10000) / 10000;
}

function leadTimeFromText(t) {
  if (!t) return null;
  const s = t.toLowerCase();
  if (s.includes('tomorrow')) return 'stock';
  if (/(\d+)\s*-\s*(\d+)\s*weeks?/.test(s)) return s.match(/(\d+)\s*-\s*(\d+)\s*weeks?/)[0];
  if (/(\d+)\s*weeks?/.test(s)) return s.match(/(\d+)\s*weeks?/)[0];
  return s;
}

const quotes = [];
const noBids = [];

for (const row of csv.rows) {
  const mpn = get(row, 'MPN');
  if (!mpn) continue;
  const desc = get(row, 'Description');
  const pack = get(row, 'Pack');
  const base = get(row, 'Base');
  const lt = get(row, 'Lead');
  const unit = parseUnitFromBase(base, pack);

  // No-bid criteria: empty pricing or $0.00
  if (unit === null || unit === 0) {
    noBids.push({ mpn, reason: !base ? 'no price returned' : '$0.00 listed' });
    quotes.push({
      vendorName: 'McMaster-Carr',
      vendorSearchKey: '1002922',
      mpn,
      mfr: 'McMaster-Carr',
      qty: 0,
      cost: 0,
      leadTime: null,
      vendorNotes: `No-bid - ${!base ? 'McMaster returned no price for this MPN' : '$0.00 returned, treating as no price'}`,
    });
    continue;
  }

  const notesParts = [`${pack} @ ${base}`];
  // Capture price breaks if present
  for (let i = 1; i <= 3; i++) {
    const qtyRange = get(row, `PB${i}Range`);
    const breakPrice = get(row, `PB${i}Price`);
    if (qtyRange && breakPrice) notesParts.push(`${qtyRange}: ${breakPrice}`);
  }
  if (lt) notesParts.push(`Lead: ${lt}`);

  quotes.push({
    vendorName: 'McMaster-Carr',
    vendorSearchKey: '1002922',
    mpn,
    mfr: 'McMaster-Carr',
    qty: 1,
    cost: unit,
    leadTime: leadTimeFromText(lt),
    vendorNotes: notesParts.join(' | '),
  });
}

fs.writeFileSync(DST, JSON.stringify(quotes, null, 2));
console.log(`Wrote ${DST}`);
console.log(`Quotes: ${quotes.length} total, ${noBids.length} no-bids`);
if (noBids.length) {
  console.log('No-bid MPNs:');
  noBids.forEach(n => console.log(`  ${n.mpn} - ${n.reason}`));
}
console.log('\nFirst 2 quotes:');
console.log(JSON.stringify(quotes.slice(0, 2), null, 2));
