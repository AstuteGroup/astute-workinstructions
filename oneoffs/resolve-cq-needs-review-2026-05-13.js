#!/usr/bin/env node
/**
 * One-off resolver for the 3 stuck CQ-NeedsReview messages from 2026-05-13:
 *   - UID 2585: STM32G030K6T6TR (Shenzhen Zhi Yu) → add_cq_with_rfq
 *   - UID 2587: W631GG6NB-12   (Liyijing)         → add_cq_with_rfq
 *   - UID 2589: BUK9Y29-40E,115 (Kexinyuan)       → add_cq against existing RFQ 1134293
 *
 * After write, moves the source message from CQ-NeedsReview → CQ-Processed.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { writeRFQ } = require('../shared/rfq-writer');
const { writeCQBatch } = require('../shared/cq-writer');
const breadcrumbs = require('../shared/breadcrumbs');
const { ImapFlow } = require('imapflow');

const JAKE_USER_ID = 1000004;
const UNQUALIFIED_BROKER_ID = 1006505;
const INBOX = 'stockRFQ@orangetsunami.com';

const CASES = [
  // UID 2589 — Kexinyuan BUK9Y29-40E (existing RFQ; MFR inferred)
  {
    uid: 2589,
    mode: 'add_cq',
    rfqSearchKey: '1134293',
    sourceMessageId: '<a8ed7ff0a55c4c3abd5914e3fc7b3758@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    matchPath: 'header',
    lines: [{
      mpn: 'BUK9Y29-40E,115',
      qty: 28500,
      resale: 6.50,
      mfrText: 'Nexperia',
      leadTime: 'STOCK',
      dateCode: '22+',
      notePublic: 'Full reels full labels',
      notePrivate: 'MFR inferred from MPN — operator did not specify; BUK prefix is Nexperia',
    }],
  },
  // UID 2585 — Zhi Yu STM32G030K6T6TR (new RFQ; matched BP 1010938)
  {
    uid: 2585,
    mode: 'add_cq_with_rfq',
    bpartnerId: 1010938,
    customerName: 'Shenzhen Zhi Yu Technology Co., Ltd',
    originalSenderEmail: 'stella@zhiyuic.com',
    originalCompanyName: 'Shenzhen Zhi Yu Technology Co., Ltd',
    sourceMessageId: '<64903dcc269d491c8f5f2d7ed8da5b96@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    lines: [{
      mpn: 'STM32G030K6T6TR',
      qty: 7169,
      resale: 0.504,
      mfrText: 'STMicroelectronics',
      leadTime: 'STOCK',
      notePublic: 'Philippines stock',
      cpc: 'STM32G030K6T6TR',
    }],
  },
  // UID 2587 — Liyijing W631GG6NB-12 (new RFQ; no Liyijing BP → Unqualified)
  {
    uid: 2587,
    mode: 'add_cq_with_rfq',
    bpartnerId: UNQUALIFIED_BROKER_ID,
    customerName: 'Liyijing Electronic Technology Co., LTD',
    originalSenderEmail: 'iris@liyijing.com.cn',
    originalCompanyName: 'Liyijing Electronic Technology Co., LTD',
    sourceMessageId: '<27e390d96ced4c9baa50f84c5828ddbe@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    lines: [{
      mpn: 'W631GG6NB-12',
      qty: 1514,
      resale: 1.84,
      mfrText: 'Winbond',
      leadTime: 'STOCK',
      notePublic: 'Hong Kong stock',
      cpc: 'W631GG6NB-12',
    }],
  },
];

async function moveToProcessed(uid) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: INBOX, pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('CQ-NeedsReview');
    try {
      await client.messageMove(String(uid), 'CQ-Processed', { uid: true });
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

(async () => {
  for (const c of CASES) {
    console.log(`\n========== UID ${c.uid} — ${c.mode} ==========`);
    try {
      if (c.mode === 'add_cq') {
        const result = await writeCQBatch(c.rfqSearchKey, c.lines, {});
        console.log(`  written=${result.written.length} flagged=${result.flagged.length} failed=${result.failed.length}`);
        if (result.flagged.length) console.log('  FLAGGED:', JSON.stringify(result.flagged, null, 2));
        if (result.failed.length) console.log('  FAILED:', JSON.stringify(result.failed, null, 2));
        breadcrumbs.write({
          cog: 'stockrfq-cq-agent',
          event: 'cq-loaded',
          uid: c.uid,
          sourceUid: c.uid,
          sourceMessageId: c.sourceMessageId,
          matchPath: c.matchPath,
          rfqSearchKey: c.rfqSearchKey,
          cqsWritten: result.written.length,
          cqsFlagged: result.flagged.length,
          cqsFailed: result.failed.length,
          note: 'manual-resolution-2026-05-13',
        });
        if (result.written.length && !result.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        } else {
          console.log(`  → left UID ${c.uid} in CQ-NeedsReview (had failures)`);
        }
      } else {
        // add_cq_with_rfq
        const rfqLines = c.lines.map(l => ({
          mpn: l.mpn, qty: l.qty, mfrText: l.mfrText,
          cpc: l.cpc || l.mpn,
          description: c.bpartnerId === UNQUALIFIED_BROKER_ID
            ? `${c.customerName} - ${l.mpn}`
            : undefined,
        }));
        const headerDescription = `${c.customerName} — Stock RFQ (captured via outbound CQ reply)`;
        const rfqResult = await writeRFQ({
          bpartnerId: c.bpartnerId,
          type: 'Stock',
          description: headerDescription,
          bpName: c.customerName,
          salesrepId: JAKE_USER_ID,
          userId: JAKE_USER_ID,
          lines: rfqLines,
        });
        console.log(`  new RFQ: searchKey=${rfqResult.searchKey} rfqId=${rfqResult.rfqId} linesWritten=${rfqResult.linesWritten}`);
        const cqResult = await writeCQBatch(rfqResult.searchKey, c.lines, {});
        console.log(`  written=${cqResult.written.length} flagged=${cqResult.flagged.length} failed=${cqResult.failed.length}`);
        if (cqResult.flagged.length) console.log('  FLAGGED:', JSON.stringify(cqResult.flagged, null, 2));
        if (cqResult.failed.length) console.log('  FAILED:', JSON.stringify(cqResult.failed, null, 2));
        breadcrumbs.write({
          cog: 'stockrfq-cq-agent',
          event: 'cq-loaded-with-rfq',
          uid: c.uid,
          sourceUid: c.uid,
          sourceMessageId: c.sourceMessageId,
          bpartnerId: c.bpartnerId,
          customerName: c.customerName,
          originalSenderEmail: c.originalSenderEmail,
          rfqId: rfqResult.rfqId,
          searchKey: rfqResult.searchKey,
          rfqLinesWritten: rfqResult.linesWritten,
          cqsWritten: cqResult.written.length,
          cqsFlagged: cqResult.flagged.length,
          cqsFailed: cqResult.failed.length,
          note: 'manual-resolution-2026-05-13',
        });
        if (cqResult.written.length && !cqResult.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        } else {
          console.log(`  → left UID ${c.uid} in CQ-NeedsReview (had failures)`);
        }
      }
    } catch (e) {
      console.error(`  ERROR on UID ${c.uid}:`, e.message);
      console.error(e.stack);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
