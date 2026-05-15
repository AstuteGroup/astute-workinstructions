#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(process.env.HOME, 'workspace/.env') });
const fs = require('fs');
const path = require('path');
const NM = require('path').resolve(process.env.HOME, 'workspace/astute-workinstructions/node_modules');
const { ImapFlow } = require(NM + '/imapflow');
const { simpleParser } = require(NM + '/mailparser');

const OUT_DIR = path.resolve(process.env.HOME, 'workspace/htc-korea-xref/attachments');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TARGET_SUBJECT = 'HTC Korea';

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'outlook.office365.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: 'excess@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('NotOffer');
  try {
    const uids = await client.search({ subject: TARGET_SUBJECT }, { uid: true });
    console.log(`Found ${uids.length} matching message(s) in NotOffer: ${uids.join(', ')}`);
    if (!uids.length) {
      console.error('No matching message; aborting.');
      process.exit(2);
    }
    const targetUid = Math.max(...uids);
    const msg = await client.fetchOne(String(targetUid), { source: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) {
      console.error('No source for message; aborting.');
      process.exit(3);
    }
    const parsed = await simpleParser(msg.source);
    console.log(`Subject: ${parsed.subject}`);
    console.log(`From: ${parsed.from && parsed.from.text}`);
    console.log(`Date: ${parsed.date}`);
    console.log(`Attachments: ${(parsed.attachments || []).length}`);
    for (const a of parsed.attachments || []) {
      if (!a.filename) continue;
      const safe = a.filename.replace(/[\/\\]/g, '_');
      const outPath = path.join(OUT_DIR, safe);
      fs.writeFileSync(outPath, a.content);
      console.log(`  saved: ${safe} (${a.content.length} bytes, ${a.contentType})`);
    }
    // Also dump the body for context
    fs.writeFileSync(path.join(OUT_DIR, '_body.html'), parsed.html || '');
    fs.writeFileSync(path.join(OUT_DIR, '_body.txt'), parsed.text || '');
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
})();
