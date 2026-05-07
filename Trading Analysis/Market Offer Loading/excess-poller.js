#!/usr/bin/env node
/**
 * Excess Poller — inbox-driven Market Offer Loading automation
 *
 * Polls excess@orangetsunami.com for UNSEEN messages, resolves the supplying
 * partner (explicit BP hint > inner-forward domain > outer From domain >
 * company name in signature), extracts lines from xlsx/csv attachments or
 * tabular body, writes the offer via shared/offer-writeback.writeOffer, and
 * emails Jake a summary with the new offer search key.
 *
 * Designed for 15-minute cron cadence. Idempotent: messages are moved out of
 * INBOX after processing so re-runs only pick up new mail.
 *
 * Usage:
 *   node excess-poller.js              # process all UNSEEN in INBOX
 *   node excess-poller.js --dry-run    # parse + resolve, do NOT writeOffer
 *                                        and do NOT move messages
 *   node excess-poller.js --uid <n>    # process only the given UID
 *   node excess-poller.js --max <n>    # cap processed count this run
 *
 * Partner resolution (first match wins):
 *   1. Explicit BP hint in body — matches any of these case-insensitive:
 *        BP: 1005525
 *        Partner: 1005525
 *        Vendor: 1005525
 *        BPartner ID: 1005525
 *   2. Inner-forward From: header (when Astute employee forwards a customer
 *      email to excess@, the outer From is the employee so we parse the inner)
 *   3. Outer From domain (when customer emails excess@ directly)
 *   4. Company name in body/signature (last resort)
 *   5. None → move to NeedsPartner, notify Jake
 *
 * Offer type is `Customer Excess` by default. Override with a body hint:
 *   Type: Broker Stock Offer
 *   Type: Customer Excess
 *
 * Line extraction:
 *   - Preferred: xlsx or csv attachment with recognizable headers
 *     (MPN/Part Number, Qty/Quantity, Price/Unit Price, MFR/Manufacturer,
 *      DC/Date Code, Description — case-insensitive fuzzy match)
 *   - Fallback: tabular prose in body (tab- or pipe-delimited rows)
 *   - Failure: route to NeedsReview, notify Jake with a body snippet
 *
 * Routing:
 *   Step 5 clean write       → Processed
 *   Unresolved partner        → NeedsPartner
 *   Parse fail / write errors → NeedsReview
 *   No offer data found       → NotOffer
 *
 * On unexpected error: notify Jake with the failure detail, leave the
 * message in INBOX but marked Seen so the same broken message isn't
 * retried forever.
 *
 * Analysis push (Step 7 of market-offer-loading.md) is NOT wired yet — the
 * Market Offer Analysis workflow's Steps 2/4/5 are still stubs (intent
 * classifier + scoring engine + output renderer). Summary email will flag
 * the new offer ID so it can be run through Analysis manually when ready.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { writeOffer } = require('../../shared/offer-writeback');
const { resolvePartner, lookupById } = require('../../shared/partner-lookup');
const { sendWithFallback } = require('../../shared/verified-send');
const { readCSVFile } = require('../../shared/csv-utils');

const EXCESS_EMAIL = 'excess@orangetsunami.com';
const FALLBACK_EMAIL = process.env.EXCESS_FALLBACK_SENDER || 'stockRFQ@orangetsunami.com';
const JAKE_EMAIL = 'jake.harris@astutegroup.com';
const ASTUTE_DOMAIN = 'astutegroup.com';

const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

if (!WORKMAIL_PASS) {
  console.error('FATAL: WORKMAIL_PASS not set in ~/workspace/.env');
  process.exit(1);
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const UID_ARG = (() => {
  const i = argv.indexOf('--uid');
  return i >= 0 ? parseInt(argv[i + 1], 10) : null;
})();
const MAX_ARG = (() => {
  const i = argv.indexOf('--max');
  return i >= 0 ? parseInt(argv[i + 1], 10) : null;
})();

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Body hint extraction ───────────────────────────────────────────────────

/**
 * Look for an explicit BP ID hint in the message body. Accepts any of:
 *   BP: 1005525
 *   Partner: 1005525
 *   Vendor: 1005525
 *   BPartner ID: 1005525
 * Returns the BP ID as a Number, or null if none found.
 */
