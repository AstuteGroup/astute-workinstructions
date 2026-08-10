#!/usr/bin/env node
/**
 * add-link-alloc-so-to-cli.js
 *
 * Adds the 'link-alloc-so' subcommand to /opt/writeback/cli.js
 *
 * Run as analytics_user:
 *   sudo -u analytics_user node scripts/add-link-alloc-so-to-cli.js
 *   sudo -u analytics_user node scripts/add-link-alloc-so-to-cli.js --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CLI_PATH = '/opt/writeback/cli.js';
const BACKUP_PATH = '/opt/writeback/cli.js.bak';

const NEW_SUBCOMMAND = `  'link-alloc-so': {
    module: 'alloc-patcher',
    fn: 'linkAllocSOLine',
    args: ['allocId', 'soLineId', 'opts'],
    description: 'Link a lot allocation to an SO Line (PATCH C_OrderLine_ID on chuboe_alloc_order_lot)',
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
  if (content.includes("'link-alloc-so'")) {
    console.log('✓ link-alloc-so subcommand already exists in CLI');
    process.exit(0);
  }

  // Find the SUBCOMMANDS object and insert the new entry
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

  // Copy the alloc-patcher module
  const writerSrc = path.join(__dirname, '../shared/alloc-patcher.js');
  const writerDst = '/opt/writeback/alloc-patcher.js';

  if (fs.existsSync(writerSrc)) {
    fs.copyFileSync(writerSrc, writerDst);
    console.log(`✓ Copied writer module to: ${writerDst}`);
  } else {
    console.log(`Warning: Writer module not found at ${writerSrc}`);
    console.log(`You may need to manually copy shared/alloc-patcher.js to /opt/writeback/`);
  }

  // Also need record-updater and breadcrumbs if not already there
  const deps = ['record-updater.js', 'breadcrumbs.js'];
  for (const dep of deps) {
    const depSrc = path.join(__dirname, '../shared', dep);
    const depDst = path.join('/opt/writeback', dep);
    if (fs.existsSync(depSrc) && !fs.existsSync(depDst)) {
      fs.copyFileSync(depSrc, depDst);
      console.log(`✓ Copied dependency: ${depDst}`);
    }
  }

  console.log();
  console.log('Done! Test with:');
  console.log('  echo \'{"allocId":12345,"soLineId":67890,"opts":{"dryRun":true}}\' | /opt/writeback/cli link-alloc-so');
}

main();
