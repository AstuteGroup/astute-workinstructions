#!/usr/bin/env node
/**
 * Create the IMAP folders the excess workflow handler needs but that don't
 * yet exist on excess@orangetsunami.com.
 *
 * Read audit-excess-folders.js first to confirm what's missing. This script
 * is idempotent — re-creating an existing folder is a no-op (logged but not
 * an error).
 *
 * Pass --dry-run to print what would be created without touching the server.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const DRY_RUN = process.argv.includes('--dry-run');

const REQUIRED_FOLDERS = [
  'Processed',
  'NeedsPartner',
  'NeedsReview',
  'NotOffer',
  'LargeOfferApprovals',
  'NeedInfo',
];

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'excess@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  console.log(`Connected to excess@orangetsunami.com${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const existing = new Set((await client.list()).map(m => m.path));

  let created = 0;
  let skipped = 0;
  for (const folder of REQUIRED_FOLDERS) {
    if (existing.has(folder)) {
      console.log(`  · ${folder} (already exists, skipping)`);
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  + ${folder} (would create)`);
      created++;
      continue;
    }
    try {
      await client.mailboxCreate(folder);
      console.log(`  + ${folder} (created)`);
      created++;
    } catch (e) {
      console.log(`  ✗ ${folder} (error: ${e.message})`);
    }
  }

  console.log('');
  console.log(`Done. ${created} ${DRY_RUN ? 'would be created' : 'created'}, ${skipped} already existed.`);

  await client.logout();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
