#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
  port: 993,
  secure: true,
  auth: {
    user: 'lamkitting@orangetsunami.com',
    pass: process.env.WORKMAIL_PASS
  },
  logger: false,
});

(async () => {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    // Search for Mouser POV0075257 emails
    const uids = await client.search({ or: [
      { subject: 'POV0075257' },
      { subject: '89497435' },
      { subject: '89519101' },
      { subject: 'Mouser' }
    ]});
    console.log('Found', uids.length, 'relevant emails');
    console.log('UIDs:', uids.slice(0, 30).join(', '));
  } finally {
    lock.release();
    await client.logout();
  }
})();
