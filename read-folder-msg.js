#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const ACCOUNT = process.argv[2] || 'excess@orangetsunami.com';
const FOLDER = process.argv[3] || 'NeedsPartner';
const SUBJ_FILTER = process.argv[4] || '';

(async () => {
  const c = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: ACCOUNT, pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(FOLDER);
    try {
      const uids = await c.search({ all: true }, { uid: true });
      for (const u of uids) {
        const msg = await c.fetchOne(String(u), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const subj = (msg.envelope && msg.envelope.subject) || '';
        if (SUBJ_FILTER && !subj.toLowerCase().includes(SUBJ_FILTER.toLowerCase())) continue;
        console.log(`\n=== UID ${u} | ${subj} ===`);
        const p = await simpleParser(msg.source);
        console.log(`From: ${p.from && p.from.text}`);
        console.log(`Date: ${p.date}`);
        console.log(`--- BODY (first 3000 chars) ---`);
        console.log((p.text || p.html || '').slice(0, 3000));
        console.log(`--- END ---`);
      }
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
