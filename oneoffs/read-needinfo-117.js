#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'rfqloading@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('NeedInfo');
  try {
    const msg = await client.fetchOne('117', { source: true }, { uid: true });
    const p = await simpleParser(msg.source);
    console.log('Subject :', p.subject);
    console.log('From    :', p.from?.text);
    console.log('To      :', p.to?.text);
    console.log('Cc      :', p.cc?.text);
    console.log('Date    :', p.date);
    console.log('Message-ID:', p.messageId);
    console.log('Atts    :', (p.attachments||[]).map(a=>`${a.filename} (${a.contentType}, ${a.size}B)`));
    console.log('\n--- BODY (first 2000 chars) ---');
    console.log((p.text || p.html || '').slice(0, 2000));
  } finally { lock.release(); }

  // Now also check Sent folder for the auto-reply
  console.log('\n\n=== Searching Sent for auto-reply ===');
  for (const folder of ['Sent', 'Sent Items', 'Sent Messages']) {
    try {
      const lock2 = await client.getMailboxLock(folder);
      try {
        const since = new Date(Date.now() - 24*60*60*1000);
        const uids = await client.search({ since }, { uid: true });
        console.log(`\n${folder}: ${uids?.length || 0} msgs in last 24h`);
        if (!uids?.length) continue;
        for await (const m of client.fetch(uids.slice(-10), { envelope: true }, { uid: true })) {
          const env = m.envelope || {};
          const subj = env.subject || '';
          const to = env.to?.[0] ? `${env.to[0].mailbox}@${env.to[0].host}` : '';
          if (/amat|master|details/i.test(subj)) {
            console.log(`  uid=${m.uid}  to=${to}  subj=${subj}`);
          }
        }
      } finally { lock2.release(); }
      break;
    } catch (e) { /* try next */ }
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
