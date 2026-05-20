#!/usr/bin/env node
//
// Updated digest v2 — adds 24h activity table at top with mixed counting rule:
//   • Claude as buyer (API + scraping): COUNT(DISTINCT rfq_line × vendor)
//   • Everyone else: COUNT(*)
// Per the operator (2026-05-20): API responses fan-out stock+LT+qty-break
// variants per (vendor, part) and should collapse; brokers email distinct
// stock batches per row, which are real.
//
// One-off send to operator. Daily recurring cron is a follow-up.

'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { execSync } = require('child_process');
const { createNotifier } = require('../shared/notifier');

const RECIPIENT = 'jake.harris@astutegroup.com';

// Window: 8am EST 2026-05-19 → 8am EST 2026-05-20 (CDT-clock since column is CT-naive)
const WINDOW_START = '2026-05-19 08:00:00';
const WINDOW_END   = '2026-05-20 08:00:00';

const EMAIL_BATCH_RFQS = ['1134681', '1134683', '1133479', '1134814', '1134804'];

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pullActivity() {
  // Mixed counting: distinct for Claude-as-buyer, raw rows for everyone else.
  // Uses a CASE in the SELECT and groups by labeled loader; the distinct count
  // is computed via COUNT(DISTINCT) and the rest is COUNT(*).
  const inSet = EMAIL_BATCH_RFQS.map(r => `'${r}'`).join(',');
  const sql =
    `WITH labeled AS ( ` +
    `SELECT v.chuboe_vq_line_id, v.chuboe_rfq_line_id, v.c_bpartner_id, ` +
    `CASE ` +
    `  WHEN v.createdby = 1049524 AND r.value IN (${inSet}) THEN 'Claude as purchasing support (email loading)' ` +
    `  WHEN v.createdby = 1049524 THEN 'Claude as buyer (API + scraping)' ` +
    `  ELSE COALESCE(u.name, 'unknown') END AS loader ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = v.createdby ` +
    `WHERE v.created >= '${WINDOW_START}'::timestamp AND v.created < '${WINDOW_END}'::timestamp AND v.isactive='Y' ` +
    `) ` +
    `SELECT loader, ` +
    `       CASE WHEN loader = 'Claude as buyer (API + scraping)' ` +
    `            THEN COUNT(DISTINCT (chuboe_rfq_line_id, c_bpartner_id)) ` +
    `            ELSE COUNT(*) END AS vqs ` +
    `FROM labeled GROUP BY loader ORDER BY vqs DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [loader, vqs] = line.split('|');
    return { loader, vqs: Number(vqs) };
  });
}

const activity = pullActivity();
const claudeBuckets = activity.filter(a => a.loader.startsWith('Claude'));
const humans = activity.filter(a => !a.loader.startsWith('Claude'));
const total = activity.reduce((a, x) => a + x.vqs, 0);
const claudeTotal = claudeBuckets.reduce((a, x) => a + x.vqs, 0);
const humanTotal = humans.reduce((a, x) => a + x.vqs, 0);

// Per-batch detail (hard-coded for today's session; dynamic discovery in
// follow-up using outer-envelope-From cross-ref against IMAP)
const batches = [
  {
    n: 1, vqs: 29, onBehalf: 'Ivy Song', forBuyer: 'Betty Song',
    rfqs: ['1134264', '1134964', '1134279', '1134281'],
    reference: '"转发: upload VQ May 13th" — sent 2026-05-19',
    outstanding: 'None — red-row subset recovered via HTML-aware reprocess after initial bounce.',
  },
  {
    n: 2, vqs: 7, onBehalf: 'Ivy Song', forBuyer: 'Molly Huang',
    rfqs: ['1134814', '1134804'],
    reference: '"转发: RFQ -5/19" — sent 2026-05-19',
    outstanding: 'None.',
  },
  {
    n: 3, vqs: 74, onBehalf: 'Ivy Song', forBuyer: 'Molly Huang',
    rfqs: ['1133479'],
    reference: '"转发: Re: RFQ 5/18/2026" — sent 2026-05-20',
    outstanding: 'Buyer attribution corrected mid-day (auto-assigned to Ivy by Tier-A unwrap; patched to Molly to match ownership).',
  },
  {
    n: 4, vqs: 31, onBehalf: 'Ivy Song', forBuyer: 'Elaine Liang',
    rfqs: ['1134681', '1134683'],
    reference: '"转发: 1134681/ 1134683" — sent 2026-05-19',
    outstanding: '1 row recovered manually — PGC tier-2 ESDLIN1524BJ @ $0.305 × 30,000 (an unnamed continuation in the email body); loaded as PGC-IC Ltd.',
  },
];

const grandWritten = batches.reduce((a, b) => a + b.vqs, 0);

function loaderHtml(row) {
  const isClaudeBucket = row.loader.startsWith('Claude');
  return `<tr><td>${isClaudeBucket ? '<b>' + esc(row.loader) + '</b>' : esc(row.loader)}</td><td style="text-align:right">${row.vqs}</td></tr>`;
}

const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">VQ Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(WINDOW_START)} CT → ${esc(WINDOW_END)} CT (24h) · ${total} VQs total</p>

<h3 style="margin-bottom:4px">Activity by loader</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:480px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="right">VQs</th></tr></thead>
<tbody>
${activity.map(loaderHtml).join('\n')}
<tr style="background:#eee"><td><b>Total supply-support</b></td><td style="text-align:right"><b>${total}</b></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Counting rule: <b>Claude as buyer</b> uses COUNT(DISTINCT (rfq_line × vendor)) because API responses fan-out stock + lead-time + qty-break variants per (vendor, part); all other loaders use raw row count because each row represents a distinct stock batch from the vendor.</i></p>

<h3 style="margin-bottom:4px">Batches loaded via vq-loading-agent</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>#</th><th>VQs</th><th>On behalf of</th><th>For buyer</th><th>RFQs</th><th>Reference</th><th>Outstanding</th></tr></thead>
<tbody>
${batches.map(b => `
<tr>
<td>${b.n}</td>
<td><b>${b.vqs}</b></td>
<td>${esc(b.onBehalf)}</td>
<td>${esc(b.forBuyer)}</td>
<td>${b.rfqs.length} RFQ${b.rfqs.length > 1 ? 's' : ''}:<br/>${b.rfqs.join(', ')}</td>
<td>${esc(b.reference)}</td>
<td>${esc(b.outstanding)}</td>
</tr>`).join('\n')}
<tr style="background:#eee"><td colspan="6" align="right"><b>Batch total:</b></td><td><b>${grandWritten}</b></td></tr>
</tbody>
</table>

<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by send-vq-digest-v2-2026-05-20.js · Window: ${esc(WINDOW_START)} → ${esc(WINDOW_END)} CT (CT-naive timestamps per chuboe_*.created convention).
</p>
</body></html>`;

(async () => {
  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'VQ Loading — Daily Digest',
  });
  await notifier.sendEmail(
    RECIPIENT,
    'VQ Loading — Daily Digest (May 19–20)',
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENT}`);
  console.log(`Activity: ${claudeTotal} from Claude (${claudeBuckets.map(c => c.vqs).join(' / ')}) + ${humanTotal} from humans = ${total} total`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
