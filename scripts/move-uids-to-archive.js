#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

const INBOX = process.argv[2];
const ARCHIVE_UIDS = process.argv.slice(3).map(Number);

if (!INBOX || ARCHIVE_UIDS.length === 0) {
  console.error('Usage: move-uids-to-archive.js <inbox> <uid1> <uid2> ...');
  process.exit(1);
}

(async () => {
  const client = new ImapFlow({
    host: 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: INBOX, pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    await client.mailboxCreate('Archive-Stuck').catch(() => {});
    await client.messageMove(ARCHIVE_UIDS, 'Archive-Stuck', { uid: true });
    console.log(`Archived ${ARCHIVE_UIDS.length} emails:`, ARCHIVE_UIDS.join(', '));
  } finally {
    lock.release();
    await client.logout();
  }
})();
