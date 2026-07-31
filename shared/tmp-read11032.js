const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve('/home/analytics_user/workspace/.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const INBOX = 'vq@orangetsunami.com';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: INBOX, pass: WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne('11032', { source: true, envelope: true }, { uid: true });
    const parsed = await simpleParser(msg.source);
    fs.writeFileSync('/tmp/11032_text.txt', parsed.text || '');
    fs.writeFileSync('/tmp/11032_html.html', parsed.html || '');
    console.log('text length', (parsed.text||'').length);
    console.log('html length', (parsed.html||'').length);
    console.log('attachments', (parsed.attachments||[]).map(a=>({filename:a.filename, contentType:a.contentType, size:a.size, contentDisposition:a.contentDisposition})));
  } finally {
    lock.release();
    await client.logout().catch(()=>{});
  }
}
main().catch(e=>{ console.error(e); process.exit(1); });
