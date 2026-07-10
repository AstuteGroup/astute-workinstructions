#!/usr/bin/env node
/**
 * LAM Wrong Warehouse Check
 *
 * Identifies LAM roster parts in non-LAM warehouses.
 * Runs weekly as part of the LAM Kitting workflow.
 *
 * Usage:
 *   node lam-wrong-warehouse-check.js <inventory-folder>
 *   node lam-wrong-warehouse-check.js <inventory-folder> --dry-run
 *
 * Output:
 *   - output/LAM_Wrong_Warehouse_YYYY-MM-DD.xlsx
 *   - Email notification if any "MISPLACED LAM STOCK" found
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// === CONFIGURATION ===

const SCRIPT_DIR = __dirname;
const ROSTER_PATH = path.join(SCRIPT_DIR, 'LAM_Master_Roster.xlsx');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const KNOWN_NON_LAM_PATH = path.join(SCRIPT_DIR, 'lam-wrong-warehouse-exclusions.json');

// LAM warehouses - exclude from check (stock here is correct)
const LAM_WAREHOUSES = ['W111', 'W115', 'W118'];

// All warehouses to exclude from results
const EXCLUDE_WAREHOUSES = ['W111', 'W115', 'W118', 'W112', 'W117', 'W106'];

// Email config
const EMAIL_ACCOUNT = 'lamkitting';
const EMAIL_TO = 'jake.harris@astutegroup.com';

// === EXCLUSION PERSISTENCE ===
// Items confirmed as "not LAM" are stored by MPN+Lot so they don't repeat

function loadExclusions() {
  if (!fs.existsSync(KNOWN_NON_LAM_PATH)) {
    return new Map();
  }
  try {
    const data = JSON.parse(fs.readFileSync(KNOWN_NON_LAM_PATH, 'utf8'));
    // Format: { "MPN|Lot": { mpn, lot, wh, reason, date } }
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('Warning: Could not load exclusions file:', err.message);
    return new Map();
  }
}

function saveExclusions(exclusions) {
  const obj = Object.fromEntries(exclusions);
  fs.writeFileSync(KNOWN_NON_LAM_PATH, JSON.stringify(obj, null, 2));
}

function makeExclusionKey(mpn, lot) {
  return `${mpn}|${lot}`;
}

function isExcluded(exclusions, mpn, lot) {
  return exclusions.has(makeExclusionKey(mpn, lot));
}

function addExclusion(exclusions, mpn, lot, wh, reason) {
  const key = makeExclusionKey(mpn, lot);
  exclusions.set(key, {
    mpn,
    lot,
    wh,
    reason: reason || 'Confirmed not LAM stock',
    date: new Date().toISOString().split('T')[0],
  });
}

// === MAIN ===

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const markNonLam = args.includes('--mark-non-lam');
  const inventoryFolder = args.find(a => !a.startsWith('--'));

  const listExclusions = args.includes('--list-exclusions');
  const clearExclusion = args.includes('--clear-exclusion');

  if (!inventoryFolder && !markNonLam && !listExclusions && !clearExclusion) {
    console.error('Usage:');
    console.error('  node lam-wrong-warehouse-check.js <inventory-folder> [--dry-run]');
    console.error('  node lam-wrong-warehouse-check.js --mark-non-lam <mpn> <lot> [reason]');
    console.error('  node lam-wrong-warehouse-check.js --clear-exclusion <mpn> <lot>');
    console.error('  node lam-wrong-warehouse-check.js --list-exclusions');
    console.error('');
    console.error('Options:');
    console.error('  --dry-run          Run without sending email');
    console.error('  --mark-non-lam     Mark an MPN+Lot as not LAM (excludes from future checks)');
    console.error('  --clear-exclusion  Remove an MPN+Lot from exclusions');
    console.error('  --list-exclusions  Show all current exclusions');
    process.exit(1);
  }

  // Handle listing exclusions
  if (args.includes('--list-exclusions')) {
    const exclusions = loadExclusions();
    console.log('=== KNOWN NON-LAM ITEMS ===');
    console.log(`Total: ${exclusions.size}`);
    console.log('');
    for (const [key, val] of exclusions) {
      console.log(`${val.mpn} | Lot: ${val.lot}`);
      console.log(`  Reason: ${val.reason}`);
      console.log(`  Added: ${val.date}`);
      console.log('');
    }
    return { listed: true, count: exclusions.size };
  }

  // Handle clearing an exclusion
  if (args.includes('--clear-exclusion')) {
    const mpn = args[args.indexOf('--clear-exclusion') + 1];
    const lot = args[args.indexOf('--clear-exclusion') + 2];

    if (!mpn || !lot) {
      console.error('Usage: node lam-wrong-warehouse-check.js --clear-exclusion <mpn> <lot>');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    const key = makeExclusionKey(mpn, lot);
    if (exclusions.has(key)) {
      exclusions.delete(key);
      saveExclusions(exclusions);
      console.log(`Removed exclusion: ${mpn} | Lot: ${lot}`);
      console.log(`Remaining exclusions: ${exclusions.size}`);
    } else {
      console.log(`No exclusion found for: ${mpn} | Lot: ${lot}`);
    }
    return { cleared: true, mpn, lot };
  }

  // Handle marking items as non-LAM
  if (markNonLam) {
    const mpn = args[args.indexOf('--mark-non-lam') + 1];
    const lot = args[args.indexOf('--mark-non-lam') + 2];
    const reason = args.slice(args.indexOf('--mark-non-lam') + 3).join(' ') || 'Confirmed not LAM stock';

    if (!mpn || !lot) {
      console.error('Usage: node lam-wrong-warehouse-check.js --mark-non-lam <mpn> <lot> [reason]');
      process.exit(1);
    }

    const exclusions = loadExclusions();
    addExclusion(exclusions, mpn, lot, '', reason);
    saveExclusions(exclusions);
    console.log(`Marked as non-LAM: ${mpn} | Lot: ${lot}`);
    console.log(`Reason: ${reason}`);
    console.log(`Total exclusions: ${exclusions.size}`);
    return { marked: true, mpn, lot };
  }

  console.log('=== LAM Wrong Warehouse Check ===');
  console.log('Inventory folder:', inventoryFolder);
  console.log('Dry run:', dryRun);
  console.log('');

  // Step 1: Load Master Roster
  console.log('Step 1: Loading Master Roster...');
  const rosterMPNs = loadRoster();
  console.log(`  Loaded ${rosterMPNs.size} roster MPNs`);

  // Step 1b: Load exclusions (items already confirmed as not LAM)
  console.log('Step 1b: Loading exclusions...');
  const exclusions = loadExclusions();
  console.log(`  Loaded ${exclusions.size} known non-LAM items`);

  // Step 2: Find main inventory file
  console.log('Step 2: Finding inventory file...');
  const invFile = findInventoryFile(inventoryFolder);
  if (!invFile) {
    console.error('  ERROR: No inventory file found in', inventoryFolder);
    process.exit(1);
  }
  console.log(`  Found: ${path.basename(invFile)}`);

  // Step 3: Load inventory and analyze
  console.log('Step 3: Loading inventory and analyzing...');
  const invData = loadInventory(invFile);
  console.log(`  Loaded ${invData.length} inventory rows`);

  // Step 4: Find roster MPNs in LAM warehouses (for cross-reference)
  const inLAMWarehouses = buildLAMWarehouseMap(invData);
  console.log(`  Found ${inLAMWarehouses.size} roster MPNs in LAM warehouses`);

  // Step 5: Find roster MPNs in wrong warehouses
  console.log('Step 4: Finding roster parts in wrong warehouses...');
  const { results, excludedCount } = findWrongWarehouseStock(invData, rosterMPNs, inLAMWarehouses, exclusions);
  console.log(`  Found ${results.length} inventory rows to review`);
  if (excludedCount > 0) {
    console.log(`  Skipped ${excludedCount} rows (previously marked as non-LAM)`);
  }

  // Step 6: Classify and sort
  results.forEach(r => {
    r.status = classifyStatus(r);
  });
  sortResults(results);

  // Step 7: Generate summary
  const summary = generateSummary(results);
  console.log('');
  console.log('=== SUMMARY ===');
  Object.entries(summary).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  // Step 8: Write output
  const today = new Date().toISOString().split('T')[0];
  const outputPath = path.join(OUTPUT_DIR, `LAM_Wrong_Warehouse_${today}.xlsx`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('');
  console.log('Step 5: Writing output...');
  writeExcel(results, summary, outputPath);
  console.log(`  Wrote: ${outputPath}`);

  // Step 9: Email if misplaced stock found
  const misplacedCount = summary['MISPLACED LAM STOCK - LAM bin location'] || 0;

  if (misplacedCount > 0 && !dryRun) {
    console.log('');
    console.log('Step 6: Sending email notification...');
    await sendNotification(results, summary, outputPath, today);
    console.log('  Email sent');
  } else if (misplacedCount > 0) {
    console.log('');
    console.log('Step 6: [DRY RUN] Would send email for', misplacedCount, 'misplaced items');
  } else {
    console.log('');
    console.log('Step 6: No misplaced LAM stock found - skipping email');
  }

  // Return results for runner integration
  return {
    totalRows: results.length,
    misplacedCount,
    outputPath,
    summary,
  };
}

// === HELPER FUNCTIONS ===

function loadRoster() {
  const wb = XLSX.readFile(ROSTER_PATH);
  const ws = wb.Sheets['Master Roster'];
  const data = XLSX.utils.sheet_to_json(ws);

  const rosterMPNs = new Map(); // MPN (uppercase, trimmed) → CPC
  for (const row of data) {
    if (row.MPN && row.CPC) {
      const mpn = String(row.MPN).toUpperCase().trim();
      rosterMPNs.set(mpn, String(row.CPC).trim());
    }
  }
  return rosterMPNs;
}

function findInventoryFile(folderOrFile) {
  // If a direct file path was provided, use it
  if (fs.existsSync(folderOrFile) && fs.statSync(folderOrFile).isFile()) {
    return folderOrFile;
  }

  // Look in the specified folder
  if (fs.existsSync(folderOrFile) && fs.statSync(folderOrFile).isDirectory()) {
    const files = fs.readdirSync(folderOrFile);

    // Priority: ASTItemLotsReportInputs files
    const mainFile = files.find(f =>
      f.includes('ASTItemLotsReportInputs') &&
      (f.endsWith('.xlsx') || f.endsWith('.xls'))
    );
    if (mainFile) return path.join(folderOrFile, mainFile);

    // Fallback: any xlsx file in folder
    const anyExcel = files.find(f => f.endsWith('.xlsx') || f.endsWith('.xls'));
    if (anyExcel) return path.join(folderOrFile, anyExcel);
  }

  // Check /tmp for the raw Infor file (common location for email downloads)
  const tmpFiles = fs.readdirSync('/tmp');
  const inforFile = tmpFiles.find(f =>
    f.includes('ASTItemLotsReportInputs') &&
    (f.endsWith('.xlsx') || f.endsWith('.xls'))
  );
  if (inforFile) return path.join('/tmp', inforFile);

  return null;
}

function loadInventory(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames[0]];

  // Find the header row (row containing "Item" in column A)
  // Typically row 8 (1-indexed) = row 7 (0-indexed) for Infor files
  const allData = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let headerRowIndex = 7; // default

  for (let i = 0; i < Math.min(15, allData.length); i++) {
    if (allData[i] && allData[i][0] === 'Item') {
      headerRowIndex = i;
      break;
    }
  }

  // Read with the correct header row
  const data = XLSX.utils.sheet_to_json(ws, { range: headerRowIndex });
  return data;
}

function buildLAMWarehouseMap(invData) {
  const inLAMWarehouses = new Map(); // MPN → [{wh, qty}]

  for (const row of invData) {
    const mpn = String(row['Item'] || '').trim();
    const wh = String(row['Warehouse'] || '').trim();
    const qty = parseFloat(row['Lot Quantity'] || 0);

    if (mpn && qty > 0 && LAM_WAREHOUSES.includes(wh)) {
      if (!inLAMWarehouses.has(mpn)) inLAMWarehouses.set(mpn, []);
      inLAMWarehouses.get(mpn).push({ wh, qty: Math.round(qty) });
    }
  }
  return inLAMWarehouses;
}

function findWrongWarehouseStock(invData, rosterMPNs, inLAMWarehouses, exclusions) {
  const results = [];
  let excludedCount = 0;

  for (const row of invData) {
    const mpn = String(row['Item'] || '').trim();
    const mpnUpper = mpn.toUpperCase();
    const wh = String(row['Warehouse'] || '').trim();
    const qty = parseFloat(row['Lot Quantity'] || 0);
    const lot = String(row['Lot'] || '').trim();

    // Skip if not a roster MPN, no qty, or in excluded warehouse
    if (!mpn || qty <= 0 || !rosterMPNs.has(mpnUpper) || EXCLUDE_WAREHOUSES.includes(wh)) {
      continue;
    }

    // Skip if this MPN+Lot was previously marked as non-LAM
    if (isExcluded(exclusions, mpn, lot)) {
      excludedCount++;
      continue;
    }

    const cpc = rosterMPNs.get(mpnUpper);
    const loc = String(row['Location'] || '').trim();
    const isLAMLoc = loc.toUpperCase().includes('LAM');
    const lamStock = inLAMWarehouses.get(mpn) || [];

    results.push({
      wh,
      whName: String(row['Warehouse Name'] || '').trim(),
      cpc,
      mpn,
      qty: Math.round(qty),
      loc,
      lot,
      isLAMLoc,
      alsoInW111: lamStock.some(s => s.wh === 'W111'),
      alsoInW115: lamStock.some(s => s.wh === 'W115'),
      alsoInW118: lamStock.some(s => s.wh === 'W118'),
    });
  }

  return { results, excludedCount };
}

function classifyStatus(r) {
  if (r.isLAMLoc) {
    return 'MISPLACED LAM STOCK - LAM bin location';
  } else if (r.alsoInW111 || r.alsoInW118) {
    return 'Has LAM stock in W111/W118 - likely other customer';
  } else if (r.alsoInW115) {
    return 'Has LAM dead stock (W115) - needs review';
  } else {
    return 'No LAM warehouse stock - likely other customer';
  }
}

function sortResults(results) {
  results.sort((a, b) => {
    // LAM bin locations first (highest priority)
    if (a.isLAMLoc && !b.isLAMLoc) return -1;
    if (!a.isLAMLoc && b.isLAMLoc) return 1;
    // Parts also in W115 next
    if (a.alsoInW115 && !b.alsoInW115) return -1;
    if (!a.alsoInW115 && b.alsoInW115) return 1;
    // Alphabetical by warehouse
    return a.wh.localeCompare(b.wh);
  });
}

function generateSummary(results) {
  const summary = {};
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return summary;
}

function writeExcel(results, summary, outputPath) {
  const wb = XLSX.utils.book_new();

  // Main results sheet
  const rows = results.map(r => ({
    'Warehouse': r.wh,
    'Warehouse Name': r.whName,
    'LAM CPC': r.cpc,
    'MPN': r.mpn,
    'Qty': r.qty,
    'Location': r.loc,
    'Lot': r.lot,
    'LAM Bin?': r.isLAMLoc ? 'YES' : '',
    'Also in LAM WH': [
      r.alsoInW111 ? 'W111' : '',
      r.alsoInW115 ? 'W115' : '',
      r.alsoInW118 ? 'W118' : '',
    ].filter(Boolean).join(', '),
    'Status': r.status,
  }));

  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  ws['!cols'] = [
    { wch: 10 },  // Warehouse
    { wch: 25 },  // Warehouse Name
    { wch: 18 },  // LAM CPC
    { wch: 25 },  // MPN
    { wch: 8 },   // Qty
    { wch: 15 },  // Location
    { wch: 12 },  // Lot
    { wch: 10 },  // LAM Bin?
    { wch: 15 },  // Also in LAM WH
    { wch: 45 },  // Status
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Wrong Warehouse');

  // Summary sheet
  const summaryRows = Object.entries(summary).map(([status, count]) => ({
    'Status': status,
    'Count': count,
  }));
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 50 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  XLSX.writeFile(wb, outputPath);
}

async function sendNotification(results, summary, attachmentPath, date) {
  // Filter to just misplaced items for the email
  const misplaced = results.filter(r => r.status === 'MISPLACED LAM STOCK - LAM bin location');

  const subject = `LAM Roster Warehouse Review - ${date}`;

  let body = `Hi,\n\n`;
  body += `The weekly LAM wrong warehouse check found ${misplaced.length} item(s) that appear to be misplaced LAM stock:\n\n`;

  // Show first 10 misplaced items
  const showItems = misplaced.slice(0, 10);
  for (const r of showItems) {
    body += `• ${r.mpn} (CPC: ${r.cpc}) - ${r.qty} pcs in ${r.wh} at ${r.loc}\n`;
  }
  if (misplaced.length > 10) {
    body += `• ... and ${misplaced.length - 10} more (see attachment)\n`;
  }

  body += `\nThese items are in LAM-labeled bin locations but not in LAM warehouses (W111/W115/W118).\n`;
  body += `Action: Move to W111.\n\n`;

  body += `Full report attached.\n\n`;
  body += `Thanks,\nClaude`;

  // Use the Python email sender (himalaya has issues with attachments)
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

# Attach file
filename = '${path.basename(attachmentPath)}'
filepath = '${attachmentPath}'
with open(filepath, 'rb') as f:
    part = MIMEBase('application', 'octet-stream')
    part.set_payload(f.read())
encoders.encode_base64(part)
part.add_header('Content-Disposition', f'attachment; filename="{filename}"')
msg.attach(part)

# Send
server = smtplib.SMTP_SSL('smtp.mail.us-east-1.awsapps.com', 465)
server.login('${EMAIL_ACCOUNT}@orangetsunami.com', os.environ.get('SMTP_PASSWORD', 'A$tuteu$a'))
server.send_message(msg)
server.quit()
print('Email sent successfully')
`;

  const { execSync } = require('child_process');
  execSync(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, { stdio: 'inherit' });
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
