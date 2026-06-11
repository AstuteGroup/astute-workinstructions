#!/usr/bin/env node
/**
 * retry-escalated-email.js
 *
 * After updating workflow logic to fix an escalation, use this to move the
 * email back to INBOX for the agent to retry with the new logic.
 *
 * Usage:
 *   node retry-escalated-email.js --workflow rfq-loading --uid 161
 *   node retry-escalated-email.js --workflow vq-loading --uid 8541
 */

'use strict';

const path = require('path');
const HOME = process.env.HOME || '/home/analytics_user';
require('dotenv').config({ path: path.join(HOME, 'workspace', '.env') });

const { ImapFlow } = require('imapflow');

const args = process.argv.slice(2);
const workflowIdx = args.indexOf('--workflow');
const uidIdx = args.indexOf('--uid');

if (workflowIdx === -1 || uidIdx === -1) {
  console.error('Usage: node retry-escalated-email.js --workflow <name> --uid <number>');
  process.exit(1);
}

const WORKFLOW = args[workflowIdx + 1];
const UID = args[uidIdx + 1];

const INBOX_MAP = {
  'rfq-loading': 'rfqloading@orangetsunami.com',
  'vq-loading': 'vq@orangetsunami.com',
  'excess': 'excess@orangetsunami.com',
  'stock-rfq': 'stockrfq@orangetsunami.com',
};

const INBOX = INBOX_MAP[WORKFLOW];
if (!INBOX) {
  console.error(`Unknown workflow: ${WORKFLOW}`);
  console.error(`Valid workflows: ${Object.keys(INBOX_MAP).join(', ')}`);
  process.exit(1);
}

async function retryEmail() {
  console.log(`\nRetrying ${WORKFLOW} email UID ${UID}...`);
  console.log(`Inbox: ${INBOX}\n`);

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: {
      user: INBOX,
      pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
    },
    logger: false,
  });

  await client.connect();

  try {
    // Search for the UID in common folders
    const foldersToCheck = ['INBOX', 'NeedsReview', 'NeedInfo', 'NeedsInfo', 'Escalated', 'Processed'];
    let found = false;
    let currentFolder = null;

    for (const folder of foldersToCheck) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const msg = await client.fetchOne(UID, { envelope: true, flags: true }, { uid: true });
          if (msg) {
            found = true;
            currentFolder = folder;
            console.log(`✓ Found in folder: ${folder}`);
            console.log(`  Subject: ${msg.envelope.subject}`);
            console.log(`  From: ${msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : 'unknown'}`);
            console.log(`  Flags: ${msg.flags ? [...msg.flags].join(', ') : 'none'}`);
            break;
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        // Folder doesn't exist or not accessible, skip
      }
    }

    if (!found) {
      console.error(`\n✗ UID ${UID} not found in any folder`);
      console.error(`  Checked: ${foldersToCheck.join(', ')}`);
      process.exit(1);
    }

    if (currentFolder === 'INBOX') {
      console.log(`\n⚠ Email is already in INBOX`);
      console.log(`  It should be picked up in the next agent run.`);
      console.log(`  If the agent is still skipping it, check:`);
      console.log(`    1. Is it marked as UNSEEN?`);
      console.log(`    2. Are there filters in the agent prompt?`);
      return;
    }

    // Move to INBOX and mark as UNSEEN
    console.log(`\n→ Moving from ${currentFolder} to INBOX...`);
    const srcLock = await client.getMailboxLock(currentFolder);
    try {
      await client.messageFlagsRemove(UID, ['\\Seen'], { uid: true });
      await client.messageMove(UID, 'INBOX', { uid: true });
      console.log(`✓ Moved to INBOX and marked as UNSEEN`);
      console.log(`\nThe agent will process it in the next run (typically within 5 minutes).`);
    } finally {
      srcLock.release();
    }

  } finally {
    await client.logout().catch(() => {});
  }
}

retryEmail().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