function extractBpHint(body) {
  if (!body) return null;
  const re = /\b(?:BP|Partner|Vendor|BPartner\s+ID|BP\s+ID)\s*[:#=]\s*(\d{6,8})\b/i;
  const m = body.match(re);
  return m ? Number(m[1]) : null;
}

/**
 * Look for an explicit offer-type hint in the message body.
 *   Type: Broker Stock Offer
 *   Type: Customer Excess
 * Returns the type string, or null if not found.
 */
function extractOfferTypeHint(body) {
  if (!body) return null;
  const re = /^[ \t]*Type\s*[:#=]\s*(.+)$/im;
  const m = body.match(re);
  if (!m) return null;
  const val = m[1].trim();
  // Only accept values we recognize — otherwise ignore so we don't error on
  // random "Type: FYI" email chatter
  const KNOWN = [
    'Customer Excess',
    'Broker Stock Offer',
    'Franchise Offers',
    'Customer Lead Time Buy',
  ];
  const match = KNOWN.find(t => t.toLowerCase() === val.toLowerCase());
  return match || null;
}

/**
 * Parse a forwarded message body to recover the inner From header. Same
 * algorithm as vortex-poller.js → parseForwardedHeaders (kept in sync).
 * Returns { originalFrom: 'person@vendor.com'|null, originalCompany: 'Name'|null }
 */
function parseForwardedHeaders(body) {
  if (!body) return { originalFrom: null, originalCompany: null };

  let text = body
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n');

  text = text.replace(/<[a-zA-Z\/][^>@]*>/g, ' ');

  const fromMatch = text.match(/^[ \t]*From:[ \t]*(.+)$/im);
  let originalFrom = null;
  let originalCompany = null;

  if (fromMatch) {
    const line = fromMatch[1];
    const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
    const found = line.match(emailRe);
    if (found && found.length) originalFrom = found[0].toLowerCase();
    // Try to pull a display name preceding the email: "Name Name <x@y>"
    const nameRe = /^([^<]+?)\s*<[^>]+>/;
    const nm = line.match(nameRe);
    if (nm) originalCompany = nm[1].trim();
  }

  return { originalFrom, originalCompany };
}

// ── Partner resolution ──────────────────────────────────────────────────────

/**
 * Resolve supplying partner for an incoming email. Returns a partner object
 * shaped like shared/partner-lookup.resolvePartner plus a `source` field that
 * names the resolver path that won.
 */
function resolvePartnerForMessage({ outerFrom, body }) {
  // 1. Explicit BP hint wins — trust the employee
  const bpHint = extractBpHint(body);
  if (bpHint) {
    const p = lookupById(bpHint);
    if (p) {
      return { ...p, matched: true, tier: 0, tierName: 'bp_hint', source: `BP hint ${bpHint}` };
    }
    log(`  BP hint ${bpHint} did not resolve to an active BP`);
  }

  // 2. Inner-forward From (only when outer sender is an Astute employee)
  const isInternalForward = outerFrom && outerFrom.toLowerCase().endsWith(`@${ASTUTE_DOMAIN}`);
  if (isInternalForward) {
    const { originalFrom, originalCompany } = parseForwardedHeaders(body);
    if (originalFrom) {
      const r = resolvePartner({ email: originalFrom, companyName: originalCompany || '' });
      if (r.matched) return { ...r, source: `forward from ${originalFrom}` };
    }
    // Forwarded but we couldn't parse an inner From — fall through to name match
    if (originalCompany) {
      const r = resolvePartner({ email: '', companyName: originalCompany });
      if (r.matched) return { ...r, source: `forward company name '${originalCompany}'` };
    }
  }

  // 3. Outer From (direct customer email)
  if (outerFrom && !isInternalForward) {
    const r = resolvePartner({ email: outerFrom });
    if (r.matched) return { ...r, source: `sender ${outerFrom}` };
  }

  return { matched: false, source: 'unresolved' };
}

// ── Line extraction ─────────────────────────────────────────────────────────

// Header synonyms for fuzzy matching. Keys are canonical field names; values
// are possible header strings we might see (case-insensitive, whitespace-
// tolerant).
const HEADER_SYNONYMS = {
  mpn: ['mpn', 'part number', 'part #', 'partnumber', 'part no', 'manufacturer part number', 'manufacturer part #', 'mfr part number', 'mfg part number', 'aml', 'p/n', 'pn'],
  qty: ['qty', 'quantity', 'qty available', 'stock', 'available', 'on hand', 'qoh', 'qty on hand'],
  price: ['price', 'unit price', 'cost', 'unit cost', 'offer price', 'asking price', '$', 'usd', 'price (usd)', 'each'],
  mfr:   ['mfr', 'manufacturer', 'brand', 'make', 'mfg'],
  dateCode: ['dc', 'date code', 'datecode', 'dates', 'dates/lot', 'd/c'],
  description: ['description', 'desc', 'part description', 'details'],
  cpc:   ['cpc', 'customer part', 'customer part code', 'customer part number', 'internal pn'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Given an array of header strings, return { mpnIdx, qtyIdx, priceIdx, mfrIdx,
 * dateCodeIdx, descriptionIdx, cpcIdx }. Indexes are -1 when the column
 * wasn't found.
 */
function matchHeaders(headers) {
  const normed = headers.map(normalizeHeader);
  const find = (key) => {
    const syns = HEADER_SYNONYMS[key];
    for (let i = 0; i < normed.length; i++) {
      if (syns.some(s => normed[i] === s)) return i;
    }
    // Contains-match fallback (less strict)
    for (let i = 0; i < normed.length; i++) {
      if (syns.some(s => normed[i].includes(s))) return i;
    }
    return -1;
  };
  return {
    mpnIdx:         find('mpn'),
    qtyIdx:         find('qty'),
    priceIdx:       find('price'),
    mfrIdx:         find('mfr'),
    dateCodeIdx:    find('dateCode'),
    descriptionIdx: find('description'),
    cpcIdx:         find('cpc'),
  };
}

/**
 * Walk an xlsx workbook looking for a sheet whose headers include an MPN
 * column. Returns the extracted lines or throws if none found.
 */
function extractLinesFromXlsx(filepath) {
  const wb = XLSX.readFile(filepath);
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    // Scan the first 10 rows for a header row with MPN
    for (let h = 0; h < Math.min(10, rows.length); h++) {
      const row = rows[h] || [];
      const headers = row.map(c => (c == null ? '' : String(c).trim()));
      if (headers.every(v => !v)) continue;
      const idx = matchHeaders(headers);
      if (idx.mpnIdx < 0) continue;

      const lines = [];
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const mpn = r[idx.mpnIdx] != null ? String(r[idx.mpnIdx]).trim() : '';
        if (!mpn) continue;
        const line = { mpn };
        if (idx.qtyIdx >= 0 && r[idx.qtyIdx] != null && r[idx.qtyIdx] !== '') {
          const n = Number(r[idx.qtyIdx]);
          if (!isNaN(n) && n > 0) line.qty = n;
        }
        if (idx.priceIdx >= 0 && r[idx.priceIdx] != null && r[idx.priceIdx] !== '') {
          const raw = String(r[idx.priceIdx]).replace(/[$,\s]/g, '');
          const n = Number(raw);
          if (!isNaN(n) && n > 0) line.price = n;
        }
        if (idx.mfrIdx >= 0 && r[idx.mfrIdx] != null) {
          const v = String(r[idx.mfrIdx]).trim();
          if (v) line.mfrText = v;
        }
        if (idx.dateCodeIdx >= 0 && r[idx.dateCodeIdx] != null) {
          const v = String(r[idx.dateCodeIdx]).trim();
          if (v) line.dateCode = v;
        }
        if (idx.descriptionIdx >= 0 && r[idx.descriptionIdx] != null) {
          const v = String(r[idx.descriptionIdx]).trim();
          if (v) line.description = v;
        }
        if (idx.cpcIdx >= 0 && r[idx.cpcIdx] != null) {
          const v = String(r[idx.cpcIdx]).trim();
          if (v) line.cpc = v;
        }
        lines.push(line);
      }
      if (lines.length > 0) {
        return { lines, sheetName, headerRow: h };
      }
    }
  }
  throw new Error(`No sheet with an MPN column found. Sheets tried: ${wb.SheetNames.join(', ')}`);
}

function extractLinesFromCsv(filepath) {
  const csv = readCSVFile(filepath);
  // csv-utils returns a wrapper with .headers and .rows. Fall back defensively.
  const headers = csv.headers || (csv.data && csv.data[0]) || [];
  const dataRows = csv.rows || csv.data || [];
  const idx = matchHeaders(headers);
  if (idx.mpnIdx < 0) throw new Error(`CSV header row has no MPN column. Headers seen: ${headers.join(', ')}`);

  const lines = [];
  for (const row of dataRows) {
    // row may be an object keyed by header, or an array
    const cell = (i) => (Array.isArray(row) ? row[i] : (row[headers[i]] != null ? row[headers[i]] : null));
    const mpn = cell(idx.mpnIdx) != null ? String(cell(idx.mpnIdx)).trim() : '';
    if (!mpn) continue;
    const line = { mpn };
    if (idx.qtyIdx >= 0) {
      const v = cell(idx.qtyIdx);
      if (v != null && v !== '') {
        const n = Number(String(v).replace(/,/g, ''));
        if (!isNaN(n) && n > 0) line.qty = n;
      }
    }
    if (idx.priceIdx >= 0) {
      const v = cell(idx.priceIdx);
      if (v != null && v !== '') {
        const n = Number(String(v).replace(/[$,\s]/g, ''));
        if (!isNaN(n) && n > 0) line.price = n;
      }
    }
    if (idx.mfrIdx >= 0) {
      const v = cell(idx.mfrIdx);
      if (v != null) {
        const s = String(v).trim();
        if (s) line.mfrText = s;
      }
    }
    if (idx.dateCodeIdx >= 0) {
      const v = cell(idx.dateCodeIdx);
      if (v != null) {
        const s = String(v).trim();
        if (s) line.dateCode = s;
      }
    }
    if (idx.descriptionIdx >= 0) {
      const v = cell(idx.descriptionIdx);
      if (v != null) {
        const s = String(v).trim();
        if (s) line.description = s;
      }
    }
    if (idx.cpcIdx >= 0) {
      const v = cell(idx.cpcIdx);
      if (v != null) {
        const s = String(v).trim();
        if (s) line.cpc = s;
      }
    }
    lines.push(line);
  }
  return { lines };
}

// ── Message processing ─────────────────────────────────────────────────────

async function downloadAttachmentsToTmp(client, uid) {
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) return { dir: null, files: [] };

  const parsed = await simpleParser(msg.source);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `excess-poller-${uid}-`));
  const files = [];
  for (const att of (parsed.attachments || [])) {
    if (!att.filename) continue;
    if (/^image\//i.test(att.contentType || '')) continue;
    const outPath = path.join(outDir, att.filename);
    fs.writeFileSync(outPath, att.content);
    files.push({ filename: att.filename, path: outPath, size: att.size || att.content.length });
  }
  return { dir: outDir, files, parsed };
}

function cleanupTmpDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
}

function extractFromAttachmentsOrBody(files, body) {
  // Prefer xlsx/csv attachments in order
  for (const f of files) {
    const ext = path.extname(f.filename).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      try {
        const r = extractLinesFromXlsx(f.path);
        return { ...r, source: `attachment ${f.filename}` };
      } catch (e) {
        log(`  xlsx parse failed on ${f.filename}: ${e.message}`);
      }
    } else if (ext === '.csv') {
      try {
        const r = extractLinesFromCsv(f.path);
        return { ...r, source: `attachment ${f.filename}` };
      } catch (e) {
        log(`  csv parse failed on ${f.filename}: ${e.message}`);
      }
    }
  }
  // Body fallback: tab- or pipe-delimited tabular prose. Very minimal.
  if (body) {
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      const headerLine = lines[i];
      // Accept tab or pipe separator, not comma (too noisy in prose)
      const sep = headerLine.includes('\t') ? '\t' : (headerLine.includes('|') ? '|' : null);
      if (!sep) continue;
      const headers = headerLine.split(sep).map(s => s.trim());
      const idx = matchHeaders(headers);
      if (idx.mpnIdx < 0) continue;
      const out = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) break;
        const parts = l.split(sep).map(s => s.trim());
        const mpn = parts[idx.mpnIdx] || '';
        if (!mpn) continue;
        const line = { mpn };
        if (idx.qtyIdx >= 0 && parts[idx.qtyIdx]) {
          const n = Number(parts[idx.qtyIdx].replace(/,/g, ''));
          if (!isNaN(n) && n > 0) line.qty = n;
        }
        if (idx.priceIdx >= 0 && parts[idx.priceIdx]) {
          const n = Number(parts[idx.priceIdx].replace(/[$,\s]/g, ''));
          if (!isNaN(n) && n > 0) line.price = n;
        }
        if (idx.mfrIdx >= 0 && parts[idx.mfrIdx]) line.mfrText = parts[idx.mfrIdx];
        if (idx.dateCodeIdx >= 0 && parts[idx.dateCodeIdx]) line.dateCode = parts[idx.dateCodeIdx];
        if (idx.descriptionIdx >= 0 && parts[idx.descriptionIdx]) line.description = parts[idx.descriptionIdx];
        if (idx.cpcIdx >= 0 && parts[idx.cpcIdx]) line.cpc = parts[idx.cpcIdx];
        out.push(line);
      }
      if (out.length > 0) return { lines: out, source: `body ${sep === '\t' ? 'tab' : 'pipe'}-delimited` };
    }
  }
  return null;
}

