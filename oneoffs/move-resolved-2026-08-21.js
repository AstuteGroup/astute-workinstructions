require('dotenv').config({path:'/home/analytics_user/workspace/.env'});
const {ImapFlow} = require('imapflow');

// UIDs fully resolved (all POVs in the email successfully patched or confirmed
// already-present) — safe to file as Processed.
const FULLY_RESOLVED = [140,137,134,131,124,115,109,81,79,38,8,5,66,158,152,119,389];

(async () => {
  const client = new ImapFlow({host: process.env.IMAP_HOST||'imap.mail.us-east-1.awsapps.com', port: 993, secure:true, auth:{user:'tracking@orangetsunami.com', pass: process.env.WORKMAIL_PASS}, logger:false});
  await client.connect();
  const lock = await client.getMailboxLock('NeedsReview');
  try {
    await client.messageFlagsAdd(FULLY_RESOLVED, ['\\Seen'], {uid:true});
    const res = await client.messageMove(FULLY_RESOLVED, 'Processed', {uid:true});
    console.log('moved:', JSON.stringify(res));
  } finally {
    lock.release();
  }
  await client.logout();
})();
