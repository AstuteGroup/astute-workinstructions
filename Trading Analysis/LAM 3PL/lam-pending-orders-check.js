#!/usr/bin/env node
/**
 * LAM Pending Orders Check
 *
 * Identifies orders that were processed in OT but not placed in Infor.
 * These are "stuck" POs that need to be chased.
 *
 * Criteria:
 *   - VQ ticked as purchased OR OT PO exists
 *   - BUT no chuboe_po_string (POV stamp from Infor)
 *   - Recency: PO cut ≤90d OR promise date ≥ today
 *
 * Usage:
 *   node lam-pending-orders-check.js [--dry-run]
 *   node lam-pending-orders-check.js --list-exclusions
 *   node lam-pending-orders-check.js --mark-ok <vq_id> [reason]
 *   node lam-pending-orders-check.js --clear-exclusion <vq_id>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const XLSX = require('xlsx');

// Load environment
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const SCRIPT_DIR = __dirname;
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const EXCLUSIONS_FILE = path.join(SCRIPT_DIR, 'lam-pending-orders-exclusions.json');

// LAM customer BP ID
const LAM_BP_ID = 1000730;

// Email config
const EMAIL_ACCOUNT = 'lamkitting';
const EMAIL_TO = 'jake.harris@astutegroup.com';

// === EXCLUSION PERSISTENCE ===

function loadExclusions() {
  if (!fs.existsSync(EXCLUSIONS_FILE)) {
    return new Map();
  }
  try {
    const data = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8'));
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('Warning: Could not load exclusions file:', err.message);
    return new Map();
  }
}

function saveExclusions(exclusions) {
  const obj = Object.fromEntries(exclusions);
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(obj, null, 2));
}

function addExclusion(exclusions, vqId, reason) {
  exclusions.set(String(vqId), {
    vqId,
    reason: reason || 'Intentionally not placed yet',
    date: new Date().toISOString().split('T')[0],
  });
}

// === MAIN ===

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Handle listing exclusions
  if (args.includes('--list-exclusions')) {
    const exclusions = loadExclusions();
    console.log('=== EXCLUDED VQ LINES ===');
    console.log(`Total: ${exclusions.size}`);
    console.log('');
    for (const [key, val] of exclusions) {
      console.log(`VQ ID: ${val.vqId}`);
      console.log(`  Reason: ${val.reason}`);
      console.log(`  Added: ${val.date}`);
      console.log('');
    }
    return { listed: true, count: exclusions.size };
  }

  // Handle marking as OK
  if (args.includes('--mark-ok')) {
    const vqId = args[args.indexOf('--mark-ok') + 1];
    const reason = args.slice(args.indexOf('--mark-ok') + 2).join(' ') || 'Intentionally not placed yet';

    if (!vqId) {
      console.error('Usage: node lam-pending-orders-check.js --mark-ok <vq_id> [reason]');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    addExclusion(exclusions, vqId, reason);
    saveExclusions(exclusions);
    console.log(`Marked as OK: VQ ${vqId}`);
    console.log(`Reason: ${reason}`);
    console.log(`Total exclusions: ${exclusions.size}`);
    return { marked: true, vqId };
  }

  // Handle clearing exclusion
  if (args.includes('--clear-exclusion')) {
    const vqId = args[args.indexOf('--clear-exclusion') + 1];

    if (!vqId) {
      console.error('Usage: node lam-pending-orders-check.js --clear-exclusion <vq_id>');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    if (exclusions.has(String(vqId))) {
      exclusions.delete(String(vqId));
      saveExclusions(exclusions);
      console.log(`Removed exclusion: VQ ${vqId}`);
      console.log(`Remaining exclusions: ${exclusions.size}`);
    } else {
      console.log(`No exclusion found for VQ ${vqId}`);
    }
    return { cleared: true, vqId };
  }

  console.log('=== LAM Pending Orders Check ===');
  console.log('Dry run:', dryRun);
  console.log('');

  // Load exclusions
  console.log('Step 1: Loading exclusions...');
  const exclusions = loadExclusions();
  console.log(`  ${exclusions.size} VQ lines excluded`);

  // Query for stuck orders
  console.log('');
  console.log('Step 2: Querying for pending orders...');
  const results = await queryPendingOrders(exclusions);
  console.log(`  Found ${results.length} stuck orders`);

  if (results.length === 0) {
    console.log('');
    console.log('No pending orders found. All clear!');
    return { count: 0 };
  }

  // Generate summary
  console.log('');
  console.log('=== SUMMARY ===');
  const bySupplier = {};
  const byAge = { '0-7d': 0, '8-30d': 0, '31-60d': 0, '60d+': 0 };

  for (const r of results) {
    bySupplier[r.supplier] = (bySupplier[r.supplier] || 0) + 1;
    const age = r.days_stuck;
    if (age <= 7) byAge['0-7d']++;
    else if (age <= 30) byAge['8-30d']++;
    else if (age <= 60) byAge['31-60d']++;
    else byAge['60d+']++;
  }

  console.log('By age:');
  Object.entries(byAge).forEach(([k, v]) => {
    if (v > 0) console.log(`  ${k}: ${v}`);
  });

  console.log('');
  console.log('By supplier:');
  Object.entries(bySupplier).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // Write output
  const today = new Date().toISOString().split('T')[0];
  const outputPath = path.join(OUTPUT_DIR, `LAM_Pending_Orders_${today}.xlsx`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('');
  console.log('Step 3: Writing output...');
  writeExcel(results, outputPath);
  console.log(`  Wrote: ${outputPath}`);

  // Send email if items found
  if (!dryRun && results.length > 0) {
    console.log('');
    console.log('Step 4: Sending email notification...');
    await sendNotification(results, outputPath, today);
    console.log('  Email sent');
  } else if (dryRun && results.length > 0) {
    console.log('');
    console.log(`Step 4: [DRY RUN] Would send email for ${results.length} stuck orders`);
  }

  return {
    count: results.length,
    outputPath,
    byAge,
    bySupplier,
  };
}

async function queryPendingOrders(exclusions) {
  const sql = `
    SELECT
      vl.chuboe_vq_line_id AS vq_id,
      rfq.value AS rfq_number,
      rlm.chuboe_mpn AS mpn,
      rlm.chuboe_mfr_text AS manufacturer,
      vl.qty AS qty,
      vl.cost AS cost,
      vl.datepromised AS promise_date,
      vl.created AS vq_created,
      vl.ispurchased,
      bp_vendor.name AS supplier,
      o.documentno AS ot_po_number,
      o.created AS po_created,
      ol.chuboe_po_string AS pov_stamp,
      CURRENT_DATE - vl.created::date AS days_stuck,
      u.name AS created_by
    FROM chuboe_vq_line vl
    JOIN chuboe_rfq_line rl ON rl.chuboe_rfq_line_id = vl.chuboe_rfq_line_id
    JOIN chuboe_rfq rfq ON rfq.chuboe_rfq_id = rl.chuboe_rfq_id
    LEFT JOIN chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
    LEFT JOIN c_bpartner bp_vendor ON bp_vendor.c_bpartner_id = vl.c_bpartner_id
    LEFT JOIN c_orderline ol ON ol.chuboe_vq_line_id = vl.chuboe_vq_line_id
    LEFT JOIN c_order o ON o.c_order_id = ol.c_order_id
    LEFT JOIN ad_user u ON u.ad_user_id = vl.createdby
    WHERE rfq.c_bpartner_id = ${LAM_BP_ID}
      AND rfq.isactive = 'Y'
      AND vl.isactive = 'Y'
      AND (vl.ispurchased = 'Y' OR o.c_order_id IS NOT NULL)
      AND (ol.chuboe_po_string IS NULL OR ol.chuboe_po_string = '' OR ol.chuboe_po_string NOT LIKE 'POV%')
      AND (
        vl.created >= CURRENT_DATE - INTERVAL '90 days'
        OR vl.datepromised >= CURRENT_DATE
      )
    ORDER BY days_stuck DESC, supplier, mpn
  `;

  const tmpFile = `/tmp/pending_orders_${Date.now()}.sql`;
  const outFile = `/tmp/pending_orders_${Date.now()}.out`;

  fs.writeFileSync(tmpFile, sql);

  try {
    execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F '|' -f "${tmpFile}" -o "${outFile}"`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const content = fs.readFileSync(outFile, 'utf8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return [];

    // Pipe-separated output: vq_id|rfq_number|mpn|manufacturer|qty|cost|promise_date|vq_created|ispurchased|supplier|ot_po_number|po_created|pov_stamp|days_stuck|created_by
    const results = [];

    for (const line of lines) {
      const values = line.split('|');
      if (values.length < 15) continue;

      const vqId = values[0];

      // Skip excluded VQ lines
      if (exclusions.has(String(vqId))) {
        continue;
      }

      results.push({
        vq_id: vqId,
        rfq_number: values[1],
        mpn: values[2],
        manufacturer: values[3],
        qty: parseInt(values[4]) || 0,
        cost: parseFloat(values[5]) || 0,
        promise_date: values[6],
        vq_created: values[7],
        is_purchased: values[8] === 'Y',
        supplier: values[9] || 'Unknown',
        ot_po_number: values[10] || '',
        po_created: values[11] || '',
        pov_stamp: values[12] || '',
        days_stuck: parseInt(values[13]) || 0,
        created_by: values[14] || '',
      });
    }

    return results;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function writeExcel(results, outputPath) {
  const wb = XLSX.utils.book_new();

  const rows = results.map(r => ({
    'VQ ID': r.vq_id,
    'RFQ #': r.rfq_number,
    'MPN': r.mpn,
    'Manufacturer': r.manufacturer,
    'Qty': r.qty,
    'Cost': r.cost,
    'Supplier': r.supplier,
    'OT PO #': r.ot_po_number,
    'PO Created': r.po_created ? r.po_created.split('T')[0] : '',
    'VQ Ticked': r.is_purchased ? 'Y' : 'N',
    'VQ Created': r.vq_created ? r.vq_created.split('T')[0] : '',
    'Promise Date': r.promise_date ? r.promise_date.split('T')[0] : '',
    'Days Stuck': r.days_stuck,
    'POV Stamp': r.pov_stamp,
    'Created By': r.created_by,
    'Status': r.ot_po_number ? 'Has OT PO - needs Infor stamp' : 'VQ ticked - needs PO',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 10 },  // VQ ID
    { wch: 12 },  // RFQ #
    { wch: 25 },  // MPN
    { wch: 20 },  // Manufacturer
    { wch: 8 },   // Qty
    { wch: 10 },  // Cost
    { wch: 25 },  // Supplier
    { wch: 12 },  // OT PO #
    { wch: 12 },  // PO Created
    { wch: 10 },  // VQ Ticked
    { wch: 12 },  // VQ Created
    { wch: 12 },  // Promise Date
    { wch: 10 },  // Days Stuck
    { wch: 15 },  // POV Stamp
    { wch: 15 },  // Created By
    { wch: 30 },  // Status
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Pending Orders');
  XLSX.writeFile(wb, outputPath);
}

async function sendNotification(results, attachmentPath, date) {
  const subject = `LAM Pending Orders Check - ${results.length} stuck orders - ${date}`;

  // Group by age
  const recent = results.filter(r => r.days_stuck <= 7);
  const old = results.filter(r => r.days_stuck > 30);

  let body = `Hi,\n\n`;
  body += `The LAM pending orders check found ${results.length} order(s) that were processed in OT but not placed in Infor:\n\n`;

  if (old.length > 0) {
    body += `⚠️ ${old.length} orders are 30+ days old and need urgent attention:\n`;
    old.slice(0, 5).forEach(r => {
      body += `  • ${r.mpn} - ${r.supplier} - ${r.days_stuck} days (${r.ot_po_number || 'no PO yet'})\n`;
    });
    if (old.length > 5) body += `  ... and ${old.length - 5} more\n`;
    body += `\n`;
  }

  if (recent.length > 0) {
    body += `${recent.length} recent orders (≤7 days) - may still be in process:\n`;
    recent.slice(0, 3).forEach(r => {
      body += `  • ${r.mpn} - ${r.supplier} - ${r.days_stuck} days\n`;
    });
    if (recent.length > 3) body += `  ... and ${recent.length - 3} more\n`;
    body += `\n`;
  }

  body += `Full report attached.\n\n`;
  body += `To exclude a VQ from future checks (if intentionally not placed):\n`;
  body += `  node lam-pending-orders-check.js --mark-ok <vq_id> "reason"\n\n`;
  body += `Thanks,\nClaude`;

  // Use Python for email with attachment
  const pythonScript = `
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
import os

msg = MIMEMultipart()
msg['From'] = '${EMAIL_ACCOUNT}@orangetsunami.com'
msg['To'] = '${EMAIL_TO}'
msg['Subject'] = '''${subject}'''

body = '''${body.replace(/'/g, "\\'")}'''
msg.attach(MIMEText(body, 'plain'))

filename = '${path.basename(attachmentPath)}'
filepath = '${attachmentPath}'
with open(filepath, 'rb') as f:
    part = MIMEBase('application', 'octet-stream')
    part.set_payload(f.read())
encoders.encode_base64(part)
part.add_header('Content-Disposition', f'attachment; filename="{filename}"')
msg.attach(part)

server = smtplib.SMTP_SSL('smtp.mail.us-east-1.awsapps.com', 465)
server.login('${EMAIL_ACCOUNT}@orangetsunami.com', os.environ.get('SMTP_PASSWORD', 'A$tuteu$a'))
server.send_message(msg)
server.quit()
print('Email sent successfully')
`;

  execSync(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, { stdio: 'inherit' });
}

// Run
if (require.main === module) {
  main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
