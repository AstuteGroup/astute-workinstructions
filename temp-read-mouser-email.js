#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createFetcher } = require('./shared/email-fetcher');
const fs = require('fs');
const path = require('path');

(async () => {
  const fetcher = await createFetcher('lamkitting');
  const messages = await fetcher.listEnvelopes('INBOX', 10);

  // Find the Mouser Invoices email
  const mouserEmail = messages.find(m => m.subject && m.subject.includes('Mouser'));
  if (!mouserEmail) {
    console.log('Mouser email not found');
    return;
  }

  console.log('Reading email:', mouserEmail.subject);
  console.log('UID:', mouserEmail.id);
  console.log('Seq:', mouserEmail.seq);

  // Read the message body
  const body = await fetcher.readMessage(mouserEmail.id, 'INBOX');
  console.log('\n=== EMAIL BODY ===');
  console.log(body?.slice(0, 500) || 'No body');

  // Download attachments
  console.log('\n=== DOWNLOADING ATTACHMENTS ===');
  const outDir = '/tmp/mouser_invoices';
  const attachments = await fetcher.downloadAttachments(mouserEmail.id, 'INBOX', outDir);

  if (attachments.length > 0) {
    for (const att of attachments) {
      console.log('- ' + att.filename + ' (' + att.contentType + ', ' + att.size + ' bytes)');
      console.log('  Saved to:', att.path);
    }
  } else {
    console.log('No attachments found');
  }
})();
