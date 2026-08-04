#!/usr/bin/env node
/**
 * add-currency-rates-to-cli.js
 *
 * Adds the 'currency-rates' subcommand to /opt/writeback/cli.js
 *
 * Run as analytics_user:
 *   sudo -u analytics_user node scripts/add-currency-rates-to-cli.js
 *   sudo -u analytics_user node scripts/add-currency-rates-to-cli.js --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLI_PATH = '/opt/writeback/cli.js';
const BACKUP_PATH = '/opt/writeback/cli.js.bak';

const NEW_SUBCOMMAND = `  'currency-rates': {
    module: 'currency-rate-writer',
    fn: 'writeCurrencyRates',
    args: ['opts'],
    description: 'Write currency conversion rates to C_Conversion_Rate',
  },`;

function main() {
  const apply = process.argv.includes('--apply');

  // Check if CLI exists
  if (!fs.existsSync(CLI_PATH)) {
    console.error(`Error: CLI not found at ${CLI_PATH}`);
    process.exit(1);
  }

  // Read current CLI
  const content = fs.readFileSync(CLI_PATH, 'utf8');

  // Check if already added
  if (content.includes("'currency-rates'")) {
    console.log('✓ currency-rates subcommand already exists in CLI');
    process.exit(0);
  }

  // Find the SUBCOMMANDS object and insert the new entry
  // Look for the last entry before the closing brace
  const subcommandsMatch = content.match(/const SUBCOMMANDS = \{[\s\S]*?\n\};/);
  if (!subcommandsMatch) {
    console.error('Error: Could not find SUBCOMMANDS object in CLI');
    process.exit(1);
  }

  const subcommands = subcommandsMatch[0];

  // Find position to insert (before the closing };)
  const insertPos = subcommands.lastIndexOf('\n};');
  if (insertPos === -1) {
    console.error('Error: Could not find insertion point');
    process.exit(1);
  }

  // Build new SUBCOMMANDS block
  const newSubcommands =
    subcommands.slice(0, insertPos) +
    '\n' + NEW_SUBCOMMAND +
    subcommands.slice(insertPos);

  const newContent = content.replace(subcommands, newSubcommands);

  console.log('=== PROPOSED CHANGE ===');
  console.log('Adding to SUBCOMMANDS:');
  console.log(NEW_SUBCOMMAND);
  console.log();

  if (!apply) {
    console.log('--- Preview only. Run with --apply to make changes. ---');
    process.exit(0);
  }

  // Backup original
  fs.copyFileSync(CLI_PATH, BACKUP_PATH);
  console.log(`Backed up to: ${BACKUP_PATH}`);

  // Write updated CLI
  fs.writeFileSync(CLI_PATH, newContent, 'utf8');
  console.log(`✓ Updated: ${CLI_PATH}`);

  // Also need to ensure the currency-rate-writer module is accessible
  const writerSrc = path.join(__dirname, '../shared/currency-rate-writer.js');
  const writerDst = '/opt/writeback/currency-rate-writer.js';

  if (fs.existsSync(writerSrc)) {
    fs.copyFileSync(writerSrc, writerDst);
    console.log(`✓ Copied writer module to: ${writerDst}`);
  } else {
    console.log(`Warning: Writer module not found at ${writerSrc}`);
    console.log(`You may need to manually copy shared/currency-rate-writer.js to /opt/writeback/`);
  }

  console.log();
  console.log('Done! Test with:');
  console.log('  echo \'{"opts":{"rates":[{"from":"EUR","to":"USD","rate":1.14}],"validFrom":"2026-08-04","validTo":"2026-09-03","dryRun":true}}\' | /opt/writeback/cli currency-rates');
}

main();
