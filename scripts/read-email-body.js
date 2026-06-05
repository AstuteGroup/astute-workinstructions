#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

const INBOX = process.argv[2] || 'excess@orangetsunami.com';
const UID = process.argv[3];

if (!UID) {
  console.error('Usage: read-email-body.js <inbox> <uid>');
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
    const msg = await client.fetchOne(String(UID), {
      envelope: true,
      bodyStructure: true,
      source: true
    }, { uid: true });

    if (!msg) {
      console.error('Message not found');
      process.exit(1);
    }

    console.log('=== ENVELOPE ===');
    console.log('Subject:', msg.envelope?.subject);
    console.log('From:', JSON.stringify(msg.envelope?.from));
    console.log('To:', JSON.stringify(msg.envelope?.to));
    console.log('CC:', JSON.stringify(msg.envelope?.cc));
    console.log('Date:', msg.envelope?.date);

    console.log('\n=== BODY (first 5000 chars) ===');
    const source = msg.source?.toString() || '';
    // Find body content (after headers)
    const bodyStart = source.indexOf('\r\n\r\n');
    if (bodyStart > 0) {
      console.log(source.slice(bodyStart, bodyStart + 5000));
    } else {
      console.log(source.slice(0, 5000));
    }

  } finally {
    lock.release();
    await client.logout();
  }
})();
