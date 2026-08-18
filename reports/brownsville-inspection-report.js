#!/usr/bin/env node
//
// Brownsville OTINs Created — Daily Report
//
// Scheduled daily to surface the previous 24 hours of OTINs
// created at Brownsville (W111).
//
// What the report contains:
//   1. Summary — total OTINs created count
//   2. Detail listing — OTIN, Created, Physical Warehouse, Inv Group, POV#, Line, MPN Received, MFR Received, Qty Received, Bin, Inspector
//
// Purpose: Surface created OTINs for transcription to another system.
//
// Usage:
//   node brownsville-inspection-report.js               # preview to stdout (no send)
//   node brownsville-inspection-report.js --send        # email operator
//   node brownsville-inspection-report.js --since 24    # custom window in hours
//   node brownsville-inspection-report.js --since 48    # backfill 2 days

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Weekend gate — skip Sat/Sun EST to reduce noise
const { exitIfWeekend } = require('../shared/weekend-gate');
exitIfWeekend();

const { execSync } = require('child_process');
const { createNotifier } = require('../shared/notifier');

const BROWNSVILLE_WAREHOUSE_GROUP_ID = 1000008;

const RECIPIENTS = [
  'justin.oberhofer@astutegroup.com',
];

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const sinceIdx = args.indexOf('--since');
const SINCE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : 24;

