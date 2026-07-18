#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
  port: 993,
  secure: true,
  auth: {
    user: 'lamkitting@orangetsunami.com',
    pass: process.env.WORKMAIL_PASS
  },
  logger: false,
});

(async () => {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    // List all emails to see what's there
    const uids = await client.search({ all: true });
    console.log('Total emails in INBOX:', uids.length);
    console.log('UIDs:', uids.join(', '));

    // Read each email's subject
    for (const uid of uids.slice(0, 20)) {
      const msg = await client.fetchOne(uid, { envelope: true });
      console.log(`UID ${uid}: ${msg.envelope.subject}`);
    }
  } finally {
    lock.release();
    await client.logout();
  }
})();
