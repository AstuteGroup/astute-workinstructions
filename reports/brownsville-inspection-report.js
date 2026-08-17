#!/usr/bin/env node
//
// Brownsville Inspection Validation — Daily Report
//
// Scheduled daily to surface the previous 24 hours of inspections
// validated at Brownsville (W111).
//
// What the report contains:
//   1. Summary metrics — total validations, total qty, unique inspectors
//   2. By inspector breakdown — count and qty per inspector
//   3. Detail listing — MPN Received, MFR Received, Qty Received, OTIN, POV#, Line, Inspector, Validated At
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

const W111_WAREHOUSE_ID = 1000015;

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
      COALESCE(v.chuboe_mpnlot_po, '') AS pov,
      COALESCE(rl.line, 0) AS line_no,
      COALESCE(ia.mpn_received, v.chuboe_mpnlot_mpn) AS mpn_received,
      COALESCE(ia.mfr_received, '') AS mfr_received,
      COALESCE(ia.qty_received, v.chuboe_mpnlot_qty) AS qty_received,
      u.name AS inspector_name,
      TO_CHAR(v.updated, 'YYYY-MM-DD HH24:MI:SS') AS validated_at
    FROM adempiere.chuboe_insp_mpnlotqueue_v v
    LEFT JOIN adempiere.ad_user u ON v.updatedby = u.ad_user_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON v.chuboe_vq_line_id = vq.chuboe_vq_line_id
    LEFT JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN insp_attrs ia ON v.m_attributesetinstance_id = ia.chuboe_insp_lot_id
    WHERE v.isvalidate = 'Y'
      AND v.chuboe_warehouse_id = ${W111_WAREHOUSE_ID}
      AND v.updated >= '${sinceTs}'::timestamp
      AND v.updated < '${untilTs}'::timestamp
    ORDER BY v.updated DESC
  `;

  // By inspector summary query
  const byInspectorQuery = `
    SELECT
      COALESCE(u.name, 'Unknown') AS inspector_name,
      COUNT(*) AS validation_count,
      SUM(CAST(v.chuboe_mpnlot_qty AS INTEGER)) AS total_qty
    FROM adempiere.chuboe_insp_mpnlotqueue_v v
    LEFT JOIN adempiere.ad_user u ON v.updatedby = u.ad_user_id
    WHERE v.isvalidate = 'Y'
      AND v.chuboe_warehouse_id = ${W111_WAREHOUSE_ID}
      AND v.updated >= '${sinceTs}'::timestamp
      AND v.updated < '${untilTs}'::timestamp
    GROUP BY u.name
    ORDER BY validation_count DESC
  `;

  // Execute queries
  // Filter out "SET" line from SET client_min_messages command output
  const detailOut = psqlPipe(detailQuery).trim().split('\n').filter(line => line && line !== 'SET');
  const details = detailOut.map(line => {
    const [otin, pov, line_no, mpn_received, mfr_received, qty_received, inspector, validated_at] = line.split('|');
    return { otin: otin || '', pov: pov || '', line_no: line_no || '', mpn_received, mfr_received: mfr_received || '', qty_received, inspector: inspector || 'Unknown', validated_at };
  });

  // Filter out "SET" line from SET client_min_messages command output
  const byInspectorOut = psqlPipe(byInspectorQuery).trim().split('\n').filter(line => line && line !== 'SET');
  const byInspector = byInspectorOut.map(line => {
    const [inspector_name, validation_count, total_qty] = line.split('|');
    return {
      inspector_name,
      validation_count: Number(validation_count) || 0,
      total_qty: Number(total_qty) || 0
    };
  });

  const totalValidations = byInspector.reduce((sum, row) => sum + row.validation_count, 0);
  const totalQty = byInspector.reduce((sum, row) => sum + row.total_qty, 0);
  const uniqueInspectors = byInspector.length;

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">Brownsville Inspection Validation — Daily Report</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)}</p>

<h3 style="margin-bottom:4px">Summary</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr><td><b>Total Validations</b></td><td>${totalValidations}</td></tr>
<tr><td><b>Total Qty</b></td><td>${formatQty(totalQty)}</td></tr>
<tr><td><b>Inspectors</b></td><td>${uniqueInspectors}</td></tr>
</table>
`;

  if (byInspector.length > 0) {
    html += `
<h3 style="margin-bottom:4px;margin-top:16px">By Inspector</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#eef"><tr><th align="left">Inspector</th><th align="right">Validations</th><th align="right">Total Qty</th><th align="left">% of Total</th></tr></thead>
<tbody>
${byInspector.map(row => {
  const pct = totalValidations > 0 ? Math.round(100 * row.validation_count / totalValidations) : 0;
  const barWidth = 100;
  const barFill = Math.round(barWidth * row.validation_count / totalValidations);
  const bar = `<span style="display:inline-block;width:${barWidth}px;height:12px;background:#eee;border-radius:2px;overflow:hidden">` +
    `<span style="display:inline-block;width:${barFill}px;height:100%;background:#48c"></span>` +
    `</span> ${pct}%`;
  return `<tr><td>${esc(row.inspector_name)}</td><td style="text-align:right">${row.validation_count}</td><td style="text-align:right">${formatQty(row.total_qty)}</td><td>${bar}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td><b>Total</b></td><td style="text-align:right"><b>${totalValidations}</b></td><td style="text-align:right"><b>${formatQty(totalQty)}</b></td><td></td></tr>
</tbody>
</table>
`;
  }

  if (details.length > 0) {
    html += `
<h3 style="margin-bottom:4px;margin-top:16px">Detail</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:900px">
<thead style="background:#eef"><tr><th align="left">OTIN</th><th align="left">POV#</th><th align="right">Line</th><th align="left">MPN Received</th><th align="left">MFR Received</th><th align="right">Qty Received</th><th align="left">Inspector</th><th align="left">Validated At</th></tr></thead>
<tbody>
${details.map(row => {
  return `<tr><td>${esc(row.otin)}</td><td>${esc(row.pov)}</td><td style="text-align:right">${esc(row.line_no)}</td><td style="font-family:monospace">${esc(row.mpn_received)}</td><td>${esc(row.mfr_received)}</td><td style="text-align:right">${formatQty(row.qty_received)}</td><td>${esc(row.inspector)}</td><td>${esc(row.validated_at)}</td></tr>`;
}).join('\n')}
</tbody>
</table>
`;
  } else {
    html += `<p style="color:#888;font-style:italic">No validations found in this window.</p>`;
  }

  html += `
<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by brownsville-inspection-report.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.updated convention).<br/>
Warehouse: W111 (Brownsville LAM Kitting, chuboe_warehouse_id = ${W111_WAREHOUSE_ID}).<br/>
Only validated inspections (isvalidate='Y') are included.
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Total Validations: ${totalValidations}`);
    console.log(`Total Qty: ${formatQty(totalQty)}`);
    console.log(`Inspectors: ${uniqueInspectors}`);
    console.log('(Preview only — pass --send to email)');
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
  console.log(`Sent to ${RECIPIENTS.join(', ')}`);
  console.log(`Summary: ${totalValidations} validations, ${formatQty(totalQty)} qty, ${uniqueInspectors} inspectors`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
