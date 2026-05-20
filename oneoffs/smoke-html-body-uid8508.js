#!/usr/bin/env node
//
// Smoke test for step 3 of the VQ Loading HTML-body work.
//
// Reads Betty Song's bounced email from NeedsReview by Message-ID
// (UID changed when it moved folders), runs it through simpleParser, and
// confirms `parsed.html` is populated and contains red-cell styling.
//
// This validates that the new `body_html` field added to
// shared/email-workflow-poller.js will actually carry the formatting the
// agent needs to disambiguate Betty's "only red rows" instruction.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const TARGET_MID = '<DB9PR02MB7020A54B4FEA4BF2E73C501695012@DB9PR02MB7020.eurprd02.prod.outlook.com>';
const FOLDER = 'NeedsReview';

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
    const lock = await client.getMailboxLock(FOLDER);
    try {
      // UID 8512 in NeedsReview = Betty's "转发: upload VQ May 13th" (was UID 8508
      // in INBOX before the bounce moved it). UIDs reassign on folder move.
      const uid = 8512;
      console.log(`Reading UID ${uid} from ${FOLDER} (Betty's email post-bounce)...`);
      console.log(`Found at UID ${uid}. Fetching source...`);

      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      const parsed = await simpleParser(msg.source);

      const textLen = (parsed.text || '').length;
      const htmlLen = (parsed.html || '').length;
      console.log(`\nSubject: ${parsed.subject}`);
      console.log(`From: ${parsed.from && parsed.from.text}`);
      console.log(`text length:  ${textLen} chars`);
      console.log(`html length:  ${htmlLen} chars`);

      const html = parsed.html || '';
      // Look for red-cell markers
      const markers = {
        'background:red':       (html.match(/background[^;>"]*red/gi)            || []).length,
        'bgcolor=red':          (html.match(/bgcolor=["']?[^"'>]*red/gi)         || []).length,
        '#FF0000 / #F00':       (html.match(/#FF0000|#F00[^0-9a-f]/gi)           || []).length,
        'rgb(255,0,0)':         (html.match(/rgb\(\s*255\s*,\s*0\s*,\s*0\s*\)/gi)|| []).length,
        '<font color=':         (html.match(/<font[^>]+color/gi)                 || []).length,
        '<td':                  (html.match(/<td/gi)                             || []).length,
        '<tr':                  (html.match(/<tr/gi)                             || []).length,
      };
      console.log('\nFormatting markers in body_html:');
      for (const [k, v] of Object.entries(markers)) console.log(`  ${k.padEnd(22)} ${v}`);

      // Save body_html to disk so we can eyeball it
      const outHtml = path.join(process.env.HOME, 'workspace', 'uid8508-body.html');
      fs.writeFileSync(outHtml, html);
      console.log(`\nFull HTML saved: ${outHtml}`);
      console.log('Sample (first 1200 chars after first <table>):');
      const tableIdx = html.toLowerCase().indexOf('<table');
      const sliceStart = tableIdx >= 0 ? tableIdx : 0;
      console.log(html.slice(sliceStart, sliceStart + 1200));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
