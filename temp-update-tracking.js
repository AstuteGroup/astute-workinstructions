#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { execSync } = require('child_process');
const fs = require('fs');
const { apiPut } = require('./shared/api-client');

const updates = [
  { po: 'PO809833', mpn: 'R-78C3.3-1.0', tracking: '380698246053', promiseDate: null },
  { po: 'PO811157', mpn: 'INA111AU', tracking: '382537096201', promiseDate: '2026-07-20' },
  { po: 'PO811157', mpn: 'TPS78618DCQR', tracking: '382537096201', promiseDate: '2026-07-20' },
  { po: 'PO811157', mpn: 'LM317S/NOPB', tracking: '382537096201', promiseDate: '2026-07-20' },
  { po: 'PO810932', mpn: '94HAB16WRT', tracking: '531734144778', promiseDate: null },
  { po: 'PO810932', mpn: 'RC0805JR-0747KL', tracking: '531734144778', promiseDate: null },
  { po: 'PO810932', mpn: 'RC0805JR-073K3L', tracking: '531734144778', promiseDate: null },
  { po: 'PO810932', mpn: 'RC0805JR-077K5L', tracking: '531734144778', promiseDate: null },
  { po: 'PO810932', mpn: 'RC0805JR-072K4L', tracking: '531734144778', promiseDate: null },
  { po: 'PO810932', mpn: '08053G105ZAT2A', tracking: '531734144778', promiseDate: null },
  { po: 'PO810928', mpn: 'EEEFC1V220P', tracking: '382268232906', promiseDate: null },
  { po: 'PO810928', mpn: 'CB3LV-3C-24M000000', tracking: '382268232906', promiseDate: null },
  { po: 'PO810928', mpn: 'EEE1VA331P', tracking: '382268232906', promiseDate: null },
  { po: 'PO810928', mpn: '164A17369X', tracking: null, promiseDate: '2026-08-24' },
  { po: 'PO810928', mpn: 'DSP2A-DC24V', tracking: '382268232906', promiseDate: null },
];

function runPsql(sql, label) {
  const tmpSql = `/tmp/tracking_${label}.sql`;
  const tmpOut = `/tmp/tracking_${label}.out`;
  fs.writeFileSync(tmpSql, sql);
  try {
    execSync(`psql -U analytics_user -d idempiere_replica -t -A -F '|' -f ${tmpSql} -o ${tmpOut}`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
      console.error(`  WARNING: psql ${label} failed: ${(e.message || '').slice(0, 300)}`);
    }
  }
  return fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
}

async function main() {
  // First get all order line IDs
  const sql = `
    SELECT
      o.documentno AS po,
      TRIM(ol.chuboe_mpn) AS mpn,
      ol.c_orderline_id,
      COALESCE(ol.chuboe_trackingnumbers, '') AS current_tracking,
      ol.datepromised::date AS current_promise
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    WHERE o.documentno IN ('PO809833', 'PO811157', 'PO810932', 'PO810928')
      AND ol.isactive = 'Y'
    ORDER BY o.documentno, ol.c_orderline_id;
  `;

  const result = runPsql(sql, 'lookup');

  const lines = {};
  for (const row of result.trim().split('\n').filter(r => r.includes('|'))) {
    const [po, mpn, id, curTracking, curPromise] = row.split('|');
    const key = `${po.trim()}|${mpn.trim()}`;
    lines[key] = {
      id: parseInt(id),
      curTracking: (curTracking || '').trim(),
      curPromise: (curPromise || '').trim()
    };
  }

  console.log('Order lines found:', Object.keys(lines).length);

  // Now patch each line
  for (const upd of updates) {
    const key = `${upd.po}|${upd.mpn}`;
    const line = lines[key];

    if (!line) {
      console.log(`  ✗ NOT FOUND: ${key}`);
      continue;
    }

    const patch = {};
    if (upd.tracking) {
      patch.Chuboe_TrackingNumbers = upd.tracking;
    }
    if (upd.promiseDate) {
      patch.DatePromised = upd.promiseDate;
    }

    if (Object.keys(patch).length === 0) {
      console.log(`  - SKIP (no changes): ${key}`);
      continue;
    }

    try {
      await apiPut('c_orderline', line.id, patch);
      const changes = [];
      if (upd.tracking) changes.push(`tracking=${upd.tracking}`);
      if (upd.promiseDate) changes.push(`promise=${upd.promiseDate}`);
      console.log(`  ✓ ${upd.po} | ${upd.mpn} → ${changes.join(', ')}`);
    } catch (err) {
      console.log(`  ✗ ERROR ${key}: ${err.message}`);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
