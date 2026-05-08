'use strict';
/**
 * v2: list folders, then search by subject within each folder.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const EMAIL = 'excess@orangetsunami.com';

const TARGET_SUBJECTS = [
  // unique subject strings (some are shared)
  'FW: Upload MO_Search Key 1008289',
  'FW: Upload MO_1002733',
  'FW: Upload MO_Search Key 1005525',
  'FW: Excess',
  'FW: Excess - Syrma',
  'FW: Excess inventory - Schneider Electric Pvt. Ltd.',
  'FW: Liquidation List',
  'FW: 5AGXMB5G4F40C5G',
  'FW: Matrix comsec - Search key#1009991',
  'FW: Altera Excess Inventory',
];

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: EMAIL, pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });

  await client.connect();

  console.log('Available folders:');
  const mailboxes = await client.list();
  for (const mb of mailboxes) {
    console.log(`  ${mb.path}  (flags: ${[...(mb.flags || [])].join(',')})`);
  }
  console.log('');

  // Search each folder for matching subjects
  const folders = ['INBOX', 'Processed', 'NeedsReview', 'NeedsPartner'];
  const found = [];
  for (const folder of folders) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch (e) {
      console.log(`(skip ${folder}: ${e.message})`);
      continue;
    }
    try {
      // Filter by date range to avoid pre-period false positives
      const since = new Date('2026-05-03T00:00:00Z');
      const before = new Date('2026-05-07T23:59:59Z');
      console.log(`Folder ${folder}: searching ${TARGET_SUBJECTS.length} subjects (date-filtered ${since.toISOString().slice(0,10)} → ${before.toISOString().slice(0,10)})...`);
      for (const subj of TARGET_SUBJECTS) {
        const uids = await client.search({ subject: subj, since, before }, { uid: true });
        if (uids && uids.length) {
          console.log(`  "${subj}" → ${uids.length} match(es): UIDs ${uids.join(',')}`);
          for (const uid of uids) {
            const msg = await client.fetchOne(String(uid), { uid: true, source: true, envelope: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const text = (parsed.text || '');
            const fromLines = [];
            const fromRe = /^[ \t>]*From:[ \t]*(.+)$/gim;
            let m;
            while ((m = fromRe.exec(text)) !== null) {
              const ln = m[1].trim();
              const emailMatch = ln.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
              fromLines.push({ raw: ln.slice(0, 120), email: emailMatch ? emailMatch[0] : null });
            }
            const attachments = (parsed.attachments || []).map(a => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
            }));
            found.push({
              uid, folder,
              subject: parsed.subject,
              date: parsed.date,
              outerFrom: parsed.from && parsed.from.text,
              attachments,
              fromLines: fromLines.slice(0, 6),
              textLen: text.length,
              htmlLen: (parsed.html || '').length,
              textHead: text.slice(0, 350).replace(/\s+/g, ' '),
              messageId: parsed.messageId,
            });
          }
        }
      }
    } finally {
      lock.release();
    }
  }

  console.log(`\n\n══════ DETAILS (${found.length} messages) ══════\n`);
  for (const f of found.sort((a, b) => (a.date || 0) - (b.date || 0))) {
    console.log('═'.repeat(100));
    console.log(`Subject: ${f.subject}`);
    console.log(`  Folder/UID  : ${f.folder} / UID ${f.uid}`);
    console.log(`  Date        : ${f.date}`);
    console.log(`  outerFrom   : ${f.outerFrom}`);
    console.log(`  Attachments : ${f.attachments.length === 0 ? 'NONE' : f.attachments.map(a => `${a.filename} (${a.contentType}, ${a.size}b)`).join(' | ')}`);
    console.log(`  text/html   : ${f.textLen}b / ${f.htmlLen}b`);
    console.log(`  From: lines :`);
    f.fromLines.forEach((fl, i) => {
      const flag = fl.email && fl.email.toLowerCase().endsWith('@astutegroup.com') ? ' [INTERNAL]' : '';
      console.log(`     [${i}] ${fl.raw}${flag}`);
    });
    console.log(`  body head   : ${f.textHead}`);
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
