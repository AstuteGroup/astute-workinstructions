#!/usr/bin/env node
/**
 * Recover emails stuck in NeedsReview due to budget exhaustion.
 * Moves them back to INBOX so the next agent cycle reprocesses them.
 *
 * Usage:
 *   node scripts/recover-budget-stuck.js --workflow broker-offers [--dry-run]
 *   node scripts/recover-budget-stuck.js --workflow excess [--dry-run]
 */

'use strict';

const { ImapFlow } = require('imapflow');

const argv = process.argv.slice(2);
const workflowIdx = argv.indexOf('--workflow');
const WORKFLOW_NAME = workflowIdx >= 0 ? argv[workflowIdx + 1] : null;
const DRY_RUN = argv.includes('--dry-run');

if (!WORKFLOW_NAME) {
  console.error('Usage: recover-budget-stuck.js --workflow <name> [--dry-run]');
  process.exit(1);
}

const workflow = require(`../shared/workflow-actions/${WORKFLOW_NAME}`);
const INBOX = workflow.inbox;
const WORKMAIL_PASS = process.env.WORKMAIL_PASS || process.env.IMAP_PASS;

if (!WORKMAIL_PASS) {
  console.error('WORKMAIL_PASS or IMAP_PASS env var required');
  process.exit(1);
}

async function main() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: INBOX, pass: WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();

  try {
    // Open NeedsReview folder
    const lock = await client.getMailboxLock('NeedsReview');
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      console.log(`Found ${uids.length} email(s) in NeedsReview`);

      if (uids.length === 0) {
        console.log('Nothing to recover');
        return;
      }

      // Fetch subjects for confirmation
      const emails = [];
      for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
        emails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || '(no subject)',
          date: msg.envelope?.date,
        });
      }

      console.log('\nEmails to recover:');
      for (const e of emails) {
        console.log(`  UID ${e.uid}: ${e.subject}`);
      }

      if (DRY_RUN) {
        console.log(`\n[DRY RUN] Would move ${emails.length} email(s) to INBOX`);
        return;
      }

      // Move all to INBOX
      await client.messageMove(uids.map(String), 'INBOX', { uid: true });
      console.log(`\nMoved ${emails.length} email(s) to INBOX`);
      console.log('They will be reprocessed on the next agent cycle');

    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
