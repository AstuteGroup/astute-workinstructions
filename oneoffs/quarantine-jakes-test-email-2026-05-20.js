#!/usr/bin/env node
//
// Find Jake's just-sent test email in vq@ INBOX and move it to NeedsReview
// (which the agent doesn't poll) so the cron won't process it. The operator
// will review the scenario manually.

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
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox.exists;
      if (!exists) { console.log('INBOX empty'); return; }
      const start = Math.max(1, exists - 30);
      const recent = [];
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true }, { uid: true })) {
        recent.push({
          uid: m.uid,
          date: m.envelope.date,
          from: (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '',
          subject: m.envelope.subject || '',
          flags: Array.from(m.flags || []),
        });
      }
      // Latest first
      recent.sort((a, b) => (b.date || 0) - (a.date || 0));
      console.log('Most recent in INBOX:');
      for (const r of recent.slice(0, 8)) {
        console.log(`  UID ${r.uid}: ${r.date && r.date.toISOString()} from=${r.from} flags=${r.flags.join(',') || '(none)'} | ${r.subject}`);
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
