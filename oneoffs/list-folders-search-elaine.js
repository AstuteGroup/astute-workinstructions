#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const folders = await client.list();
    console.log('All folders:');
    for (const f of folders) console.log(`  ${f.path}`);
    console.log();
    for (const f of folders) {
      try {
        const lock = await client.getMailboxLock(f.path);
        try {
          const exists = client.mailbox.exists;
          if (!exists) continue;
          const start = Math.max(1, exists - 500);
          for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
            const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
            if (from.includes('elaine.liang')) {
              console.log(`  [${f.path}] UID ${m.uid}: ${m.envelope.date && m.envelope.date.toISOString()} | ${m.envelope.subject || ''}`);
            }
          }
        } finally { lock.release(); }
      } catch (e) { /* skip locked / nonexistent */ }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
