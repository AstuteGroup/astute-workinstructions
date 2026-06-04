#!/usr/bin/env node
//
// VQ Loading — Daily Digest
//
// Scheduled daily at 8am EST (~12 UTC during DST, 13 UTC standard — DST drift
// acceptable per ops convention). Surfaces the previous 24 hours of VQ
// loading activity to the operator for review.
//
// What the digest contains:
//   1. Activity-by-loader table — mixed counting rule:
//        • Claude as buyer (createdby=1049524 AND RFQ NOT in email batches):
//          COUNT(DISTINCT (rfq_line × vendor)) — collapses API stock+LT+qty-
//          break response variants per (vendor, part).
//        • Claude as purchasing support (createdby=1049524 AND RFQ IN email
//          batches), and all human loaders: COUNT(*) — each row is a distinct
//          broker stock batch.
//        • NetComponents sourcing — shown only when active.
//        Claude buckets with 0 activity are hidden automatically (avoids
//        clutter for paused workflows).
//   2. Per-batch detail table — one row per email processed by
//      vq-loading-agent in the window. For each batch:
//        • VQs written
//        • On behalf of (outer envelope From — discovered via IMAP cross-ref
//          on the breadcrumb's messageId)
//        • For buyer (chuboe_buyer_id assigned)
//        • RFQs covered
//        • Outstanding (escalations, silent losses, partial extractions)
//        • Reference (email subject + date for the operator to find it)
//
// Usage:
//   node vq-loading-daily-digest.js               # preview to stdout (no send)
//   node vq-loading-daily-digest.js --send        # email operator
//   node vq-loading-daily-digest.js --since 24    # custom window in hours
//   node vq-loading-daily-digest.js --since 48    # backfill 2 days

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const fs = require('fs');
const { execSync } = require('child_process');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createNotifier } = require('../../../shared/notifier');
const { isKnownBuyer, isKnownSupport } = require('../../../shared/partner-lookup');

const BREADCRUMBS = path.join(process.env.HOME, 'workspace', '.offer-pipeline', 'breadcrumbs.jsonl');
const ATTRIBUTION_LOG = path.join(process.env.HOME, 'workspace', '.vq-batch-attribution.jsonl');
const RECIPIENT = 'jake.harris@astutegroup.com';
const CLAUDE_USER_ID = 1049524;

