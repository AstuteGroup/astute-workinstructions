#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
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
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne('118', { source: true }, { uid: true });
    const p = await simpleParser(msg.source);
    console.log('Subject :', p.subject);
    console.log('From    :', p.from?.text);
    console.log('To      :', p.to?.text);
    console.log('Cc      :', p.cc?.text);
    console.log('Date    :', p.date);
    console.log('In-Reply-To:', p.inReplyTo);
    console.log('Atts    :', (p.attachments||[]).map(a=>`${a.filename} (${a.contentType}, ${a.size}B)`));
    console.log('\n--- BODY (full) ---');
    console.log(p.text || p.html || '');
  } finally { lock.release(); }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
