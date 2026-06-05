#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const fs = require('fs');

const INBOX = process.argv[2] || 'excess@orangetsunami.com';
const UID = process.argv[3];
const OUTPUT_DIR = process.argv[4] || '/tmp';

if (!UID) {
  console.error('Usage: extract-attachment.js <inbox> <uid> [output_dir]');
  process.exit(1);
}

(async () => {
  const client = new ImapFlow({
    host: 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: INBOX, pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const msg = await client.fetchOne(String(UID), { bodyStructure: true, source: true }, { uid: true });

    if (!msg.bodyStructure) {
      console.error('No body structure found');
      process.exit(1);
    }

    // Parse MIME to find attachments
    const source = msg.source.toString();
    const boundary = source.match(/boundary="([^"]+)"/)?.[1] || source.match(/boundary=([^\s;]+)/)?.[1];

    if (!boundary) {
      console.error('No MIME boundary found');
      process.exit(1);
    }

    const parts = source.split('--' + boundary);
    let attachmentCount = 0;

    for (const part of parts) {
      const filenameMatch = part.match(/filename="([^"]+)"/i) || part.match(/filename=([^\s;]+)/i);
      if (!filenameMatch) continue;

      const filename = filenameMatch[1].replace(/['"]/g, '');
      const contentTransferMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
      const encoding = contentTransferMatch ? contentTransferMatch[1].toLowerCase() : '7bit';

      // Find the content (after double newline)
      const contentStart = part.indexOf('\r\n\r\n');
      if (contentStart === -1) continue;

      let content = part.slice(contentStart + 4);
      // Remove trailing boundary marker
      const endIdx = content.lastIndexOf('\r\n--');
      if (endIdx > 0) content = content.slice(0, endIdx);

      let buffer;
      if (encoding === 'base64') {
        buffer = Buffer.from(content.replace(/\s/g, ''), 'base64');
      } else {
        buffer = Buffer.from(content);
      }

      const outPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outPath, buffer);
      console.log('Extracted:', outPath);
      attachmentCount++;
    }

    if (attachmentCount === 0) {
      console.error('No attachments found');
    }

  } finally {
    lock.release();
    await client.logout();
  }
})();
