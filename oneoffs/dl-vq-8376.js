#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne('8376', { source: true, envelope: true }, { uid: true });
    const p = await simpleParser(msg.source);
    console.log('Subject :', p.subject);
    console.log('From    :', p.from?.text);
    console.log('Date    :', p.date);
    console.log('Body (head):\n' + (p.text || '').slice(0, 800));
    console.log('\nAtts:');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-8376-'));
    for (const a of (p.attachments || [])) {
      if (!a.filename) continue;
      if (/^image\//i.test(a.contentType || '')) continue;
      const dst = path.join(outDir, a.filename);
      fs.writeFileSync(dst, a.content);
      console.log(`  ${dst}  ${a.size}B  ${a.contentType}`);
    }
    console.log('\nDir:', outDir);
  } finally { lock.release(); }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
