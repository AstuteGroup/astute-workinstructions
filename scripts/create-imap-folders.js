#!/usr/bin/env node
/**
 * Create IMAP folders for a workflow inbox.
 * Usage: node scripts/create-imap-folders.js <account> <folder1> [folder2] ...
 */
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

const ACCOUNT_MAP = {
  vq: 'vq@orangetsunami.com',
  excess: 'excess@orangetsunami.com',
  stockrfq: 'stockRFQ@orangetsunami.com',
  vortex: 'vortex@orangetsunami.com',
  rfqloading: 'rfqloading@orangetsunami.com',
  brokeroffers: 'brokeroffers@orangetsunami.com',
  tracking: 'tracking@orangetsunami.com',
};

async function main() {
  const [,, account, ...folders] = process.argv;
  if (!account || folders.length === 0) {
    console.error('Usage: node scripts/create-imap-folders.js <account> <folder1> [folder2] ...');
    console.error('Accounts:', Object.keys(ACCOUNT_MAP).join(', '));
    process.exit(1);
  }

  const email = ACCOUNT_MAP[account.toLowerCase()];
  if (!email) {
    console.error(`Unknown account: ${account}. Valid: ${Object.keys(ACCOUNT_MAP).join(', ')}`);
    process.exit(1);
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: process.env.WORKMAIL_PASS },
    logger: false,
  });

  await client.connect();
  console.log(`Connected to ${email}`);

  for (const f of folders) {
    try {
      await client.mailboxCreate(f);
      console.log(`  Created: ${f}`);
    } catch (e) {
      if (e.message.includes('ALREADYEXISTS') || e.message.toLowerCase().includes('already exists')) {
        console.log(`  Already exists: ${f}`);
      } else {
        console.error(`  Error creating ${f}: ${e.message}`);
      }
    }
  }

  const list = await client.list();
  console.log('\nFolders in mailbox:');
  list.forEach(m => console.log(`  - ${m.path}`));

  await client.logout();
}

main().catch(e => { console.error(e); process.exit(1); });
