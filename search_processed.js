const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const subject = process.argv[2];
(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  await client.mailboxOpen('Processed');
  // Search by subject substring
  const uids = await client.search({ subject, since: new Date(Date.now() - 7*86400000) });
  console.error(`UIDs matching: ${uids.join(', ')}`);
  for await (const msg of client.fetch(uids.slice(-2), { source: true, envelope: true, uid: true })) {
    const parsed = await simpleParser(msg.source);
    console.log('===', msg.uid, '|', parsed.subject, '|', parsed.from?.value[0]?.address);
    console.log('MID:', parsed.messageId);
    console.log('BODY:');
    console.log(parsed.text || '');
    console.log('---END---');
  }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