// Load per-VQ attribution rows from the local JSONL log. Maps each
// chuboe_vq_line.id back to its source email's UID, so the digest can do
// precise per-batch "claimed vs active in OT" reconciliation. Written by
// shared/workflow-actions/vq-loading.js after each successful write.
function loadAttributionSince(sinceMs) {
  if (!fs.existsSync(ATTRIBUTION_LOG)) return [];
  const raw = fs.readFileSync(ATTRIBUTION_LOG, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = Date.parse(obj.ts);
      if (ts >= sinceMs) out.push(obj);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const sinceIdx = args.indexOf('--since');
const SINCE_HOURS = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : 24;

function psqlPipe(sql) {
  return execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert UTC Date → CT-naive timestamp string (CT clock digits with no TZ
// suffix; matches chuboe_*.created column storage).
function utcToCTNaive(d) {
  // CDT = UTC-5 during May 2026 (DST). Hard-coded for now — DST drift is OK.
  const ct = new Date(d.getTime() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ct.getUTCFullYear()}-${pad(ct.getUTCMonth() + 1)}-${pad(ct.getUTCDate())} ${pad(ct.getUTCHours())}:${pad(ct.getUTCMinutes())}:${pad(ct.getUTCSeconds())}`;
}

function loadBreadcrumbsSince(sinceMs) {
  if (!fs.existsSync(BREADCRUMBS)) return [];
  const raw = fs.readFileSync(BREADCRUMBS, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = Date.parse(obj.ts);
      if (ts >= sinceMs) out.push(obj);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// ─── IMAP outer-From cross-ref ──────────────────────────────────────────────
//
// The agent's breadcrumb captures `senderEmail` = the DEEPEST resolved actor
// from the chain walk (per shared/partner-lookup.js Tier-A logic). That's
// useful for buyer attribution but it doesn't tell us "who forwarded the
// email to vq@?" For the digest's "On behalf of" column we want the actual
// outer envelope From. Lookup by Message-ID across vq@ folders.
async function fetchOuterFromForMessageIds(messageIds) {
  if (!messageIds || messageIds.length === 0) return new Map();
  const result = new Map();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    for (const folder of ['Processed', 'INBOX', 'NeedsReview', 'NoBid']) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          for (const mid of messageIds) {
            if (result.has(mid)) continue;
            try {
              const uids = await client.search({ header: { 'message-id': mid } }, { uid: true });
              if (!uids || uids.length === 0) continue;
              const msg = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
              if (!msg) continue;
              const from = (msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '';
              const subject = msg.envelope.subject || '';
              const date = msg.envelope.date;
              result.set(mid, { outerFrom: from, subject, date, folder });
            } catch (_) { /* skip per-message errors */ }
          }
        } finally { lock.release(); }
      } catch (_) { /* skip folder not accessible */ }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

// ─── Activity by loader (top section) ───────────────────────────────────────
function pullActivity(sinceTs, untilTs, emailBatchRfqs) {
  const inClause = emailBatchRfqs.length
    ? emailBatchRfqs.map(r => `'${r}'`).join(',')
    : `''`; // empty list — nothing matches
  // Mixed counting rule: Claude-as-buyer uses DISTINCT (rfq_line × vendor);
  // everyone else uses raw COUNT(*). Also surface ad_user_id so we can tag
  // human loaders with their role registry classification.
  const sql =
    `WITH labeled AS ( ` +
    `SELECT v.chuboe_vq_line_id, v.chuboe_rfq_line_id, v.c_bpartner_id, v.createdby, ` +
    `CASE ` +
    `  WHEN v.createdby = ${CLAUDE_USER_ID} AND r.value IN (${inClause}) THEN 'Claude as purchasing support (email loading)' ` +
    `  WHEN v.createdby = ${CLAUDE_USER_ID} THEN 'Claude as buyer (API + scraping)' ` +
    `  ELSE COALESCE(u.name, 'unknown') END AS loader ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.ad_user u ON u.ad_user_id = v.createdby ` +
    `WHERE v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp AND v.isactive='Y' ` +
    `) SELECT loader, MIN(createdby) AS user_id, ` +
    `       CASE WHEN loader = 'Claude as buyer (API + scraping)' ` +
    `            THEN COUNT(DISTINCT (chuboe_rfq_line_id, c_bpartner_id)) ` +
    `            ELSE COUNT(*) END AS vqs ` +
    `FROM labeled GROUP BY loader ORDER BY vqs DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [loader, userId, vqs] = line.split('|');
    return { loader, userId: Number(userId), vqs: Number(vqs) };
  });
}

// ─── Top 3 buyers per loader ─────────────────────────────────────────────────
// Returns Map<loaderName, [{buyerName, buyerId, vqs}, ...]> (up to 3 per loader)
// Shows which buyers each loader is loading VQs on behalf of.
function pullTopBuyersPerLoader(sinceTs, untilTs, emailBatchRfqs) {
  const inClause = emailBatchRfqs.length
    ? emailBatchRfqs.map(r => `'${r}'`).join(',')
    : `''`;
  // Use chuboe_buyer_id from the VQ line — that's the buyer who did the sourcing.
  const sql =
    `WITH labeled AS ( ` +
    `SELECT v.chuboe_vq_line_id, v.createdby, v.chuboe_buyer_id, ` +
    `CASE ` +
    `  WHEN v.createdby = ${CLAUDE_USER_ID} AND r.value IN (${inClause}) THEN 'Claude as purchasing support (email loading)' ` +
    `  WHEN v.createdby = ${CLAUDE_USER_ID} THEN 'Claude as buyer (API + scraping)' ` +
    `  ELSE COALESCE(lu.name, 'unknown') END AS loader ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `LEFT JOIN adempiere.ad_user lu ON lu.ad_user_id = v.createdby ` +
    `WHERE v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp AND v.isactive='Y' ` +
    `), ` +
    `by_buyer AS ( ` +
    `SELECT l.loader, l.chuboe_buyer_id, bu.name AS buyer_name, COUNT(*) AS vqs ` +
    `FROM labeled l ` +
    `LEFT JOIN adempiere.ad_user bu ON bu.ad_user_id = l.chuboe_buyer_id ` +
    `GROUP BY l.loader, l.chuboe_buyer_id, bu.name ` +
    `), ` +
    `ranked AS ( ` +
    `SELECT *, ROW_NUMBER() OVER (PARTITION BY loader ORDER BY vqs DESC) AS rn ` +
    `FROM by_buyer ` +
    `) ` +
    `SELECT loader, chuboe_buyer_id, buyer_name, vqs FROM ranked WHERE rn <= 3 ORDER BY loader, rn;`;
  const out = psqlPipe(sql);
  const m = new Map();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [loader, buyerId, buyerName, vqs] = line.split('|');
    if (!m.has(loader)) m.set(loader, []);
    m.get(loader).push({
      buyerId: buyerId ? Number(buyerId) : null,
      buyerName: buyerName || '(no buyer)',
      vqs: Number(vqs),
    });
  }
  return m;
}

// ─── Buyer activity breakdown ────────────────────────────────────────────────
// For each buyer, shows how many VQs were loaded by Claude vs support vs self.
// Returns array of { buyerId, buyerName, byClaude, bySupport, bySelf, total }
function pullBuyerActivityBreakdown(sinceTs, untilTs, emailBatchRfqs) {
  const inClause = emailBatchRfqs.length
    ? emailBatchRfqs.map(r => `'${r}'`).join(',')
    : `''`;
  // Categorize each VQ by loader type, then pivot by buyer.
  const sql =
    `WITH categorized AS ( ` +
    `SELECT v.chuboe_vq_line_id, v.chuboe_buyer_id, v.createdby, ` +
    `CASE ` +
    `  WHEN v.createdby = ${CLAUDE_USER_ID} THEN 'claude' ` +
    `  WHEN v.createdby = v.chuboe_buyer_id THEN 'self' ` +
    `  ELSE 'support' END AS loader_type ` +
    `FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `WHERE v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp ` +
    `AND v.isactive='Y' AND v.chuboe_buyer_id IS NOT NULL ` +
    `) ` +
    `SELECT c.chuboe_buyer_id, bu.name AS buyer_name, ` +
    `SUM(CASE WHEN loader_type = 'claude' THEN 1 ELSE 0 END) AS by_claude, ` +
    `SUM(CASE WHEN loader_type = 'support' THEN 1 ELSE 0 END) AS by_support, ` +
    `SUM(CASE WHEN loader_type = 'self' THEN 1 ELSE 0 END) AS by_self, ` +
    `COUNT(*) AS total ` +
    `FROM categorized c ` +
    `LEFT JOIN adempiere.ad_user bu ON bu.ad_user_id = c.chuboe_buyer_id ` +
    `GROUP BY c.chuboe_buyer_id, bu.name ` +
    `ORDER BY total DESC;`;
  const out = psqlPipe(sql);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [buyerId, buyerName, byClaude, bySupport, bySelf, total] = line.split('|');
    return {
      buyerId: buyerId ? Number(buyerId) : null,
      buyerName: buyerName || '(unknown)',
      byClaude: Number(byClaude) || 0,
      bySupport: Number(bySupport) || 0,
      bySelf: Number(bySelf) || 0,
      total: Number(total) || 0,
    };
  });
}

