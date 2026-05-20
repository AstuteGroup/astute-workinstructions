#!/usr/bin/env node
//
// Deactivate the 293 VQs written by UID 8516 today (2026-05-20 04:30-05:00 CT)
// across RFQs 1134279/1134964/1134264/1134281/1134282. These were loaded against
// Betty Song's explicit "only red-highlighted rows" instruction — UID 8508 was
// bounced for that reason; UID 8516 was a text-format resend that lost Betty's
// chain, so the agent loaded everything.
//
// All 293 confirmed IsPurchased='N' before the run (purchase-status query
// 2026-05-20). The FULL set is being deactivated — including any that may
// overlap Betty's red subset — so that step 4 (reprocess UID 8508 via the
// HTML-aware pipeline) can be tested against a clean state.

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { patchRecord } = require('../shared/record-updater');

const TARGETS = ['1134279', '1134964', '1134264', '1134281', '1134282'];
const SNAPSHOT_PATH = path.join(process.env.HOME, 'workspace', 'rollback-uid8516-snapshot.csv');

function fetchTargets() {
  const sql =
    `SELECT v.chuboe_vq_line_id, r.value, v.c_bpartner_id, v.chuboe_rfq_line_id, ` +
    `v.cost, v.c_currency_id, v.ispurchased, COALESCE(v.chuboe_mpn,''), COALESCE(v.chuboe_mfr_text,'') ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `WHERE r.value IN (${TARGETS.map(t => `'${t}'`).join(',')}) ` +
    `AND v.created >= '2026-05-20 04:30:00'::timestamp ` +
    `AND v.created <  '2026-05-20 05:00:00'::timestamp ` +
    `AND v.isactive = 'Y'`;
  const out = execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [id, rfq, bp, rfqLine, cost, currency, purchased, mpn, mfr] = line.split('|');
    return {
      id: Number(id),
      rfq,
      bpartnerId: Number(bp),
      rfqLineId: Number(rfqLine),
      cost,
      currencyId: currency,
      purchased,
      mpn,
      mfr,
    };
  });
}

function csvField(s) {
  if (s == null) return '';
  const v = String(s);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

(async () => {
  console.log('=== Fetching VQ targets ===');
  const targets = fetchTargets();
  console.log(`Found ${targets.length} VQs.\n`);

  const purchased = targets.filter(t => t.purchased === 'Y');
  if (purchased.length > 0) {
    console.error(`ABORT: ${purchased.length} of ${targets.length} are IsPurchased='Y'. Halting.`);
    console.error('Purchased IDs:', purchased.map(t => t.id).join(','));
    process.exit(1);
  }
  console.log(`Confirmed: 0/${targets.length} purchased. Proceeding.\n`);

  const header = 'vq_id,rfq,bpartner_id,rfq_line_id,cost,currency_id,mpn,mfr,patch_status,patch_error';
  fs.writeFileSync(SNAPSHOT_PATH, header + '\n');

  console.log('=== Deactivating ===');
  let ok = 0, fail = 0;
  for (const t of targets) {
    let status = 'ok', error = '';
    try {
      const result = await patchRecord('chuboe_vq_line', t.id, { IsActive: 'N' }, {
        source: 'rollback-uid8516-2026-05-20',
      });
      if (result && result.status && result.status !== 'ok' && result.status !== 'patched') {
        status = result.status;
        error = JSON.stringify(result).slice(0, 300);
        fail++;
      } else {
        ok++;
      }
    } catch (err) {
      status = 'fail';
      error = String(err && err.message ? err.message : err).slice(0, 300);
      fail++;
    }
    const csv = [
      t.id, t.rfq, t.bpartnerId, t.rfqLineId, t.cost, t.currencyId,
      csvField(t.mpn), csvField(t.mfr), status, csvField(error),
    ].join(',');
    fs.appendFileSync(SNAPSHOT_PATH, csv + '\n');
    if ((ok + fail) % 25 === 0) {
      console.log(`  Progress: ${ok + fail}/${targets.length} (${ok} ok, ${fail} fail)`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Deactivated: ${ok}`);
  console.log(`Failed: ${fail}`);
  console.log(`Snapshot: ${SNAPSHOT_PATH}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
