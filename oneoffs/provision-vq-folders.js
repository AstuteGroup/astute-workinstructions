#!/usr/bin/env node
/**
 * One-off: pre-create the IMAP folders the vq-loading agent will route to.
 *
 * The poller auto-creates folders on first cmdRoute, but pre-provisioning
 * keeps the first tick clean and gives the operator visibility into the
 * folder set before any messages land.
 *
 * Existing folders (per oneoffs/check-vq-inbox.js, 2026-05-14):
 *   INBOX, Processed, NeedsReview, NeedsVendor, NoBid, Duplicates,
 *   Sent Items, Drafts, Junk E-mail, Deleted Items, Outbox
 *
 * Adding (new actions in shared/workflow-actions/vq-loading.js):
 *   NeedInfo          (need_info_vendor + clarify_vendor — keepsPending sidecars)
 *   OutboundPending   (outbound_pending — Astute-internal reply chains)
 *
 * Idempotent: mailboxCreate throws if folder exists; caught and ignored.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('/home/analytics_user/workspace/astute-workinstructions/node_modules/imapflow');

const FOLDERS_TO_ADD = ['NeedInfo', 'OutboundPending'];

(async () => {
  const c = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await c.connect();
  try {
    const before = (await c.list()).map(b => b.path);
    console.log('Existing folders:');
    for (const b of before.sort()) console.log('  ' + b);

    console.log('\nProvisioning:');
    for (const f of FOLDERS_TO_ADD) {
      if (before.includes(f)) {
        console.log(`  ${f} — already exists, skip`);
        continue;
      }
      try {
        await c.mailboxCreate(f);
        console.log(`  ${f} — created`);
      } catch (e) {
        console.log(`  ${f} — failed: ${e.message}`);
      }
    }

    const after = (await c.list()).map(b => b.path);
    console.log('\nAll folders now:');
    for (const b of after.sort()) console.log('  ' + b);
  } finally {
    await c.logout();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
