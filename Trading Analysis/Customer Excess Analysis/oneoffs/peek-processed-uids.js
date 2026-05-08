'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const EMAIL = 'excess@orangetsunami.com';

// Mapping of (Processed-folder UID) → which offer SK it should be (by polling order)
// Sourced by cross-referencing breadcrumb dates with email dates in Processed folder.
const TARGETS = [
  // Bucket A — Upload MO confirmations
  { uid: 895, label: '1026077  Upload MO_Search Key 1008289 → Seagate (1008289)' },
  { uid: 896, label: '1026078  Upload MO_Search Key 1008289 → Seagate (1008289)' },
  { uid: 898, label: '1026079  Upload MO_Search Key 1008289 → Seagate (1008289)' },
  { uid: 900, label: '1026080  Upload MO_1002733 → KLA (1002733)' },
  { uid: 901, label: '1026081  Upload MO_1002733 → KLA (1002733)' },
  { uid: 902, label: '1026082  Upload MO_1002733 → KLA (1002733)' },
  { uid: 903, label: '1026083  Upload MO_1002733 → KLA (1002733)' },
  { uid: 905, label: '1026084  Upload MO_Search Key 1005525 → Avago (1005525)' },
  { uid: 906, label: '1026085  Upload MO_Search Key 1005525 → Avago (1005525)' },
  // Bucket B — real data
  { uid: 879, label: '1026074  Excess - Syrma' },
  { uid: 881, label: '1026075  Excess inventory - Schneider Electric Pvt. Ltd.' },
  { uid: 918, label: '1026089  Liquidation List' },
  { uid: 1115, label: '1026092  5AGXMB5G4F40C5G' },
  { uid: 1116, label: '1026093  5AGXMB5G4F40C5G' },
  { uid: 1141, label: '1026113  Matrix comsec - Search key#1009991 → Matrix Comesec (1009991)' },
  { uid: 1142, label: '1026114  Matrix comsec - Search key#1009991 → Matrix Comesec (1009991)' },
  // 1026070 (FW: Excess) and 1026115 (FW: Altera Excess Inventory) need to be located
  // by polling-date — multiple matches in Processed
];

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: EMAIL, pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('Processed');
  try {
    for (const t of TARGETS) {
      try {
        const msg = await client.fetchOne(String(t.uid), { uid: true, source: true, envelope: true, internalDate: true }, { uid: true });
        if (!msg || !msg.source) { console.log(`UID ${t.uid}: NOT FOUND`); continue; }
        const parsed = await simpleParser(msg.source);
        const text = (parsed.text || '');

        const fromLines = [];
        const fromRe = /^[ \t>]*From:[ \t]*(.+)$/gim;
        let m;
        while ((m = fromRe.exec(text)) !== null) {
          const ln = m[1].trim();
          const emailMatch = ln.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
          fromLines.push({ raw: ln.slice(0, 130), email: emailMatch ? emailMatch[0] : null });
        }

        const attachments = (parsed.attachments || []).map(a => ({
          filename: a.filename, contentType: a.contentType, size: a.size,
        }));

        console.log('═'.repeat(110));
        console.log(`UID ${t.uid}: ${t.label}`);
        console.log(`  Subject     : ${parsed.subject}`);
        console.log(`  Date        : ${parsed.date && parsed.date.toISOString()}`);
        console.log(`  outerFrom   : ${parsed.from && parsed.from.text}`);
        console.log(`  Attachments : ${attachments.length === 0 ? 'NONE' : attachments.map(a => `${a.filename} [${a.contentType}, ${a.size}b]`).join(' | ')}`);
        console.log(`  Text/HTML   : ${text.length}b text, ${(parsed.html || '').length}b html`);
        console.log(`  From: lines :`);
        fromLines.slice(0, 8).forEach((fl, i) => {
          const flag = fl.email && fl.email.toLowerCase().endsWith('@astutegroup.com') ? ' [INTERNAL]' : '';
          console.log(`     [${i}] ${fl.raw}${flag}`);
        });
        console.log(`  Body head   : ${text.slice(0, 350).replace(/\s+/g, ' ')}`);
      } catch (e) {
        console.log(`UID ${t.uid}: ERROR ${e.message}`);
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
