#!/usr/bin/env node
/**
 * Clear the 3 PC28F128J3F75B needs-review messages now that PC28F is in the
 * prefix-map (→ Micron Technology Inc).
 *   - UID 2231: hazel@kexinyuanmicroelectronic.com → add_cq against RFQ 1134158
 *   - UID 2233: liora@igzrc.cn  (Shenzhen Mingsheng — no BP) → add_cq_with_rfq Unqualified
 *   - UID 2583: sales@globalingg.com → add_cq against RFQ 1134316
 *
 * Same operator quote for all three (classic fishing pattern): 2,000 pcs in
 * Austin, TX @ $6.00 USD each.
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

const COMMON_LINE = {
  mpn: 'PC28F128J3F75B',
  qty: 2000,
  resale: 6.00,
  mfrText: 'Micron Technology Inc',
  leadTime: 'STOCK',
  notePublic: 'Austin TX stock',
  notePrivate: 'MFR inferred from MPN prefix via mfr-resolver (PC28F → Micron, former Intel StrataFlash); operator did not specify',
};

const CASES = [
  {
    uid: 2231,
    mode: 'add_cq',
    rfqSearchKey: '1134158',
    sourceMessageId: '<99b8da55e0d8424181f5311feaaeae3e@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    matchPath: 'mpn-fuzzy',
    lines: [{ ...COMMON_LINE, cpc: 'PC28F128J3F75B' }],
  },
  {
    uid: 2233,
    mode: 'add_cq_with_rfq',
    bpartnerId: UNQUALIFIED_BROKER_ID,
    customerName: 'Shenzhen Mingsheng Electronics Co., Ltd.',
    originalSenderEmail: 'liora@igzrc.cn',
    originalCompanyName: 'Shenzhen Mingsheng Electronics Co., Ltd.',
    sourceMessageId: '<5a8f6abea9c747d8b21fb14fa9bfbe2d@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    rfqLineQty: 2000,
    cqLines: [{ ...COMMON_LINE, cpc: 'PC28F128J3F75B' }],
  },
  {
    uid: 2583,
    mode: 'add_cq',
    rfqSearchKey: '1134316',
    sourceMessageId: '<3b22ba9a47114fc6ad927d9da6ce8ae5@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    matchPath: 'mpn-fuzzy',
    lines: [{ ...COMMON_LINE, cpc: 'PC28F128J3F75B' }],
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
    try { await client.messageMove(String(uid), 'CQ-Processed', { uid: true }); }
    finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

(async () => {
  for (const c of CASES) {
    console.log(`\n========== UID ${c.uid} — ${c.mode} ==========`);
    try {
      if (c.mode === 'add_cq') {
        const r = await writeCQBatch(c.rfqSearchKey, c.lines, {});
        console.log(`  written=${r.written.length} flagged=${r.flagged.length} failed=${r.failed.length}`);
        if (r.flagged.length) console.log('  FLAGGED:', JSON.stringify(r.flagged, null, 2));
        if (r.failed.length) console.log('  FAILED:', JSON.stringify(r.failed, null, 2));
        breadcrumbs.write({
          cog: 'stockrfq-cq-agent', event: 'cq-loaded',
          uid: c.uid, sourceUid: c.uid, sourceMessageId: c.sourceMessageId,
          matchPath: c.matchPath, rfqSearchKey: c.rfqSearchKey,
          cqsWritten: r.written.length, cqsFlagged: r.flagged.length,
          cqsFailed: r.failed.length, note: 'pc28f-backlog-clear-2026-05-14',
        });
        if (r.written.length && !r.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        }
      } else {
        const rfqLines = c.cqLines.map(l => ({
          mpn: l.mpn, qty: c.rfqLineQty != null ? c.rfqLineQty : l.qty,
          mfrText: l.mfrText, cpc: l.cpc || l.mpn,
          description: `${c.customerName} - ${l.mpn}`,
        }));
        const rfq = await writeRFQ({
          bpartnerId: c.bpartnerId, type: 'Stock',
          description: `${c.customerName} — Stock RFQ (captured via outbound CQ reply)`,
          bpName: c.customerName,
          salesrepId: JAKE_USER_ID, userId: JAKE_USER_ID, lines: rfqLines,
        });
        console.log(`  new RFQ: searchKey=${rfq.searchKey} rfqId=${rfq.rfqId} linesWritten=${rfq.linesWritten}`);
        const cq = await writeCQBatch(rfq.searchKey, c.cqLines, {});
        console.log(`  written=${cq.written.length} flagged=${cq.flagged.length} failed=${cq.failed.length}`);
        if (cq.flagged.length) console.log('  FLAGGED:', JSON.stringify(cq.flagged, null, 2));
        if (cq.failed.length) console.log('  FAILED:', JSON.stringify(cq.failed, null, 2));
        breadcrumbs.write({
          cog: 'stockrfq-cq-agent', event: 'cq-loaded-with-rfq',
          uid: c.uid, sourceUid: c.uid, sourceMessageId: c.sourceMessageId,
          bpartnerId: c.bpartnerId, customerName: c.customerName,
          originalSenderEmail: c.originalSenderEmail,
          rfqId: rfq.rfqId, searchKey: rfq.searchKey,
          rfqLinesWritten: rfq.linesWritten,
          cqsWritten: cq.written.length, cqsFlagged: cq.flagged.length,
          cqsFailed: cq.failed.length, note: 'pc28f-backlog-clear-2026-05-14',
        });
        if (cq.written.length && !cq.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        }
      }
    } catch (e) {
      console.error(`  ERROR on UID ${c.uid}:`, e.message);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
