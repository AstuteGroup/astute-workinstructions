#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'rfqloading@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('NeedInfo');
  try {
    const msg = await client.fetchOne('117', { source: true }, { uid: true });
    const p = await simpleParser(msg.source);
    const out = '/tmp/amat-117-body.txt';
    fs.writeFileSync(out, p.text || p.html || '');
    console.log('wrote', out, fs.statSync(out).size, 'bytes');
    console.log('Message-ID:', p.messageId);
  } finally { lock.release(); }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
