#!/usr/bin/env node
//
// Brownsville Inspection Validation — Daily Report
//
// Scheduled daily to surface inspections validated at Brownsville (W111)
// in the previous 24 hours.
//
// What the report contains:
//   Detail listing — OTIN, Physical Warehouse, Inv Group, POV#, Line, MPN Received,
//   MFR Received, Qty Received, Bin, Inspector, Validated At
//
// Purpose: Daily digest of inspection activity at Brownsville.
//
// Usage:
//   node brownsville-inspection-report.js               # preview to stdout (no send)
//   node brownsville-inspection-report.js --send        # email operator
//   node brownsville-inspection-report.js --since 24    # custom window in hours
//   node brownsville-inspection-report.js --since 48    # backfill 2 days

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { execSync } = require('child_process');
const { createNotifier } = require('../../shared/notifier');

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

  // Combined detail query - shows both validated and pending OTINs
  // Validated: filtered by updated timestamp (when validation occurred)
  // Pending: filtered by created timestamp (when OTIN was created)
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
      COALESCE(wg.name, '') AS physical_warehouse,
      COALESCE(w.name, '') AS inv_group,
      COALESCE(v.chuboe_mpnlot_po, '') AS pov,
      COALESCE(rl.line, 0) AS line_no,
      COALESCE(ia.mpn_received, v.chuboe_mpnlot_mpn) AS mpn_received,
      COALESCE(ia.mfr_received, '') AS mfr_received,
      COALESCE(ia.qty_received, v.chuboe_mpnlot_qty) AS qty_received,
      COALESCE(v.name, '') AS bin,
      u.name AS inspector,
      TO_CHAR(v.updated, 'YYYY-MM-DD HH24:MI:SS') AS validated_at
    FROM adempiere.chuboe_insp_mpnlotqueue_v v
    LEFT JOIN adempiere.ad_user u ON v.updatedby = u.ad_user_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON v.chuboe_vq_line_id = vq.chuboe_vq_line_id
    LEFT JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN insp_attrs ia ON v.m_attributesetinstance_id = ia.chuboe_insp_lot_id
    LEFT JOIN adempiere.chuboe_warehouse w ON v.chuboe_warehouse_id = w.chuboe_warehouse_id
    LEFT JOIN adempiere.chuboe_warehouse_group wg ON v.chuboe_warehouse_group_id = wg.chuboe_warehouse_group_id
    WHERE v.chuboe_warehouse_group_id = ${BROWNSVILLE_WAREHOUSE_GROUP_ID}
      AND v.isvalidate = 'Y'
      AND v.updated >= '${sinceTs}'::timestamp
      AND v.updated < '${untilTs}'::timestamp
    ORDER BY v.updated DESC
  `;

  // Execute query
  // Filter out "SET" line from SET client_min_messages command output
  const detailOut = psqlPipe(detailQuery).trim().split('\n').filter(line => line && line !== 'SET');
  const details = detailOut.map(line => {
    const [otin, physical_warehouse, inv_group, pov, line_no, mpn_received, mfr_received, qty_received, bin, inspector, validated_at] = line.split('|');
    return { otin: otin || '', physical_warehouse: physical_warehouse || '', inv_group: inv_group || '', pov: pov || '', line_no: line_no || '', mpn_received: mpn_received || '', mfr_received: mfr_received || '', qty_received: qty_received || '0', bin: bin || '', inspector: inspector || 'Unknown', validated_at: validated_at || '' };
  });

  const totalRows = details.length;

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">Brownsville Inspection Validation — Daily Report</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)} · ${details.length} rows</p>
`;

  if (details.length > 0) {
    html += `
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#eef"><tr><th align="left">OTIN</th><th align="left">Physical Warehouse</th><th align="left">Inv Group</th><th align="left">POV#</th><th align="right">Line</th><th align="left">MPN Received</th><th align="left">MFR Received</th><th align="right">Qty Received</th><th align="left">Bin</th><th align="left">Inspector</th><th align="left">Validated At</th></tr></thead>
<tbody>
${details.map(row => {
  return `<tr><td>${esc(row.otin)}</td><td>${esc(row.physical_warehouse)}</td><td>${esc(row.inv_group)}</td><td>${esc(row.pov)}</td><td style="text-align:right">${esc(row.line_no)}</td><td style="font-family:monospace">${esc(row.mpn_received)}</td><td>${esc(row.mfr_received)}</td><td style="text-align:right">${formatQty(row.qty_received)}</td><td>${esc(row.bin)}</td><td>${esc(row.inspector)}</td><td>${esc(row.validated_at)}</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  } else {
    html += `<p style="color:#888;font-style:italic">No activity in this window.</p>`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by brownsville-inspection-report.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive).<br/>
Warehouse Group: BROWNSVILLE (chuboe_warehouse_group_id = ${BROWNSVILLE_WAREHOUSE_GROUP_ID}).<br/>
Shows inspections validated in the window.
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log(`\n${totalRows} rows (Preview only — pass --send to email)`);
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'Brownsville Inspection Report',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENTS,
    `Brownsville Inspection Validation — Daily Report (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENTS.join(', ')} (${totalRows} rows)`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
