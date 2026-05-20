#!/usr/bin/env node
//
// Patch the 74 VQs on RFQ 1133479 written by UID 8515/8517 (Ivy's "RFQ
// 5/18/2026" consolidated batch for Molly Huang). The agent's Tier-A
// forwarder-vs-owner unwrap stopped at Ivy Song (1013784) and assigned her
// as chuboe_buyer_id. The actual buyer per operator intent is Molly Huang
// (1011012). Same forwarder-fallback defect already logged in deferred-work.
//
// Scope: only the 74 VQs created in the 09:30-10:00 UTC window on 2026-05-20
// with current chuboe_buyer_id = 1013784. Idempotent — re-running is safe.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const { patchRecord } = require('../shared/record-updater');

const SNAPSHOT = path.join(process.env.HOME, 'workspace', 'patch-buyer-1133479-snapshot.csv');
const OLD_BUYER = 1013784; // Ivy Song
const NEW_BUYER = 1011012; // Molly Huang

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function fetchTargets() {
  const sql =
    `SELECT v.chuboe_vq_line_id, v.chuboe_mpn, bp.name AS vendor, v.cost, v.qty ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id ` +
    `WHERE r.value = '1133479' ` +
    `AND v.chuboe_buyer_id = ${OLD_BUYER} ` +
    `AND v.created BETWEEN '2026-05-20 04:30:00'::timestamp AND '2026-05-20 05:00:00'::timestamp ` +
    `AND v.isactive='Y'`;
  return psqlPipe(sql).trim().split('\n').filter(Boolean).map(line => {
    const [id, mpn, vendor, cost, qty] = line.split('|');
    return { id: Number(id), mpn, vendor, cost, qty };
  });
}

function csvField(s) {
  if (s == null) return '';
  const v = String(s);
  return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
}

(async () => {
  const targets = fetchTargets();
  console.log(`Found ${targets.length} VQs with chuboe_buyer_id=${OLD_BUYER} (Ivy) on RFQ 1133479 in load window\n`);
  if (targets.length === 0) {
    console.log('Nothing to patch.');
    return;
  }

  fs.writeFileSync(SNAPSHOT, 'vq_id,mpn,vendor,cost,qty,patch_status,patch_error\n');

  let ok = 0, fail = 0;
  for (const t of targets) {
    let status = 'ok', error = '';
    try {
      const result = await patchRecord('chuboe_vq_line', t.id, { Chuboe_Buyer_ID: NEW_BUYER }, {
        source: 'patch-buyer-1133479-2026-05-20',
      });
      if (result && result.status && result.status !== 'ok' && result.status !== 'patched') {
        status = result.status;
        error = JSON.stringify(result).slice(0, 280);
        fail++;
      } else {
        ok++;
      }
    } catch (err) {
      status = 'fail';
      error = String(err && err.message ? err.message : err).slice(0, 280);
      fail++;
    }
    fs.appendFileSync(SNAPSHOT, [t.id, csvField(t.mpn), csvField(t.vendor), t.cost, t.qty, status, csvField(error)].join(',') + '\n');
    if ((ok + fail) % 20 === 0) console.log(`  Progress: ${ok + fail}/${targets.length} (${ok} ok, ${fail} fail)`);
  }
  console.log(`\nDone. ${ok} patched, ${fail} failed.`);
  console.log(`Snapshot: ${SNAPSHOT}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
