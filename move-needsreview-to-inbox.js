#!/usr/bin/env node
/**
 * One-off: move all messages in excess@/NeedsReview back to INBOX and
 * flag them \Unseen so the agent's next tick picks them up. Done after
 * the architecture migration on 2026-05-08 to give the new agent a chance
 * to re-process offers the static parser couldn't handle.
 *
 * Idempotent — running it again on an empty NeedsReview folder is a no-op.
 *
 * Usage:
 *   node move-needsreview-to-inbox.js                   # excess (default)
 *   node move-needsreview-to-inbox.js --account stockrfq
 *   node move-needsreview-to-inbox.js --account excess --dry-run
 */
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const accountIdx = argv.indexOf('--account');
const ACCOUNT_KEY = accountIdx >= 0 ? argv[accountIdx + 1] : 'excess';

const ACCOUNTS = {
  excess:   { user: 'excess@orangetsunami.com',   label: 'excess'   },
  stockrfq: { user: 'stockRFQ@orangetsunami.com', label: 'stockrfq' },
};
const acct = ACCOUNTS[ACCOUNT_KEY];
if (!acct) { console.error(`Unknown account '${ACCOUNT_KEY}'. Valid: ${Object.keys(ACCOUNTS).join(', ')}`); process.exit(2); }

const HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const PASS = process.env.WORKMAIL_PASS;
if (!PASS) { console.error('FATAL: WORKMAIL_PASS not set'); process.exit(1); }

(async () => {
  const c = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: acct.user, pass: PASS }, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock('NeedsReview');
    let uids;
    try {
      uids = await c.search({ all: true }, { uid: true });
      console.log(`[${acct.label}] NeedsReview has ${uids.length} message(s)`);
      if (uids.length === 0) { console.log('Nothing to move.'); return; }
      // Print envelope summary so the operator knows what's about to move
      for await (const m of c.fetch(uids, { envelope: true }, { uid: true })) {
        const env = m.envelope || {};
        const subj = (env.subject || '').slice(0, 70);
        const date = env.date ? env.date.toISOString().slice(0, 10) : '';
        console.log(`  [${date}] uid=${m.uid}  ${subj}`);
      }
      if (DRY_RUN) {
        console.log(`\n[DRY-RUN] Would move ${uids.length} message(s) NeedsReview → INBOX and mark them \\Unseen.`);
        return;
      }
      // Mark unseen FIRST (while still in NeedsReview), then move.
      // Order is robust: if the move fails, at least the messages stay in
      // NeedsReview but flagged unseen — visible state, not lost.
      await c.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      console.log(`Marked ${uids.length} as \\Unseen.`);
    } finally { lock.release(); }

    if (!DRY_RUN) {
      // The move requires the source mailbox open; need a fresh lock since we just released
      const lock2 = await c.getMailboxLock('NeedsReview');
      try {
        await c.messageMove(uids, 'INBOX', { uid: true });
        console.log(`Moved ${uids.length} message(s) NeedsReview → INBOX.`);
      } finally { lock2.release(); }
    }
  } finally {
    await c.logout().catch(() => {});
  }
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
