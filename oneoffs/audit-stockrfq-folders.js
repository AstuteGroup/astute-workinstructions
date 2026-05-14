#!/usr/bin/env node
/**
 * Audit which IMAP folders exist in stockRFQ@orangetsunami.com vs which ones
 * the stockrfq + stockrfq-cq workflow handlers route messages to.
 *
 * The poller's `route` command moves the email to action.folder after the
 * handler runs. If the folder doesn't exist, the move fails and the message
 * loops in INBOX next tick.
 *
 * Read-only. Lists folders + checks the required ones.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const REQUIRED_FOLDERS = [
  // stockrfq workflow:
  'Processed',
  'NeedsReview',
  'NotRFQ',
  'OutboundPending',
  'LargeStockRFQApprovals',
  // stockrfq-cq workflow (reads from OutboundPending):
  'CQ-Processed',
  'CQ-Skipped',
  'CQ-NeedsReview',
];

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'stockRFQ@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  console.log(`Connected to stockRFQ@orangetsunami.com`);
  console.log('');

  const mailboxes = await client.list();
  const existingPaths = new Set(mailboxes.map(m => m.path));

  console.log(`All folders in this account (${mailboxes.length}):`);
  for (const mb of mailboxes.sort((a, b) => a.path.localeCompare(b.path))) {
    const isRequired = REQUIRED_FOLDERS.includes(mb.path);
    const marker = isRequired ? '  [required] ' : '              ';
    console.log(`${marker}${mb.path}`);
  }

  console.log('');
  console.log('Required folder check:');
  let allPresent = true;
  for (const folder of REQUIRED_FOLDERS) {
    const present = existingPaths.has(folder);
    if (!present) allPresent = false;
    console.log(`  ${present ? '✓' : '✗ MISSING'}  ${folder}`);
  }
  console.log('');
  if (allPresent) {
    console.log('All required folders present.');
  } else {
    console.log('Some folders missing. Run create-stockrfq-folders.js next to create them.');
  }

  await client.logout();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
