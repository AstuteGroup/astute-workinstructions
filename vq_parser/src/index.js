#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { listEnvelopes, readMessage, moveMessage, createFolder, markUnread } = require('./email/fetcher');
const { isProcessed, markProcessed, getStats, removeProcessed } = require('./email/tracker');
const { extractQuoteData } = require('./parser/extractor');
const { extractFromAllSources } = require('./parser/multi-source-extractor');
const { mapFields } = require('./mapper/field-mapper');
const { writeCSV } = require('./output/csv-writer');
const logger = require('./utils/logger');

const program = new Command();

program
  .name('vq-parser')
  .description('VQ Email Parser - Parse vendor quotes from email into ERP-ready CSVs')
  .version('1.0.0');

program
  .command('fetch')
  .description('Fetch and process new emails from inbox')
  .option('--dry-run', 'Parse but do not generate CSV or mark processed')
  .option('--verbose', 'Detailed parsing output')
  .option('--limit <n>', 'Process at most n emails', parseInt)
  .option('--output-dir <path>', 'Override output directory')
  .action(async (opts) => {
    if (opts.verbose) process.env.VERBOSE = '1';

    const outputDir = opts.outputDir || process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
    logger.info('Starting VQ email fetch...');

    try {
      // Ensure Processed folder exists
      await createFolder('Processed');

      // List inbox envelopes
      const envelopes = await listEnvelopes('INBOX', opts.limit || 50);
      logger.info(`Found ${envelopes.length} envelopes in INBOX`);

      let processed = 0;
      let skipped = 0;
      let failed = 0;

      for (const envelope of envelopes) {
        // Skip already processed
        if (isProcessed(envelope.id)) {
          skipped++;
          continue;
        }

        if (opts.limit && processed >= opts.limit) break;

        logger.info(`Processing email ${envelope.id}: "${envelope.subject}"`);

        try {
          // Read message body
          const body = await readMessage(envelope.id);
          if (!body) {
            logger.warn(`Empty body for message ${envelope.id}`);
            failed++;
            continue;
          }

          // Parse the email using multi-source extractor (attachments, body, links)
          const parsed = await extractFromAllSources(
            envelope.id,
            body,
            envelope.subject,
            'INBOX',
            envelope.hasAttachment
          );
          logger.info(`  Source: ${parsed.source}, Strategy: ${parsed.strategy}, Confidence: ${parsed.confidence}, Lines: ${parsed.lines.length}`);

          if (parsed.needsManualReview) {
            logger.warn(`  Needs manual review - skipping`);
            failed++;
            continue;
          }

          // Map fields (async - uses LLM for vendor inference)
          const rows = await mapFields(parsed, envelope, body);
          logger.info(`  Mapped ${rows.length} rows`);

          if (opts.dryRun) {
            logger.info('  [DRY RUN] Would write CSV with rows:');
            rows.forEach((row, i) => {
              logger.info(`    Row ${i + 1}: MPN=${row.chuboe_mpn}, Cost=${row.cost}, Qty=${row.qty}`);
            });
          } else {
            // Write CSV
            const vendorName = envelope.from ? (envelope.from.name || '') : '';
            const rfq = rows[0] ? rows[0]['chuboe_rfq_id'] : 'UNKNOWN';
            const csvPath = writeCSV(rows, rfq, vendorName, outputDir);

            if (csvPath) {
              // Move email to Processed folder
              await moveMessage(envelope.id, 'Processed');

              // Mark as processed
              markProcessed(envelope.id, {
                rfq,
                csvFile: path.basename(csvPath),
                subject: envelope.subject,
                from: envelope.from ? envelope.from.addr : '',
                rows: rows.length
              });

              processed++;
              logger.info(`  Successfully processed → ${path.basename(csvPath)}`);
            } else {
              failed++;
            }
          }
        } catch (err) {
          logger.error(`  Failed to process email ${envelope.id}:`, err.message);
          failed++;
        }
      }

      logger.info(`\nDone: ${processed} processed, ${skipped} already done, ${failed} failed`);
    } catch (err) {
      logger.error('Fetch failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('parse <file>')
  .description('Parse a single .eml/.txt file (for testing)')
  .option('--verbose', 'Detailed parsing output')
  .option('--output-dir <path>', 'Override output directory')
  .action(async (file, opts) => {
    if (opts.verbose) process.env.VERBOSE = '1';

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      logger.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const body = fs.readFileSync(filePath, 'utf-8');
    const filename = path.basename(filePath, path.extname(filePath));

    logger.info(`Parsing file: ${filePath}`);

    const parsed = extractQuoteData(body, filename);
    logger.info(`Strategy: ${parsed.strategy}, Confidence: ${parsed.confidence}, Lines: ${parsed.lines.length}`);

    if (parsed.flags.length > 0) {
      logger.info(`Flags: ${parsed.flags.join(', ')}`);
    }

    const fakeEnvelope = {
      id: 'file',
      subject: filename,
      from: { name: 'Unknown', addr: 'unknown@unknown.com' },
      to: { name: '', addr: '' },
      date: new Date().toISOString()
    };

    const rows = await mapFields(parsed, fakeEnvelope, body);
    logger.info(`Mapped ${rows.length} rows`);

    if (rows.length > 0) {
      const outputDir = opts.outputDir || process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
      const rfq = rows[0]['chuboe_rfq_id'] || 'UNKNOWN';
      const csvPath = writeCSV(rows, rfq, 'test', outputDir);
      if (csvPath) {
        logger.info(`Output: ${csvPath}`);
      }
    } else {
      logger.warn('No rows parsed from file');
    }
  });

program
  .command('status')
  .description('Show processing stats')
  .action(() => {
    const stats = getStats();
    console.log('\nVQ Parser Status');
    console.log('================');
    console.log(`Processed emails: ${stats.processedCount}`);
    console.log(`Last run: ${stats.lastRun || 'never'}`);
    if (stats.recentIds.length > 0) {
      console.log('\nRecent:');
      stats.recentIds.forEach(item => {
        console.log(`  ID ${item.id}: ${item.subject || 'N/A'} → ${item.csvFile || 'N/A'} (${item.date})`);
      });
    }
  });

program
  .command('reprocess <id>')
  .description('Re-process a specific email ID')
  .option('--verbose', 'Detailed parsing output')
  .option('--output-dir <path>', 'Override output directory')
  .action(async (id, opts) => {
    if (opts.verbose) process.env.VERBOSE = '1';
    logger.info(`Re-processing email ID: ${id}`);

    // Remove from processed list
    removeProcessed(id);

    // Read from INBOX or Processed folder
    let body = await readMessage(id, 'INBOX');
    let sourceFolder = 'INBOX';

    if (!body) {
      body = await readMessage(id, 'Processed');
      sourceFolder = 'Processed';
    }

    if (!body) {
      logger.error(`Could not read message ${id} from INBOX or Processed`);
      process.exit(1);
    }

    const envelopes = await listEnvelopes(sourceFolder, 100);
    const envelope = envelopes.find(e => e.id === String(id)) || {
      id, subject: '', from: {}, to: {}, date: '', hasAttachment: false
    };

    const parsed = await extractFromAllSources(
      id,
      body,
      envelope.subject,
      sourceFolder,
      envelope.hasAttachment
    );
    logger.info(`Source: ${parsed.source}, Strategy: ${parsed.strategy}, Confidence: ${parsed.confidence}, Lines: ${parsed.lines.length}`);

    const rows = await mapFields(parsed, envelope, body);
    if (rows.length > 0) {
      const outputDir = opts.outputDir || process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
      const rfq = rows[0]['chuboe_rfq_id'] || 'UNKNOWN';
      const vendorName = envelope.from ? (envelope.from.name || '') : '';
      const csvPath = writeCSV(rows, rfq, vendorName, outputDir);
      if (csvPath) {
        markProcessed(id, { rfq, csvFile: path.basename(csvPath), reprocessed: true });
        logger.info(`Output: ${csvPath}`);
      }
    }
  });

program
  .command('test-connection')
  .description('Test IMAP connection via himalaya')
  .action(async () => {
    logger.info('Testing IMAP connection...');
    try {
      const envelopes = await listEnvelopes('INBOX', 5);
      logger.info(`Connection successful! Found ${envelopes.length} emails in INBOX.`);
      envelopes.forEach(e => {
        console.log(`  [${e.id}] ${e.subject} (from: ${e.from.name || e.from.addr || 'unknown'})`);
      });
    } catch (err) {
      logger.error('Connection failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('consolidate')
  .description('Consolidate output CSVs into upload-ready files')
  .option('--output-dir <path>', 'Override output directory')
  .option('--dry-run', 'Show what would be done without doing it')
  .action(async (opts) => {
    const outputDir = opts.outputDir || process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output');
    const uploadsDir = path.join(outputDir, 'uploads');
    const archiveDir = path.join(outputDir, 'archive');

    // Ensure directories exist
    [uploadsDir, archiveDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // Read all CSV files in output (not in subdirs)
    const csvFiles = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.csv') && fs.statSync(path.join(outputDir, f)).isFile());

    if (csvFiles.length === 0) {
      console.log('No CSV files to consolidate.');
      return;
    }

    // Parse and categorize
    const { VQ_COLUMNS } = require('../config/columns');
    const { parse } = require('csv-parse/sync');

    const knownRFQ = [];
    const unknownRFQ = [];
    const stats = { complete: 0, partial: 0, mismatch: 0, unknown: 0 };

    for (const file of csvFiles) {
      const content = fs.readFileSync(path.join(outputDir, file), 'utf-8');
      const records = parse(content, { columns: true, skip_empty_lines: true });

      for (const row of records) {
        const rfq = row.chuboe_rfq_id || '';
        const notes = row.chuboe_note_public || '';

        // Categorize for stats
        if (rfq === 'UNKNOWN' || rfq === '') {
          stats.unknown++;
          unknownRFQ.push(row);
        } else {
          if (notes.includes('[PARTIAL')) {
            stats.partial++;
          } else if (notes.includes('Quoted MPN:') && notes.includes('RFQ MPN:')) {
            stats.mismatch++;
          } else {
            stats.complete++;
          }
          knownRFQ.push(row);
        }
      }
    }

    // Generate timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').substring(0, 15);

    // Handle failed parsing emails (in INBOX, not processed)
    await createFolder('NeedsReview');
    const inboxEmails = await listEnvelopes('INBOX', 100);
    const tracker = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'processed-ids.json'), 'utf-8'));
    const trackedSubjects = new Set(Object.values(tracker.processedIds).map(m => m.subject).filter(s => s));

    const failedEmails = inboxEmails.filter(e => !trackedSubjects.has(e.subject));

    console.log('\n=== VQ Consolidation Summary ===\n');
    console.log(`Ready for upload:     ${knownRFQ.length} records`);
    console.log(`  - Complete:         ${stats.complete}`);
    console.log(`  - Partial data:     ${stats.partial}`);
    console.log(`  - MPN mismatch:     ${stats.mismatch}`);
    console.log(`\nNeeds RFQ assignment: ${unknownRFQ.length} records`);
    console.log(`  - RFQ unknown:      ${stats.unknown}`);
    console.log(`\nFailed parsing:       ${failedEmails.length} emails`);

    if (failedEmails.length > 0) {
      console.log('  Emails to review:');
      failedEmails.slice(0, 10).forEach(e => console.log(`    - ${e.subject.substring(0, 60)}`));
      if (failedEmails.length > 10) console.log(`    ... and ${failedEmails.length - 10} more`);
    }

    if (opts.dryRun) {
      console.log('\n[DRY RUN] No files created or moved.');
      return;
    }

    // Write consolidated files
    const { stringify } = require('csv-stringify/sync');

    if (knownRFQ.length > 0) {
      const uploadFile = path.join(uploadsDir, `VQ_UPLOAD_${timestamp}.csv`);
      const data = knownRFQ.map(row => VQ_COLUMNS.map(col => row[col] || ''));
      fs.writeFileSync(uploadFile, stringify([VQ_COLUMNS, ...data]), 'utf-8');
      console.log(`\nCreated: ${uploadFile}`);
    }

    if (unknownRFQ.length > 0) {
      const unknownFile = path.join(uploadsDir, `VQ_UNKNOWN_${timestamp}.csv`);
      const data = unknownRFQ.map(row => VQ_COLUMNS.map(col => row[col] || ''));
      fs.writeFileSync(unknownFile, stringify([VQ_COLUMNS, ...data]), 'utf-8');
      console.log(`Created: ${unknownFile}`);
    }

    // Move original CSVs to archive
    for (const file of csvFiles) {
      const src = path.join(outputDir, file);
      const dest = path.join(archiveDir, file);
      fs.renameSync(src, dest);
    }
    console.log(`\nArchived ${csvFiles.length} source files to ${archiveDir}`);

    // Move failed emails to NeedsReview and mark unread
    if (failedEmails.length > 0) {
      console.log(`\nMoving ${failedEmails.length} failed emails to NeedsReview folder...`);
      for (const email of failedEmails) {
        await moveMessage(email.id, 'NeedsReview', 'INBOX');
        await markUnread(email.id, 'NeedsReview');
      }
      console.log('Done. Emails marked as unread in NeedsReview folder.');
    }

    console.log('\nConsolidation complete.');
  });

program.parse(process.argv);
