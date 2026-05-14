#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
  port: 993, secure: true,
  auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
  logger: false,
});

(async () => {
  await client.connect();
  // List folders so I know where to look
  const mbs = await client.list();
  console.log('FOLDERS:');
  for (const m of mbs) console.log('  ' + m.path);

  // Search across INBOX + a few sensible folders for subject containing 1132932
  const candidates = ['INBOX', 'Processed', 'NeedsReview', 'NeedInfo'].filter(p =>
    mbs.some(m => m.path === p));

  for (const folder of candidates) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ subject: '1132932' }, { uid: true });
        if (!uids || uids.length === 0) continue;
        console.log(`\n=== ${folder} (${uids.length} hits) ===`);
        for (const uid of uids.slice(0, 5)) {
          for await (const msg of client.fetch(uid, { envelope: true, source: true, bodyStructure: true }, { uid: true })) {
            const e = msg.envelope || {};
            console.log(`uid=${uid}  date=${e.date && e.date.toISOString()}  from=${e.from && e.from[0] && (e.from[0].mailbox + '@' + e.from[0].host)}  subj=${e.subject}`);
            // Decode body
            const parsed = await simpleParser(msg.source);
            console.log(`  text-length: ${(parsed.text || '').length}  html-length: ${(parsed.html || '').length}`);
            console.log(`  attachments: ${(parsed.attachments || []).length}`);
            for (const a of parsed.attachments || []) {
              console.log(`    - ${a.filename}  (${a.contentType}, ${a.size} bytes)`);
            }
            // First 1000 chars of plain text
            if (parsed.text) {
              console.log('  --- text preview ---');
              console.log(parsed.text.slice(0, 1500).split('\n').map(l => '  | ' + l).join('\n'));
            }
          }
        }
      } finally { lock.release(); }
    } catch (e) {
      console.log(`  ${folder}: ERROR ${e.message}`);
    }
  }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
