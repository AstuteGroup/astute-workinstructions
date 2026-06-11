const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: 993,
    secure: true,
    auth: {
      user: 'vq@orangetsunami.com',
      pass: process.env.WORKMAIL_PASS
    },
    logger: false
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  const msg = await client.fetchOne('8702', { source: true, uid: true });
  const parsed = await simpleParser(msg.source);

  for (const att of parsed.attachments) {
    if (att.filename === 'instructions-for-jake.md') {
      const outPath = path.join(__dirname, '../../sales-pulse-instructions.md');
      fs.writeFileSync(outPath, att.content);
      console.log('Saved attachment to', outPath);
    }
  }

  await client.logout();
})();
