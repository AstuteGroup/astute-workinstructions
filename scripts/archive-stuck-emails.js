#!/usr/bin/env node
/**
 * archive-stuck-emails.js
 *
 * Moves old stuck emails (>24h) to an Archive folder so they stop appearing
 * in the stuck email warnings. These are emails that were SEEN but never
 * processed - usually noise (bounces, internal forwards, spam) that ended
 * up in the wrong inbox.
 *
 * Usage:
 *   node scripts/archive-stuck-emails.js --workflow vq-loading [--dry-run]
 *   node scripts/archive-stuck-emails.js --all [--dry-run]
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');

const WORKFLOWS = {
  'vq-loading': { inbox: 'vq@orangetsunami.com', sourceFolder: 'INBOX' },
  'excess': { inbox: 'excess@orangetsunami.com', sourceFolder: 'INBOX' },
  'stockrfq': { inbox: 'stockRFQ@orangetsunami.com', sourceFolder: 'INBOX' },
  'rfq-loading': { inbox: 'rfqloading@orangetsunami.com', sourceFolder: 'INBOX' },
};

const ARCHIVE_FOLDER = 'Archive-Stuck';
const MIN_AGE_HOURS = 24;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ALL = argv.includes('--all');
const workflowIdx = argv.indexOf('--workflow');
const workflowName = workflowIdx >= 0 ? argv[workflowIdx + 1] : null;

if (!ALL && !workflowName) {
  console.error('Usage: archive-stuck-emails.js --workflow <name> [--dry-run]');
  console.error('       archive-stuck-emails.js --all [--dry-run]');
  console.error('');
  console.error('Workflows: vq-loading, excess, stockrfq, rfq-loading');
  process.exit(1);
}

const WORKMAIL_PASS = process.env.WORKMAIL_PASS;
if (!WORKMAIL_PASS) {
  console.error('FATAL: WORKMAIL_PASS not set');
  process.exit(1);
}

async function archiveStuckEmails(name, config) {
  console.log(`\n=== ${name} (${config.inbox}) ===`);

  const client = new ImapFlow({
    host: 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: config.inbox, pass: WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();

  try {
    const lock = await client.getMailboxLock(config.sourceFolder);

    try {
      // Find SEEN emails older than 24 hours
      const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);
      const seenUids = (await client.search({ seen: true }, { uid: true })) || [];

      if (seenUids.length === 0) {
        console.log('  No SEEN emails in inbox');
        return { archived: 0 };
      }

      const oldUids = [];
      for await (const msg of client.fetch(seenUids, { envelope: true }, { uid: true })) {
        const env = msg.envelope || {};
        const msgDate = env.date ? new Date(env.date) : null;
        if (msgDate && msgDate < cutoff) {
          oldUids.push({
            uid: msg.uid,
            subject: (env.subject || '').slice(0, 50),
            date: msgDate.toISOString().slice(0, 10),
          });
        }
      }

      if (oldUids.length === 0) {
        console.log('  No stuck emails >24h old');
        return { archived: 0 };
      }

      console.log(`  Found ${oldUids.length} stuck emails to archive:`);
      for (const email of oldUids.slice(0, 10)) {
        console.log(`    UID ${email.uid}: ${email.subject} (${email.date})`);
      }
      if (oldUids.length > 10) {
        console.log(`    ... and ${oldUids.length - 10} more`);
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would move ${oldUids.length} emails to ${ARCHIVE_FOLDER}`);
        return { archived: 0, wouldArchive: oldUids.length };
      }

      // Create archive folder if needed
      try {
        await client.mailboxCreate(ARCHIVE_FOLDER);
        console.log(`  Created folder: ${ARCHIVE_FOLDER}`);
      } catch (e) {
        // Folder exists
      }

      // Move emails
      const uidList = oldUids.map(e => e.uid);
      await client.messageMove(uidList, ARCHIVE_FOLDER, { uid: true });
      console.log(`  ✓ Moved ${oldUids.length} emails to ${ARCHIVE_FOLDER}`);

      return { archived: oldUids.length };

    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function main() {
  const workflows = ALL
    ? Object.entries(WORKFLOWS)
    : [[workflowName, WORKFLOWS[workflowName]]];

  if (!ALL && !WORKFLOWS[workflowName]) {
    console.error(`Unknown workflow: ${workflowName}`);
    console.error('Valid workflows:', Object.keys(WORKFLOWS).join(', '));
    process.exit(1);
  }

  let totalArchived = 0;
  let totalWouldArchive = 0;

  for (const [name, config] of workflows) {
    try {
      const result = await archiveStuckEmails(name, config);
      totalArchived += result.archived || 0;
      totalWouldArchive += result.wouldArchive || 0;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  console.log('');
  if (DRY_RUN) {
    console.log(`[DRY-RUN] Would archive ${totalWouldArchive} total emails`);
    console.log('Run without --dry-run to execute');
  } else {
    console.log(`Done. Archived ${totalArchived} total emails.`);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
