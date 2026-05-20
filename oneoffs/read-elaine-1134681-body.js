#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['Processed', 'INBOX', 'NeedsReview']) {
      const lock = await client.getMailboxLock(folder);
      try {
        const exists = client.mailbox.exists;
        if (!exists) continue;
        const start = Math.max(1, exists - 200);
        for await (const m of client.fetch(`${start}:*`, { envelope: true }, { uid: true })) {
          const from = (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || '';
          const subj = m.envelope.subject || '';
          if (from.includes('elaine.liang') && /1134681|1134683/.test(subj)) {
            console.log(`[${folder}] UID ${m.uid}: ${m.envelope.date.toISOString()} | ${subj}`);
            const msg = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
            const parsed = await simpleParser(msg.source);
            const txt = parsed.text || '';
            const html = parsed.html || '';
            const outTxt = path.join(process.env.HOME, 'workspace', `elaine-1134681-body.txt`);
            const outHtml = path.join(process.env.HOME, 'workspace', `elaine-1134681-body.html`);
            fs.writeFileSync(outTxt, txt);
            fs.writeFileSync(outHtml, html);
            console.log(`  text=${txt.length} chars, html=${html.length} chars`);
            console.log(`  Body saved: ${outTxt} + ${outHtml}`);
            console.log(`\n--- BODY first 4000 chars ---`);
            console.log(txt.slice(0, 4000));
          }
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