function psqlPipe(sql) {
  // Explicitly use OS user to override PGUSER env var set by cron
  // (cron sets PGUSER=analytics_user for write jobs, but this is read-only)
  const user = require('os').userInfo().username;
  // Suppress NOTICE messages (Conversion Rate Not Found spam from the view)
  // Use separate -c for SET so it doesn't appear in output
  return execSync(`psql -U ${user} -d idempiere_replica -t -A -F'|' -v ON_ERROR_STOP=1 -c "SET client_min_messages TO WARNING" -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatQty(n) {
  return Number(n).toLocaleString();
}

// Convert UTC Date → CT-naive timestamp string
function utcToCTNaive(d) {
  const ct = new Date(d.getTime() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  // Detail listing query - pulls MPN/MFR/Qty from inspection form (not VQ)
  // Inspection attributes are stored in m_attributeinstance linked via chuboe_insprecordasimap
  const detailQuery = `
    WITH insp_attrs AS (
      SELECT
        map.chuboe_insp_lot_id,
        MAX(CASE WHEN attr.name = 'MPN Received' THEN ai.value END) AS mpn_received,
        MAX(CASE WHEN attr.name = 'Manufacturer Received' THEN ai.value END) AS mfr_received,
        MAX(CASE WHEN attr.name = 'Total QTY Received' THEN ai.value END) AS qty_received
      FROM adempiere.chuboe_insprecordasimap map
      JOIN adempiere.m_attributeinstance ai ON map.m_attributesetinstance_id = ai.m_attributesetinstance_id
      JOIN adempiere.m_attribute attr ON ai.m_attribute_id = attr.m_attribute_id
      WHERE attr.name IN ('MPN Received', 'Manufacturer Received', 'Total QTY Received')
        AND map.m_attributesetinstance_id > 0
      GROUP BY map.chuboe_insp_lot_id
    )
    SELECT
      COALESCE(v.chuboe_otin_search, '') AS otin,
      TO_CHAR(v.created, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
      COALESCE(wg.name, '') AS warehouse_group,
      COALESCE(w.name, '') AS warehouse,
      COALESCE(v.chuboe_mpnlot_po, '') AS pov,
      COALESCE(rl.line, 0) AS line_no,
      COALESCE(ia.mpn_received, v.chuboe_mpnlot_mpn) AS mpn_received,
      COALESCE(ia.mfr_received, '') AS mfr_received,
      COALESCE(ia.qty_received, v.chuboe_mpnlot_qty) AS qty_received,
      COALESCE(s.name, '') AS bin_location,
      u.name AS inspector_name,
      CASE WHEN v.isvalidate = 'Y' THEN TO_CHAR(v.updated, 'YYYY-MM-DD HH24:MI:SS') ELSE '' END AS validated_at
    FROM adempiere.chuboe_insp_mpnlotqueue_v v
    LEFT JOIN adempiere.ad_user u ON v.updatedby = u.ad_user_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON v.chuboe_vq_line_id = vq.chuboe_vq_line_id
    LEFT JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN insp_attrs ia ON v.m_attributesetinstance_id = ia.chuboe_insp_lot_id
    LEFT JOIN adempiere.chuboe_warehouse w ON v.chuboe_warehouse_id = w.chuboe_warehouse_id
    LEFT JOIN adempiere.chuboe_warehouse_group wg ON v.chuboe_warehouse_group_id = wg.chuboe_warehouse_group_id
    LEFT JOIN adempiere.chuboe_warehouse_shelf s ON v.chuboe_warehouse_shelf_id = s.chuboe_warehouse_shelf_id
    WHERE v.chuboe_warehouse_group_id = ${BROWNSVILLE_WAREHOUSE_GROUP_ID}
      AND v.created >= '${sinceTs}'::timestamp
      AND v.created < '${untilTs}'::timestamp
    ORDER BY v.created DESC
  `;

  // Execute query
  // Filter out "SET" line from SET client_min_messages command output
  const detailOut = psqlPipe(detailQuery).trim().split('\n').filter(line => line && line !== 'SET');
  const details = detailOut.map(line => {
    const [otin, created_at, warehouse_group, warehouse, pov, line_no, mpn_received, mfr_received, qty_received, bin_location, inspector, validated_at] = line.split('|');
    return { otin: otin || '', created_at, warehouse_group: warehouse_group || '', warehouse: warehouse || '', pov: pov || '', line_no: line_no || '', mpn_received, mfr_received: mfr_received || '', qty_received, bin_location: bin_location || '', inspector: inspector || 'Unknown', validated_at: validated_at || '' };
  });

  const totalOTINs = details.length;

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">Brownsville OTINs Created — Daily Report</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Summary</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr><td><b>Total OTINs Created</b></td><td>${totalOTINs}</td></tr>
</table>
`;

  if (details.length > 0) {
    html += `
<h3 style="margin-bottom:4px;margin-top:16px">Detail</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:1100px">
<thead style="background:#eef"><tr><th align="left">OTIN</th><th align="left">Created</th><th align="left">Physical Warehouse</th><th align="left">Inv Group</th><th align="left">POV#</th><th align="right">Line</th><th align="left">MPN Received</th><th align="left">MFR Received</th><th align="right">Qty Received</th><th align="left">Bin</th><th align="left">Inspector</th><th align="left">Validated At</th></tr></thead>
<tbody>
${details.map(row => {
  return `<tr><td>${esc(row.otin)}</td><td>${esc(row.created_at)}</td><td>${esc(row.warehouse_group)}</td><td>${esc(row.warehouse)}</td><td>${esc(row.pov)}</td><td style="text-align:right">${esc(row.line_no)}</td><td style="font-family:monospace">${esc(row.mpn_received)}</td><td>${esc(row.mfr_received)}</td><td style="text-align:right">${formatQty(row.qty_received)}</td><td>${esc(row.bin_location)}</td><td>${esc(row.inspector)}</td><td>${esc(row.validated_at)}</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  } else {
    html += `<p style="color:#888;font-style:italic">No OTINs created in this window.</p>`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by brownsville-inspection-report.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.created convention).<br/>
Physical Warehouse: BROWNSVILLE (chuboe_warehouse_group_id = ${BROWNSVILLE_WAREHOUSE_GROUP_ID}).<br/>
Shows all OTINs created in window; Validated At shown for validated lines.
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Total OTINs Created: ${totalOTINs}`);
    console.log('(Preview only — pass --send to email)');
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'Brownsville OTIN Report',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENTS,
    `Brownsville OTINs Created — Daily Report (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENTS.join(', ')} (${totalOTINs} OTINs)`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
