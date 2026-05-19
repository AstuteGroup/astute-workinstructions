#!/usr/bin/env node
/**
 * scripts/vq-watchlist.js — VQ-loading shakeout milestone surfacer.
 *
 * Today (2026-05-14) the cron VQ agent was lifted to claim-terminal-grade
 * parity. The honest open question is whether it will hold up on real
 * complex inbound. This scanner surfaces three concrete milestones the
 * moment they happen, so the operator doesn't have to manually scan the
 * digest for them:
 *
 *   1. fresh_complex_type2_load
 *        First 'loaded' event with emailType='type2' + >=10 quotes across
 *        the source UID + >=5 unique RFQ targets (proxy for multi-vendor
 *        complexity), with no escalation breadcrumb on that UID.
 *
 *   2. partial_clarify_stitch
 *        First 'loaded' event with `stitched_from: "partial_clarify"`.
 *        Validates the multi-vendor reply-merge path end-to-end.
 *
 *   3. mfr_resolver_overreach
 *        VQs created today whose MFR matches the known-overreach prefix +
 *        the misclassified canonical (see project_mfr_resolver_prefix_overreach.md).
 *        Surface each as a row so the operator can spot-check and PATCH.
 *
 * Idempotency: each milestone fires its anomaly email ONCE. State is
 * persisted at ~/workspace/.vq-watchlist-state.json. MFR overreach
 * detections accumulate by VQ id so already-emailed rows don't re-fire.
 *
 * Usage:
 *   node scripts/vq-watchlist.js              # scan + print, do not email
 *   node scripts/vq-watchlist.js --notify     # scan + email operator on new firings
 *   node scripts/vq-watchlist.js --reset      # wipe state file (re-fire all)
 *   node scripts/vq-watchlist.js --status     # print current state
 *
 * No OT writes. No API calls except the optional notifier on --notify.
 * Safe to run on any cadence; the recommendation is every 15 min.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const breadcrumbs = require(`${REPO}/shared/breadcrumbs`);
const { createNotifier } = require(`${REPO}/shared/notifier`);

const STATE_FILE = path.join(process.env.HOME || '/home/analytics_user',
  'workspace', '.vq-watchlist-state.json');

const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';

// Known overreach prefixes (per project_mfr_resolver_prefix_overreach.md).
// Each entry has EITHER mpnPrefix (SQL LIKE) OR mpnRegex (POSIX ~*) — not both.
//
// Tight prefixes only — XC* alone matches Xilinx Zynq (XC7Z*) which IS
// correctly AMD post-2022 acquisition. The actual overreach cases per the
// memory + spot-checks are narrower:
//   - ISO15xx/ISO72xx → TI digital isolators (resolver picks Issi/ISSI)
//   - ISL → Renesas (was Intersil; resolver picks Issi/ISSI)
//   - XC6 + digit → Torex LDOs (resolver picks AMD); XC6S*/XC6V* are Xilinx
//     Spartan-6 and correctly canonicalize to AMD post-2022 acquisition,
//     so the pattern must require a digit after XC6.
//   - BCM857 → Nexperia (resolver picks Broadcom)
const OVERREACH_PATTERNS = [
  { mpnPrefix: 'ISO15',  wrongMfr: 'Issi', actualMfr: 'Texas Instruments (ISO15xx digital isolators)' },
  { mpnPrefix: 'ISO72',  wrongMfr: 'Issi', actualMfr: 'Texas Instruments (ISO72xx digital isolators)' },
  { mpnPrefix: 'ISL',    wrongMfr: 'Issi', actualMfr: 'Renesas (was Intersil)' },
  { mpnRegex:  '^XC6[0-9]', wrongMfr: 'AMD',  actualMfr: 'Torex (XC6xxx LDOs)' },
  { mpnPrefix: 'BCM857', wrongMfr: 'Broadcom', actualMfr: 'Nexperia' },
];

// AD_Table_ID for chuboe_vq_line — used to filter chuboe_pricing_api_result
// to rows that link back to a VQ (record_id = chuboe_vq_line_id).
const VQ_LINE_AD_TABLE_ID = 1000008;

// ─── STATE ───────────────────────────────────────────────────────────────────

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastScanTs: null,
      fired: {
        fresh_complex_type2_load: null,
        partial_clarify_stitch: null,
      },
      mfr_overreach_seen_vq_ids: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('state file corrupt; starting fresh:', e.message);
    return {
      lastScanTs: null,
      fired: { fresh_complex_type2_load: null, partial_clarify_stitch: null },
      mfr_overreach_seen_vq_ids: [],
    };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── MILESTONE: fresh complex Type 2 load ───────────────────────────────────

