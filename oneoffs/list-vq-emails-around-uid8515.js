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
    for (const folder of ['Processed', 'INBOX', 'NeedsReview', 'NoBid']) {
      console.log(`\n--- ${folder} ---`);
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = client.mailbox.exists;
        if (!exists) continue;
        const start = Math.max(1, exists - 300);
        const matches = [];
        for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
          if (m.envelope.date && /^2026-05-20T(08|09|10)/.test(m.envelope.date.toISOString())) {
            matches.push({ uid: m.uid, date: m.envelope.date.toISOString(), from: (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '', subj: m.envelope.subject || '' });
          }
        }
        for (const e of matches) console.log(`  UID ${e.uid}: ${e.date} | from=${e.from} | ${e.subj}`);
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
