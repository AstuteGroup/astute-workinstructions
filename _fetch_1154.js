const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'stockRFQ@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne('1154', { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);
    console.log('FROM:', parsed.from?.text);
    console.log('SUBJECT:', parsed.subject);
    console.log('DATE:', parsed.date);
    console.log('---BODY---');
    console.log(parsed.text || '(no text, html length=' + (parsed.html||'').length + ')');
    console.log('---ATTACHMENTS---');
    for (const a of parsed.attachments || []) {
      const p = '/home/analytics_user/workspace/file-drop/ncf_' + (a.filename||'unnamed').replace(/[^\w.-]/g, '_');
      fs.writeFileSync(p, a.content);
      console.log(a.filename, '->', p, a.size, 'bytes', a.contentType);
    }
  } finally { lock.release(); await client.logout(); }
})().catch(e => { console.error(e); process.exit(1); });