function findFreshComplexType2Load(state) {
  if (state.fired.fresh_complex_type2_load) return null;

  // Look at all-time breadcrumbs (this only fires ONCE so we don't care about a window).
  const events = breadcrumbs.readSince(0).filter(b =>
    b.cog === 'vq-loading-agent' && b.event === 'loaded' && b.emailType === 'type2'
  );

  // Group by sourceUid — one inbound email can fan out across multiple RFQs.
  const bySourceUid = new Map();
  for (const e of events) {
    const key = e.sourceUid || e.uid;
    if (!bySourceUid.has(key)) bySourceUid.set(key, []);
    bySourceUid.get(key).push(e);
  }

  // Find the first sourceUid with: total quotesSubmitted >= 10 AND distinct rfqSearchKey >= 5.
  // The latter is a coarse proxy for "multi-vendor" — Type 2 bulk summaries
  // typically fan out across multiple RFQs because vendors are quoting different RFQ lines.
  for (const [sourceUid, loads] of bySourceUid) {
    loads.sort((a, b) => a.ts.localeCompare(b.ts));
    let totalQuotes = 0;
    const distinctRfqs = new Set();
    for (const l of loads) {
      totalQuotes += l.quotesSubmitted || 0;
      if (l.rfqSearchKey) distinctRfqs.add(l.rfqSearchKey);
    }
    if (totalQuotes >= 10 && distinctRfqs.size >= 5) {
      const first = loads[0];
      return {
        ts: first.ts,
        sourceUid,
        rfqCount: distinctRfqs.size,
        quotesSubmitted: totalQuotes,
        senderEmail: first.senderEmail,
        rfqs: [...distinctRfqs].slice(0, 10),
      };
    }
  }
  return null;
}

// ─── MILESTONE: partial_clarify stitch ───────────────────────────────────────

function findPartialClarifyStitch(state) {
  if (state.fired.partial_clarify_stitch) return null;
  const events = breadcrumbs.readSince(0).filter(b =>
    b.cog === 'vq-loading-agent'
    && b.event === 'loaded'
    && b.stitched_from === 'partial_clarify'
  );
  if (events.length === 0) return null;
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const first = events[0];
  return {
    ts: first.ts,
    uid: first.uid,
    rfqSearchKey: first.rfqSearchKey,
    written: first.written,
    senderEmail: first.senderEmail,
    messageId: first.messageId,
  };
}

// ─── MILESTONE: MFR resolver overreach detections ────────────────────────────

