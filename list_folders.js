const { ImapFlow } = require('imapflow');
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const list = await client.list();
  for (const m of list) console.log(m.path, '|', m.specialUse || '');
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
