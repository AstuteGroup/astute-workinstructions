#!/usr/bin/env node

/**
 * Batch reprocess emails from a mail folder
 *
 * This script lists all emails CURRENTLY in the target folder and processes them
 * using their current IDs. This is the permanent solution - IDs are always fresh
 * and correct regardless of previous folder moves.
 *
 * Usage:
 *   node scripts/batch-reprocess.js                    # Process all in Processed folder
 *   node scripts/batch-reprocess.js --folder INBOX     # Process from INBOX
 *   node scripts/batch-reprocess.js --limit 10         # Process only 10 emails
 *   node scripts/batch-reprocess.js --dry-run          # Parse but don't write CSVs
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { listEnvelopes, readMessage } = require('../src/email/fetcher');
const { markProcessed } = require('../src/email/tracker');
const { extractFromAllSources } = require('../src/parser/multi-source-extractor');
const { mapFields } = require('../src/mapper/field-mapper');
const { writeCSV } = require('../src/output/csv-writer');

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    folder: 'Processed',
    limit: 500,
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--folder' && args[i + 1]) {
      options.folder = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  console.log('=== Batch Reprocess Emails ===\n');
  console.log(`Folder: ${options.folder}`);
  console.log(`Limit: ${options.limit}`);
  console.log(`Dry run: ${options.dryRun}\n`);

  // List all emails CURRENTLY in the folder - this is the key fix
  // We use the current IDs directly, not stored IDs from a tracker file
  console.log(`Listing emails in ${options.folder} folder...`);
  const envelopes = await listEnvelopes(options.folder, options.limit);

  if (envelopes.length === 0) {
    console.log('No emails found in folder.');
    return;
  }

  console.log(`Found ${envelopes.length} emails to process\n`);

  let processed = 0;
  let failed = 0;
  let vendorMatched = 0;
  let vendorMissing = 0;
  let totalRows = 0;

  for (const envelope of envelopes) {
    const id = envelope.id;

    try {
      // Read message using current ID from the folder
      const body = await readMessage(id, options.folder);
      if (!body) {
        console.log(`[${id}] SKIP - could not read message body`);
        failed++;
        continue;
      }

      // Parse email using multi-source extractor
      const parsed = await extractFromAllSources(
        id,
        body,
        envelope.subject,
        options.folder,
        envelope.hasAttachment
      );

      // Map fields (async - includes vendor lookup)
      const rows = await mapFields(parsed, envelope, body);

      if (rows.length === 0) {
        console.log(`[${id}] SKIP - no rows parsed from: ${envelope.subject.substring(0, 50)}`);
        failed++;
        continue;
      }

      // Check vendor capture
      const hasVendor = rows[0].c_bpartner_id && rows[0].c_bpartner_id !== '';
      if (hasVendor) {
        vendorMatched++;
      } else {
        vendorMissing++;
      }

      const rfq = rows[0].chuboe_rfq_id || 'UNKNOWN';
      const vendorName = envelope.from ? (envelope.from.name || '') : '';

      if (options.dryRun) {
        // Dry run - just show what would be done
        const vendorStatus = hasVendor ? `✓ vendor ${rows[0].c_bpartner_id}` : '✗ no vendor';
        console.log(`[${id}] DRY RUN - RFQ ${rfq}, ${rows.length} rows, ${vendorStatus}`);
        processed++;
        totalRows += rows.length;
      } else {
        // Write CSV
        const csvPath = writeCSV(rows, rfq, vendorName, OUTPUT_DIR);

        if (csvPath) {
          // Update tracker with current ID
          markProcessed(id, {
            rfq,
            csvFile: path.basename(csvPath),
            subject: envelope.subject,
            from: envelope.from ? envelope.from.addr : '',
            rows: rows.length,
            vendor: hasVendor ? rows[0].c_bpartner_id : 'MISSING',
            folder: options.folder,
            processedAt: new Date().toISOString()
          });

          processed++;
          totalRows += rows.length;
          const vendorStatus = hasVendor ? `✓ vendor ${rows[0].c_bpartner_id}` : '✗ no vendor';
          console.log(`[${id}] OK - RFQ ${rfq}, ${rows.length} rows, ${vendorStatus}`);
        } else {
          failed++;
          console.log(`[${id}] FAIL - could not write CSV`);
        }
      }

    } catch (err) {
      failed++;
      console.log(`[${id}] ERROR - ${err.message}`);
    }

    // Progress every 50
    if ((processed + failed) % 50 === 0 && processed + failed > 0) {
      const pct = Math.round((processed + failed) / envelopes.length * 100);
      console.log(`\n--- Progress: ${processed + failed}/${envelopes.length} (${pct}%) ---\n`);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Folder: ${options.folder}`);
  console.log(`Total emails: ${envelopes.length}`);
  console.log(`Processed: ${processed} (${Math.round(processed / envelopes.length * 100)}%)`);
  console.log(`Failed: ${failed}`);
  console.log(`Total rows: ${totalRows}`);

  if (processed > 0) {
    console.log(`\nVendor capture:`);
    console.log(`  Matched: ${vendorMatched} (${Math.round(vendorMatched / processed * 100)}%)`);
    console.log(`  Missing: ${vendorMissing} (${Math.round(vendorMissing / processed * 100)}%)`);
  }

  if (options.dryRun) {
    console.log('\n[DRY RUN] No files were written.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
