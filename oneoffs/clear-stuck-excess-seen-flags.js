#!/usr/bin/env node
/**
 * One-off script to clear SEEN flags on emails stuck by the reply-parser bug.
 *
 * Bug: reply-parser intercepted new forwards (FW: subject from Astute sender),
 * marked them SEEN before excess-agent could process them.
 *
 * Fix: reply-parser.js now skips FW:/Fwd: subjects without escalation markers.
 *
 * This script clears the SEEN flag so the fixed excess-agent can reprocess.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');

const STUCK_UIDS = [1417, 1418, 1456, 1498, 1501, 1516, 1517];

async function main() {
  const client = new ImapFlow({
    host: 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: 'excess@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  console.log('Connected to excess@ inbox');

  const lock = await client.getMailboxLock('INBOX');
  try {
    for (const uid of STUCK_UIDS) {
      try {
        await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        console.log(`✓ Cleared SEEN on UID ${uid}`);
      } catch (e) {
        console.log(`✗ UID ${uid} - ${e.message}`);
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();
  console.log('\nDone. Emails will reprocess on next excess-agent tick (every 5 min).');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
