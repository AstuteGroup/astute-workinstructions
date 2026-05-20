#!/usr/bin/env node
//
// Read Ivy's "RFQ -5/19" email (UID 8509 originally, now in Processed with a
// different UID due to folder move) to see what 7 quotes the table actually
// contained and whether the parts on 1134814 and 1134804 overlap as the
// operator described.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const TARGET_MID = '<DB9PR02MB7020A54B4FEA4BF2E73C501695012@DB9PR02MB7020.eurprd02.prod.outlook.com>';

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
    for (const folder of ['Processed', 'INBOX', 'NeedsReview']) {
      console.log(`\n--- ${folder} ---`);
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = client.mailbox.exists;
        if (!exists) continue;
        const start = Math.max(1, exists - 40);
        for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
          const subj = m.envelope.subject || '';
          const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
          const date = m.envelope.date;
          if (from.includes('ivy.song') && date && /^2026-05-(19|20)/.test(date.toISOString())) {
            console.log(`  UID ${m.uid}: ${date.toISOString()} | ${subj}`);
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