// ─── API enrichment overlap detection ────────────────────────────────────────
// Finds RFQ lines where Claude did API enrichment AND a buyer also sourced.
// This is duplicate effort — Claude already has franchise pricing.
function pullApiEnrichmentOverlap(sinceTs, untilTs) {
  // Find RFQ lines that have BOTH:
  // 1. VQs from Claude as buyer (API enrichment) — createdby = Claude AND buyer = Claude
  // 2. VQs from human buyers (createdby = buyer, buyer is a known buyer)
  const sql =
    `WITH api_lines AS ( ` +
    `  SELECT DISTINCT v.chuboe_rfq_line_id ` +
    `  FROM adempiere.chuboe_vq_line v ` +
    `  WHERE v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp ` +
    `  AND v.isactive='Y' ` +
    `  AND v.createdby = ${CLAUDE_USER_ID} ` +
    `  AND (v.chuboe_buyer_id = ${CLAUDE_USER_ID} OR v.chuboe_buyer_id IS NULL) ` +
    `), ` +
    `buyer_vqs AS ( ` +
    `  SELECT v.chuboe_rfq_line_id, v.chuboe_buyer_id, bu.name AS buyer_name, ` +
    `         r.value AS rfq, ` +
    `         (SELECT lm.chuboe_mpn FROM adempiere.chuboe_rfq_line_mpn lm ` +
    `          WHERE lm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id LIMIT 1) AS mpn, ` +
    `         COUNT(*) AS vq_count ` +
    `  FROM adempiere.chuboe_vq_line v ` +
    `  JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `  JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `  LEFT JOIN adempiere.ad_user bu ON bu.ad_user_id = v.chuboe_buyer_id ` +
    `  WHERE v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp ` +
    `  AND v.isactive='Y' ` +
    `  AND v.createdby != ${CLAUDE_USER_ID} ` +
    `  AND v.chuboe_buyer_id IS NOT NULL ` +
    `  AND v.createdby = v.chuboe_buyer_id ` +
    `  GROUP BY v.chuboe_rfq_line_id, v.chuboe_buyer_id, bu.name, r.value, rl.chuboe_rfq_line_id ` +
    `) ` +
    `SELECT bv.buyer_name, bv.rfq, bv.mpn, bv.vq_count ` +
    `FROM buyer_vqs bv ` +
    `JOIN api_lines al ON bv.chuboe_rfq_line_id = al.chuboe_rfq_line_id ` +
    `ORDER BY bv.buyer_name, bv.rfq;`;
  const out = psqlPipe(sql);
  const rows = out.trim().split('\n').filter(Boolean).map(line => {
    const [buyerName, rfq, mpn, vqCount] = line.split('|');
    return { buyerName, rfq, mpn: mpn || '(unknown)', vqCount: Number(vqCount) || 0 };
  });
  // Aggregate by buyer
  const byBuyer = new Map();
  for (const r of rows) {
    if (!byBuyer.has(r.buyerName)) byBuyer.set(r.buyerName, { lines: [], totalVqs: 0 });
    byBuyer.get(r.buyerName).lines.push(r);
    byBuyer.get(r.buyerName).totalVqs += r.vqCount;
  }
  return { rows, byBuyer };
}

