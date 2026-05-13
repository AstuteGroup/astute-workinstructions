#!/usr/bin/env node
/**
 * One-off: load the 67-line McMaster AMAT RFQ from NeedInfo/UID 117,
 * using the answers from the operator's reply (UID 120 in NeedsReview):
 *   qty=1, type=3PL/VMI, seller=Josh Syre, contact=Yongmei Cao.
 *
 * Direct enqueue (bypasses workflow action handler so we can set
 * salesrepId=Josh rather than the handler's hardcoded default). Then
 * moves UID 117 → Processed and UID 120 → Processed for IMAP hygiene.
 */

'use strict';

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const fs = require('fs');
const path = require('path');
const queue = require('../shared/rfq-load-queue');
const { ImapFlow } = require('imapflow');

const BPARTNER_ID = 1000724;        // Applied Materials
const RFQ_TYPE    = '3PL/VMI';
const SALESREP_ID = 1005243;        // Josh Syre
const CONTACT_ID  = 1042557;        // Yongmei Cao
const DESCRIPTION = 'AMAT RFQ - 67 McMaster items (consolidated request list, fwd Josh Syre) - 2026.05.13';
const BODY_FILE   = '/tmp/amat-117-body.txt';

function parseLines(text) {
  const raw = text.split('\n').map(l => l.trim());
  const items = [];
  // Find the start: the first "MCMASTER CARR SUPPLY" anchor implies the line above is MPN,
  // 2 lines above is description, 3 above is CPC. Iterate vendor anchors.
  for (let i = 3; i < raw.length; i++) {
    if (raw[i] !== 'MCMASTER CARR SUPPLY') continue;
    const cpc  = raw[i - 3];
    const desc = raw[i - 2];
    let mpn    = raw[i - 1];
    if (!cpc || !desc || !mpn) continue;
    // Strip Josh's `_duplicate` annotation if present on the MPN
    mpn = mpn.replace(/_duplicate$/i, '');
    items.push({
      cpc,
      description: desc,
      mpn,
      mfrText: '',        // McMaster is vendor, not MFR — leave blank
      qty: 1,
      targetPrice: 0,
    });
  }
  return items;
}

async function moveIMAP(folder, uid, target) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'rfqloading@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(folder);
  try {
    try { await client.mailboxCreate(target); } catch { /* exists */ }
    await client.messageMove(String(uid), target, { uid: true });
    console.log(`  moved ${folder}/uid=${uid} → ${target}`);
  } finally { lock.release(); }
  await client.logout();
}

(async () => {
  const text = fs.readFileSync(BODY_FILE, 'utf-8');
  const lines = parseLines(text);
  console.log(`Parsed ${lines.length} items`);
  if (lines.length !== 67) {
    console.warn(`WARN: expected 67, got ${lines.length}`);
  }
  console.log('First 3:', JSON.stringify(lines.slice(0, 3), null, 2));
  console.log('Last 3 :', JSON.stringify(lines.slice(-3), null, 2));

  const jobId = queue.enqueue({
    bpartnerId: BPARTNER_ID,
    type:       RFQ_TYPE,
    description: DESCRIPTION,
    salesrepId: SALESREP_ID,
    userId:     CONTACT_ID,
    lines,
  });
  console.log(`\nEnqueued: ${jobId}`);
  console.log('Daemon will pick up within ~10s (idle poll interval).');

  console.log('\nMoving IMAP messages → Processed...');
  await moveIMAP('NeedInfo', 117, 'Processed');
  await moveIMAP('NeedsReview', 120, 'Processed');
  console.log('\nDONE.');
})().catch(e => { console.error(e); process.exit(1); });
