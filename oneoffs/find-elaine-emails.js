#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['Processed', 'INBOX', 'NeedsReview']) {
      console.log(`\n--- ${folder} ---`);
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = client.mailbox.exists;
        if (!exists) continue;
        const start = Math.max(1, exists - 300);
        for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
          const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
          if (from.includes('elaine.liang') && m.envelope.date && /^2026-05-(19|20)/.test(m.envelope.date.toISOString())) {
            console.log(`  UID ${m.uid}: ${m.envelope.date.toISOString()} | ${m.envelope.subject || ''}`);
          }
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
