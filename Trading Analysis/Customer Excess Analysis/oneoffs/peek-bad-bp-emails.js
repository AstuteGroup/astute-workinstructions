'use strict';
/**
 * Peek at the 18 source emails behind the wrong-BP customer-excess offers.
 * Reports per-UID: subject, outerFrom, attachments, body From-lines, body
 * snippet, line counts.
 *
 * Searches across INBOX, /Loaded, /NeedsReview, /NeedsPartner — the poller
 * moves messages on success/failure, so we don't know which folder a given UID
 * landed in.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const ACCOUNT = 'excess';
const EMAIL = 'excess@orangetsunami.com';

const TARGETS = [
  // Bucket A (footer-noise — were 9 originally; we have UIDs from breadcrumbs)
  { uid: 854, offerSk: '1026077', wrongBp: 'Laurel Kee', subject: 'FW: Upload MO_Search Key 1008289' },
  { uid: 855, offerSk: '1026078', wrongBp: 'Laurel Kee', subject: 'FW: Upload MO_Search Key 1008289' },
  { uid: 860, offerSk: '1026079', wrongBp: 'Laurel Kee', subject: 'FW: Upload MO_Search Key 1008289' },
  { uid: 862, offerSk: '1026080', wrongBp: 'Laurel Kee', subject: 'FW: Upload MO_1002733' },
  { uid: 863, offerSk: '1026081', wrongBp: 'Laurel Kee', subject: 'FW: Upload MO_1002733' },
  { uid: 864, offerSk: '1026082', wrongBp: 'Lathis',     subject: 'FW: Upload MO_1002733' },
  { uid: 865, offerSk: '1026083', wrongBp: 'Lathis',     subject: 'FW: Upload MO_1002733' },
  { uid: 614, offerSk: '1026084', wrongBp: 'Laurel Kee',     subject: 'FW: Upload MO_Search Key 1005525' },
  { uid: 615, offerSk: '1026085', wrongBp: 'Gopalakrishnan', subject: 'FW: Upload MO_Search Key 1005525' },
  // Bucket B (real data, wrong BP)
  { uid: 830, offerSk: '1026070', wrongBp: 'Aaron Mendoza',  subject: 'FW: Excess' },
  { uid: 839, offerSk: '1026074', wrongBp: 'Nandhini',       subject: 'FW: Excess - Syrma' },
  { uid: 840, offerSk: '1026075', wrongBp: 'Nandhini',       subject: 'FW: Excess inventory - Schneider Electric Pvt. Ltd.' },
  { uid: 916, offerSk: '1026089', wrongBp: 'Edgar Santana',  subject: 'FW: Liquidation List' },
  { uid: 1113, offerSk: '1026092', wrongBp: 'Aaron Mendoza', subject: 'FW: 5AGXMB5G4F40C5G' },
  { uid: 1114, offerSk: '1026093', wrongBp: 'Aaron Mendoza', subject: 'FW: 5AGXMB5G4F40C5G' },
  { uid: 616,  offerSk: '1026113', wrongBp: 'Nandhini',       subject: 'FW: Matrix comsec - Search key#1009991' },
  { uid: 617,  offerSk: '1026114', wrongBp: 'Gopalakrishnan', subject: 'FW: Matrix comsec - Search key#1009991' },
  { uid: 868,  offerSk: '1026115', wrongBp: 'Aaron Mendoza',  subject: 'FW: Altera Excess Inventory' },
];

const FOLDERS = ['INBOX', 'Loaded', 'NeedsReview', 'NeedsPartner'];

function getPassword() {
  if (process.env.WORKMAIL_PASS) return process.env.WORKMAIL_PASS;
  if (process.env.SMTP_PASS) return process.env.SMTP_PASS;
  throw new Error('WORKMAIL_PASS not set');
}

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: EMAIL, pass: getPassword() },
    logger: false,
  });

  await client.connect();

  // Build UID → folder map by walking each candidate folder
  const targetsByUid = new Map(TARGETS.map(t => [t.uid, t]));
  const found = [];

  for (const folder of FOLDERS) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch (e) {
      console.log(`(skipping folder ${folder}: ${e.message})`);
      continue;
    }
    try {
      for (const uid of targetsByUid.keys()) {
        if (found.some(f => f.uid === uid)) continue; // already located in earlier folder
        try {
          const msg = await client.fetchOne(String(uid), {
            uid: true,
            source: true,
            envelope: true,
          }, { uid: true });
          if (!msg || !msg.source) continue;

          const parsed = await simpleParser(msg.source);
          const target = targetsByUid.get(uid);

          // Extract all From: lines from body
          const text = (parsed.text || '') + '\n' + (parsed.html || '').replace(/<[^>]+>/g, ' ');
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
            uid,
            folder,
            offerSk: target.offerSk,
            wrongBp: target.wrongBp,
            subject: parsed.subject,
            outerFrom: parsed.from && parsed.from.text,
            attachments,
            fromLines: fromLines.slice(0, 6),
            textLen: (parsed.text || '').length,
            htmlLen: (parsed.html || '').length,
            bodySnippet: (parsed.text || '').slice(0, 400).replace(/\s+/g, ' '),
          });
        } catch (e) {
          // UID not in this folder — silent
        }
      }
    } finally {
      lock.release();
    }
  }

  console.log(`\nFound ${found.length} of ${TARGETS.length} target UIDs across folders ${FOLDERS.join(', ')}.\n`);

  for (const f of found.sort((a, b) => a.offerSk.localeCompare(b.offerSk))) {
    console.log('═'.repeat(100));
    console.log(`Offer SK ${f.offerSk}  UID ${f.uid}  Folder: ${f.folder}`);
    console.log(`  Wrong BP    : ${f.wrongBp}`);
    console.log(`  Subject     : ${f.subject}`);
    console.log(`  outerFrom   : ${f.outerFrom}`);
    console.log(`  Attachments : ${f.attachments.length === 0 ? 'NONE' : f.attachments.map(a => `${a.filename} (${a.contentType}, ${a.size}b)`).join(' | ')}`);
    console.log(`  text/html   : ${f.textLen}b / ${f.htmlLen}b`);
    console.log(`  From: lines :`);
    f.fromLines.forEach((fl, i) => {
      const flag = fl.email && fl.email.toLowerCase().endsWith('@astutegroup.com') ? ' [INTERNAL]' : '';
      console.log(`     [${i}] ${fl.raw}${flag}`);
    });
    console.log(`  body snippet: ${f.bodySnippet}`);
  }

  const missing = TARGETS.filter(t => !found.some(f => f.uid === t.uid));
  if (missing.length) {
    console.log(`\nMISSING UIDs (not found in any folder):`);
    missing.forEach(m => console.log(`  UID ${m.uid}  offerSk ${m.offerSk}  subject: ${m.subject}`));
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
