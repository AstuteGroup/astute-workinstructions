#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10), secure: true,
    auth: { user: 'stockRFQ@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const folders = await client.list();
    for (const m of folders) {
      try {
        const status = await client.status(m.path, { messages: true, uidNext: true });
        console.log(`${m.path.padEnd(40)} msgs=${status.messages} uidNext=${status.uidNext}`);
      } catch (e) {
        console.log(`${m.path.padEnd(40)} <error: ${e.message}>`);
      }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
