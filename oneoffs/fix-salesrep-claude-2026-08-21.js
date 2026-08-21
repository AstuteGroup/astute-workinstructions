#!/usr/bin/env node
// One-time backfill: c_order.SalesRep_ID was left as Claude Harris (1049524)
// on 39 open (docstatus='IP') POs — the "auto-corrects buyer" logic in
// tickVQForPurchase() only ever patches chuboe_vq_line.chuboe_buyer_id, never
// c_order.SalesRep_ID on the PO document itself. Every one of these POs maps
// to exactly one RFQ with a real, unambiguous chuboe_rfq.salesrep_id — use
// that as the correction source.
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { execSync } = require('child_process');
const { patchRecord } = require('../shared/record-updater');

const APPLY = process.argv.includes('--apply');
const startIdx = process.argv.indexOf('--start');
const endIdx = process.argv.indexOf('--end');
const START = startIdx >= 0 ? parseInt(process.argv[startIdx + 1], 10) : 0;
const END = endIdx >= 0 ? parseInt(process.argv[endIdx + 1], 10) : Infinity;

function psqlJsonRows(innerSql) {
  const sql = `SELECT row_to_json(t) FROM (${innerSql}) t;`;
  const out = execSync(`psql -U analytics_user -d idempiere_replica -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

(async () => {
  const rows = psqlJsonRows(`
    SELECT o.c_order_id, o.documentno, MIN(r.salesrep_id) AS correct_salesrep_id, MIN(u.name) AS correct_name
    FROM adempiere.c_orderline ol
    JOIN adempiere.c_order o ON ol.c_order_id = o.c_order_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON ol.chuboe_vq_line_id = vq.chuboe_vq_line_id
    LEFT JOIN adempiere.chuboe_rfq r ON vq.chuboe_rfq_id = r.chuboe_rfq_id
    LEFT JOIN adempiere.ad_user u ON u.ad_user_id = r.salesrep_id
    WHERE o.issotrx='N' AND o.isactive='Y' AND ol.isactive='Y' AND o.docstatus='IP'
      AND o.salesrep_id = 1049524
    GROUP BY o.c_order_id, o.documentno
    ORDER BY o.documentno
  `);

  console.log(`${rows.length} POs to fix. Processing slice [${START}, ${END}).`);
  for (const r of rows.slice(START, END)) {
    if (r.correct_salesrep_id == null) {
      console.log(`SKIP ${r.documentno} — no resolvable salesrep`);
      continue;
    }
    if (APPLY) {
      await patchRecord('c_order', r.c_order_id, { SalesRep_ID: r.correct_salesrep_id });
      console.log(`PATCHED ${r.documentno} → ${r.correct_name} (${r.correct_salesrep_id})`);
    } else {
      console.log(`would patch ${r.documentno} → ${r.correct_name} (${r.correct_salesrep_id})`);
    }
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