// Returns 'Buyer' / 'Support' / 'Untagged' / '(Claude)' for the role column.
function roleFor(loaderName, userId) {
  if (loaderName.startsWith('Claude')) return '(Claude)';
  if (isKnownBuyer(userId)) return 'Buyer';
  if (isKnownSupport(userId)) return 'Support';
  return 'Untagged';
}

// ─── Active VQ count per RFQ in window (reconciliation) ─────────────────────
function pullActiveCountsByRfq(sinceTs, untilTs, rfqs) {
  if (!rfqs.length) return new Map();
  const sql =
    `SELECT r.value, COUNT(*) FROM adempiere.chuboe_vq_line v ` +
    `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
    `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
    `WHERE r.value IN (${rfqs.map(r => `'${r}'`).join(',')}) ` +
    `AND v.created >= '${sinceTs}'::timestamp AND v.created < '${untilTs}'::timestamp ` +
    `AND v.isactive='Y' ` +
    `GROUP BY r.value;`;
  const out = psqlPipe(sql);
  const m = new Map();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [rfq, cnt] = line.split('|');
    m.set(rfq, Number(cnt));
  }
  return m;
}

function lookupUserNames(userIds) {
  if (!userIds.length) return new Map();
  const out = psqlPipe(`SELECT ad_user_id, name FROM adempiere.ad_user WHERE ad_user_id IN (${userIds.join(',')})`);
  const m = new Map();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [id, name] = line.split('|');
    m.set(Number(id), name);
  }
  return m;
}

