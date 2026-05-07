#!/usr/bin/env node
/**
 * run-poller.js — universal CLI entry point for the offer pipeline.
 *
 * Replaces excess-poller.js as the cron-invoked script. excess-poller.js
 * is preserved as the legacy reference implementation; both call into
 * shared/offer-poller.js but the legacy file uses inlined logic for any
 * ad-hoc replay scenarios that may still reference it.
 *
 * USAGE:
 *   node run-poller.js --account excess
 *   node run-poller.js --account excess --dry-run
 *   node run-poller.js --account excess --uid 12345        # single message
 *   node run-poller.js --account excess --max 10           # cap this run
 *
 * Future second inbox (placeholder):
 *   node run-poller.js --account broker          # not active until real
 *                                                  inbox added to ACCOUNT_TO_EMAIL
 *                                                  in shared/offer-poller.js
 */

'use strict';

const path = require('path');
const { runOfferPoller, ACCOUNT_TO_EMAIL } = require('../../shared/offer-poller');

function parseArgs(argv) {
  const args = { account: null, dryRun: false, uid: null, max: null, defaultOfferType: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') args.account = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--uid') args.uid = parseInt(argv[++i], 10);
    else if (a === '--max') args.max = parseInt(argv[++i], 10);
    else if (a === '--default-offer-type') args.defaultOfferType = argv[++i];
  }
  return args;
}

function defaultOfferTypeFor(account) {
  switch ((account || '').toLowerCase()) {
    case 'excess':    return 'Customer Excess';
    case 'broker':    return 'Broker Stock Offer';
    case 'franchise': return 'Franchise Offers';
    default: return 'Customer Excess';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) {
    console.error(`Usage: node run-poller.js --account <name> [--dry-run] [--uid <n>] [--max <n>]`);
    console.error(`Available accounts: ${Object.keys(ACCOUNT_TO_EMAIL).join(', ')}`);
    process.exit(2);
  }
  if (!ACCOUNT_TO_EMAIL[args.account]) {
    console.error(`run-poller: account '${args.account}' not configured.`);
    console.error(`Available: ${Object.keys(ACCOUNT_TO_EMAIL).join(', ') || '(none — only excess wired so far)'}`);
    console.error(`Add the inbox email to ACCOUNT_TO_EMAIL in shared/offer-poller.js to enable.`);
    process.exit(2);
  }

  const result = await runOfferPoller({
    account: args.account,
    defaultOfferType: args.defaultOfferType || defaultOfferTypeFor(args.account),
    lockName: `offer-poller-${args.account}`,
    dryRun: args.dryRun,
    uid: args.uid,
    max: args.max,
  });

  if (result.skipped === 'locked') {
    process.exit(0); // silent skip when previous run still active
  }
  if (result.error) {
    console.error('run-poller:', result.error, result.detail || '');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
