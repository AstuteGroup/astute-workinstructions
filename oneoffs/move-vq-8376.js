#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

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
    try { await client.mailboxCreate('Processed'); } catch { /* exists */ }
    await client.messageMove('8376', 'Processed', { uid: true });
    console.log('moved INBOX/uid=8376 → Processed');
  } finally { lock.release(); }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