(async () => {
  const now = Date.now();
  const sinceMs = now - SINCE_HOURS * 3600 * 1000;
  const sinceTs = utcToCTNaive(new Date(sinceMs));
  const untilTs = utcToCTNaive(new Date(now));

  // 1. Read breadcrumbs in window for vq-loading-agent
  const bcs = loadBreadcrumbsSince(sinceMs).filter(b => b.cog === 'vq-loading-agent');
  const loaded = bcs.filter(b => b.event === 'loaded');
  const escalated = bcs.filter(b => b.event && b.event.startsWith('escalated'));

  // 2. Group loaded events by sourceUid (= one email per group)
  const byUid = new Map();
  for (const e of loaded) {
    const uid = e.sourceUid || e.uid;
    if (!byUid.has(uid)) byUid.set(uid, { uid, messageId: e.messageId, firstTs: e.ts, events: [] });
    byUid.get(uid).events.push(e);
  }

  // 3. IMAP cross-ref: outer From for each batch's messageId
  const messageIds = [...new Set([...byUid.values()].map(b => b.messageId).filter(Boolean))];
  const mid2info = messageIds.length ? await fetchOuterFromForMessageIds(messageIds) : new Map();

  // 4. Build per-batch detail
  const emailBatchRfqs = new Set();
  const batches = [];
  for (const [uid, group] of byUid) {
    const rfqs = group.events.map(e => ({
      rfq: e.rfqSearchKey,
      isPrimary: e.isPrimary,
      written: e.written || 0,
      skipped: e.skipped || 0,
      failed: e.failed || 0,
      coverageHit: e.coverageHit || 0,
      coverageTotal: e.coverageTotal || 0,
    }));
    rfqs.forEach(r => emailBatchRfqs.add(r.rfq));
    const claimed = rfqs.reduce((a, r) => a + r.written, 0);
    const failed = rfqs.reduce((a, r) => a + r.failed, 0);
    const senderEmail = group.events[0]?.senderEmail || '';
    const info = mid2info.get(group.messageId);
    // Breadcrumb's buyerId = what the agent assigned at load time. Captured
    // for audit but should NOT drive the displayed buyer — operator may have
    // patched it later (e.g., today's UID 8515 Ivy → Molly correction).
    const breadcrumbBuyerId = group.events[0]?.buyerId;

    // Per-batch CURRENT buyer attribution from OT: aggregate chuboe_buyer_id
    // across active VQs that landed within this batch's load-time window on
    // its RFQs. Reflects any operator patches since the breadcrumb was written.
    const eventTimes = group.events.map(e => Date.parse(e.ts)).filter(Number.isFinite);
    let currentBuyerId = breadcrumbBuyerId;
    let currentActive = 0;
    if (eventTimes.length && rfqs.length) {
      const winStart = utcToCTNaive(new Date(Math.min(...eventTimes) - 2 * 60 * 1000)); // -2min slop
      const winEnd   = utcToCTNaive(new Date(Math.max(...eventTimes) + 5 * 60 * 1000)); // +5min slop
      const distinctRfqs = [...new Set(rfqs.map(r => r.rfq))];
      try {
        const sql =
          `SELECT v.chuboe_buyer_id, COUNT(*) cnt ` +
          `FROM adempiere.chuboe_vq_line v ` +
          `JOIN adempiere.chuboe_rfq_line rl ON v.chuboe_rfq_line_id = rl.chuboe_rfq_line_id ` +
          `JOIN adempiere.chuboe_rfq r ON rl.chuboe_rfq_id = r.chuboe_rfq_id ` +
          `WHERE r.value IN (${distinctRfqs.map(r => `'${r}'`).join(',')}) ` +
          `AND v.created BETWEEN '${winStart}'::timestamp AND '${winEnd}'::timestamp ` +
          `AND v.isactive='Y' ` +
          `GROUP BY v.chuboe_buyer_id ORDER BY cnt DESC;`;
        const out = psqlPipe(sql);
        const rows = out.trim().split('\n').filter(Boolean).map(l => {
          const [bid, cnt] = l.split('|');
          return { buyerId: bid ? Number(bid) : null, count: Number(cnt) };
        });
        if (rows.length) {
          currentBuyerId = rows[0].buyerId;
          currentActive = rows.reduce((a, x) => a + x.count, 0);
        } else {
          // No active VQs landed in this batch's window → either rolled back
          // or the load failed silently.
          currentBuyerId = null;
          currentActive = 0;
        }
      } catch (_) {
        // Fail open: keep the breadcrumb buyer if the OT query errors.
      }
    }

    batches.push({
      uid,
      messageId: group.messageId,
      firstTs: group.firstTs,
      outerFrom: (info && info.outerFrom) || senderEmail || '?',
      subject: (info && info.subject) || '(subject unavailable)',
      emailDate: info && info.date ? info.date.toISOString() : null,
      buyerId: currentBuyerId,             // current OT-derived buyer
      breadcrumbBuyerId,                    // what the agent assigned at load time
      rfqs,
      claimedWritten: claimed,
      failedCount: failed,
      currentActive,
    });
  }
  batches.sort((a, b) => a.firstTs.localeCompare(b.firstTs));

  // 5. Per-batch reconciliation via the local attribution log.
  // shared/workflow-actions/vq-loading.js writes one JSONL row per successful
  // VQ write tying vqLineId → sourceUid. The digest reads that log, groups
  // by sourceUid, and queries OT for is_active=Y on the vqLineIds attributed
  // to each batch. Gives precise "claimed vs active" per batch without an
  // OT schema change. Window-time-based fallback removed.
  const allBatchRfqs = [...emailBatchRfqs];
  const attribRows = loadAttributionSince(sinceMs);
  const attribByUid = new Map();
  for (const a of attribRows) {
    const uid = a.sourceUid;
    if (!uid) continue;
    if (!attribByUid.has(uid)) attribByUid.set(uid, []);
    attribByUid.get(uid).push(a);
  }

  // Bulk query: for every vqLineId across all batches, which are active?
  const allVqLineIds = attribRows.map(a => a.vqLineId).filter(Number.isFinite);
  const activeIds = new Set();
  if (allVqLineIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < allVqLineIds.length; i += 500) chunks.push(allVqLineIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const sql = `SELECT chuboe_vq_line_id FROM adempiere.chuboe_vq_line WHERE chuboe_vq_line_id IN (${chunk.join(',')}) AND isactive='Y'`;
      const out = psqlPipe(sql);
      for (const line of out.trim().split('\n').filter(Boolean)) {
        const id = Number(line);
        if (Number.isFinite(id)) activeIds.add(id);
      }
    }
  }

  for (const b of batches) {
    const rows = attribByUid.get(b.uid) || [];
    b.attributedVqIds = rows.map(r => r.vqLineId);
    b.activeInOt = rows.filter(r => activeIds.has(r.vqLineId)).length;
    b.attributedTotal = rows.length;
    b.silentLoss = Math.max(0, b.claimedWritten - b.attributedTotal);
    b.deactivatedAfterLoad = b.attributedTotal - b.activeInOt;
  }

  // 6. Look up buyer names + user names. Include both current and breadcrumb
  // buyer IDs so the digest can render "was X, now Y" diffs.
  const buyerIds = [
    ...new Set(batches.flatMap(b => [b.buyerId, b.breadcrumbBuyerId]).filter(Boolean)),
  ];
  const buyerMap = lookupUserNames(buyerIds);

  // 7. Activity by loader (mixed counting rule) + top buyers per loader
  const activity = pullActivity(sinceTs, untilTs, allBatchRfqs);
  const topBuyers = pullTopBuyersPerLoader(sinceTs, untilTs, allBatchRfqs);
  const buyerBreakdown = pullBuyerActivityBreakdown(sinceTs, untilTs, allBatchRfqs);
  const apiOverlap = pullApiEnrichmentOverlap(sinceTs, untilTs);

  // Apply "hide zero" rule for Claude buckets
  const claudeBucketNames = new Set([
    'Claude as buyer (API + scraping)',
    'Claude as purchasing support (email loading)',
    'Claude — NetComponents sourcing',
  ]);
  const activityShown = activity.filter(a => !claudeBucketNames.has(a.loader) || a.vqs > 0);
  const totalAll = activityShown.reduce((a, x) => a + x.vqs, 0);

  // ─── Render HTML ─────────────────────────────────────────────────────────
  const dispWindow = `${sinceTs} CT → ${untilTs} CT (${SINCE_HOURS}h)`;
  let html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="color:#2a5;margin-bottom:4px">VQ Loading — Daily Digest</h2>
<p style="margin-top:0;color:#666">${esc(dispWindow)} · ${totalAll} VQs total · ${batches.length} email batch${batches.length === 1 ? '' : 'es'} processed</p>

<h3 style="margin-bottom:4px">Activity by loader</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:700px">
<thead style="background:#eef"><tr><th align="left">Loader</th><th align="left">Role</th><th align="right">VQs</th><th align="left">Top 3 Buyers</th></tr></thead>
<tbody>
${activityShown.map(a => {
  const role = roleFor(a.loader, a.userId);
  const roleColor = role === 'Support' ? '#888' : role === 'Untagged' ? '#b00' : '#222';
  const nameDisplay = claudeBucketNames.has(a.loader) ? '<b>' + esc(a.loader) + '</b>' : esc(a.loader);
  const buyers = topBuyers.get(a.loader) || [];
  const buyersDisplay = buyers.length > 0
    ? buyers.map(b => `${esc(b.buyerName)} (${b.vqs})`).join(', ')
    : '<i style="color:#999">—</i>';
  return `<tr><td>${nameDisplay}</td><td style="color:${roleColor}"><i>${esc(role)}</i></td><td style="text-align:right">${a.vqs}</td><td style="font-size:11px">${buyersDisplay}</td></tr>`;
}).join('\n')}
<tr style="background:#eee"><td colspan="2"><b>Total supply-support</b></td><td style="text-align:right"><b>${totalAll}</b></td><td></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Counting rule: <b>Claude as buyer</b> uses COUNT(DISTINCT (rfq_line × vendor)) because API responses fan-out stock + lead-time + qty-break variants per (vendor, part); all other loaders use raw row count because each row is a distinct stock batch from the vendor. Claude buckets with 0 activity are hidden. <b>Top 3 Buyers</b> = chuboe_buyer_id on the VQs — who each loader is loading on behalf of.</i></p>

<h3 style="margin-bottom:4px">Buyer Activity Breakdown</h3>
<p style="margin-top:0;color:#666;font-size:11px">For each buyer, how their VQs were loaded: by Claude, by support staff, or by themselves.</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:600px">
<thead style="background:#eef"><tr><th align="left">Buyer</th><th align="right">By Claude</th><th align="right">By Support</th><th align="right">By Self</th><th align="right">Total</th><th align="left">Mix</th></tr></thead>
<tbody>
${buyerBreakdown.filter(b => b.total > 0).slice(0, 20).map(b => {
  const claudePct = b.total > 0 ? Math.round(100 * b.byClaude / b.total) : 0;
  const supportPct = b.total > 0 ? Math.round(100 * b.bySupport / b.total) : 0;
  const selfPct = b.total > 0 ? Math.round(100 * b.bySelf / b.total) : 0;
  // Visual bar showing proportions
  const barWidth = 100;
  const claudeW = Math.round(barWidth * b.byClaude / b.total);
  const supportW = Math.round(barWidth * b.bySupport / b.total);
  const selfW = barWidth - claudeW - supportW;
  const bar = `<span style="display:inline-block;width:${barWidth}px;height:12px;background:#eee;border-radius:2px;overflow:hidden">` +
    (claudeW > 0 ? `<span style="display:inline-block;width:${claudeW}px;height:100%;background:#4a4" title="Claude ${claudePct}%"></span>` : '') +
    (supportW > 0 ? `<span style="display:inline-block;width:${supportW}px;height:100%;background:#88c" title="Support ${supportPct}%"></span>` : '') +
    (selfW > 0 ? `<span style="display:inline-block;width:${selfW}px;height:100%;background:#ca4" title="Self ${selfPct}%"></span>` : '') +
    `</span>`;
  return `<tr><td>${esc(b.buyerName)}</td><td style="text-align:right;color:#4a4">${b.byClaude || '—'}</td><td style="text-align:right;color:#88c">${b.bySupport || '—'}</td><td style="text-align:right;color:#ca4">${b.bySelf || '—'}</td><td style="text-align:right"><b>${b.total}</b></td><td>${bar}</td></tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>Legend: <span style="color:#4a4">■ Claude</span> · <span style="color:#88c">■ Support</span> · <span style="color:#ca4">■ Self</span>. "Self" = buyer loaded their own VQs (createdby = chuboe_buyer_id). Top 20 buyers by volume shown.</i></p>
`;

  // API Enrichment Overlap section
  if (apiOverlap.rows.length > 0) {
    const overlapBuyers = [...apiOverlap.byBuyer.entries()].sort((a, b) => b[1].totalVqs - a[1].totalVqs);
    html += `
<h3 style="margin-bottom:4px;color:#b80">⚠️ API Enrichment Overlap</h3>
<p style="margin-top:0;color:#666;font-size:11px">Parts where Claude already got franchise pricing via API, but a buyer also manually sourced. This is duplicate effort.</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;min-width:500px">
<thead style="background:#fff3e0"><tr><th align="left">Buyer</th><th align="right">Overlap VQs</th><th align="right">RFQ Lines</th><th align="left">Sample MPNs</th></tr></thead>
<tbody>
${overlapBuyers.map(([buyerName, data]) => {
  const sampleMpns = [...new Set(data.lines.map(l => l.mpn))].slice(0, 3).join(', ');
  const lineCount = data.lines.length;
  return `<tr><td>${esc(buyerName)}</td><td style="text-align:right">${data.totalVqs}</td><td style="text-align:right">${lineCount}</td><td style="font-size:11px">${esc(sampleMpns)}${lineCount > 3 ? ' …' : ''}</td></tr>`;
}).join('\n')}
<tr style="background:#fff3e0"><td><b>Total overlap</b></td><td style="text-align:right"><b>${apiOverlap.rows.reduce((a, r) => a + r.vqCount, 0)}</b></td><td style="text-align:right"><b>${apiOverlap.rows.length}</b></td><td></td></tr>
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>These are RFQ lines where Claude's API enrichment (DigiKey, Mouser, TTI, etc.) already returned pricing, and then a buyer also loaded VQs for the same line. The buyer's manual effort may have been unnecessary — check if the franchise quotes were sufficient.</i></p>
`;
  } else {
    html += `<p style="color:#4a4;margin-top:16px"><b>✓ No API enrichment overlap</b> — buyers aren't duplicating Claude's franchise sourcing.</p>`;
  }

  if (batches.length > 0) {
    html += `<h3 style="margin-bottom:4px">Batches loaded via vq-loading-agent</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
<thead style="background:#eef"><tr><th>#</th><th>VQs (active / written)</th><th>On behalf of</th><th>For buyer</th><th>RFQs</th><th>Reference</th><th>Outstanding</th></tr></thead>
<tbody>
${batches.map((b, i) => {
  // Determine display buyer using CURRENT chuboe_buyer_id (post-patches),
  // with the breadcrumb's original assignment as audit context.
  const currentBuyerName = b.buyerId ? (buyerMap.get(b.buyerId) || `id=${b.buyerId}`) : null;
  const breadcrumbBuyerName = b.breadcrumbBuyerId ? (buyerMap.get(b.breadcrumbBuyerId) || `id=${b.breadcrumbBuyerId}`) : null;
  const wasPatched = b.breadcrumbBuyerId && b.buyerId && b.buyerId !== b.breadcrumbBuyerId;
  // Precise rolled-back signal now uses the attribution log: 0 of this
  // batch's attributed vqLineIds are active in OT.
  const rolledBack = b.attributedTotal > 0 && b.activeInOt === 0;

  let buyerDisplay;
  if (rolledBack) {
    buyerDisplay = `<span style="color:#666"><i>(rolled back — 0 active VQs)</i></span>` +
      (breadcrumbBuyerName ? `<br/><small style="color:#999">breadcrumb had: ${esc(breadcrumbBuyerName)}</small>` : '');
  } else if (wasPatched) {
    buyerDisplay = `<b>${esc(currentBuyerName)}</b><br/><small style="color:#888">patched (was ${esc(breadcrumbBuyerName)})</small>`;
  } else if (!b.buyerId) {
    buyerDisplay = '<i style="color:#999">(escalated)</i>';
  } else if (isKnownSupport(b.buyerId)) {
    buyerDisplay = `<span style="color:#b00">⚠️ ${esc(currentBuyerName)}</span><br/><small style="color:#b00">support — mis-attributed (needs patch)</small>`;
  } else if (isKnownBuyer(b.buyerId)) {
    buyerDisplay = esc(currentBuyerName);
  } else {
    buyerDisplay = `<span style="color:#b80">${esc(currentBuyerName)}</span><br/><small style="color:#b80">untagged — add to registry?</small>`;
  }

  const rfqList = [...new Set(b.rfqs.map(r => r.rfq))].join(', ');
  const outstanding = [];
  if (rolledBack) outstanding.push(`Batch was rolled back — 0 active VQs in OT despite ${b.attributedTotal} written from this batch (attribution log)`);
  if (b.deactivatedAfterLoad > 0 && !rolledBack) outstanding.push(`${b.deactivatedAfterLoad} of ${b.attributedTotal} VQs from this batch later deactivated in OT (post-load patch?)`);
  if (b.silentLoss > 0) outstanding.push(`Silent loss: agent claimed ${b.claimedWritten} writes but attribution log has only ${b.attributedTotal} (Δ ${b.silentLoss})`);
  if (!rolledBack && b.buyerId && isKnownSupport(b.buyerId)) outstanding.push(`Buyer is a support user (${esc(currentBuyerName)}) — needs operator patch`);
  if (b.failedCount > 0) outstanding.push(`${b.failedCount} hard failure(s) (e.g., Chuboe_VendorType null) — see breadcrumbs`);
  if (outstanding.length === 0) outstanding.push('None');
  // VQs column: show "active / claimed" when they differ, else just the number.
  const vqsCell = b.attributedTotal !== b.activeInOt
    ? `<b>${b.activeInOt}</b> <small style="color:#666">of ${b.attributedTotal} written</small>`
    : `<b>${b.activeInOt}</b>`;
  return `<tr>
<td>${i + 1}</td>
<td>${vqsCell}</td>
<td>${esc(b.outerFrom)}</td>
<td>${buyerDisplay}</td>
<td>${esc(rfqList)}</td>
<td>"${esc(b.subject)}"<br/><small>${esc(b.emailDate ? b.emailDate.slice(0, 10) : '')}</small></td>
<td>${outstanding.join('<br/>')}</td>
</tr>`;
}).join('\n')}
</tbody>
</table>
<p style="color:#666;font-size:11px;margin-top:4px"><i>"VQs (active / written)" reconciles against <code>~/workspace/.vq-batch-attribution.jsonl</code>: each successful VQ write tags its vqLineId to the source email's UID, so the digest queries OT for is_active=Y on this batch's specific vqLineIds — precise per-batch reconciliation regardless of other loaders hitting the same RFQs. "Active" can be less than "written" if rows were patched/deactivated post-load.</i></p>`;
  } else {
    html += `<p style="color:#999"><i>No vq-loading-agent batches processed in this window.</i></p>`;
  }

  if (escalated.length > 0) {
    html += `<h3 style="margin-bottom:4px;color:#b00">Escalations</h3><ul>`;
    for (const e of escalated) {
      html += `<li><b>UID ${esc(e.uid)}</b> — ${esc(e.event)}: ${esc(e.reason || '(no reason)')}<br/><small>subject: ${esc(e.subject || '?')}</small></li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="color:#999;font-size:11px;margin-top:16px;border-top:1px solid #eee;padding-top:8px">
Generated by vq-loading-daily-digest.js · Scheduled daily 8am EST.<br/>
Window: ${esc(dispWindow)} (CT-naive per chuboe_*.created convention).<br/>
Top-section "Active in OT (since window)" only counts rows created in this window — pre-existing prior loads excluded.
</p></body></html>`;

  if (!SEND) {
    console.log('--- HTML preview ---');
    console.log(html);
    console.log('\n--- Summary ---');
    console.log(`Activity rows: ${activityShown.length} · Total VQs: ${totalAll}`);
    console.log(`Batches: ${batches.length} · Escalations: ${escalated.length}`);
    console.log('(Preview only — pass --send to email)');
    return;
  }

  const notifier = createNotifier({
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'VQ Loading — Daily Digest',
  });
  const today = new Date().toISOString().slice(0, 10);
  await notifier.sendEmail(
    RECIPIENT,
    `VQ Loading — Daily Digest (${today})`,
    html,
    { html: true },
  );
  console.log(`Sent to ${RECIPIENT}`);
  console.log(`Activity: ${activityShown.map(a => `${a.loader.replace(/Claude as /, 'C-')}=${a.vqs}`).join(' / ')} · ${batches.length} batch(es)`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
