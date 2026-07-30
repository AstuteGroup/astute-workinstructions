#!/usr/bin/env node
/**
 * LAM New Lines / Approvals Workflow
 *
 * Processes newly added parts from roster (Phase 3, approvals, etc.) and
 * categorizes them into actionable buckets:
 *   - ORDER: Ready to place PO (all required data present)
 *   - REVIEW: Needs verification (missing data or unusual values)
 *   - NO_ACTION: Informational only (stock OK or POV pending)
 *
 * Also generates reorder-alert format CSV for sourcing pipeline compatibility.
 *
 * Usage:
 *   node lam-new-add.js --award "Phase 3"
 *   node lam-new-add.js --award "Phase 3" --run-sourcing
 *   node lam-new-add.js --award "Phase 3" --rfq 1139539 --run-sourcing --send-email
 *
 * Options:
 *   --award <name>     Filter roster by Award column (required)
 *   --rfq <value>      Source RFQ for validation (required for --send-email)
 *   --run-sourcing     Chain to lam-kitting-source.js after generating CSV
 *   --send-email       Send bucketed xlsx via email (requires --rfq)
 *   --skip-validation  Skip roster validation (NOT RECOMMENDED)
 *   --dry-run          Show what would be done without writing files
 *
 * Output:
 *   output/LAM_NewLinesApprovals_<award>_<date>.xlsx  - Bucketed Excel (Order/Review/No Action tabs)
 *   output/LAM_NewAdd_<award>_<date>.csv              - Reorder-alert format for sourcing
 *   output/LAM_NewAdd_<award>_<date>_sourced.xlsx     - After sourcing (if --run-sourcing)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');

const SCRIPT_DIR = __dirname;
const ROSTER_PATH = path.join(SCRIPT_DIR, 'LAM_Master_Roster.xlsx');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

// Bucketing categories
const BUCKET = {
  ORDER: 'Order',         // New lines or approved changes, no stock → place PO
  REVIEW: 'Review',       // Needs verification before ordering
  NO_ACTION: 'No Action'  // Have stock or notification-only
};

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

// For new parts being added, inventory is assumed to be 0 (they're new)
// Future enhancement: could check Infor inventory via shared/inventory-fetch-and-parse
function getInventoryLevels(cpcs) {
  // New parts have no inventory
  return {};
}

// For new parts being added, POVs don't exist yet (they're new)
// Future enhancement: could check OT for any historical orders
function getExistingPOVs(cpcs) {
  // New parts have no POVs
  return {};
}

// Determine bucket for a new part
// For NEW parts, the decision is based on data completeness:
//   ORDER: All required data present → ready to place PO
//   REVIEW: Missing data or requires verification
//   NO_ACTION: Informational only (rare for new parts)
function determineBucket(part, inventory, existingPOV, opts = {}) {
  const cpc = part['CPC'];
  const mpn = part['MPN'];
  const moq = parseInt(part['MOQ']) || 100;
  const basePrice = part['Base Unit Price'];
  const resalePrice = part['Resale Price'];
  const leadTime = parseInt(part['Contractual Lead Time']) || 0;

  const reviewReasons = [];

  // Missing CPC or MPN → definitely needs review
  if (!cpc) reviewReasons.push('Missing CPC');
  if (!mpn) reviewReasons.push('Missing MPN');

  // Missing pricing data → needs review
  if (!basePrice) reviewReasons.push('Missing Base Price');

  // Note: Resale Price often populated later, don't block on it
  // but flag it for awareness
  const hasResaleWarning = !resalePrice;

  // Very high MOQ → review (unusual, may need approval)
  if (moq > 1000) {
    reviewReasons.push(`High MOQ (${moq})`);
  }

  // Very long lead time → review
  if (leadTime > 30) {
    reviewReasons.push(`Long lead (${leadTime} wks)`);
  }

  // If critical data is missing, route to Review
  if (reviewReasons.length > 0) {
    return {
      bucket: BUCKET.REVIEW,
      reason: reviewReasons.join('; ')
    };
  }

  // All required data present → ready to ORDER
  let orderReason = `New part, MOQ ${moq}`;
  if (leadTime > 0) {
    orderReason += `, ${leadTime} wk lead`;
  }
  if (hasResaleWarning) {
    orderReason += ' (resale price TBD)';
  }

  return {
    bucket: BUCKET.ORDER,
    reason: orderReason
  };
}

// Write multi-sheet Excel with bucketed data
async function writeBucketedExcel(bucketedParts, outputPath, opts = {}) {
  const workbook = new ExcelJS.Workbook();

  const headers = [
    'CPC', 'MPN', 'Manufacturer', 'Description',
    'QTY On Hand', 'Threshold', 'Shortfall',
    'MOQ', 'Base Price', 'Resale Price', 'Lead Time (Wks)',
    'Bucket Reason'
  ];

  for (const bucketName of [BUCKET.ORDER, BUCKET.REVIEW, BUCKET.NO_ACTION]) {
    const parts = bucketedParts[bucketName] || [];
    const sheet = workbook.addWorksheet(bucketName);

    // Add headers
    sheet.addRow(headers);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' }
    };

    // Add data rows
    for (const item of parts) {
      const part = item.part;
      const threshold = parseInt(part['Reorder Threshold']) || parseInt(part['MOQ']) || 100;
      const qtyOnHand = item.qtyOnHand || 0;

      sheet.addRow([
        part['CPC'] || '',
        part['MPN'] || '',
        part['Manufacturer'] || '',
        part['Description'] || '',
        qtyOnHand,
        threshold,
        Math.max(0, threshold - qtyOnHand),
        part['MOQ'] || '',
        part['Base Unit Price'] || '',
        part['Resale Price'] || '',
        part['Contractual Lead Time'] || '',
        item.reason || ''
      ]);
    }

    // Auto-fit columns
    sheet.columns.forEach(col => {
      col.width = 15;
    });
    sheet.getColumn(4).width = 40; // Description
    sheet.getColumn(12).width = 30; // Reason

    // Color code by bucket
    const bucketColors = {
      [BUCKET.ORDER]: 'FFFFCCCC',    // Light red - action needed
      [BUCKET.REVIEW]: 'FFFFEB9C',   // Light yellow - review
      [BUCKET.NO_ACTION]: 'FFC6EFCE' // Light green - ok
    };

    for (let i = 2; i <= parts.length + 1; i++) {
      const row = sheet.getRow(i);
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: bucketColors[bucketName] }
      };
    }
  }

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
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
  const bucketedXlsx = path.join(OUTPUT_DIR, `LAM_NewLinesApprovals_${awardSlug}_${today}.xlsx`);

  console.log('LAM New Lines / Approvals Workflow');
  console.log('===================================');
  console.log(`Award filter: ${opts.award}`);
  console.log(`Output: ${bucketedXlsx}`);
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

  // For new parts, inventory and POV data will be empty (they're new)
  // Bucketing is based on data completeness
  const cpcs = parts.map(p => p['CPC']).filter(Boolean);
  const inventory = getInventoryLevels(cpcs);
  const existingPOVs = getExistingPOVs(cpcs);

  // Bucket each part
  console.log('');
  console.log('Categorizing parts...');
  const bucketedParts = {
    [BUCKET.ORDER]: [],
    [BUCKET.REVIEW]: [],
    [BUCKET.NO_ACTION]: []
  };

  for (const part of parts) {
    const cpc = part['CPC'];
    const { bucket, reason } = determineBucket(part, inventory, existingPOVs, opts);
    bucketedParts[bucket].push({
      part,
      qtyOnHand: inventory[cpc] || 0,
      reason
    });
  }

  console.log(`  ${BUCKET.ORDER}: ${bucketedParts[BUCKET.ORDER].length} parts (need PO)`);
  console.log(`  ${BUCKET.REVIEW}: ${bucketedParts[BUCKET.REVIEW].length} parts (verify before ordering)`);
  console.log(`  ${BUCKET.NO_ACTION}: ${bucketedParts[BUCKET.NO_ACTION].length} parts (stock OK or POV pending)`);

  if (opts.dryRun) {
    console.log('');
    console.log('  [DRY RUN] Would write:', bucketedXlsx);
    return;
  }

  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write bucketed Excel
  console.log('');
  console.log('Writing bucketed Excel...');
  await writeBucketedExcel(bucketedParts, bucketedXlsx);
  console.log(`  Written: ${bucketedXlsx}`);

  // Also write CSV for sourcing pipeline compatibility
  console.log('');
  console.log('Building reorder-alert CSV (for sourcing)...');
  const rows = parts.map(buildAlertRow);
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
    const finalXlsx = fs.existsSync(outputXlsx) ? outputXlsx : bucketedXlsx;
    if (opts.sendEmail && fs.existsSync(finalXlsx)) {
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

      const { sendLamEmail } = require('./lam-email-templates');

      // Determine mode based on award name
      const isApproval = opts.award.toLowerCase().includes('approval');
      const mode = isApproval ? 'approval' : 'newParts';

      const emailDate = new Date().toISOString().split('T')[0];

      // Build attachments list
      const attachments = [{ filename: path.basename(bucketedXlsx), path: bucketedXlsx }];
      if (fs.existsSync(outputXlsx) && outputXlsx !== bucketedXlsx) {
        attachments.push({ filename: path.basename(outputXlsx), path: outputXlsx });
      }

      await sendLamEmail('newLinesApprovals', {
        date: emailDate,
        mode: mode,
        to: 'jake.harris@astutegroup.com',  // Manual runs → Jake only
        stats: {
          total: parts.length,
          order: bucketedParts[BUCKET.ORDER].length,
          review: bucketedParts[BUCKET.REVIEW].length,
          noAction: bucketedParts[BUCKET.NO_ACTION].length
        },
        notes: `Award: ${opts.award}\nValidated against RFQ ${opts.rfq}`,
        attachments: attachments
      });

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
