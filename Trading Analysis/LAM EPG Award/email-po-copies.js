/**
 * Email the 4 PO copy PDFs to Jake.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createNotifier } = require('../../shared/notifier');

const POS = [
  { po: 'PO809585', vendor: 'SMARTEL',      file: 'PO809585_SMARTEL.pdf' },
  { po: 'PO809591', vendor: 'CHIP ENERGY',   file: 'PO809591_CHIP_ENERGY.pdf' },
  { po: 'PO809592', vendor: 'Dragon Core',   file: 'PO809592_Dragon_Core.pdf' },
  { po: 'PO809593', vendor: 'HK Firsttop',   file: 'PO809593_HK_Firsttop.pdf' },
];

const attachments = POS.map(p => ({
  filename: p.file,
  content: fs.readFileSync(path.join(__dirname, p.file)),
}));

const body = `Hi Jake,

Attached are the 4 PO copies retrieved from OT for the LAM EPG broker orders:

  PO809585 / POV0075525 — SMARTEL (8 lines)
  PO809591 / POV0075529 — CHIP ENERGY (2 lines)
  PO809592 / POV0075532 — Dragon Core (3 lines)
  PO809593 / POV0075533 — HK Firsttop (1 line)

These were pulled via the iDempiere REST API print endpoint.

— Claude via analytics terminal
`;

const notifier = createNotifier({
  fromEmail: 'vortex@orangetsunami.com',
  fromName: 'Analytics Terminal',
  smtpPass: process.env.WORKMAIL_PASS,
});

notifier.sendWithAttachment(
  'jake.harris@Astutegroup.com',
  'LAM EPG — PO Copies (PO809585, PO809591, PO809592, PO809593)',
  body,
  attachments,
).then(ok => console.log(ok ? '✓ Email sent' : '✗ Email failed'))
 .catch(e => { console.error(e); process.exit(1); });
