'use strict';
/**
 * List all messages in Processed/NeedsReview/NeedsPartner folders received during 5/04-5/07.
 * Just envelope info — subject, date, message-id, from.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { ImapFlow } = require('imapflow');

const EMAIL = 'excess@orangetsunami.com';

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: EMAIL, pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });

  await client.connect();

  for (const folder of ['INBOX', 'Processed', 'NeedsReview', 'NeedsPartner']) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch (e) {
      console.log(`(skip ${folder}: ${e.message})`); continue;
    }
    try {
      const status = await client.status(folder, { messages: true, uidNext: true });
      console.log(`\n=== ${folder} === (${status.messages} messages, uidNext=${status.uidNext})`);
      if (!status.messages || status.messages === 0) continue;

      // Fetch envelopes for the most recent ~500 messages
      const range = status.messages > 500 ? `${status.messages - 500}:${status.messages}` : '1:*';
      let count = 0;
      for await (const msg of client.fetch(range, { envelope: true, uid: true, internalDate: true })) {
        const dt = msg.internalDate || (msg.envelope && msg.envelope.date);
        if (!dt) continue;
        const date = new Date(dt);
        if (date >= new Date('2026-05-03') && date <= new Date('2026-05-08')) {
          const subj = (msg.envelope && msg.envelope.subject) || '';
          const from = (msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {};
          const fromStr = from.address || '?';
          console.log(`  UID ${msg.uid}  ${date.toISOString().slice(0,16)}  ${fromStr.padEnd(40).slice(0,40)}  ${subj.slice(0, 80)}`);
          count++;
        }
      }
      console.log(`  → ${count} messages in 5/03–5/07 window`);
    } finally {
      lock.release();
    }
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
