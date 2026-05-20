#!/usr/bin/env node
//
// Fetch Ivy's "RFQ -5/19" email body to inspect what RFQ headers + parts it
// contained. Operator flagged 1134689 as mentioned twice and wants to verify
// the agent's handling.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

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
    for (const folder of ['Processed', 'INBOX']) {
      console.log(`\n--- ${folder} ---`);
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = client.mailbox.exists;
        if (!exists) continue;
        const start = Math.max(1, exists - 100);
        const matches = [];
        for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
          const subj = m.envelope.subject || '';
          const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
          const date = m.envelope.date;
          if (from.includes('ivy.song') && /RFQ.*5.?\/?19|5\/19.*RFQ/i.test(subj)) {
            matches.push({ uid: m.uid, subject: subj, date: date.toISOString() });
            console.log(`  Candidate UID ${m.uid}: ${date.toISOString()} | ${subj}`);
          }
        }
        // Try each candidate and look for 1134689 in the body
        for (const c of matches) {
          const msg = await client.fetchOne(String(c.uid), { source: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          const text = parsed.text || '';
          const occurrences = (text.match(/1134689/g) || []).length;
          console.log(`    UID ${c.uid}: body has 1134689 × ${occurrences}`);
          if (occurrences > 0) {
            // Print the context around each occurrence
            const lines = text.split('\n');
            const outPath = path.join(process.env.HOME, 'workspace', `molly-batch-uid${c.uid}-body.txt`);
            fs.writeFileSync(outPath, text);
            console.log(`    Body saved: ${outPath}`);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('1134689') || lines[i].includes('1134814') || lines[i].includes('1134804')) {
                const start = Math.max(0, i - 1);
                const end = Math.min(lines.length, i + 3);
                console.log(`    -- Lines ${start}-${end-1} --`);
                for (let j = start; j < end; j++) console.log(`      [${j}] ${lines[j].slice(0, 250)}`);
                console.log();
              }
            }
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
