#!/usr/bin/env node
/**
 * One-off: list recent messages in NeedInfo / NeedsReview / NotRFQ / Processed
 * for the rfqloading@ inbox, filtered to AMAT-ish subjects, so we can see
 * where the "master AMAT RFQ" email landed.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const FOLDERS = ['INBOX', 'NeedInfo', 'NeedsReview', 'NotRFQ', 'Processed'];
const SINCE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'rfqloading@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  console.log('Connected.');

  for (const folder of FOLDERS) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ since: SINCE }, { uid: true });
        console.log(`\n=== ${folder} (${uids?.length || 0} msgs in last 3d) ===`);
        if (!uids || uids.length === 0) continue;
        const recent = uids.slice(-30); // most recent 30
        for await (const msg of client.fetch(recent, { envelope: true }, { uid: true })) {
          const env = msg.envelope || {};
          const from = env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '';
          const subj = env.subject || '';
          const date = env.date ? env.date.toISOString() : '';
          const flag = /amat|applied|master/i.test(subj) ? ' <-- MATCH' : '';
          console.log(`  uid=${msg.uid}  ${date}  from=${from}  subj=${subj.slice(0,120)}${flag}`);
        }
      } finally { lock.release(); }
    } catch (e) {
      console.log(`\n=== ${folder} === ERROR: ${e.message}`);
    }
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
