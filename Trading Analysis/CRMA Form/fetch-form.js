#!/usr/bin/env node
/**
 * Pull the most recent blank CRMA form from the stockRFQ inbox.
 *
 * Usage:
 *   node fetch-form.js [--subject "CRMA Form"] [--out <dir>]
 *
 * Defaults:
 *   subject pattern → /CRMA Form/i
 *   out dir         → /home/analytics_user/workspace/tmp/crma-<timestamp>/
 *
 * Output: prints the downloaded path so the next step (fill-form.js --src) can use it.
 */
const path = require('path');
const fs = require('fs');
const { createFetcher } = require('../../shared/email-fetcher');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const subjectPattern = new RegExp(arg('--subject', 'CRMA Form'), 'i');
const outDir = arg('--out', `/home/analytics_user/workspace/tmp/crma-${Date.now()}`);

(async () => {
  const f = createFetcher('stockrfq');
  const envs = await f.listEnvelopes('INBOX', 100);
  envs.sort((a, b) => new Date(b.date) - new Date(a.date));

  const target = envs.find(e => subjectPattern.test(e.subject || '') && e.hasAttachment);
  if (!target) {
    console.error(`No matching CRMA form found in stockRFQ inbox (subject ~ ${subjectPattern})`);
    process.exit(1);
  }

  console.log(`Found: ${target.date} | ${target.subject}`);
  fs.mkdirSync(outDir, { recursive: true });
  const atts = await f.downloadAttachments(target.id, 'INBOX', outDir);

  const form = atts.find(a => /CRMA.*\.xlsx$/i.test(a.filename));
  if (!form) {
    console.error('No CRMA xlsx attachment on the matched message');
    process.exit(1);
  }
  console.log(`\n${form.path}`);
})().catch(e => { console.error(e.message); process.exit(1); });
