#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
  port: 993, secure: true,
  auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
  logger: false,
});
(async () => {
  try {
    await client.connect();
    const mbs = await client.list();
    console.log('CONNECTED. folders (' + mbs.length + '):');
    for (const m of mbs) console.log(' ', m.path);
    await client.logout();
  } catch (e) {
    console.log('CONNECT FAILED:', e.message);
  }
})();
