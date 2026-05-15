/**
 * Inspect what's sitting in NeedsReview + CQ-NeedsReview for stockRFQ@.
 */
'use strict';
require('dotenv').config({ path: require('path').join(require('os').homedir(), 'workspace/.env') });
const { ImapFlow } = require('imapflow');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'stockRFQ@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  for (const folder of ['NeedsReview', 'CQ-NeedsReview']) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const status = await client.status(folder, { messages: true, unseen: true });
        const uids = (await client.search({ all: true }, { uid: true })) || [];
        console.log(`${folder}: total=${status.messages}, unseen=${status.unseen}`);
        if (uids.length === 0) continue;
        // Pull envelope + flags for each
        for await (const msg of client.fetch(uids, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const env = msg.envelope || {};
          const flags = [...(msg.flags || [])].join(',') || '-';
          const subj = (env.subject || '').substring(0, 70);
          const ts = msg.internalDate ? msg.internalDate.toISOString().substring(0, 16) : '';
          console.log(`  uid=${msg.uid} flags=${flags} date=${ts}  subj="${subj}"`);
        }
      } finally { lock.release(); }
    } catch (e) {
      console.log(`${folder}: ERROR ${e.message}`);
    }
  }
  await client.logout();
})();
