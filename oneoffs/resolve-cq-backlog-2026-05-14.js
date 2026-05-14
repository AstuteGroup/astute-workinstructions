#!/usr/bin/env node
/**
 * Clear auto-resolvable CQ-NeedsReview backlog using the new decision-tree rules.
 *   - UID 2278: FDS6982AS  80564pcs → add_cq against existing RFQ 1134147
 *                                    (MFR inferred: FDS → On Semiconductor)
 *   - UID 2280: STM32G030K6T6TR 7169pcs (Keyunxin) → add_cq_with_rfq under BP 1004400
 *   - UID 2282: UCC28C43DR (ask 18187, fill 5687) → add_cq_with_rfq under Unqualified
 *                                                    (Nico Technology — no BP); MFR UCC → TI
 *
 * Skipped (left in CQ-NeedsReview for operator triage):
 *   - 2231 / 2233 / 2583: PC28F128J3F75B — prefix PC28F genuinely needs a manual call
 *     (Intel/Numonyx/Micron — different across acquisition timeline)
 *   - 2485: "SZ-KS16/12N (3rd Request!!)" — qty mismatch + escalation flag
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { writeRFQ } = require('../shared/rfq-writer');
const { writeCQBatch } = require('../shared/cq-writer');
const { apiPost } = require('../shared/api-client');
const breadcrumbs = require('../shared/breadcrumbs');
const { ImapFlow } = require('imapflow');

const JAKE_USER_ID = 1000004;
const UNQUALIFIED_BROKER_ID = 1006505;
const INBOX = 'stockRFQ@orangetsunami.com';

const CASES = [
  // UID 2278 — Qizhong FDS6982AS (existing RFQ 1134147; MFR inferred Onsemi)
  {
    uid: 2278,
    mode: 'add_cq',
    rfqSearchKey: '1134147',
    sourceMessageId: '<3fc52b593d33437d819cbc3c29d6af5f@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    matchPath: 'mpn-fuzzy',
    lines: [{
      mpn: 'FDS6982AS',
      qty: 80564,
      resale: 0.64,
      mfrText: 'On Semiconductor',
      leadTime: 'STOCK',
      dateCode: '1717',
      notePublic: 'Philippines stock',
      notePrivate: 'MFR inferred from MPN prefix via mfr-resolver (FDS → On Semiconductor); operator did not specify',
    }],
  },

  // UID 2280 — Keyunxin STM32G030K6T6TR (new RFQ; matched BP 1004400)
  {
    uid: 2280,
    mode: 'add_cq_with_rfq',
    bpartnerId: 1004400,
    customerName: 'Shenzhen Keyunxin Electronics',
    originalSenderEmail: 'kimi@keyunxin.net',
    originalCompanyName: 'Shenzhen Keyunxin Elec',
    sourceMessageId: '<442131b0d5e9470ca0209e2126da23c5@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    rfqLineQty: 7169,
    cqLines: [{
      mpn: 'STM32G030K6T6TR',
      qty: 7169,
      resale: 0.504,
      mfrText: 'STMicroelectronics',
      leadTime: 'STOCK',
      notePublic: 'Philippines stock',
      cpc: 'STM32G030K6T6TR',
    }],
  },

  // UID 2282 — Nico Technology UCC28C43DR (partial fill; broker not in OT → Unqualified)
  // RFQ qty = broker's ask (18,187); CQ qty = operator's fill (5,687).
  // MFR inferred: UCC → Texas Instruments.
  {
    uid: 2282,
    mode: 'add_cq_with_rfq',
    bpartnerId: UNQUALIFIED_BROKER_ID,
    customerName: 'Shenzhen Nico Technology Co., Ltd',
    originalSenderEmail: 'mila-5085qwer@qq.com',
    originalCompanyName: 'Shenzhen Nico Technology Co., Ltd',
    sourceMessageId: '<39bac13f26ff460a87ec9e265ce841a1@VI1PR02MB4317.eurprd02.prod.outlook.com>',
    rfqLineQty: 18187,            // broker's ask
    cqLines: [{
      mpn: 'UCC28C43DR',
      qty: 5687,                  // operator's partial fill
      resale: 0.845,
      mfrText: 'Texas Instruments',
      leadTime: 'STOCK',
      notePublic: 'Philippines stock — partial fill (5687 of 18187 requested)',
      notePrivate: 'MFR inferred from MPN prefix via mfr-resolver (UCC → Texas Instruments); operator did not specify',
      cpc: 'UCC28C43DR',
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
          note: 'backlog-clear-2026-05-14',
        });
        if (result.written.length && !result.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        }
      } else {
        // add_cq_with_rfq — handle separate RFQ-ask qty vs CQ-fill qty
        const rfqLines = c.cqLines.map(l => ({
          mpn: l.mpn,
          qty: c.rfqLineQty != null ? c.rfqLineQty : l.qty,
          mfrText: l.mfrText,
          cpc: l.cpc || l.mpn,
          description: c.bpartnerId === UNQUALIFIED_BROKER_ID
            ? `${c.customerName} - ${l.mpn}`
            : undefined,
        }));
        const rfqResult = await writeRFQ({
          bpartnerId: c.bpartnerId,
          type: 'Stock',
          description: `${c.customerName} — Stock RFQ (captured via outbound CQ reply)`,
          bpName: c.customerName,
          salesrepId: JAKE_USER_ID,
          userId: JAKE_USER_ID,
          lines: rfqLines,
        });
        console.log(`  new RFQ: searchKey=${rfqResult.searchKey} rfqId=${rfqResult.rfqId} linesWritten=${rfqResult.linesWritten}`);
        const cqResult = await writeCQBatch(rfqResult.searchKey, c.cqLines, {});
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
          note: 'backlog-clear-2026-05-14',
        });
        if (cqResult.written.length && !cqResult.failed.length) {
          await moveToProcessed(c.uid);
          console.log(`  → moved UID ${c.uid} to CQ-Processed`);
        }
      }
    } catch (e) {
      console.error(`  ERROR on UID ${c.uid}:`, e.message);
      console.error(e.stack);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