// ── Notification helpers ──────────────────────────────────────────────────

async function sendNotice({ subject, html }) {
  if (DRY_RUN) {
    log(`  [dry-run] would send: ${subject}`);
    return;
  }
  try {
    await sendWithFallback({
      primary:  { from: EXCESS_EMAIL,   pass: WORKMAIL_PASS, displayName: 'Excess Poller' },
      fallback: { from: FALLBACK_EMAIL, pass: WORKMAIL_PASS, displayName: 'Excess Poller' },
      mail: { to: JAKE_EMAIL, subject, html },
      log
    });
  } catch (e) {
    log('notice email failed:', e.message);
  }
}

function linesPreviewHtml(lines, max = 10) {
  const rows = lines.slice(0, max).map(l => `
    <tr>
      <td>${escapeHtml(l.mpn)}</td>
      <td>${escapeHtml(l.mfrText || '')}</td>
      <td style="text-align:right">${l.qty != null ? l.qty.toLocaleString() : ''}</td>
      <td style="text-align:right">${l.price != null ? '$' + l.price.toFixed(4) : ''}</td>
      <td>${escapeHtml(l.dateCode || '')}</td>
    </tr>`).join('');
  const more = lines.length > max ? `<tr><td colspan="5" style="color:#666">…and ${lines.length - max} more</td></tr>` : '';
  return `<table cellpadding="4" cellspacing="0" border="1" style="border-collapse:collapse;font-size:12px">
    <tr style="background:#eee"><th>MPN</th><th>MFR</th><th>Qty</th><th>Price</th><th>DC</th></tr>
    ${rows}${more}
  </table>`;
}

