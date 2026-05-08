#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const PASS = process.env.WORKMAIL_PASS;

async function listFolder(inbox, folder) {
  const c = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: inbox, pass: PASS }, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(folder).catch(() => null);
    if (!lock) { console.log(`  ${folder}: (folder doesn't exist)`); return; }
    try {
      const uids = await c.search({ all: true }, { uid: true });
      console.log(`\n  ${folder}: ${uids.length} message(s)`);
      if (uids.length === 0) return;
      const lastN = uids.slice(-15);
      for await (const m of c.fetch(lastN, { envelope: true }, { uid: true })) {
        const env = m.envelope || {};
        const from = env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '';
        const date = env.date ? env.date.toISOString().slice(0, 10) : '';
        console.log(`    [${date}] ${(env.subject || '').slice(0, 60)} ← ${from.slice(0, 40)}`);
      }
      if (uids.length > 15) console.log(`    ... (showing last 15 of ${uids.length})`);
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
}

(async () => {
  console.log('═══ excess@orangetsunami.com ═══');
  for (const f of ['NeedsReview', 'NeedsPartner', 'NotOffer']) await listFolder('excess@orangetsunami.com', f);
  console.log('\n═══ stockRFQ@orangetsunami.com ═══');
  for (const f of ['NeedsReview', 'NotRFQ']) await listFolder('stockRFQ@orangetsunami.com', f);
})();
