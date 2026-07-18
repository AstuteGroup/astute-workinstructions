#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/mouser-invoices';

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
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    // Fetch UID 7 - Mouser Invoices email
    const msg = await client.fetchOne(7, { source: true });
    const parsed = await simpleParser(msg.source);

    console.log('Subject:', parsed.subject);
    console.log('From:', parsed.from?.text);
    console.log('Date:', parsed.date);
    console.log('Attachments:', parsed.attachments?.length || 0);

    if (parsed.attachments) {
      for (const att of parsed.attachments) {
        const filename = att.filename || 'unknown';
        const outputPath = path.join(OUTPUT_DIR, filename);
        fs.writeFileSync(outputPath, att.content);
        console.log(`Saved: ${filename} (${att.size} bytes)`);
      }
    }

    console.log('\nAttachments saved to:', OUTPUT_DIR);
  } finally {
    lock.release();
    await client.logout();
  }
})();
