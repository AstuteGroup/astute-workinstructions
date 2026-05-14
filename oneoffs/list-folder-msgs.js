#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

const folder = process.argv[2];
if (!folder) { console.error('Usage: list-folder-msgs.js <folder>'); process.exit(2); }

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10), secure: true,
    auth: { user: 'stockRFQ@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
        const e = m.envelope || {};
        const from = e.from && e.from[0] ? `${e.from[0].mailbox || ''}@${e.from[0].host || ''}` : '';
        console.log(`uid=${m.uid}  date=${e.date && e.date.toISOString()}  from=${from}  subj=${e.subject || ''}`);
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
