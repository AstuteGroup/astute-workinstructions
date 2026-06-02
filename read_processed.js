const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const targetUid = parseInt(process.argv[2], 10);
const folder = process.argv[3] || 'Processed';

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  await client.mailboxOpen(folder);
  for await (const msg of client.fetch({ uid: String(targetUid) }, { source: true, envelope: true, uid: true })) {
    const parsed = await simpleParser(msg.source);
    console.log(JSON.stringify({
      uid: msg.uid,
      subject: parsed.subject,
      from: parsed.from && parsed.from.value[0] && parsed.from.value[0].address,
      message_id: parsed.messageId,
      body: parsed.text || ''
    }));
  }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
