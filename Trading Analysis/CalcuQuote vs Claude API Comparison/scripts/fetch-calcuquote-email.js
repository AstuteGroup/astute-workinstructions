#!/usr/bin/env node
// Fetch a CalcuQuote BOM email + attachment from the VQ inbox.
//
// Usage:
//   node fetch-calcuquote-email.js \
//     --subject-pattern "1132586|Johnson Controls"   # regex matched against subject
//     [--out-dir <dir>]                              # default: ~/workspace/scratch/cq-rfq-<token>/
//     [--days-back 7]                                # how far back to search the inbox
//
// Saves the BOM xlsx + email body to the output dir. Run this before compare-cq-vs-api.js.

const fs = require('fs');
const path = require('path');
const { createFetcher } = require('/home/analytics_user/workspace/astute-workinstructions/shared/email-fetcher');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}
const SUBJECT_PATTERN = arg('subject-pattern');
if (!SUBJECT_PATTERN) {
  console.error('--subject-pattern <regex> is required');
  process.exit(1);
}
const DAYS_BACK = parseInt(arg('days-back', '7'), 10);
const OUT_DIR_OVERRIDE = arg('out-dir');

(async () => {
  const f = createFetcher('vq');
  const envs = await f.listEnvelopes('INBOX', 200);
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  const re = new RegExp(SUBJECT_PATTERN, 'i');
  const matches = envs
    .filter(e => new Date(e.date) > cutoff)
    .filter(e => re.test(e.subject))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (matches.length === 0) {
    console.error(`No matching email in last ${DAYS_BACK} days. Subject pattern: ${SUBJECT_PATTERN}`);
    process.exit(1);
  }

  const target = matches[0];
  console.log(`Matched email id=${target.id} date=${target.date}`);
  console.log(`  subject: ${target.subject}`);
  console.log(`  from:    ${JSON.stringify(target.from)}`);
  if (matches.length > 1) console.log(`  (${matches.length - 1} other matches in window — using most recent)`);

  // Derive output dir from the subject if not provided — pull first 7-digit RFQ token
  let outDir = OUT_DIR_OVERRIDE;
  if (!outDir) {
    const rfqToken = (target.subject.match(/\d{7}/) || ['unknown'])[0];
    outDir = `/home/analytics_user/workspace/scratch/cq-rfq-${rfqToken}`;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const msg = await f.readMessage(target.id);
  fs.writeFileSync(path.join(outDir, 'email.txt'), msg.text || '');
  if (msg.html) fs.writeFileSync(path.join(outDir, 'email.html'), msg.html);

  const saved = await f.downloadAttachments(target.id, 'INBOX', outDir);
  console.log(`Saved ${saved.length} attachment(s) to ${outDir}`);
  const bom = saved.find(s => /Costed.*BOM.*\.xlsx$/i.test(String(s)));
  if (bom) console.log(`  BOM file: ${bom}`);
  else console.warn('  WARNING: no Costed BOM xlsx detected in attachments.');
})().catch(e => { console.error(e); process.exit(1); });
