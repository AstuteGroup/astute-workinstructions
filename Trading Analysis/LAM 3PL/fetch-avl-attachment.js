#!/usr/bin/env node
/**
 * Fetch the AVL attachment from LAM kitting email
 */

const path = require('path');
const fs = require('fs');
const { createFetcher } = require('../../shared/email-fetcher');

const OUTPUT_DIR = '/home/analytics_user/workspace/file-drop';

async function main() {
  const fetcher = createFetcher('lamkitting');

  console.log('Checking lamkitting@orangetsunami.com inbox...');
  const envelopes = await fetcher.listEnvelopes('INBOX', 10);

  console.log(`Found ${envelopes.length} messages\n`);

  // Find the message with Excel attachment
  let targetEnv = null;
  for (const env of envelopes) {
    console.log(`UID: ${env.uid} | Subject: ${env.subject}`);
    if (env.subject && env.subject.includes('Working Copy')) {
      targetEnv = env;
    }
  }

  if (!targetEnv) {
    console.log('\nNo "Working Copy" message found');
    return;
  }

  console.log('\n=== Fetching target message ===');
  console.log('Subject:', targetEnv.subject);

  // Use raw IMAP to download attachments
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  // Get password from env
  const password = process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
  if (!password) {
    // Try himalaya config
    const configPath = path.join(process.env.HOME, '.config', 'himalaya', 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/backend\.auth\.raw\s*=\s*"([^"]+)"/);
      if (match) password = match[1];
    }
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993,
    secure: true,
    auth: {
      user: 'lamkitting@orangetsunami.com',
      pass: password
    },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    // Search for the message
    const uids = await client.search({ subject: 'Working Copy' });
    console.log('Found UIDs:', uids);

    if (uids.length === 0) {
      console.log('No matching messages');
      return;
    }

    const uid = uids[uids.length - 1]; // Most recent
    console.log('Downloading UID:', uid);

    // Download full message
    const { content } = await client.download(uid);
    const chunks = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }
    const rawEmail = Buffer.concat(chunks);

    // Parse with mailparser
    const parsed = await simpleParser(rawEmail);

    console.log('Subject:', parsed.subject);
    console.log('Attachments:', parsed.attachments?.length || 0);

    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const att of parsed.attachments) {
        const outPath = path.join(OUTPUT_DIR, att.filename);
        fs.writeFileSync(outPath, att.content);
        console.log('Saved:', outPath, `(${att.content.length} bytes)`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

// Load env
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
