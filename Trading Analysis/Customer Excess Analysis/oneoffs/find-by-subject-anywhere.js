'use strict';
/**
 * Search ALL folders for the 10 target subjects, no date filter, return UID + folder + envelope date.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
const { ImapFlow } = require('imapflow');

const EMAIL = 'excess@orangetsunami.com';

const SUBJECTS = [
  'Upload MO_Search Key 1008289',
  'Upload MO_1002733',
  'Upload MO_Search Key 1005525',
  'Excess - Syrma',
  'Excess inventory - Schneider Electric',
  'Liquidation List',
  '5AGXMB5G4F40C5G',
  'Matrix comsec',
  'Altera Excess',
  'FW: Excess',
];

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: EMAIL, pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });

  await client.connect();

  const mailboxes = await client.list();
  const candidates = mailboxes.map(mb => mb.path).filter(p =>
    !p.startsWith('Sent') && !p.startsWith('Drafts') && !p.startsWith('Outbox') && !p.startsWith('Inventory'));

  for (const folder of candidates) {
    let lock;
    try { lock = await client.getMailboxLock(folder); }
    catch (e) { console.log(`(skip ${folder})`); continue; }
    try {
      const status = await client.status(folder, { messages: true });
      if (!status.messages) { console.log(`${folder}: empty`); continue; }
      console.log(`\n=== ${folder} (${status.messages} msgs) ===`);
      for (const subj of SUBJECTS) {
        try {
          const uids = await client.search({ subject: subj }, { uid: true });
          if (uids && uids.length) {
            for (const uid of uids) {
              const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true }, { uid: true });
              if (!msg) continue;
              const dt = msg.internalDate || (msg.envelope && msg.envelope.date);
              const subjActual = msg.envelope && msg.envelope.subject;
              console.log(`  "${subj}" → UID ${msg.uid}  ${dt && new Date(dt).toISOString()}  Subject: ${subjActual}`);
            }
          }
        } catch (e) {}
      }
    } finally {
      lock.release();
    }
  }

  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
