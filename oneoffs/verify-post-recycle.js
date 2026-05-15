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
  for (const folder of ['INBOX', 'OutboundPending', 'NeedsReview', 'CQ-NeedsReview']) {
    const lock = await client.getMailboxLock(folder);
    try {
      const unseen = (await client.search({ seen: false }, { uid: true })) || [];
      console.log(`${folder}: unseen=${unseen.length}  tail=${unseen.slice(-12).join(',')}`);
    } finally { lock.release(); }
  }
  await client.logout();
})();
