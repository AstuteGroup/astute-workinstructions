#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const TARGET_MID = '<DB9PR02MB7020464D6418E39BE2D55EA895012@DB9PR02MB7020.eurprd02.prod.outlook.com>';

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const folders = await client.list();
    for (const f of folders) {
      try {
        const lock = await client.getMailboxLock(f.path);
        try {
          const uids = await client.search({ header: { 'message-id': TARGET_MID } }, { uid: true });
          if (uids && uids.length > 0) {
            console.log(`[${f.path}] match UID: ${uids.join(',')}`);
            for (const u of uids) {
              const msg = await client.fetchOne(String(u), { source: true, envelope: true }, { uid: true });
              const parsed = await simpleParser(msg.source);
              console.log(`  Subject: ${parsed.subject}`);
              console.log(`  From: ${parsed.from && parsed.from.text}`);
              console.log(`  text=${(parsed.text||'').length} html=${(parsed.html||'').length}`);
              const outTxt = path.join(process.env.HOME, 'workspace', 'elaine-body.txt');
              const outHtml = path.join(process.env.HOME, 'workspace', 'elaine-body.html');
              fs.writeFileSync(outTxt, parsed.text || '');
              fs.writeFileSync(outHtml, parsed.html || '');
              console.log(`  Saved: ${outTxt} + ${outHtml}`);
            }
          }
        } finally { lock.release(); }
      } catch (e) { /* skip */ }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