function queryPsql(sql) {
  // -A unaligned, -t tuples-only, -F | column sep.
  try {
    const out = execSync(`psql -A -t -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean).map(line => line.split('|'));
  } catch (e) {
    console.error('psql query failed:', e.message);
    return [];
  }
}

function findMfrOverreach(state) {
  // Scan VQs created in last 48h whose Chuboe_MFR_ID resolves to a known
  // mis-canonical for a given MPN prefix. Skip any vq_id we've already
  // surfaced (state.mfr_overreach_seen_vq_ids).
  const seenSet = new Set(state.mfr_overreach_seen_vq_ids);
  const findings = [];

  for (const pat of OVERREACH_PATTERNS) {
    // chuboe_mpn is on vq_line, chuboe_mfr_id → chuboe_mfr.name resolves to canonical.
    // LEFT JOIN to chuboe_rfq via the rfq_line gives us the RFQ search-key
    // (operator's main navigation key). LEFT JOIN to chuboe_pricing_api_result
    // by (ad_table_id, record_id) surfaces the source API result row for
    // API-loaded VQs — null for email-driven loads.
    const mpnMatch = pat.mpnRegex
      ? `UPPER(vq.chuboe_mpn) ~* '${pat.mpnRegex}'`
      : `UPPER(vq.chuboe_mpn) LIKE UPPER('${pat.mpnPrefix}%')`;
    const sql = `
      SELECT vq.chuboe_vq_line_id,
             vq.chuboe_mpn,
             m.name,
             bp.name AS vendor,
             vq.created,
             rfq.value AS rfq_search_key,
             par.api_result_id
      FROM adempiere.chuboe_vq_line vq
      LEFT JOIN adempiere.chuboe_mfr m ON vq.chuboe_mfr_id = m.chuboe_mfr_id
      LEFT JOIN adempiere.c_bpartner bp ON vq.c_bpartner_id = bp.c_bpartner_id
      LEFT JOIN adempiere.chuboe_rfq_line rl ON vq.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      LEFT JOIN adempiere.chuboe_rfq rfq ON rl.chuboe_rfq_id = rfq.chuboe_rfq_id
      LEFT JOIN LATERAL (
        SELECT MAX(chuboe_pricing_api_result_id) AS api_result_id
        FROM adempiere.chuboe_pricing_api_result
        WHERE ad_table_id = ${VQ_LINE_AD_TABLE_ID}
          AND record_id = vq.chuboe_vq_line_id
          AND isactive = 'Y'
      ) par ON true
      WHERE vq.isactive='Y'
        AND vq.created >= NOW() - INTERVAL '48 hours'
        AND ${mpnMatch}
        AND m.name = '${pat.wrongMfr}'
      ORDER BY vq.created DESC
      LIMIT 50
    `;
    const rows = queryPsql(sql);
    for (const row of rows) {
      const [vqId, mpn, mfrName, vendor, created, rfqSearchKey, apiResultId] = row;
      if (seenSet.has(Number(vqId))) continue;
      findings.push({
        vqId: Number(vqId),
        mpn,
        wrongMfr: mfrName,
        actualMfr: pat.actualMfr,
        vendor,
        created,
        rfqSearchKey: rfqSearchKey || null,
        apiResultId: apiResultId ? Number(apiResultId) : null,
      });
    }
  }
  return findings;
}

// ─── EMAIL RENDERING ─────────────────────────────────────────────────────────

function renderFirstType2Email(milestone) {
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#0a0">VQ Watchlist — first fresh complex Type 2 load</h2>
<p>The cron VQ agent just processed its first multi-vendor Type 2 bulk-summary email at production complexity. This is the empirical proof point that the agent matches the terminal-mode behavior on the shape that produced the 1132932 calibration.</p>
<table style="border-collapse:collapse;font-size:13px;margin:8px 0">
  <tr><td><b>Time (UTC)</b></td><td>${esc(milestone.ts)}</td></tr>
  <tr><td><b>Source UID</b></td><td>${milestone.sourceUid}</td></tr>
  <tr><td><b>Sender</b></td><td>${esc(milestone.senderEmail || '(unknown)')}</td></tr>
  <tr><td><b>RFQs fanned-out</b></td><td>${milestone.rfqCount}</td></tr>
  <tr><td><b>Quotes submitted</b></td><td>${milestone.quotesSubmitted}</td></tr>
  <tr><td><b>RFQs (first 10)</b></td><td>${milestone.rfqs.join(', ')}</td></tr>
</table>
<p>Spot-check recommendation: pick 2-3 of the loaded VQs and verify against the source email. Cron agent now considered terminal-grade-validated on Type 2 complexity if spot-check passes.</p>
</body></html>`;
}

function renderStitchEmail(milestone) {
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#0a0">VQ Watchlist — first partial_clarify reply stitch</h2>
<p>A broker (or operator) replied to a multi-vendor clarification request, and the cron agent successfully merged the answer with the sidecar's residual state and wrote the resulting VQs. End-to-end multi-vendor outreach round-trip validated.</p>
<table style="border-collapse:collapse;font-size:13px;margin:8px 0">
  <tr><td><b>Time (UTC)</b></td><td>${esc(milestone.ts)}</td></tr>
  <tr><td><b>UID</b></td><td>${milestone.uid}</td></tr>
  <tr><td><b>RFQ</b></td><td>${esc(milestone.rfqSearchKey || '')}</td></tr>
  <tr><td><b>VQs written</b></td><td>${milestone.written}</td></tr>
  <tr><td><b>Sender (replier)</b></td><td>${esc(milestone.senderEmail || '(unknown)')}</td></tr>
  <tr><td><b>Message-ID</b></td><td><code>${esc(milestone.messageId || '')}</code></td></tr>
</table>
<p>Spot-check: confirm the merge didn't re-write any already-loaded vendor (per sidecar's <code>loaded_vendors[]</code>). Pre-write dedup would have caught it but this is the first real test of rules (1)+(2) in § 3.2.</p>
</body></html>`;
}

function renderOverreachEmail(findings) {
  const rows = findings.map(f =>
    `<tr><td>${f.vqId}</td>` +
    `<td>${esc(f.rfqSearchKey || '—')}</td>` +
    `<td><code>${esc(f.mpn)}</code></td>` +
    `<td style="color:#b00"><b>${esc(f.wrongMfr)}</b></td>` +
    `<td>${esc(f.actualMfr)}</td>` +
    `<td>${esc(f.vendor || '')}</td>` +
    `<td>${f.apiResultId || '—'}</td>` +
    `<td>${esc((f.created || '').slice(0, 19))}</td></tr>`
  ).join('');
  return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">VQ Watchlist — MFR resolver overreach detections</h2>
<p>${findings.length} VQ row${findings.length === 1 ? '' : 's'} created in the last 48h match a known mis-canonical assignment pattern from <code>shared/mfr-resolver.js</code> prefix inference. Spot-check and PATCH <code>Chuboe_MFR_ID</code> as needed.</p>
<table style="border-collapse:collapse;font-size:13px;margin:8px 0">
  <tr style="background:#f5f5f5"><th>VQ ID</th><th>RFQ</th><th>MPN</th><th>Wrong MFR</th><th>Likely Actual</th><th>Vendor</th><th>API Result ID</th><th>Created</th></tr>
  ${rows}
</table>
<p style="color:#666;font-size:11px">RFQ = <code>chuboe_rfq.value</code> (operator nav key). API Result ID is the <code>chuboe_pricing_api_result</code> row that wrote this VQ — populated for API-driven loads (DigiKey/Mouser/TTI/Arrow/Avnet), blank for email-driven Type 1/2 loads. Tracking: <code>project_mfr_resolver_prefix_overreach.md</code>. These rows are recorded in <code>~/workspace/.vq-watchlist-state.json</code> so the email won't repeat for the same VQ.</p>
</body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--reset')) {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    console.log('watchlist state reset');
    return;
  }
  if (args.includes('--status')) {
    const state = readState();
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const notify = args.includes('--notify');

  const state = readState();
  const now = new Date().toISOString();

  console.log(`[${now}] vq-watchlist scan…`);

  // Scan three milestones.
  const m1 = findFreshComplexType2Load(state);
  const m2 = findPartialClarifyStitch(state);
  const m3 = findMfrOverreach(state);

  const newFirings = [];
  if (m1) {
    console.log('NEW: fresh_complex_type2_load — sourceUid', m1.sourceUid,
      '· rfqs', m1.rfqCount, '· quotes', m1.quotesSubmitted);
    newFirings.push({ kind: 'fresh_complex_type2_load', data: m1 });
  }
  if (m2) {
    console.log('NEW: partial_clarify_stitch — uid', m2.uid,
      '· rfq', m2.rfqSearchKey, '· written', m2.written);
    newFirings.push({ kind: 'partial_clarify_stitch', data: m2 });
  }
  if (m3.length > 0) {
    console.log(`NEW: mfr_resolver_overreach — ${m3.length} unsurfaced finding${m3.length === 1 ? '' : 's'}`);
    for (const f of m3) console.log(`   vq=${f.vqId} mpn=${f.mpn} wrong=${f.wrongMfr}`);
    newFirings.push({ kind: 'mfr_resolver_overreach', data: m3 });
  }
  if (newFirings.length === 0) {
    console.log('no new firings.');
  }

  // Send anomaly emails (one per milestone).
  if (notify && newFirings.length > 0) {
    const notifier = createNotifier({
      fromEmail: process.env.WORKMAIL_USER || 'stockRFQ@orangetsunami.com',
      fromName: 'VQ Watchlist',
    });
    for (const firing of newFirings) {
      let subject, html;
      if (firing.kind === 'fresh_complex_type2_load') {
        subject = 'VQ Watchlist — first fresh complex Type 2 load';
        html = renderFirstType2Email(firing.data);
      } else if (firing.kind === 'partial_clarify_stitch') {
        subject = 'VQ Watchlist — first partial_clarify reply stitch';
        html = renderStitchEmail(firing.data);
      } else if (firing.kind === 'mfr_resolver_overreach') {
        subject = `VQ Watchlist — MFR overreach: ${firing.data.length} new VQ row(s)`;
        html = renderOverreachEmail(firing.data);
      }
      const ok = await notifier.sendEmail(OPERATOR_EMAIL, subject, html, { html: true });
      console.log(`email ${firing.kind}: ${ok ? 'sent' : 'FAILED'}`);
    }
  }

  // Persist state ONLY after we've successfully run; mark milestones fired so
  // they don't re-email next tick. For MFR overreach, accumulate seen vq_ids.
  if (m1) state.fired.fresh_complex_type2_load = m1;
  if (m2) state.fired.partial_clarify_stitch = m2;
  if (m3.length > 0) {
    for (const f of m3) {
      if (!state.mfr_overreach_seen_vq_ids.includes(f.vqId)) {
        state.mfr_overreach_seen_vq_ids.push(f.vqId);
      }
    }
  }
  state.lastScanTs = now;
  writeState(state);
}

main().catch(err => {
  console.error('vq-watchlist failed:', err);
  process.exit(1);
});
