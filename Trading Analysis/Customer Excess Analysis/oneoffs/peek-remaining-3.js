'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'excess@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('Processed');
  try {
    // Search FW: Excess close to 5/04 polling date AND inventory
    // We know: UID 869 (3/24), UID 870 (3/25), UID 879 (Excess - Syrma 4/06), UID 881 (Excess inv 4/07)
    // 1026070 was polled 5/04 16:38, FW: Excess subject. Need to find the message that triggered it.
    // Let's list ALL FW: Excess hits regardless of subject suffix:
    const candidates = [
      { uid: 918, label: '1026089 FW: Liquidation List' },
      { uid: 1143, label: '1026115 FW: Altera Excess Inventory (most recent in Processed)' },
      { uid: 869, label: '1026070? FW: Excess (UID 869)' },
      { uid: 870, label: '1026070? FW: Excess (UID 870)' },
    ];
    for (const c of candidates) {
      try {
        const msg = await client.fetchOne(String(c.uid), { uid: true, source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const text = parsed.text || '';
        const fromLines = [];
        const fromRe = /^[ \t>]*From:[ \t]*(.+)$/gim;
        let m;
        while ((m = fromRe.exec(text)) !== null) fromLines.push(m[1].slice(0, 130));
        const attachments = (parsed.attachments || []).map(a => `${a.filename} [${a.contentType}, ${a.size}b]`);
        console.log('═'.repeat(110));
        console.log(`UID ${c.uid}: ${c.label}`);
        console.log(`  Subject  : ${parsed.subject}`);
        console.log(`  Date     : ${parsed.date && parsed.date.toISOString()}`);
        console.log(`  Attachs  : ${attachments.length === 0 ? 'NONE' : attachments.join(' | ')}`);
        console.log(`  From:    :`);
        fromLines.slice(0, 6).forEach((l, i) => console.log(`     [${i}] ${l}`));
        console.log(`  Snippet  : ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
      } catch (e) {
        console.log(`UID ${c.uid}: ${e.message}`);
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
