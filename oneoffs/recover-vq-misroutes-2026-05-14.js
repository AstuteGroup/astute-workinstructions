#!/usr/bin/env node
/**
 * One-off: move 4 messages misrouted by the vq-loading-agent's 11:45 UTC fire
 * back to INBOX as unseen so the next tick (with the fixed prompt) reprocesses
 * them under the corrected vendor-resolution + MPN-fuzzy rules.
 *
 * Root cause: agent prompt step 3.8 included `bp.iscustomer != 'Y'` in the
 * vendor query, excluding broker-distributors that we both buy from AND sell
 * to (IMP, Component Dynamics — both isvendor=Y AND iscustomer=Y). The fix
 * drops all role filters and matches on isactive only, with a Pass 2 inactive
 * sweep when no active BP matches the domain.
 *
 * Also: agent prompt step 3.6 RFQ-match was exact-only on chuboe_mpn. The fix
 * uses chuboe_mpn_clean with a Pass 2 prefix/suffix fuzzy match (mirrors
 * loadBulkSummary.matchMpnToLine). UID 8407 (BTS50162EKAXUMA1 → BTS50162EKA
 * on RFQ 1132427) is the calibration case.
 *
 * Sidecars (kept-pending state from needs_vendor / need_info_vendor /
 * clarify_vendor) are also cleared so re-extraction is truly fresh.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('/home/analytics_user/workspace/astute-workinstructions/node_modules/imapflow');
const { simpleParser } = require('/home/analytics_user/workspace/astute-workinstructions/node_modules/mailparser');
const pending = require('/home/analytics_user/workspace/astute-workinstructions/shared/workflow-pending-state');

const RECOVERIES = [
  { folder: 'NeedsReview',  uid: '8407', tag: 'IMP BTS50162EKAXUMA1 (orig 8366)' },
  { folder: 'NeedsVendor',  uid: '8401', tag: 'IMP LT1499CS#PBF (orig 8350)' },
  { folder: 'NeedsVendor',  uid: '8405', tag: 'Component Dynamics MT47H128 (orig 8359)' },
  { folder: 'NeedInfo',     uid: '8403', tag: 'GTC USA MAX5903 (orig 8353)' },
];

(async () => {
  const c = new ImapFlow({
    host: 'imap.mail.us-east-1.awsapps.com', port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await c.connect();

  for (const r of RECOVERIES) {
    console.log(`\n→ ${r.tag}  (${r.folder}/${r.uid})`);
    const lock = await c.getMailboxLock(r.folder);
    let msgId = null;
    try {
      // Capture Message-ID so we can clear any sidecar keyed on it.
      const msg = await c.fetchOne(r.uid, { source: true }, { uid: true });
      if (!msg || !msg.source) {
        console.log('  ! UID not found — skipping');
        continue;
      }
      const parsed = await simpleParser(msg.source);
      msgId = parsed.messageId || null;

      // Clear sidecar if present (no-op for NeedsReview UIDs — that action
      // wasn't keepsPending).
      if (msgId) {
        const cleared = pending.clearSidecar('vq-loading', msgId);
        console.log('  sidecar cleared:', cleared ? 'yes' : 'none');
      }

      // Move back to INBOX
      await c.messageMove(r.uid, 'INBOX', { uid: true });
      console.log('  moved to INBOX');
    } finally {
      lock.release();
    }

    // Now in INBOX — mark unseen so the poller picks it up. We need to find
    // the new UID in INBOX (UIDs reassign on move).
    const inboxLock = await c.getMailboxLock('INBOX');
    try {
      // The just-moved message will have the highest INBOX UID for this thread.
      // Find it by Message-ID via SEARCH.
      let newUid = null;
      if (msgId) {
        const uids = await c.search({ header: ['Message-ID', msgId] }, { uid: true });
        if (uids.length > 0) newUid = uids[uids.length - 1];
      }
      if (!newUid) {
        console.log('  ! couldn\'t locate new INBOX UID — manual flag-clear needed');
        continue;
      }
      await c.messageFlagsRemove(String(newUid), ['\\Seen'], { uid: true });
      console.log('  new INBOX UID:', newUid, '— marked unseen');
    } finally {
      inboxLock.release();
    }
  }

  await c.logout();
  console.log('\nDone. Next vq-loading-agent tick should pick these up.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
