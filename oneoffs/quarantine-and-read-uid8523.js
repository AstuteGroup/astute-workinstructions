#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const TARGET_UID = 8523;

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    // Read body first while still in INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(TARGET_UID), { source: true, envelope: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      const txt = parsed.text || '';
      const outTxt = path.join(process.env.HOME, 'workspace', `uid8523-body.txt`);
      fs.writeFileSync(outTxt, txt);
      console.log(`Subject: ${parsed.subject}`);
      console.log(`From envelope: ${parsed.from && parsed.from.text}`);
      console.log(`To envelope:   ${parsed.to && parsed.to.text}`);
      console.log(`Cc envelope:   ${parsed.cc && parsed.cc.text}`);
      console.log(`Date: ${parsed.date && parsed.date.toISOString()}`);
      console.log(`\nText length: ${txt.length}\n--- BODY ---`);
      console.log(txt);

      // Mark Seen + move to NeedsReview
      console.log('\nQuarantining...');
      try { await client.messageFlagsAdd(String(TARGET_UID), ['\\Seen'], { uid: true }); } catch (_) {}
      const moveResult = await client.messageMove(String(TARGET_UID), 'NeedsReview', { uid: true });
      console.log(`Move result: ${JSON.stringify(moveResult)}`);
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
