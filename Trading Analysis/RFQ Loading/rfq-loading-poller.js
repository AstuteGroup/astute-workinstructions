#!/usr/bin/env node
/**
 * Legacy entry point for RFQ Loading — delegates to the generic
 * shared/email-workflow-poller.js with --workflow rfq-loading.
 *
 * This file is preserved so existing /schedule routines and operator scripts
 * continue to work without modification. For new email-driven workflows,
 * invoke shared/email-workflow-poller.js directly. See:
 *   ~/workspace/astute-workinstructions/email-workflow-architecture.md
 */

const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
if (!args.includes('--workflow')) args.push('--workflow', 'rfq-loading');

const r = spawnSync(process.execPath, [
  path.resolve(__dirname, '../../shared/email-workflow-poller.js'),
  ...args,
], { stdio: 'inherit' });

process.exit(r.status == null ? 1 : r.status);
