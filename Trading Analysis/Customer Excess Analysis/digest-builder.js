#!/usr/bin/env node
/**
 * digest-builder.js — operator digest cog (cog 7).
 *
 * Reads breadcrumbs since the last digest send and emails Jake a 4-section
 * summary:
 *
 *   1. What got written        — every offer loaded since last digest
 *   2. Which path + why        — type-router decisions (offer → route + rule)
 *   3. Drill-down candidates   — V1 placeholder; HOT/WARM lines once analysis ships
 *   4. Exceptions              — NeedsReview / NeedsPartner / write-failed / partial / unrouted
 *
 * Schedule: 7am / 12pm / 4pm EDT (11/16/20 UTC) — registered in cron-jobs.js.
 *
 * Empty-window behavior: still sends a one-line "no activity" digest so the
 * operator knows the system fired. Silence is ambiguous; explicit zero is not.
 *
 * USAGE:
 *   node digest-builder.js               # send digest for current window
 *   node digest-builder.js --dry-run     # render but don't send (prints HTML to stdout)
 *   node digest-builder.js --since-hours 24   # explicit window override
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const fs = require('fs');
const breadcrumbs = require('../../shared/breadcrumbs');
const { sendWithFallback } = require('../../shared/verified-send');
const { createFetcher } = require('../../shared/email-fetcher');
const { psqlQuery } = require('../../shared/db-helpers');

const STATE_DIR = path.join(process.env.HOME || '/home/analytics_user', 'workspace', '.offer-pipeline');
const STATE_FILE = path.join(STATE_DIR, 'last-digest.json');

const SENDER = 'excess@orangetsunami.com';
const FALLBACK = process.env.EXCESS_FALLBACK_SENDER || 'stockRFQ@orangetsunami.com';
const RECIPIENT = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';

// ── State tracking (last digest send time) ────────────────────────────────

function loadLastDigest() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return null; }
}

function saveLastDigest(state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Formatting helpers ────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // Format as YYYY-MM-DD HH:MM UTC for unambiguous timestamps in the email
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtQty(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString('en-US');
}

// ── Breadcrumb enrichment (BP names + offer-type labels) ──────────────────
//
// Two breadcrumb writers emit `cog: 'offer-poller', event: 'loaded'`:
//   - shared/offer-poller.js (static poller, verbose format with partner.name,
//     account, subject, source, offerType-label, lineCount)
//   - shared/workflow-actions/excess.js (excess agent, compact format —
//     bpartnerId + offerType-id + linesWritten, no partner.name or labels)
//
// The renderer can't tell them apart by event-type, so we enrich any crumb
// that's missing partner.name / offerType-label via a single SQL lookup.
// Mutates crumbs in place; safe to call multiple times (no-op when enriched).

async function enrichLoadedCrumbs(crumbs) {
  // Backfill partner.name on any crumb that has a bpartnerId/partner.id but
  // no partner.name. Covers offer-poller (Section 1), stockrfq-agent
  // (Section 4), and offer-router (Section 3) — all render a partner column.
  const needsLookup = crumbs.filter(c => {
    if (c.partner && c.partner.name) return false;
    const id = c.bpartnerId || (c.partner && c.partner.id);
    return id && (
      (c.cog === 'offer-poller'   && c.event === 'loaded') ||
      (c.cog === 'stockrfq-agent' && c.event === 'loaded') ||
      (c.cog === 'offer-router')
    );
  });
  const bpIds = [...new Set(needsLookup.map(c => Number(c.bpartnerId || (c.partner && c.partner.id))).filter(Boolean))];

  const typeIdsNeeded = [...new Set(
    crumbs
      .filter(c => c.cog === 'offer-poller' && c.event === 'loaded')
      .map(c => Number(c.offerType))
      .filter(n => Number.isFinite(n))   // compact form stores numeric type-id
  )];

  let bpMap = new Map();
  if (bpIds.length > 0) {
    try {
      const out = psqlQuery(
        `SELECT c_bpartner_id, name FROM adempiere.c_bpartner WHERE c_bpartner_id IN (${bpIds.join(',')})`
      );
      for (const line of out.split('\n').filter(Boolean)) {
        const [id, name] = line.split('|');
        bpMap.set(Number(id), name);
      }
    } catch (e) {
      console.error('enrichLoadedCrumbs: BP lookup failed:', e.message);
    }
  }

  let typeMap = new Map();
  if (typeIdsNeeded.length > 0) {
    try {
      const out = psqlQuery(
        `SELECT chuboe_offer_type_id, name FROM adempiere.chuboe_offer_type WHERE chuboe_offer_type_id IN (${typeIdsNeeded.join(',')})`
      );
      for (const line of out.split('\n').filter(Boolean)) {
        const [id, name] = line.split('|');
        typeMap.set(Number(id), name);
      }
    } catch (e) {
      console.error('enrichLoadedCrumbs: offer-type lookup failed:', e.message);
    }
  }

  for (const c of crumbs) {
    const isOfferLoaded  = c.cog === 'offer-poller' && c.event === 'loaded';
    const isStockLoaded  = c.cog === 'stockrfq-agent' && c.event === 'loaded';
    const isOfferRouter  = c.cog === 'offer-router';
    if (!isOfferLoaded && !isStockLoaded && !isOfferRouter) continue;
    // Backfill partner.name from bpartnerId (DB lookup) OR customerName
    // (agent-parsed string preserved on the crumb — used for Unqualified
    // Broker fallback where the DB name is generic but the agent knew the
    // real broker, e.g. "JSD Electronics" vs "Unqualified Broker").
    const partnerId = c.bpartnerId || (c.partner && c.partner.id);
    if (!(c.partner && c.partner.name) && partnerId) {
      const dbName = bpMap.get(Number(partnerId));
      const UNQUALIFIED_BROKER_ID = 1006505;
      const preferAgentParsed = Number(partnerId) === UNQUALIFIED_BROKER_ID && c.customerName;
      const name = preferAgentParsed ? c.customerName : (dbName || c.customerName || '');
      c.partner = c.partner || {};
      c.partner.id = c.partner.id || partnerId;
      c.partner.name = name;
    }
    // Backfill offerTypeLabel when offerType is a numeric id
    if (Number.isFinite(Number(c.offerType))) {
      c.offerTypeLabel = typeMap.get(Number(c.offerType)) || `Type ${c.offerType}`;
    } else if (typeof c.offerType === 'string' && c.offerType.length > 0) {
      c.offerTypeLabel = c.offerType;
    }
    // Compact form uses linesWritten; verbose form uses lineCount. Unify.
    if (c.lineCount == null && c.linesWritten != null) c.lineCount = c.linesWritten;
  }
}

// ── Section builders ──────────────────────────────────────────────────────

const SECTION_HEADER = `style="background:#2c3e50;color:#fff;padding:10px 14px;margin:24px 0 0 0;font-size:14px;font-weight:bold"`;
const TABLE_STYLE = `cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:12px;width:100%;font-family:Arial,sans-serif"`;
const TH_STYLE = `style="background:#ecf0f1;text-align:left;padding:6px"`;

function buildSection1Loaded(crumbs) {
  const loaded = crumbs.filter(c => c.cog === 'offer-poller' && c.event === 'loaded');
  if (loaded.length === 0) {
    return { html: `<p style="color:#666">No new offers written in this window.</p>`, count: 0 };
  }
  const rows = loaded.map(c => {
    const partnerName = (c.partner && c.partner.name) || '';
    const partnerId   = (c.partner && c.partner.id) || c.bpartnerId || '';
    const partnerCell = partnerName
      ? `${escapeHtml(partnerName)} <span style="color:#888;font-size:11px">(BP ${escapeHtml(partnerId)})</span>`
      : `<span style="color:#c0392b">(unresolved)</span> <span style="color:#888;font-size:11px">BP ${escapeHtml(partnerId)}</span>`;
    const typeLabel   = c.offerTypeLabel || c.offerType || '';
    const account     = c.account || (c.uid != null ? 'excess' : ''); // compact crumbs from excess.js have uid; account field absent
    return `
    <tr>
      <td>${escapeHtml(fmtTime(c.ts))}</td>
      <td>${escapeHtml(account)}</td>
      <td><b>${escapeHtml(c.searchKey || '')}</b></td>
      <td>${partnerCell}</td>
      <td>${escapeHtml(typeLabel)}</td>
      <td style="text-align:right">${fmtQty(c.lineCount)}</td>
      <td>${escapeHtml(c.source || c.subject || '')}</td>
    </tr>`;
  }).join('');
  return {
    html: `<table ${TABLE_STYLE}>
      <tr><th ${TH_STYLE}>Loaded At</th><th ${TH_STYLE}>Inbox</th><th ${TH_STYLE}>Search Key</th><th ${TH_STYLE}>Partner</th><th ${TH_STYLE}>Type</th><th ${TH_STYLE}>Lines</th><th ${TH_STYLE}>Extracted From / Subject</th></tr>
      ${rows}
    </table>`,
    count: loaded.length,
  };
}

function buildSection2Routing(crumbs) {
  const routed = crumbs.filter(c => c.cog === 'offer-router' && (c.event === 'routed' || c.event === 'unrouted'));
  if (routed.length === 0) {
    return { html: `<p style="color:#666">No routing decisions in this window.</p>`, count: 0 };
  }
  const rows = routed.map(c => {
    const partnerName = (c.partner && c.partner.name) || '';
    const partnerId   = (c.partner && c.partner.id) || '';
    const partnerCell = partnerName
      ? `${escapeHtml(partnerName)} <span style="color:#888;font-size:11px">(BP ${escapeHtml(partnerId)})</span>`
      : (partnerId
          ? `<span style="color:#c0392b">(unresolved)</span> <span style="color:#888;font-size:11px">BP ${escapeHtml(partnerId)}</span>`
          : `<span style="color:#888">—</span>`);
    return `
    <tr>
      <td>${escapeHtml(fmtTime(c.ts))}</td>
      <td><b>${escapeHtml(c.searchKey || '')}</b></td>
      <td>${partnerCell}</td>
      <td>${escapeHtml(c.offerType || '')}</td>
      <td>${c.event === 'unrouted' ? '<span style="color:#c0392b">UNROUTED</span>' : escapeHtml(c.route || '')}</td>
      <td>${escapeHtml(c.rule || c.reason || '')}</td>
    </tr>`;
  }).join('');
  return {
    html: `<table ${TABLE_STYLE}>
      <tr><th ${TH_STYLE}>Decided At</th><th ${TH_STYLE}>Search Key</th><th ${TH_STYLE}>Partner</th><th ${TH_STYLE}>Type</th><th ${TH_STYLE}>Route</th><th ${TH_STYLE}>Rule / Reason</th></tr>
      ${rows}
    </table>`,
    count: routed.length,
  };
}

function buildSection3DrillDown(crumbs) {
  // V1 placeholder: count what was queued for analysis vs data-captured.
  // When real analysis ships, this becomes a per-line opportunity table sourced
  // from analysis breadcrumbs (HOT/WARM tier).
  const queued = crumbs.filter(c => c.cog === 'customer-excess-analysis' && c.event === 'queued');
  const brokerCaptured = crumbs.filter(c => c.cog === 'broker-data-capture' && c.event === 'captured');
  const franchiseCaptured = crumbs.filter(c => c.cog === 'franchise-data-capture' && c.event === 'captured');

  const total = queued.length + brokerCaptured.length + franchiseCaptured.length;
  if (total === 0) {
    return { html: `<p style="color:#666">No offers reached downstream cogs in this window.</p>`, count: 0 };
  }

  const queuedList = queued.length === 0 ? '' : `
    <p><b>${queued.length}</b> Customer Excess offer${queued.length === 1 ? '' : 's'} queued for analysis:</p>
    <ul>${queued.map(c => `<li>${escapeHtml(c.searchKey || c.offerId)}</li>`).join('')}</ul>`;
  const brokerList = brokerCaptured.length === 0 ? '' : `
    <p><b>${brokerCaptured.length}</b> Broker Stock offer${brokerCaptured.length === 1 ? '' : 's'} captured (data only):</p>
    <ul>${brokerCaptured.map(c => `<li>${escapeHtml(c.searchKey || c.offerId)}</li>`).join('')}</ul>`;
  const franchiseList = franchiseCaptured.length === 0 ? '' : `
    <p><b>${franchiseCaptured.length}</b> Franchise offer${franchiseCaptured.length === 1 ? '' : 's'} captured (data only):</p>
    <ul>${franchiseCaptured.map(c => `<li>${escapeHtml(c.searchKey || c.offerId)}</li>`).join('')}</ul>`;
  return {
    html: `<p style="background:#fef9e7;padding:8px;border-left:4px solid #f1c40f;color:#5d4e1d">
      <b>V1 stub:</b> Customer Excess Analysis (intent classifier + scoring + per-line drill-down) is still being built. Once live, this section will list HOT/WARM tier opportunities with MPN, partner, score, and franchise/RFQ context.
    </p>
    ${queuedList}
    ${brokerList}
    ${franchiseList}`,
    count: total,
  };
}

// Section 4 = the operator's open action queue.
// Sources, in order:
//   (a) Live IMAP envelopes in NeedsReview  → persistent until operator acts
//   (b) Live IMAP envelopes in NeedsPartner → persistent until operator acts
//   (c) Window-scoped events that don't have a folder counterpart
//       (write-failed, partial-write, unrouted, router-failed, connect-failed,
//        unrecognized-reply) — these self-heal or only need a one-shot ack,
//       so window-scoping is correct for them.
//
// Per operator directive 2026-05-05: items must carry forward across digests
// until they're actually resolved, not just until the next digest window opens.
//
// As of 2026-05-08 the queue spans BOTH the excess and stockrfq inboxes —
// pass `accounts: ['excess', 'stockrfq']` to scan both.
async function buildSection4OpenQueue(crumbs, { accounts = ['excess', 'stockrfq'] } = {}) {
  let needsReview = [];
  let needsPartner = [];
  let folderError = null;
  for (const account of accounts) {
    const fetcher = createFetcher(account);
    try {
      const envs = await fetcher.listEnvelopes('NeedsReview', 500);
      needsReview.push(...envs.map(e => ({ ...e, _account: account })));
    } catch (err) {
      folderError = (folderError ? folderError + '; ' : '') + `${account}/NeedsReview: ${err.message}`;
    }
    try {
      const envs = await fetcher.listEnvelopes('NeedsPartner', 500);
      needsPartner.push(...envs.map(e => ({ ...e, _account: account })));
    } catch (err) {
      // NeedsPartner only exists for excess; stockrfq's miss here is expected
      if (account !== 'stockrfq') {
        folderError = (folderError ? folderError + '; ' : '') + `${account}/NeedsPartner: ${err.message}`;
      }
    }
  }

  const windowEvents = crumbs.filter(c =>
    (c.cog === 'offer-poller' && (
      c.event === 'write-failed' ||
      c.event === 'partial-write' ||
      c.event === 'unexpected-error' ||
      c.event === 'connect-failed'
    ))
    || (c.cog === 'offer-router' && (c.event === 'unrouted' || c.event === 'router-failed'))
    || (c.cog === 'reply-parser' && c.event === 'unrecognized-reply')
  );

  const rows = [];

  // (a) NeedsReview — oldest first so chronic items rise to the top of the table
  for (const env of [...needsReview].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))) {
    const id = env.id;
    const fromStr = env.from && env.from.addr ? env.from.addr : '';
    const subj = env.subject || '';
    const action = `Reply: <code>LINES: ${id}</code> + paste table — or <code>IGNORE: ${id}</code> if junk`;
    rows.push(`
      <tr>
        <td style="white-space:nowrap">${escapeHtml(fmtTime(env.date))}</td>
        <td>${escapeHtml(env._account || '')}</td>
        <td><b>UID ${escapeHtml(String(id))}</b></td>
        <td><b>needs-review</b></td>
        <td>NeedsReview</td>
        <td>${escapeHtml(fromStr)}</td>
        <td>${escapeHtml(subj)}</td>
        <td>${action}</td>
      </tr>`);
  }

  // (b) NeedsPartner — same sort
  for (const env of [...needsPartner].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))) {
    const id = env.id;
    const fromStr = env.from && env.from.addr ? env.from.addr : '';
    const subj = env.subject || '';
    const action = `Reply: <code>PARTNER: ${id} = &lt;BP id or company name&gt;</code>`;
    rows.push(`
      <tr>
        <td style="white-space:nowrap">${escapeHtml(fmtTime(env.date))}</td>
        <td>${escapeHtml(env._account || '')}</td>
        <td><b>UID ${escapeHtml(String(id))}</b></td>
        <td><b>needs-partner</b></td>
        <td>NeedsPartner</td>
        <td>${escapeHtml(fromStr)}</td>
        <td>${escapeHtml(subj)}</td>
        <td>${action}</td>
      </tr>`);
  }

  // (c) Window-scoped non-folder events
  for (const c of windowEvents) {
    const _accountForRow = c.cog === 'reply-parser' ? 'excess' : 'excess';
    let action = '';
    if (c.event === 'write-failed')          action = `Investigate writeOffer error; manual replay possible after fix`;
    else if (c.event === 'partial-write')    action = `Offer ${c.searchKey || ''} loaded with ${c.errorCount || ''} line errors; review NeedsReview`;
    else if (c.event === 'unrouted')         action = `Offer type "${c.offerType}" not in router map; add a route or update writer to use a known type`;
    else if (c.event === 'router-failed')    action = `Downstream cog threw on offer ${c.searchKey || ''}; check log`;
    else if (c.event === 'connect-failed')   action = `IMAP connect failed — check WORKMAIL_PASS and host`;
    else if (c.event === 'unexpected-error') action = `Unhandled exception on UID ${c.uid || ''}; moved to NeedsPartner for retry sweep`;
    else if (c.event === 'unrecognized-reply') action = `Reply to UID ${c.uid || ''} didn't match any directive — kickback email sent. May indicate a new directive shape we should add.`;

    const idCell = c.uid != null
      ? `<b>UID ${escapeHtml(String(c.uid))}</b>`
      : (c.searchKey
          ? `Offer <b>${escapeHtml(c.searchKey)}</b>`
          : (c.offerId ? `id ${escapeHtml(c.offerId)}` : ''));
    let folder = '';
    if (c.event === 'unexpected-error') folder = 'NeedsPartner';
    else if (c.event === 'partial-write' || c.event === 'write-failed') folder = 'NeedsReview';
    else if (c.event === 'unrecognized-reply') folder = 'INBOX (Seen)';

    const fromCell = c.outerFrom || c.fromAddr || c.from || '';
    const subjectCell = c.subject || '';
    const errorCell = c.error || '';

    rows.push(`
      <tr>
        <td style="white-space:nowrap">${escapeHtml(fmtTime(c.ts))}</td>
        <td>${escapeHtml(_accountForRow)}</td>
        <td>${idCell}</td>
        <td><b>${escapeHtml(c.event)}</b></td>
        <td>${escapeHtml(folder)}</td>
        <td>${escapeHtml(fromCell)}</td>
        <td>${escapeHtml(subjectCell)}${errorCell ? `<div style="color:#c0392b;font-family:monospace;font-size:11px;margin-top:4px">${escapeHtml(errorCell.slice(0, 200))}</div>` : ''}</td>
        <td>${action}</td>
      </tr>`);
  }

  const healthNote = folderError
    ? `<p style="color:#c0392b">⚠ Folder enumeration failed (${escapeHtml(folderError)}) — open queue may be incomplete; window-scoped events still shown below.</p>`
    : '';

  if (rows.length === 0) {
    return { html: `${healthNote}<p style="color:#27ae60">No open exceptions. ✓</p>`, count: 0, folderCount: needsReview.length + needsPartner.length };
  }

  return {
    html: `${healthNote}<table ${TABLE_STYLE}>
      <tr>
        <th ${TH_STYLE}>When (email date)</th>
        <th ${TH_STYLE}>Inbox</th>
        <th ${TH_STYLE}>Reference</th>
        <th ${TH_STYLE}>Event</th>
        <th ${TH_STYLE}>Folder</th>
        <th ${TH_STYLE}>From</th>
        <th ${TH_STYLE}>Subject / Error</th>
        <th ${TH_STYLE}>Action</th>
      </tr>
      ${rows.join('')}
    </table>
    <p style="color:#666;font-size:11px;margin-top:8px">
      <b>To reply:</b> use the UID in the Reference column — e.g., <code>PARTNER: 97 = ...</code> or <code>LINES: 97</code>.<br/>
      <b>To find manually:</b> open the listed Folder in the offer inbox (<code>excess@orangetsunami.com</code>), then match on the From + Subject columns.<br/>
      <b>Persistence:</b> NeedsReview / NeedsPartner items carry forward across digests until you act on them. Other event types are window-scoped (this digest only).
    </p>`,
    count: rows.length,
    folderCount: needsReview.length + needsPartner.length,
  };
}

// Section 5 = Stock RFQ activity in window (loaded via stockrfq-agent).
function buildSection5StockRFQ(crumbs) {
  const loaded = crumbs.filter(c => c.cog === 'stockrfq-agent' && c.event === 'loaded');
  const needsReview = crumbs.filter(c => c.cog === 'stockrfq-agent' && c.event === 'needs-review');
  const notRfq = crumbs.filter(c => c.cog === 'stockrfq-agent' && c.event === 'not-rfq');

  const total = loaded.length + needsReview.length + notRfq.length;
  if (total === 0) {
    return { html: `<p style="color:#666">No stockRFQ@ activity in this window.</p>`, count: 0 };
  }

  const summary = `<p>
    <b>${loaded.length}</b> RFQ${loaded.length === 1 ? '' : 's'} loaded ·
    <b>${needsReview.length}</b> needs-review ·
    <b>${notRfq.length}</b> not-rfq
  </p>`;

  if (loaded.length === 0) return { html: summary, count: total };

  const rows = loaded.map(c => {
    const partnerName = (c.partner && c.partner.name) || '';
    const partnerId   = (c.partner && c.partner.id) || c.bpartnerId || '';
    const customerCell = partnerName
      ? `${escapeHtml(partnerName)} <span style="color:#888;font-size:11px">(BP ${escapeHtml(partnerId)})</span>`
      : `<span style="color:#c0392b">(unresolved)</span> <span style="color:#888;font-size:11px">BP ${escapeHtml(partnerId)}</span>`;
    return `
    <tr>
      <td>${escapeHtml(fmtTime(c.ts))}</td>
      <td><b>${escapeHtml(c.searchKey || '')}</b></td>
      <td>${customerCell}</td>
      <td>${escapeHtml(c.type || 'Stock')}</td>
      <td style="text-align:right">${fmtQty(c.linesWritten)}</td>
      <td style="text-align:right;color:${c.errorCount ? '#c0392b' : '#27ae60'}">${fmtQty(c.errorCount || 0)}</td>
    </tr>`;
  }).join('');

  return {
    html: `${summary}
      <table ${TABLE_STYLE}>
        <tr><th ${TH_STYLE}>Loaded At</th><th ${TH_STYLE}>Search Key</th><th ${TH_STYLE}>Customer</th><th ${TH_STYLE}>Type</th><th ${TH_STYLE}>Lines Written</th><th ${TH_STYLE}>Errors</th></tr>
        ${rows}
      </table>`,
    count: total,
  };
}

// Section 6 = Cron job health in window (every job, success/failure/skip).
function buildSection6CronHealth(crumbs) {
  const events = crumbs.filter(c => c.cog === 'cron-runner');
  if (events.length === 0) {
    return {
      html: `<p style="color:#666">No cron events recorded yet (the cron-runner started writing breadcrumbs as of 2026-05-08; the first window after that change may be sparse).</p>`,
      count: 0,
    };
  }

  // Group by job name; for each, record success count, failure count, last event
  const byJob = new Map();
  for (const e of events) {
    const name = e.job || '(unknown)';
    if (!byJob.has(name)) byJob.set(name, { name, success: 0, failure: 0, skipNotDue: 0, skipOtDown: 0, last: null, lastFailure: null });
    const j = byJob.get(name);
    if (e.event === 'job-success') j.success++;
    else if (e.event === 'job-failure') { j.failure++; j.lastFailure = e; }
    else if (e.event === 'job-skip-not-due') j.skipNotDue++;
    else if (e.event === 'job-skip-ot-down') j.skipOtDown++;
    if (!j.last || new Date(e.ts) > new Date(j.last.ts)) j.last = e;
  }

  const jobs = [...byJob.values()].sort((a, b) => {
    // Failed jobs first, then by name
    if ((b.failure > 0) !== (a.failure > 0)) return (b.failure > 0) ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const failureCount = jobs.filter(j => j.failure > 0).length;
  const skipOtCount = jobs.filter(j => j.skipOtDown > 0).length;

  const summary = failureCount > 0
    ? `<p style="color:#c0392b"><b>${failureCount}</b> job${failureCount === 1 ? '' : 's'} reported failure${failureCount === 1 ? '' : 's'} in this window. ${skipOtCount > 0 ? `<b>${skipOtCount}</b> skipped due to OT downtime.` : ''}</p>`
    : `<p style="color:#27ae60">All cron jobs healthy in this window. ${skipOtCount > 0 ? `(<b>${skipOtCount}</b> skipped due to OT downtime — informational, not a failure.)` : ''}</p>`;

  const rows = jobs.map(j => {
    const status = j.failure > 0
      ? `<span style="color:#c0392b">⚠ ${j.failure} failure${j.failure === 1 ? '' : 's'}</span>`
      : `<span style="color:#27ae60">OK</span>`;
    const errCell = j.lastFailure
      ? `<code style="font-size:11px;color:#c0392b">${escapeHtml(j.lastFailure.reason || `exit ${j.lastFailure.exitCode}`)}</code>`
      : '';
    return `
      <tr>
        <td><b>${escapeHtml(j.name)}</b></td>
        <td>${status}</td>
        <td style="text-align:right">${j.success}</td>
        <td style="text-align:right">${j.failure}</td>
        <td style="text-align:right">${j.skipNotDue}</td>
        <td style="text-align:right">${j.skipOtDown}</td>
        <td style="white-space:nowrap">${j.last ? escapeHtml(fmtTime(j.last.ts)) : ''}</td>
        <td>${errCell}</td>
      </tr>`;
  }).join('');

  return {
    html: `${summary}
      <table ${TABLE_STYLE}>
        <tr><th ${TH_STYLE}>Job</th><th ${TH_STYLE}>Status</th><th ${TH_STYLE}>Success</th><th ${TH_STYLE}>Failure</th><th ${TH_STYLE}>Skip (not due)</th><th ${TH_STYLE}>Skip (OT down)</th><th ${TH_STYLE}>Last Event</th><th ${TH_STYLE}>Last Failure Reason</th></tr>
        ${rows}
      </table>
      <p style="color:#666;font-size:11px;margin-top:6px">Skip counts for sub-hourly jobs are normal — only the cadence-due tick actually executes; the others skip with reason "not due."</p>`,
    count: events.length,
    failureCount,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function buildDigestEmail({ since, until, crumbs }) {
  await enrichLoadedCrumbs(crumbs);
  const s1 = buildSection1Loaded(crumbs);
  const s2 = buildSection2Routing(crumbs);
  const s3 = buildSection3DrillDown(crumbs);
  const s4 = await buildSection4OpenQueue(crumbs);
  const s5 = buildSection5StockRFQ(crumbs);
  const s6 = buildSection6CronHealth(crumbs);

  // Activity is window-scoped (sections 1-3, 5, 6); the open queue is current state.
  const windowActivity = s1.count + s2.count + s3.count + s5.count;
  const openQueue = s4.count;
  const cronFailures = s6.failureCount || 0;

  const headlines = [];
  if (cronFailures > 0) headlines.push(`<span style="color:#c0392b"><b>⚠ ${cronFailures} cron failure${cronFailures === 1 ? '' : 's'}</b></span>`);
  if (s1.count > 0) headlines.push(`<b>${s1.count}</b> excess loaded`);
  if (s5.count > 0) {
    const loaded = (crumbs.filter(c => c.cog === 'stockrfq-agent' && c.event === 'loaded')).length;
    headlines.push(`<b>${loaded}</b> stock RFQ loaded`);
  }
  if (openQueue > 0) headlines.push(`<b>${openQueue}</b> open queue item${openQueue === 1 ? '' : 's'}`);

  const summaryLine = headlines.length === 0
    ? `<p style="color:#27ae60"><i>No activity in window, no failures, queue clear.</i></p>`
    : `<p>Window: <b>${fmtTime(since)}</b> → <b>${fmtTime(until)}</b><br/>${headlines.join(' · ')}</p>`;

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
    <h2 style="margin:0 0 6px 0">Operations Digest</h2>
    ${summaryLine}

    <h3 ${SECTION_HEADER}>1. Cron job health (this window)</h3>
    ${s6.html}

    <h3 ${SECTION_HEADER}>2. Customer Excess — offers loaded</h3>
    ${s1.html}

    <h3 ${SECTION_HEADER}>3. Customer Excess — type-router decisions</h3>
    ${s2.html}

    <h3 ${SECTION_HEADER}>4. Stock RFQ — RFQs loaded</h3>
    ${s5.html}

    <h3 ${SECTION_HEADER}>5. Drill-down candidates (Customer Excess Analysis)</h3>
    ${s3.html}

    <h3 ${SECTION_HEADER}>6. Open Action Queue (carries forward across digests)</h3>
    ${s4.html}

    <p style="color:#888;font-size:11px;margin-top:24px">
      Auto-generated by <code>Customer Excess Analysis/digest-builder.js</code> at 11/16/20 UTC.
      Reply with structured commands (e.g., <code>PARTNER: 12345 = GE Aerospace</code>, <code>SKIP: 1024645</code>) to feed back into the excess pipeline — handled by the reply-parser cog on next run.
    </p>
  </body></html>`;

  const subjBits = [];
  if (cronFailures > 0) subjBits.push(`⚠ ${cronFailures} cron failure${cronFailures === 1 ? '' : 's'}`);
  if (s1.count > 0) subjBits.push(`${s1.count} excess loaded`);
  if (s5.count > 0) {
    const loaded = (crumbs.filter(c => c.cog === 'stockrfq-agent' && c.event === 'loaded')).length;
    if (loaded > 0) subjBits.push(`${loaded} stock RFQ loaded`);
  }
  if (openQueue > 0) subjBits.push(`${openQueue} open`);

  const subject = subjBits.length === 0
    ? `Ops Digest — quiet window (${fmtTime(until)})`
    : `Ops Digest — ${subjBits.join(', ')} (${fmtTime(until)})`;

  return { subject, html, totalActivity: windowActivity + openQueue + cronFailures };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sinceHoursIdx = argv.indexOf('--since-hours');
  const sinceHours = sinceHoursIdx >= 0 ? parseFloat(argv[sinceHoursIdx + 1]) : null;

  const last = loadLastDigest();
  const now = new Date();
  let since;
  if (sinceHours != null) {
    since = new Date(now.getTime() - sinceHours * 3600 * 1000);
  } else if (last && last.lastSent) {
    since = new Date(last.lastSent);
  } else {
    // First run — default to last 8 hours
    since = new Date(now.getTime() - 8 * 3600 * 1000);
  }

  const crumbs = breadcrumbs.readSince(since.getTime());
  const { subject, html, totalActivity } = await buildDigestEmail({ since: since.toISOString(), until: now.toISOString(), crumbs });

  console.log(`digest-builder: window ${since.toISOString()} → ${now.toISOString()}, breadcrumbs=${crumbs.length}, activity=${totalActivity}`);

  if (dryRun) {
    console.log('--- SUBJECT ---');
    console.log(subject);
    console.log('--- HTML ---');
    console.log(html);
    return;
  }

  const pass = process.env.WORKMAIL_PASS;
  if (!pass) {
    console.error('FATAL: WORKMAIL_PASS not set');
    process.exit(1);
  }

  try {
    const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
    await sendWithFallback({
      primary:  { from: SENDER,   pass, displayName: 'Customer Excess Digest' },
      fallback: { from: FALLBACK, pass, displayName: 'Customer Excess Digest' },
      mail: { to: RECIPIENT, subject, html },
      log,
    });
    log(`digest sent to ${RECIPIENT}`);
    breadcrumbs.write({
      cog: 'digest-builder', event: 'sent',
      since: since.toISOString(), until: now.toISOString(),
      activityCount: totalActivity, breadcrumbCount: crumbs.length,
    });
    saveLastDigest({ lastSent: now.toISOString(), activityCount: totalActivity });
  } catch (err) {
    console.error('digest send failed:', err.message);
    breadcrumbs.write({
      cog: 'digest-builder', event: 'send-failed',
      since: since.toISOString(), until: now.toISOString(),
      error: err.message,
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
}

module.exports = { buildDigestEmail };
