#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createFetcher } = require('./shared/email-fetcher');

async function main() {
  const fetcher = createFetcher('lamkitting');
  const emails = await fetcher.listEnvelopes('INBOX', 10);

  // Sort by date descending (most recent first)
  emails.sort((a, b) => new Date(b.date) - new Date(a.date));

  console.log('Recent emails in lamkitting:\n');
  for (const email of emails.slice(0, 5)) {
    console.log(`UID ${email.id}: ${email.date}`);
    console.log(`   Subject: ${email.subject}`);
    console.log(`   From: ${email.from.name || email.from.addr}`);
    if (email.attachments?.length > 0) {
      console.log(`   Attachments: ${email.attachments.map(a => a.filename).join(', ')}`);
    }
    console.log('');
  }
}
main().catch(console.error);
