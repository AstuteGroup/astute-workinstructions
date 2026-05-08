#!/usr/bin/env node
/**
 * One-off: move all messages in excess@/NeedsPartner back to INBOX with
 * \Unseen so the agent retries them under the updated decision tree
 * (added company-name fallback in 2026-05-08 customer-excess-analysis.md).
 */
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const PASS = process.env.WORKMAIL_PASS;
if (!PASS) { console.error('FATAL: WORKMAIL_PASS not set'); process.exit(1); }

(async () => {
  const c = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: 'excess@orangetsunami.com', pass: PASS }, logger: false });
  await c.connect();
  try {
    let uids;
    {
      const lock = await c.getMailboxLock('NeedsPartner');
      try {
        uids = await c.search({ all: true }, { uid: true });
        console.log(`NeedsPartner has ${uids.length} message(s)`);
        if (uids.length === 0) return;
        for await (const m of c.fetch(uids, { envelope: true }, { uid: true })) {
          const env = m.envelope || {};
          console.log(`  uid=${m.uid}  ${(env.subject || '').slice(0, 70)}`);
        }
        await c.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      } finally { lock.release(); }
    }
    {
      const lock = await c.getMailboxLock('NeedsPartner');
      try {
        await c.messageMove(uids, 'INBOX', { uid: true });
        console.log(`Moved ${uids.length} message(s) NeedsPartner → INBOX, marked \\Unseen.`);
      } finally { lock.release(); }
    }
  } finally { await c.logout().catch(() => {}); }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
