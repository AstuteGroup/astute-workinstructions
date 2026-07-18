#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createFetcher } = require('./shared/email-fetcher');
const fs = require('fs');

async function main() {
  const fetcher = createFetcher('lamkitting');

  // Download attachments from UID 55
  const attachments = await fetcher.downloadAttachments(55, 'INBOX', '/tmp/new_invoice');

  console.log('Downloaded attachments:');
  for (const att of attachments) {
    console.log(`  ${att.filename}: ${att.path}`);
  }
}
main().catch(console.error);
