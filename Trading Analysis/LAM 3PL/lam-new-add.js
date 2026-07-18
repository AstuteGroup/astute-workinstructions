#!/usr/bin/env node
/**
 * LAM New Add Workflow
 *
 * Generates reorder-alert format CSV for newly added parts (Phase 3, etc.)
 * so they can be enriched via the standard lam-kitting-source.js pipeline.
 *
 * Usage:
 *   node lam-new-add.js --award "Phase 3" --rfq 1139539
 *   node lam-new-add.js --award "Phase 3" --rfq 1139539 --run-sourcing
 *   node lam-new-add.js --award "Phase 3" --rfq 1139539 --run-sourcing --send-email
 *
 * Options:
 *   --award <name>     Filter roster by Award column (required)
 *   --rfq <value>      Source RFQ for validation (required for --send-email)
 *   --run-sourcing     Chain to lam-kitting-source.js after generating CSV
 *   --send-email       Send sourced xlsx via email (requires --run-sourcing AND --rfq)
 *   --skip-validation  Skip roster validation (NOT RECOMMENDED)
 *   --dry-run          Show what would be done without writing files
 *
 * Output:
 *   output/LAM_NewAdd_<award>_<date>.csv           - Reorder-alert format
 *   output/LAM_NewAdd_<award>_<date>_sourced.xlsx  - After sourcing (if --run-sourcing)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ROSTER_PATH = path.join(SCRIPT_DIR, 'LAM_Master_Roster.xlsx');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

// Reorder alert columns - must match what lam-kitting-source.js expects
const ALERT_HEADERS = [
  'Lam P/N', 'MPN', 'Manufacturer', 'Item Description',
  'QTY ON HAND', 'W115 Stale Inventory', 'Reorder Threshold', 'Shortfall', 'Priority',
  'On Order Qty', 'Recent POV', 'Last Promise Date', 'Last RFQ',
  'Base Unit Price', 'Resale Price', 'Historical Purchase Price',
  'OT Previous Supplier', 'OT Buyer', 'Historical Buyer',
  'Lead Time', 'LAM MOQ'
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    award: null,
    rfq: null,
    runSourcing: false,
    sendEmail: false,
    skipValidation: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--award' && args[i + 1]) {
      opts.award = args[++i];
    } else if (args[i] === '--rfq' && args[i + 1]) {
      opts.rfq = args[++i];
    } else if (args[i] === '--run-sourcing') {
      opts.runSourcing = true;
    } else if (args[i] === '--send-email') {
      opts.sendEmail = true;
    } else if (args[i] === '--skip-validation') {
      opts.skipValidation = true;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    }
  }

  return opts;
}

function loadRoster() {
  if (!fs.existsSync(ROSTER_PATH)) {
    console.error('ERROR: Master Roster not found:', ROSTER_PATH);
    process.exit(1);
  }
  const wb = XLSX.readFile(ROSTER_PATH);
  return XLSX.utils.sheet_to_json(wb.Sheets['Master Roster']);
}

function buildAlertRow(part) {
  const moq = parseInt(part['MOQ']) || 100;
  const threshold = parseInt(part['Reorder Threshold']) || moq;

  return [
    part['CPC'] || '',
    part['MPN'] || '',
    part['Manufacturer'] || '',
    part['Description'] || '',
    0,                    // QTY ON HAND - new parts have 0
    '',                   // W115 Stale Inventory
    threshold,            // Reorder Threshold
    threshold,            // Shortfall = threshold (100% shortfall for new parts)
    'CRITICAL',           // Priority - all new parts are critical
    0,                    // On Order Qty
    '',                   // Recent POV
    '',                   // Last Promise Date
    '',                   // Last RFQ
    part['Base Unit Price'] || '',
    part['Resale Price'] || '',
    '',                   // Historical Purchase Price
    '',                   // OT Previous Supplier
    '',                   // OT Buyer
    part['Buyer'] || '',  // Historical Buyer
    part['Contractual Lead Time'] || '',
    moq                   // LAM MOQ
  ];
}

function writeCSV(rows, outputPath) {
  const csvContent = [
    ALERT_HEADERS.join(','),
    ...rows.map(r => r.map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
  ].join('\n');

  fs.writeFileSync(outputPath, csvContent);
  return csvContent;
}

function validateParts(parts, award) {
  const issues = [];

  for (const p of parts) {
    const missing = [];
    if (!p['CPC']) missing.push('CPC');
    if (!p['MPN']) missing.push('MPN');
    if (!p['Base Unit Price']) missing.push('Base Unit Price');
    if (!p['Resale Price']) missing.push('Resale Price');

    if (missing.length > 0) {
      issues.push(`${p['CPC'] || p['MPN'] || '(unknown)'}: missing ${missing.join(', ')}`);
    }
  }

  return issues;
}

async function main() {
  const opts = parseArgs();

  if (!opts.award) {
    console.error('Usage: node lam-new-add.js --award <name> [--run-sourcing] [--send-email]');
    console.error('');
    console.error('Example: node lam-new-add.js --award "Phase 3" --run-sourcing --send-email');
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const awardSlug = opts.award.replace(/\s+/g, '_');
  const outputCsv = path.join(OUTPUT_DIR, `LAM_NewAdd_${awardSlug}_${today}.csv`);
  const outputXlsx = outputCsv.replace('.csv', '_sourced.xlsx');

  console.log('LAM New Add Workflow');
  console.log('====================');
  console.log(`Award filter: ${opts.award}`);
  console.log(`Output: ${outputCsv}`);
  console.log('');

  // Load and filter roster
  console.log('Loading Master Roster...');
  const roster = loadRoster();
  const parts = roster.filter(r => String(r['Award'] || '').trim() === opts.award);

  if (parts.length === 0) {
    console.error(`ERROR: No parts found with Award = "${opts.award}"`);
    process.exit(1);
  }

  console.log(`  Found ${parts.length} parts with Award = "${opts.award}"`);

  // Validate
  const issues = validateParts(parts, opts.award);
  if (issues.length > 0) {
    console.log('');
    console.log('WARNING: Some parts have missing data:');
    issues.forEach(i => console.log(`  - ${i}`));
    console.log('');
  }

  // Build alert rows
  console.log('');
  console.log('Building reorder-alert CSV...');
  const rows = parts.map(buildAlertRow);

  if (opts.dryRun) {
    console.log('  [DRY RUN] Would write:', outputCsv);
    console.log(`  [DRY RUN] ${rows.length} rows`);
    return;
  }

  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write CSV
  writeCSV(rows, outputCsv);
  console.log(`  Written: ${outputCsv}`);
  console.log(`  ${rows.length} parts ready for sourcing`);

  // Run sourcing if requested
  if (opts.runSourcing) {
    console.log('');
    console.log('Running franchise sourcing...');
    console.log('─'.repeat(60));

    const sourcingScript = path.join(SCRIPT_DIR, 'lam-kitting-source.js');
    try {
      execSync(`node "${sourcingScript}" "${outputCsv}"`, {
        stdio: 'inherit',
        cwd: SCRIPT_DIR,
      });
    } catch (err) {
      console.error('Sourcing failed:', err.message);
      process.exit(1);
    }

    console.log('─'.repeat(60));
    console.log(`Sourced output: ${outputXlsx}`);

    // Send email if requested
    if (opts.sendEmail && fs.existsSync(outputXlsx)) {
      // VALIDATION GATE: Must validate against RFQ before sending
      if (!opts.rfq && !opts.skipValidation) {
        console.error('');
        console.error('ERROR: --rfq required when using --send-email');
        console.error('       This ensures roster data is validated against OT before sending.');
        console.error('       Use --skip-validation to bypass (NOT RECOMMENDED)');
        process.exit(1);
      }

      if (opts.rfq && !opts.skipValidation) {
        console.log('');
        console.log('Validating roster against RFQ...');
        const { validateRoster } = require('../../shared/roster-validator');
        const validation = await validateRoster({ award: opts.award, rfqValue: opts.rfq });

        if (!validation.valid) {
          console.error('');
          console.error('VALIDATION FAILED - Email blocked');
          console.error('Issues found:');
          for (const issue of validation.issues) {
            console.error('  - ' + issue);
          }
          console.error('');
          console.error('Fix roster data before sending. Use scripts/check-phase3-roster.js to auto-fix.');
          process.exit(1);
        }
      }

      console.log('');
      console.log('Sending email...');

      // Load sourced data for summary
      const wb = XLSX.readFile(outputXlsx);
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

      const inStock = data.filter(r => r['In Stock Supplier']).length;
      const leadTime = data.filter(r => !r['In Stock Supplier'] && r['Lead Time Supplier']).length;
      const restricted = data.filter(r => String(r['Sourcing Status'] || '').startsWith('RESTRICTED')).length;
      const noCoverage = data.filter(r => r['Sourcing Status'] === 'NO COVERAGE').length;

      const { createNotifier } = require('../../shared/notifier');
      const notifier = createNotifier({
        fromEmail: 'vortex@orangetsunami.com',
        fromName: 'LAM 3PL'
      });

      const subject = `LAM ${opts.award} Sourced - ${parts.length} Parts (${inStock} In Stock, ${leadTime} Lead Time, ${restricted} Restricted, ${noCoverage} No Coverage)`;
      const body = `${opts.award} new add enrichment attached.\n\nValidated against RFQ ${opts.rfq}.\nSame format as weekly reorder - review margins and create VQs for ready items.`;

      await notifier.sendWithAttachment(
        process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com',
        subject,
        body,
        [{ filename: path.basename(outputXlsx), path: outputXlsx }]
      );

      console.log('  Email sent');
    }
  }

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
