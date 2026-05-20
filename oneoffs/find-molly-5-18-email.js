#!/usr/bin/env node
//
// Find the "转发: Re: RFQ 5/18/2026" email from Ivy (Molly batch). Look across
// folders — could be Processed (handled), INBOX (unprocessed), NeedsReview
// (bounced), NoBid, or somewhere else.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');

function getPassword() {
  return process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
}

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: getPassword() },
    logger: false,
  });

  await client.connect();
  try {
    const folders = ['INBOX', 'Processed', 'NeedsReview', 'NoBid', 'NeedsVendor', 'ClarifyVendor', 'NeedInfoVendor'];
    for (const folder of folders) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const exists = client.mailbox.exists;
          if (!exists) continue;
          const start = Math.max(1, exists - 150);
          for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true }, { uid: true })) {
            const subj = m.envelope.subject || '';
            const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
            // Match "RFQ 5/18" or "RFQ-5/18" or "RFQ 05/18" etc.
            if (from.includes('ivy.song') && /RFQ\s*-?\s*0?5\s*[\/-]\s*18|5\s*[\/-]\s*18\s*\/?\s*2026/i.test(subj)) {
              const flags = Array.from(m.flags || []).join(',') || '(none)';
              console.log(`[${folder}] UID ${m.uid}: ${m.envelope.date.toISOString()} | flags=${flags} | ${subj}`);
            }
          }
        } finally {
          lock.release();
        }
      } catch (e) {
        if (!/Mailbox doesn't exist/i.test(e.message)) console.error(`  ${folder}: ${e.message}`);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
