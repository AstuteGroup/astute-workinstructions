#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

function getPassword() { return process.env.WORKMAIL_PASS || process.env.SMTP_PASS; }

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: getPassword() },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('Processed');
    try {
      const msg = await client.fetchOne('8517', { source: true, envelope: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      console.log('Subject: ' + parsed.subject);
      console.log('From:    ' + (parsed.from && parsed.from.text));
      console.log('To:      ' + (parsed.to && parsed.to.text));
      console.log('Cc:      ' + (parsed.cc && parsed.cc.text));
      console.log('Date:    ' + parsed.date.toISOString());
      console.log('\n--- BODY (first 3000 chars) ---');
      console.log((parsed.text || '').slice(0, 3000));
      fs.writeFileSync(path.join(process.env.HOME, 'workspace', 'uid8517-body.txt'), parsed.text || '');
      // Find RFQ numbers
      const rfqs = [...new Set((parsed.text || '').match(/\b11[0-9]{5}\b/g) || [])];
      console.log('\n--- RFQ numbers found: ---');
      for (const r of rfqs) console.log('  ' + r);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
