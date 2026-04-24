#!/usr/bin/env node
/**
 * Email a filled CRMA form back to the buyer via the stockRFQ@ notifier.
 *
 * Usage:
 *   node email-form.js \
 *     --to jake.harris@Astutegroup.com \
 *     --file /path/to/CRMA_<so>_<customer>_<mpn>_<qty>pc.xlsx \
 *     --subject 'CRMA Draft - SO506499 / COV0021316 - Masline B20NJ50RE-B (8 pc broken)' \
 *     --body /path/to/body.txt   # optional; if omitted, a generic body is used
 */
const fs = require('fs');
const path = require('path');
const { createNotifier } = require('../../shared/notifier');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const to = arg('--to', 'jake.harris@Astutegroup.com');
const file = arg('--file');
const subject = arg('--subject');
const bodyFile = arg('--body');

if (!file || !subject) {
  console.error('Usage: node email-form.js --to <email> --file <xlsx> --subject <subject> [--body <body.txt>]');
  process.exit(1);
}

const body = bodyFile
  ? fs.readFileSync(bodyFile, 'utf-8')
  : `Filled CRMA draft attached. Please review the dropdown picks and fill in the four Infor-only fields (Customer Code, Astute Invoice Number, Infor Item Number, Lot Number) before sending to CSE.\n\n— Claude`;

(async () => {
  const n = createNotifier({ fromEmail: 'stockRFQ@orangetsunami.com', fromName: 'Stock RFQ' });
  const ok = await n.sendWithAttachment(
    to, subject, body,
    [{ filename: path.basename(file), path: file }]
  );
  console.log(ok ? 'SENT ok' : 'SEND FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
