#!/usr/bin/env node
//
// Move Betty Song's "转发: upload VQ May 13th" email (UID 8512 in NeedsReview,
// originally UID 8508 in INBOX before the 2026-05-20 01:39 UTC bounce) back to
// INBOX so the vq-loading-agent cron picks it up on the next 5-min tick.
//
// Pre-conditions:
//   - shared/email-workflow-poller.js `read` command now exposes body_html
//   - agent-prompt.txt §3.7.0 instructs the agent to consult body_html when
//     the operator's body text references visual formatting
//   - All 293 VQs from the prior misload (UID 8516) have been deactivated;
//     snapshot at ~/workspace/rollback-uid8516-snapshot.csv
//
// Action:
//   - Clear the \Seen flag (otherwise the poller's UNSEEN list won't pick it up)
//   - IMAP MOVE NeedsReview UID 8512 → INBOX
//
// After running, monitor:
//   - tail ~/.workspace/.cron-sentinels/vq-loading-agent.json (or wherever the
//     agent writes activity)
//   - check breadcrumbs at ~/workspace/.offer-pipeline/breadcrumbs.jsonl for
//     a new `loaded` or `escalated-*` event from vq-loading-agent
//   - compare any new writes against rollback-uid8516-snapshot.csv

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');

const SOURCE_FOLDER = 'NeedsReview';
const TARGET_FOLDER = 'INBOX';
const SOURCE_UID = 8512;

function getPassword() {
  return process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
}

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: getPassword() },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(SOURCE_FOLDER);
    try {
      // Verify the message is what we expect before moving.
      const msg = await client.fetchOne(String(SOURCE_UID), { envelope: true, flags: true }, { uid: true });
      if (!msg) {
        console.error(`UID ${SOURCE_UID} not found in ${SOURCE_FOLDER}. Aborting.`);
        process.exit(1);
      }
      console.log(`Found UID ${SOURCE_UID} in ${SOURCE_FOLDER}:`);
      console.log(`  Subject: ${msg.envelope.subject}`);
      console.log(`  From:    ${msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address}`);
      console.log(`  Date:    ${msg.envelope.date}`);
      console.log(`  Flags:   ${Array.from(msg.flags || []).join(', ') || '(none)'}`);

      if (!/upload VQ May 13th/i.test(msg.envelope.subject || '')) {
        console.error(`Subject doesn't match expected 'upload VQ May 13th'. Aborting to be safe.`);
        process.exit(1);
      }

      // Clear \Seen so the poller's UNSEEN list picks it up.
      if (msg.flags && msg.flags.has && msg.flags.has('\\Seen')) {
        console.log('Clearing \\Seen flag...');
        await client.messageFlagsRemove(String(SOURCE_UID), ['\\Seen'], { uid: true });
      } else if (Array.isArray(msg.flags) && msg.flags.includes('\\Seen')) {
        console.log('Clearing \\Seen flag...');
        await client.messageFlagsRemove(String(SOURCE_UID), ['\\Seen'], { uid: true });
      } else {
        console.log('Message already unseen — no flag change needed.');
      }

      console.log(`Moving UID ${SOURCE_UID} from ${SOURCE_FOLDER} to ${TARGET_FOLDER}...`);
      const result = await client.messageMove(String(SOURCE_UID), TARGET_FOLDER, { uid: true });
      console.log(`Move result: ${JSON.stringify(result)}`);
    } finally {
      lock.release();
    }

    // Confirm landing in INBOX.
    const inboxLock = await client.getMailboxLock(TARGET_FOLDER);
    try {
      const exists = client.mailbox.exists;
      console.log(`\nINBOX now has ${exists} messages.`);
      const start = Math.max(1, exists - 4);
      console.log(`Recent ${TARGET_FOLDER} envelopes (UID order):`);
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true }, { uid: true })) {
        const flags = Array.from(m.flags || []).join(',') || '(none)';
        console.log(`  UID ${m.uid}: ${m.envelope.subject}  [${flags}]`);
      }
    } finally {
      inboxLock.release();
    }

    console.log('\nDone. Watch breadcrumbs.jsonl for the next vq-loading-agent tick.');
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
