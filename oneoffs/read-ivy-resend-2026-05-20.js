#!/usr/bin/env node
//
// Read Ivy's text-format resend email (the one loaded yesterday that wrote
// 293 VQs against Betty's "only red" intent) from the Processed folder.
// Looking for any trace of Molly Huang in the body, since the agent stamped
// her as buyerId 1011012 on that load and neither the RFQ records nor the
// prior VQs reference her.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const TARGET_MID = '<DB9PR02MB70206AD8159DAF482CD40CB395012@DB9PR02MB7020.eurprd02.prod.outlook.com>';

function getPassword() {
  return process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
}

async function searchFolder(client, folder) {
  const lock = await client.getMailboxLock(folder);
  try {
    const exists = client.mailbox.exists;
    if (exists === 0) return null;
    // Look at the most recent 50 messages, find by subject + sender
    const start = Math.max(1, exists - 49);
    let match = null;
    for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
      const subj = m.envelope.subject || '';
      const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
      const date = m.envelope.date;
      const day = date ? date.toISOString().slice(0, 10) : '';
      const hour = date ? date.toISOString().slice(11, 13) : '';
      // Ivy's resend was 2026-05-20 around 09:38 UTC
      if (/upload VQ May 13th/i.test(subj) && from.includes('ivy.song') && day === '2026-05-20' && hour === '09') {
        match = m;
      }
    }
    return match;
  } finally {
    lock.release();
  }
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
    let m = null;
    for (const folder of ['Processed', 'INBOX', 'NeedsReview']) {
      console.log(`Searching ${folder}...`);
      m = await searchFolder(client, folder);
      if (m) {
        console.log(`Found in ${folder}: UID ${m.uid}, subject "${m.envelope.subject}", date ${m.envelope.date.toISOString()}`);
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          const text = parsed.text || '';
          console.log(`\nBody text length: ${text.length} chars`);
          console.log('Searching body for "Molly", "Huang", "molly.huang":');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (/molly|huang/i.test(lines[i])) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length, i + 2);
              console.log(`  Line ${i}: ${lines.slice(start, end).join(' / ').slice(0, 300)}`);
            }
          }
          if (!/molly|huang/i.test(text)) {
            console.log('  NO match in body text. Molly was NOT in the email.');
          }
        } finally {
          lock.release();
        }
        break;
      }
    }
    if (!m) console.log('Not found in any folder.');
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