// ── Main per-message processor ────────────────────────────────────────────

async function processMessage(client, uid) {
  log(`processing UID ${uid}`);
  let tmpDir = null;
  try {
    // 1. Download source + attachments
    const { dir, files, parsed } = await downloadAttachmentsToTmp(client, uid);
    tmpDir = dir;
    if (!parsed) {
      log(`  UID ${uid}: no source`);
      return { uid, status: 'skipped', reason: 'no source' };
    }

    const subject = parsed.subject || '';
    const outerFrom = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
    const body = parsed.text || parsed.html || '';
    log(`  subject="${subject}" from=${outerFrom} attachments=${files.length}`);

    // 2. Resolve partner
    const partner = resolvePartnerForMessage({ outerFrom, body });
    if (!partner.matched) {
      log(`  UID ${uid}: partner unresolved (${partner.source})`);
      await sendNotice({
        subject: `Excess Poller — NeedsPartner: "${subject}"`,
        html: `<p>Could not resolve a partner for this excess email.</p>
               <p><b>From:</b> ${escapeHtml(outerFrom)}<br/>
                  <b>Subject:</b> ${escapeHtml(subject)}<br/>
                  <b>UID:</b> ${uid}</p>
               <p>Forward again to excess@ with a body hint like <code>BP: 1005525</code> or tell me the BP ID directly and I'll load it.</p>`
      });
      if (!DRY_RUN) await client.messageMove(String(uid), 'NeedsPartner', { uid: true });
      return { uid, status: 'needs-partner' };
    }
    log(`  partner resolved: ${partner.name} (BP=${partner.c_bpartner_id}) via ${partner.source}`);

    // 3. Extract lines
    const extracted = extractFromAttachmentsOrBody(files, body);
    if (!extracted || !extracted.lines || extracted.lines.length === 0) {
      log(`  UID ${uid}: no lines extractable`);
      const snippet = (body || '').slice(0, 1000);
      await sendNotice({
        subject: `Excess Poller — NeedsReview: "${subject}"`,
        html: `<p>Partner resolved (${escapeHtml(partner.name)}, BP ${partner.c_bpartner_id}) but I could not find offer lines.</p>
               <p><b>From:</b> ${escapeHtml(outerFrom)}<br/>
                  <b>Subject:</b> ${escapeHtml(subject)}<br/>
                  <b>UID:</b> ${uid}<br/>
                  <b>Attachments:</b> ${files.length ? files.map(f => escapeHtml(f.filename)).join(', ') : '(none)'}</p>
               <p>Body preview:</p>
               <pre style="background:#f5f5f5;padding:8px;font-size:11px">${escapeHtml(snippet)}</pre>`
      });
      if (!DRY_RUN) await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      return { uid, status: 'needs-review', reason: 'no lines' };
    }
    log(`  extracted ${extracted.lines.length} lines from ${extracted.source}`);

    // 4. Determine offer type (default Customer Excess, override via body hint)
    const offerType = extractOfferTypeHint(body) || 'Customer Excess';

    // 5. Build description
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const partnerSlug = partner.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const description = `${today}-${partnerSlug}-ExcessPoller`;

    // 6. Write offer (unless dry-run)
    if (DRY_RUN) {
      log(`  [dry-run] would writeOffer BP=${partner.c_bpartner_id} type=${offerType} lines=${extracted.lines.length}`);
      await sendNotice({
        subject: `Excess Poller [DRY-RUN] — ${partner.name}: ${extracted.lines.length} lines`,
        html: `<p>Dry-run only — no OT write.</p>
               <p><b>From:</b> ${escapeHtml(outerFrom)}<br/>
                  <b>Partner:</b> ${escapeHtml(partner.name)} (BP ${partner.c_bpartner_id}) via ${escapeHtml(partner.source)}<br/>
                  <b>Offer type:</b> ${escapeHtml(offerType)}<br/>
                  <b>Description:</b> ${escapeHtml(description)}<br/>
                  <b>Source:</b> ${escapeHtml(extracted.source)}<br/>
                  <b>Lines:</b> ${extracted.lines.length}</p>
               ${linesPreviewHtml(extracted.lines)}`
      });
      return { uid, status: 'dry-run', lines: extracted.lines.length };
    }

    log(`  calling writeOffer (BP=${partner.c_bpartner_id}, type='${offerType}', lines=${extracted.lines.length})`);
    const start = Date.now();
    let result;
    try {
      result = await writeOffer({
        bpartnerId: partner.c_bpartner_id,
        offerTypeId: offerType,
        description,
        writeMpnRecords: true,
        lines: extracted.lines,
      });
    } catch (err) {
      log(`  UID ${uid}: writeOffer threw: ${err.message}`);
      await sendNotice({
        subject: `Excess Poller — WRITE FAILED: ${partner.name}`,
        html: `<p style="color:#b00">writeOffer threw for ${escapeHtml(partner.name)} (BP ${partner.c_bpartner_id}).</p>
               <p><b>Error:</b> ${escapeHtml(err.message)}<br/>
                  <b>UID:</b> ${uid}<br/>
                  <b>Subject:</b> ${escapeHtml(subject)}<br/>
                  <b>Lines:</b> ${extracted.lines.length}</p>`
      });
      await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      return { uid, status: 'error', reason: err.message };
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const clean = result.offerId != null
      && result.linesWritten === extracted.lines.length
      && result.errors.length === 0;

    log(`  writeOffer done: searchKey=${result.searchKey} offerId=${result.offerId} lines=${result.linesWritten}/${extracted.lines.length} errors=${result.errors.length} elapsed=${elapsed}s`);

    // 7. Route email + summary
    if (clean) {
      await client.messageMove(String(uid), 'Processed', { uid: true });
      await sendNotice({
        subject: `Excess Poller — ${partner.name}: offer ${result.searchKey} loaded (${result.linesWritten} lines)`,
        html: `<p>Loaded offer <b>${escapeHtml(result.searchKey)}</b> (chuboe_offer_id ${result.offerId}).</p>
               <p><b>Partner:</b> ${escapeHtml(partner.name)} (BP ${partner.c_bpartner_id}) via ${escapeHtml(partner.source)}<br/>
                  <b>Offer type:</b> ${escapeHtml(offerType)}<br/>
                  <b>Source:</b> ${escapeHtml(extracted.source)}<br/>
                  <b>Lines written:</b> ${result.linesWritten}<br/>
                  <b>MPN records:</b> ${result.mpnsWritten}<br/>
                  <b>Elapsed:</b> ${elapsed}s</p>
               ${linesPreviewHtml(extracted.lines)}
               <p style="color:#666;font-size:11px">Market Offer Analysis (intent classifier, scoring, output renderer) is still under construction — the offer is loaded and queryable in OT; enrich via analyze-offer when ready.</p>`
      });
      return { uid, status: 'loaded', offerId: result.offerId, searchKey: result.searchKey, lines: result.linesWritten };
    } else {
      await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      await sendNotice({
        subject: `Excess Poller — PARTIAL: ${partner.name} (${result.errors.length} errors)`,
        html: `<p style="color:#b60">Offer <b>${escapeHtml(result.searchKey || '(no key)')}</b> loaded with errors.</p>
               <p><b>Partner:</b> ${escapeHtml(partner.name)} (BP ${partner.c_bpartner_id})<br/>
                  <b>Lines written:</b> ${result.linesWritten}/${extracted.lines.length}<br/>
                  <b>Errors:</b> ${result.errors.length}</p>
               <pre style="background:#fee;padding:8px;font-size:11px">${escapeHtml(result.errors.slice(0, 20).join('\n'))}</pre>`
      });
      return { uid, status: 'partial', offerId: result.offerId, errors: result.errors.length };
    }
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  log(`excess-poller starting (dry-run=${DRY_RUN}, uid=${UID_ARG || 'all unseen'}, max=${MAX_ARG || 'none'})`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EXCESS_EMAIL, pass: WORKMAIL_PASS },
    logger: false
  });

  try {
    await client.connect();
  } catch (err) {
    log('FATAL: cannot connect to excess inbox:', err.message);
    process.exit(2);
  }

  // Ensure destination folders exist
  for (const f of ['Processed', 'NeedsPartner', 'NeedsReview', 'NotOffer']) {
    try { await client.mailboxCreate(f); } catch (e) { /* already exists */ }
  }

  let processed = 0;
  const counts = { loaded: 0, 'needs-partner': 0, 'needs-review': 0, 'dry-run': 0, error: 0, partial: 0, skipped: 0 };

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids;
      if (UID_ARG) {
        uids = [UID_ARG];
      } else {
        const search = await client.search({ seen: false }, { uid: true });
        uids = search || [];
      }
      if (MAX_ARG && uids.length > MAX_ARG) {
        log(`capping run at --max ${MAX_ARG} of ${uids.length} UNSEEN`);
        uids = uids.slice(0, MAX_ARG);
      }
      log(`found ${uids.length} message(s) to process`);

      for (const uid of uids) {
        processed++;
        try {
          const r = await processMessage(client, uid);
          counts[r.status] = (counts[r.status] || 0) + 1;
        } catch (err) {
          counts.error++;
          log(`  UID ${uid}: unexpected error: ${err.message}`);
          log(err.stack);
          // Mark Seen but don't move — leave in INBOX for investigation.
          // Skipped in dry-run so a test run is fully non-destructive.
          if (!DRY_RUN) {
            try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (e) {}
          }
          await sendNotice({
            subject: `Excess Poller — unexpected error on UID ${uid}`,
            html: `<p style="color:#b00">Unhandled exception processing UID ${uid}.</p><pre>${escapeHtml(err.message)}</pre>`
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  log(`done. processed=${processed} ${JSON.stringify(counts)}`);
  // Force exit — underlying pg pool may linger
  process.exit(0);
}

main().catch(err => {
  log('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
