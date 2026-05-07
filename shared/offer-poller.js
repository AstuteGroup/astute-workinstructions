/**
 * shared/offer-poller.js — universal inbox poller for market offers.
 *
 * Lifted from `Trading Analysis/Market Offer Loading/excess-poller.js` and
 * generalized so a second inbox (broker, franchise) is one config line.
 *
 * Each call:
 *   1. Acquires a per-account lockfile (skips silently if previous run still active)
 *   2. Connects to the inbox via ImapFlow (auth via shared/email-fetcher creds)
 *   3. For every UNSEEN message:
 *        a. download source + attachments
 *        b. resolve partner (BP hint → inner-forward → outer From → company name)
 *        c. extract lines from xlsx → csv → pdf → body fallback
 *        d. writeOffer() → chuboe_offer + lines + line_mpn
 *        e. dispatch to type router (Customer Excess → analysis; broker/franchise → data-capture)
 *   4. Writes a breadcrumb at every decision point so the digest builder can summarize
 *   5. Releases lock and exits
 *
 * USAGE:
 *   const { runOfferPoller } = require('../shared/offer-poller');
 *   const result = await runOfferPoller({
 *     account: 'excess',                    // must be in email-fetcher's ACCOUNT_MAP
 *     defaultOfferType: 'Customer Excess',  // override via body hint "Type: ..."
 *     lockName: 'offer-poller-excess',
 *     dryRun: false,
 *     uid: null,                            // single-UID processing for replay
 *     max: null,                            // cap messages this run
 *   });
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { writeOffer } = require('./offer-writeback');
const { resolvePartner, lookupById } = require('./partner-lookup');
const { sendWithFallback } = require('./verified-send');
const { readCSVFile } = require('./csv-utils');
const breadcrumbs = require('./breadcrumbs');
const { acquireLock, releaseLock } = require('./lockfile');
const pdfExtract = require('./pdf-extract');
const router = require('./offer-router');
const overrides = require('./feedback-overrides');
const { classifyJunk } = require('./junk-classifier');

const ASTUTE_DOMAIN = 'astutegroup.com';
const JAKE_EMAIL = 'jake.harris@astutegroup.com';

const ACCOUNT_TO_EMAIL = {
  excess:    'excess@orangetsunami.com',
  // PLACEHOLDER — second inbox not yet defined. Leave commented out until
  // operator gives the real address; the cron registry references this map.
  // broker:    'broker@orangetsunami.com',
  // franchise: 'franchise@orangetsunami.com',
};

const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

// ── Body-hint parsing ───────────────────────────────────────────────────────

// Body BP hint: "BP: 1008289", "Partner #1002733", etc.
function extractBpHintFromBody(body) {
  if (!body) return null;
  const re = /\b(?:BP|Partner|Vendor|BPartner\s+ID|BP\s+ID)\s*[:#=]\s*(\d{6,8})\b/i;
  const m = body.match(re);
  return m ? Number(m[1]) : null;
}

// Subject BP hint: sellers put the OT search key in the subject when forwarding
// excess/offer emails to excess@. Patterns observed:
//   "FW: Upload MO_Search Key 1008289"      → 1008289
//   "FW: Upload MO_1002733"                 → 1002733
//   "FW: Matrix comsec - Search key#1009991"→ 1009991
//   "FW: ... [#1234567]"                    → 1234567
// 6-8 digit OT search keys only (matches body convention).
function extractBpHintFromSubject(subject) {
  if (!subject) return null;
  const patterns = [
    /\bSearch\s*Key\s*[#:=\s]\s*(\d{6,8})\b/i,
    /\bMO[_\s-]+(\d{6,8})\b/i,
    /\[#\s*(\d{6,8})\s*\]/,
  ];
  for (const re of patterns) {
    const m = subject.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractBpHint(body, subject) {
  return extractBpHintFromSubject(subject) || extractBpHintFromBody(body);
}

function extractOfferTypeHint(body) {
  if (!body) return null;
  const re = /^[ \t]*Type\s*[:#=]\s*(.+)$/im;
  const m = body.match(re);
  if (!m) return null;
  const val = m[1].trim();
  const KNOWN = ['Customer Excess', 'Broker Stock Offer', 'Franchise Offers', 'Customer Lead Time Buy'];
  return KNOWN.find(t => t.toLowerCase() === val.toLowerCase()) || null;
}

// Walk the body for ALL "From: …" lines (multi-hop forward chains commonly
// stack 2-3 hops: customer → emp1 → emp2 → excess@). Return them in order so
// the resolver can prefer the deepest non-Astute sender.
function parseAllForwardedHeaders(body) {
  if (!body) return [];
  let text = body
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n');
  text = text.replace(/<[a-zA-Z\/][^>@]*>/g, ' ');
  const out = [];
  const re = /^[ \t>]*From:[ \t]*(.+)$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = m[1];
    const found = line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
    const email = found && found.length ? found[0].toLowerCase() : null;
    const nameMatch = line.match(/^([^<]+?)\s*<[^>]+>/);
    const company = nameMatch ? nameMatch[1].trim() : null;
    if (email || company) out.push({ email, company });
  }
  return out;
}

// Backwards-compat wrapper — returns the deepest non-Astute From: in the chain
// (previously returned the first From:, which on multi-hop chains was always
// the immediate-prior internal Astute employee, not the actual customer).
function parseForwardedHeaders(body) {
  const all = parseAllForwardedHeaders(body);
  if (all.length === 0) return { originalFrom: null, originalCompany: null };
  // Prefer the deepest non-Astute sender. Fall back to deepest if all are Astute.
  const nonAstute = all.filter(h => h.email && !h.email.endsWith(`@${ASTUTE_DOMAIN}`));
  const pick = nonAstute.length > 0 ? nonAstute[nonAstute.length - 1] : all[all.length - 1];
  return { originalFrom: pick.email || null, originalCompany: pick.company || null };
}

function resolvePartnerForMessage({ outerFrom, body, subject }) {
  // Subject hint takes priority — sellers put the OT search key in the subject
  // when forwarding offers to excess@ ("Upload MO_Search Key 1008289",
  // "Search key#1009991"). This is the contract; honor it before walking the
  // forward chain.
  const bpHint = extractBpHint(body, subject);
  if (bpHint) {
    const p = lookupById(bpHint);
    if (p) return { ...p, matched: true, tier: 0, tierName: 'bp_hint', source: `BP hint ${bpHint}` };
  }
  const isInternalForward = outerFrom && outerFrom.toLowerCase().endsWith(`@${ASTUTE_DOMAIN}`);
  if (isInternalForward) {
    const { originalFrom, originalCompany } = parseForwardedHeaders(body);
    if (originalFrom) {
      const r = resolvePartner({ email: originalFrom, companyName: originalCompany || '' });
      if (r.matched) return { ...r, source: `forward from ${originalFrom}` };
    }
    if (originalCompany) {
      const r = resolvePartner({ email: '', companyName: originalCompany });
      if (r.matched) return { ...r, source: `forward company name '${originalCompany}'` };
    }
  }
  if (outerFrom && !isInternalForward) {
    const r = resolvePartner({ email: outerFrom });
    if (r.matched) return { ...r, source: `sender ${outerFrom}` };
  }
  return { matched: false, source: 'unresolved' };
}

// ── Line extraction ─────────────────────────────────────────────────────────

const HEADER_SYNONYMS = {
  mpn: ['mpn', 'part number', 'part #', 'partnumber', 'part no', 'manufacturer part number', 'manufacturer part #', 'mfr part number', 'mfr part', 'mfg part number', 'mfg part', 'aml', 'p/n', 'pn'],
  qty: ['qty', 'quantity', 'qty available', 'stock', 'available', 'on hand', 'qoh', 'qty on hand'],
  price: ['price', 'unit price', 'cost', 'unit cost', 'offer price', 'asking price', '$', 'usd', 'price (usd)', 'each'],
  mfr: ['mfr', 'manufacturer', 'brand', 'make', 'mfg'],
  dateCode: ['dc', 'date code', 'datecode', 'dates', 'dates/lot', 'd/c'],
  description: ['description', 'desc', 'part description', 'details'],
  cpc: ['cpc', 'customer part', 'customer part code', 'customer part number', 'internal pn'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ');
}

// Match each conceptual column to exactly one header index. Resolution is
// in-order (mpn first, then qty, price, mfr, ...) and a column already taken
// by an earlier key is excluded from later keys. This prevents a header like
// "mfr part" from being claimed by both `mpn` (as the part column) and `mfr`
// (via the substring "mfr"), which would write the MPN string into mfrText.
function matchHeaders(headers) {
  const normed = headers.map(normalizeHeader);
  const used = new Set();
  const find = key => {
    const syns = HEADER_SYNONYMS[key];
    for (let i = 0; i < normed.length; i++) {
      if (used.has(i)) continue;
      if (syns.some(s => normed[i] === s)) { used.add(i); return i; }
    }
    for (let i = 0; i < normed.length; i++) {
      if (used.has(i)) continue;
      if (syns.some(s => normed[i].includes(s))) { used.add(i); return i; }
    }
    return -1;
  };
  return {
    mpnIdx: find('mpn'), qtyIdx: find('qty'), priceIdx: find('price'),
    mfrIdx: find('mfr'), dateCodeIdx: find('dateCode'),
    descriptionIdx: find('description'), cpcIdx: find('cpc'),
  };
}

function extractLinesFromXlsx(filepath) {
  const wb = XLSX.readFile(filepath);
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
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
          const n = Number(String(r[idx.priceIdx]).replace(/[$,\s]/g, ''));
          if (!isNaN(n) && n > 0) line.price = n;
        }
        if (idx.mfrIdx >= 0 && r[idx.mfrIdx] != null) { const v = String(r[idx.mfrIdx]).trim(); if (v) line.mfrText = v; }
        if (idx.dateCodeIdx >= 0 && r[idx.dateCodeIdx] != null) { const v = String(r[idx.dateCodeIdx]).trim(); if (v) line.dateCode = v; }
        if (idx.descriptionIdx >= 0 && r[idx.descriptionIdx] != null) { const v = String(r[idx.descriptionIdx]).trim(); if (v) line.description = v; }
        if (idx.cpcIdx >= 0 && r[idx.cpcIdx] != null) { const v = String(r[idx.cpcIdx]).trim(); if (v) line.cpc = v; }
        lines.push(line);
      }
      if (lines.length > 0) return { lines, sheetName, headerRow: h };
    }
  }
  throw new Error(`No sheet with an MPN column found. Sheets tried: ${wb.SheetNames.join(', ')}`);
}

function extractLinesFromCsv(filepath) {
  const csv = readCSVFile(filepath);
  const headers = csv.headers || (csv.data && csv.data[0]) || [];
  const dataRows = csv.rows || csv.data || [];
  const idx = matchHeaders(headers);
  if (idx.mpnIdx < 0) throw new Error(`CSV header row has no MPN column. Headers seen: ${headers.join(', ')}`);
  const lines = [];
  for (const row of dataRows) {
    const cell = i => (Array.isArray(row) ? row[i] : (row[headers[i]] != null ? row[headers[i]] : null));
    const mpn = cell(idx.mpnIdx) != null ? String(cell(idx.mpnIdx)).trim() : '';
    if (!mpn) continue;
    const line = { mpn };
    if (idx.qtyIdx >= 0) { const v = cell(idx.qtyIdx); if (v != null && v !== '') { const n = Number(String(v).replace(/,/g, '')); if (!isNaN(n) && n > 0) line.qty = n; } }
    if (idx.priceIdx >= 0) { const v = cell(idx.priceIdx); if (v != null && v !== '') { const n = Number(String(v).replace(/[$,\s]/g, '')); if (!isNaN(n) && n > 0) line.price = n; } }
    if (idx.mfrIdx >= 0) { const v = cell(idx.mfrIdx); if (v != null) { const s = String(v).trim(); if (s) line.mfrText = s; } }
    if (idx.dateCodeIdx >= 0) { const v = cell(idx.dateCodeIdx); if (v != null) { const s = String(v).trim(); if (s) line.dateCode = s; } }
    if (idx.descriptionIdx >= 0) { const v = cell(idx.descriptionIdx); if (v != null) { const s = String(v).trim(); if (s) line.description = s; } }
    if (idx.cpcIdx >= 0) { const v = cell(idx.cpcIdx); if (v != null) { const s = String(v).trim(); if (s) line.cpc = s; } }
    lines.push(line);
  }
  return { lines };
}

async function extractLinesFromPdf(filepath) {
  const r = await pdfExtract.extractAndParse(filepath);
  if (r.needsReview || r.lines.length === 0) {
    throw new Error(`PDF extraction below threshold (text=${r.textConfidence}, line=${r.lineConfidence}, strategy=${r.strategy})`);
  }
  // pdf-extract returns lines with the same shape we need (mpn, qty, mfrText, price, dateCode, leadTime)
  return { lines: r.lines, source: `pdf strategy=${r.strategy}` };
}

function extractLinesFromBody(body) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i];
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
      if (idx.qtyIdx >= 0 && parts[idx.qtyIdx]) { const n = Number(parts[idx.qtyIdx].replace(/,/g, '')); if (!isNaN(n) && n > 0) line.qty = n; }
      if (idx.priceIdx >= 0 && parts[idx.priceIdx]) { const n = Number(parts[idx.priceIdx].replace(/[$,\s]/g, '')); if (!isNaN(n) && n > 0) line.price = n; }
      if (idx.mfrIdx >= 0 && parts[idx.mfrIdx]) line.mfrText = parts[idx.mfrIdx];
      if (idx.dateCodeIdx >= 0 && parts[idx.dateCodeIdx]) line.dateCode = parts[idx.dateCodeIdx];
      if (idx.descriptionIdx >= 0 && parts[idx.descriptionIdx]) line.description = parts[idx.descriptionIdx];
      if (idx.cpcIdx >= 0 && parts[idx.cpcIdx]) line.cpc = parts[idx.cpcIdx];
      out.push(line);
    }
    if (out.length > 0) return { lines: out, source: `body ${sep === '\t' ? 'tab' : 'pipe'}-delimited` };
  }
  return null;
}

// HTML table extraction. Outlook-style emails commonly paste an inline part
// list as a real <table> rather than tab/pipe-delimited text. The plaintext
// fallback above flattens those cells to one-per-line and loses empty cells,
// so we parse the HTML directly.
//
// Linear stack-based parser handles nested tables (Outlook signature blocks
// nest tables freely). For each completed table, we run matchHeaders against
// the first row; if it has an MPN column, we extract data rows. We try every
// table and return the first one that yields ≥1 line.
function decodeHtmlEntities(s) {
  return s.replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripInlineHtmlTags(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p\s*>/gi, ' ')
    .replace(/<o:p\s*\/?>/gi, ' ')
    .replace(/<\/o:p\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
}
function cleanHtmlCell(raw) {
  return decodeHtmlEntities(stripInlineHtmlTags(raw)).replace(/\s+/g, ' ').trim();
}

function extractTablesFromHtml(html) {
  if (!html) return [];
  const h = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const tagRe = /<(\/?)(table|tr|td|th)\b[^>]*?>/gi;
  const tables = [];
  const stack = []; // each: { rows: [[...]], currentRow: null|[], cellOpen: bool }
  let lastIndex = 0;
  let m;

  while ((m = tagRe.exec(h)) !== null) {
    const tag = m[2].toLowerCase();
    const isClose = m[1] === '/';
    const between = h.slice(lastIndex, m.index);

    if (stack.length) {
      const ctx = stack[stack.length - 1];
      if (ctx.currentRow && ctx.cellOpen) {
        ctx.currentRow[ctx.currentRow.length - 1] += between;
      }
    }

    if (tag === 'table' && !isClose) {
      stack.push({ rows: [], currentRow: null, cellOpen: false });
    } else if (tag === 'table' && isClose) {
      const t = stack.pop();
      if (t) tables.push(t.rows);
    } else if (tag === 'tr' && !isClose) {
      if (stack.length) {
        const ctx = stack[stack.length - 1];
        ctx.currentRow = [];
        ctx.cellOpen = false;
      }
    } else if (tag === 'tr' && isClose) {
      if (stack.length) {
        const ctx = stack[stack.length - 1];
        if (ctx.currentRow) ctx.rows.push(ctx.currentRow);
        ctx.currentRow = null;
        ctx.cellOpen = false;
      }
    } else if ((tag === 'td' || tag === 'th') && !isClose) {
      if (stack.length) {
        const ctx = stack[stack.length - 1];
        if (ctx.currentRow) {
          ctx.currentRow.push('');
          ctx.cellOpen = true;
        }
      }
    } else if ((tag === 'td' || tag === 'th') && isClose) {
      if (stack.length) {
        const ctx = stack[stack.length - 1];
        if (ctx.currentRow && ctx.cellOpen) {
          const i = ctx.currentRow.length - 1;
          ctx.currentRow[i] = cleanHtmlCell(ctx.currentRow[i]);
          ctx.cellOpen = false;
        }
      }
    }
    lastIndex = tagRe.lastIndex;
  }
  return tables;
}

function extractLinesFromHtml(html) {
  const tables = extractTablesFromHtml(html);
  for (const rows of tables) {
    if (rows.length < 2) continue;
    // Try first few rows as the header row (Outlook sometimes prepends an empty TR)
    for (let h = 0; h < Math.min(3, rows.length); h++) {
      const headers = rows[h];
      if (!headers || headers.every(c => !c)) continue;
      const idx = matchHeaders(headers);
      if (idx.mpnIdx < 0) continue;
      const out = [];
      for (let r = h + 1; r < rows.length; r++) {
        const cells = rows[r];
        if (!cells || cells.length === 0) continue;
        const mpn = (cells[idx.mpnIdx] || '').trim();
        if (!mpn) continue;
        const line = { mpn };
        if (idx.qtyIdx >= 0 && cells[idx.qtyIdx]) { const n = Number(String(cells[idx.qtyIdx]).replace(/,/g, '')); if (!isNaN(n) && n > 0) line.qty = n; }
        if (idx.priceIdx >= 0 && cells[idx.priceIdx]) { const n = Number(String(cells[idx.priceIdx]).replace(/[$,\s]/g, '')); if (!isNaN(n) && n > 0) line.price = n; }
        if (idx.mfrIdx >= 0 && cells[idx.mfrIdx]) line.mfrText = cells[idx.mfrIdx];
        if (idx.dateCodeIdx >= 0 && cells[idx.dateCodeIdx]) line.dateCode = cells[idx.dateCodeIdx];
        if (idx.descriptionIdx >= 0 && cells[idx.descriptionIdx]) line.description = cells[idx.descriptionIdx];
        if (idx.cpcIdx >= 0 && cells[idx.cpcIdx]) line.cpc = cells[idx.cpcIdx];
        out.push(line);
      }
      if (out.length > 0) return { lines: out, source: `body html-table (${headers.length} cols)` };
    }
  }
  return null;
}

// Reject "MPN" cells that are obviously footer/signature junk — embedded URLs
// or all-uppercase brand-link text. Caught 2026-05-07 when the inline-HTML
// table parser pulled `FRANCHISED BRANDS<HTTPS://WWW.ASTUTE.GLOBAL/FRANCHISED/>`
// out of an Astute email signature on confirmation-only emails (no real offer
// data) and wrote it as 2 line records per offer.
function looksLikeMpn(s) {
  if (!s) return false;
  const trimmed = String(s).trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  // URL fragments — `<HTTPS://...>` or bare `HTTP://`
  if (/<\s*HTTPS?\s*:/i.test(trimmed)) return false;
  if (/^HTTPS?:\/\//i.test(trimmed)) return false;
  if (/^WWW\./i.test(trimmed)) return false;
  // Anchor-tag fragments leaking through
  if (/<\s*\/?\s*A\s/i.test(trimmed)) return false;
  // Must contain at least one alphanumeric
  if (!/[A-Za-z0-9]/.test(trimmed)) return false;
  return true;
}

function filterRealMpns(result, log) {
  if (!result || !result.lines || result.lines.length === 0) return result;
  const before = result.lines.length;
  const filtered = result.lines.filter(l => looksLikeMpn(l.mpn));
  if (filtered.length !== before) {
    if (log) log(`  filtered ${before - filtered.length} junk MPN line(s) (URL/footer fragments)`);
  }
  if (filtered.length === 0) return null;
  return { ...result, lines: filtered };
}

async function extractFromAttachmentsOrBody(files, body, html, log) {
  for (const f of files) {
    const ext = path.extname(f.filename).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
      try { const r = extractLinesFromXlsx(f.path); return filterRealMpns({ ...r, source: `xlsx attachment ${f.filename}` }, log); }
      catch (e) { log(`  xlsx parse failed on ${f.filename}: ${e.message}`); }
    } else if (ext === '.csv') {
      try { const r = extractLinesFromCsv(f.path); return filterRealMpns({ ...r, source: `csv attachment ${f.filename}` }, log); }
      catch (e) { log(`  csv parse failed on ${f.filename}: ${e.message}`); }
    } else if (ext === '.pdf') {
      try { const r = await extractLinesFromPdf(f.path); return filterRealMpns({ ...r, source: `pdf attachment ${f.filename}` }, log); }
      catch (e) { log(`  pdf parse failed on ${f.filename}: ${e.message}`); }
    }
  }
  // HTML body table — handles inline lists pasted as Outlook tables
  // (preserves empty cells; plaintext flattening loses them).
  if (html) {
    try {
      const r = extractLinesFromHtml(html);
      const filtered = filterRealMpns(r, log);
      if (filtered && filtered.lines.length > 0) return filtered;
    } catch (e) { log(`  html-table parse threw: ${e.message}`); }
  }
  const body0 = extractLinesFromBody(body);
  if (body0) return filterRealMpns(body0, log);
  return null;
}

// ── IMAP helpers ────────────────────────────────────────────────────────────

async function downloadAttachmentsToTmp(client, uid, account) {
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) return { dir: null, files: [], parsed: null };
  const parsed = await simpleParser(msg.source);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `offer-poller-${account}-${uid}-`));
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
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// ── Per-message processor ──────────────────────────────────────────────────

async function processMessage(client, uid, config, log, sendNotice, sourceFolder = 'INBOX') {
  const isRetry = sourceFolder !== 'INBOX';
  log(`processing UID ${uid}${isRetry ? ` [retry from ${sourceFolder}]` : ''}`);
  let tmpDir = null;
  try {
    const { dir, files, parsed } = await downloadAttachmentsToTmp(client, uid, config.account);
    tmpDir = dir;
    if (!parsed) {
      log(`  UID ${uid}: no source`);
      return { uid, status: 'skipped', reason: 'no source' };
    }

    const subject = parsed.subject || '';
    const outerFrom = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
    const body = parsed.text || parsed.html || '';
    log(`  subject="${subject}" from=${outerFrom} attachments=${files.length}`);

    // ── Junk classifier (first attempt only — retries skip the classifier) ──
    // High-confidence junk → silently route to NotOffer.
    // Low-confidence junk → send a single yes/no email, hold in NeedsReview
    //   tagged junk-check-pending. Operator's YES/NO answer determines
    //   whether the next retry sweep moves it to NotOffer (YES = it IS junk)
    //   or force-processes it bypassing the classifier (NO = it's legit).
    if (!isRetry) {
      // forceProcess override means operator already said "no, not junk" — skip classifier
      const fp = overrides.getForceProcess && overrides.getForceProcess(config.account, uid);
      const ig = overrides.getIgnore && overrides.getIgnore(config.account, uid);
      if (ig) {
        log(`  UID ${uid}: operator IGNORE override — routing to NotOffer`);
        breadcrumbs.write({
          cog: 'offer-poller', event: 'ignored-by-operator', account: config.account,
          uid, subject, source: ig.source,
        });
        if (!config.dryRun) {
          try { await client.messageMove(String(uid), 'NotOffer', { uid: true }); } catch (e) {}
          if (overrides.consumeIgnore) overrides.consumeIgnore(config.account, uid);
        }
        return { uid, status: 'ignored-by-operator' };
      }
      if (!fp) {
        const verdict = classifyJunk({ subject, body, outerFrom, attachmentNames: files.map(f => f.filename) });
        if (verdict.tier === 'high-confidence-junk') {
          log(`  UID ${uid}: high-conf junk — silent NotOffer (${verdict.signals.join('; ')})`);
          breadcrumbs.write({
            cog: 'offer-poller', event: 'junk-auto-filtered', account: config.account,
            uid, subject, outerFrom, signals: verdict.signals,
          });
          if (!config.dryRun) await client.messageMove(String(uid), 'NotOffer', { uid: true });
          return { uid, status: 'junk-auto-filtered' };
        }
        if (verdict.tier === 'low-confidence-junk') {
          log(`  UID ${uid}: low-conf junk — sending yes/no email (${verdict.signals.join('; ')})`);
          breadcrumbs.write({
            cog: 'offer-poller', event: 'junk-check-pending', account: config.account,
            uid, subject, outerFrom, signals: verdict.signals,
          });
          await sendNotice({
            force: true,  // bypass the verbose-email suppression — this IS the operator question
            subject: `Junk check — UID ${uid}: ${subject || '(no subject)'}`,
            html: `<p>I'm not sure if this email is an offer or junk. Please reply with <b>YES</b> (it's junk, drop it) or <b>NO</b> (it's a real offer, process it).</p>
                   <p><b>UID:</b> ${uid}<br/>
                      <b>From:</b> ${escapeHtml(outerFrom)}<br/>
                      <b>Subject:</b> ${escapeHtml(subject)}<br/>
                      <b>Why I'm asking:</b> ${escapeHtml(verdict.signals.join('; '))}</p>
                   <p>Body preview:</p>
                   <pre style="background:#f5f5f5;padding:8px;font-size:11px">${escapeHtml((body || '').slice(0, 600))}</pre>
                   <p style="color:#888;font-size:11px">Reply <code>YES: ${uid}</code> or <code>NO: ${uid}</code> on its own line. Or just <code>YES</code> / <code>NO</code> if you reply to this email directly (subject line carries the UID).</p>`,
          });
          if (!config.dryRun) await client.messageMove(String(uid), 'NeedsReview', { uid: true });
          return { uid, status: 'junk-check-pending' };
        }
        // tier === 'likely-offer' — fall through to normal processing
      } else {
        log(`  UID ${uid}: forceProcess override active — bypassing classifier`);
        breadcrumbs.write({
          cog: 'offer-poller', event: 'forceProcess-applied', account: config.account,
          uid, source: fp.source,
        });
        if (overrides.consumeForceProcess) overrides.consumeForceProcess(config.account, uid);
      }
    }

    // Partner resolution — operator override (from reply-parser) wins
    const override = overrides.getPartner(config.account, uid);
    let partner;
    if (override) {
      const looked = lookupById(override.bpId);
      if (looked) {
        partner = { ...looked, matched: true, tier: -1, tierName: 'override', source: `operator override (${override.source})` };
        log(`  UID ${uid}: applying operator partner override → ${partner.name} (BP=${partner.c_bpartner_id})`);
        breadcrumbs.write({
          cog: 'offer-poller', event: 'partner-override-applied', account: config.account,
          uid, bpId: override.bpId, source: override.source,
        });
      } else {
        log(`  UID ${uid}: operator override BP=${override.bpId} not found in DB; falling back to email-based resolution`);
        partner = resolvePartnerForMessage({ outerFrom, body, subject });
      }
    } else {
      partner = resolvePartnerForMessage({ outerFrom, body, subject });
    }
    if (!partner.matched) {
      log(`  UID ${uid}: partner unresolved${isRetry ? ' (still — leaving in NeedsPartner)' : ''}`);
      // Only emit the breadcrumb on FIRST failure. Retries that still fail
      // would otherwise spam the breadcrumbs log every 30 min for stuck
      // messages — the operator already knows from the prior digest.
      if (!isRetry) {
        breadcrumbs.write({
          cog: 'offer-poller', event: 'needs-partner', account: config.account,
          uid, subject, outerFrom,
        });
        await sendNotice({
          subject: `Offer Poller [${config.account}] — NeedsPartner: "${subject}"`,
          html: `<p>Could not resolve a partner for this offer email.</p>
                 <p><b>From:</b> ${escapeHtml(outerFrom)}<br/>
                    <b>Subject:</b> ${escapeHtml(subject)}<br/>
                    <b>UID:</b> ${uid}<br/>
                    <b>Inbox:</b> ${escapeHtml(config.inboxEmail)}</p>
                 <p>Reply with <code>PARTNER: ${uid} = &lt;BP id or company name&gt;</code> to resolve.</p>`,
        });
        if (!config.dryRun) await client.messageMove(String(uid), 'NeedsPartner', { uid: true });
      }
      return { uid, status: 'needs-partner' };
    }
    log(`  partner: ${partner.name} (BP=${partner.c_bpartner_id}) via ${partner.source}`);

    // Line extraction — operator LINES override (from reply-parser) wins.
    // If operator pasted line data in their reply to a NeedsReview email, use
    // those lines directly and skip attachment/body extraction entirely.
    const linesOverride = overrides.getLines && overrides.getLines(config.account, uid);
    let extracted;
    if (linesOverride && linesOverride.lines && linesOverride.lines.length > 0) {
      extracted = { lines: linesOverride.lines, source: `operator LINES override (${linesOverride.source})` };
      log(`  UID ${uid}: applying operator LINES override → ${extracted.lines.length} line(s)`);
      breadcrumbs.write({
        cog: 'offer-poller', event: 'lines-override-applied', account: config.account,
        uid, lineCount: extracted.lines.length, source: linesOverride.source,
      });
    } else {
      extracted = await extractFromAttachmentsOrBody(files, body, parsed.html, log);
    }
    if (!extracted || !extracted.lines || extracted.lines.length === 0) {
      log(`  UID ${uid}: no lines extractable${isRetry ? ' (still — leaving in NeedsReview)' : ''}`);
      // Only emit needs-review breadcrumb on FIRST failure. Retries that still fail
      // would otherwise spam the digest every cycle for stuck messages.
      if (!isRetry) {
        breadcrumbs.write({
          cog: 'offer-poller', event: 'needs-review', account: config.account,
          uid, subject, outerFrom, partner: { id: partner.c_bpartner_id, name: partner.name },
          reason: 'no-lines',
          attachmentNames: files.map(f => f.filename),
        });
        if (!config.dryRun) await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      }
      return { uid, status: 'needs-review', reason: 'no lines' };
    }
    log(`  extracted ${extracted.lines.length} lines from ${extracted.source}`);

    // Offer type. Resolution order:
    //   1. Explicit body hint "Type: Broker" / "Type: Customer Excess" wins.
    //   2. Otherwise start from the inbox default (e.g. excess@ → Customer Excess).
    //   3. Heuristic flip: if the resolved partner is vendor-only (isvendor=Y,
    //      iscustomer=N) and we're about to write Customer Excess, flip to
    //      Broker Stock Offer — this is a broker liquidation list, not a
    //      customer offering excess inventory. Caught Future Electronics
    //      "Daily Liquidation List" landing as Customer Excess on 2026-05-05.
    let offerType = extractOfferTypeHint(body) || config.defaultOfferType;
    if (
      offerType === 'Customer Excess' &&
      partner.iscustomer === 'N' && partner.isvendor === 'Y'
    ) {
      log(`  vendor-only BP detected (${partner.name}); flipping offer type Customer Excess → Broker Stock Offer`);
      breadcrumbs.write({
        cog: 'offer-poller', event: 'offer-type-flipped', account: config.account,
        uid, from: 'Customer Excess', to: 'Broker Stock Offer',
        partner: { id: partner.c_bpartner_id, name: partner.name },
        reason: 'partner is vendor-only',
      });
      offerType = 'Broker Stock Offer';
    }

    // Description
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const partnerSlug = partner.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const description = `${today}-${partnerSlug}-${config.account}Poller`;

    // Cross-forward dedup. The same source email is sometimes forwarded to
    // excess@ by multiple Astute employees in close succession (or twice by
    // the same employee). Without this guard, we write two identical offers
    // to OT for the same customer. Discovered 2026-05-07: "FW: 5AGXMB5G4F40C5G"
    // and "FW: Matrix comsec - Search key#1009991" each produced 2 dup offers.
    // Heuristic: same BP + same offer type + same line count + same first/last
    // MPN within the last 6 hours = duplicate. Cheap signal, very few false
    // positives (an honest re-submission of the same excess list ~6h apart
    // is rare; if it happens, operator can re-trigger via PARTNER override).
    const sortedMpns = extracted.lines.map(l => String(l.mpn || '').trim()).filter(Boolean).sort();
    const firstMpn = sortedMpns[0] || '';
    const lastMpn = sortedMpns[sortedMpns.length - 1] || '';
    const offerTypeId = (typeof offerType === 'number')
      ? offerType
      : ({ 'Customer Excess': 1000000, 'Broker Stock Offer': 1000001, 'Franchise Offers': 1000002, 'Customer Lead Time Buy': 1000003 }[offerType] || null);
    if (offerTypeId && firstMpn && lastMpn) {
      const { execSync } = require('child_process');
      const dedupSql = `
        SELECT o.value, o.chuboe_offer_id
        FROM adempiere.chuboe_offer o
        WHERE o.isactive='Y'
          AND o.c_bpartner_id=${parseInt(partner.c_bpartner_id, 10)}
          AND o.chuboe_offer_type_id=${offerTypeId}
          AND o.created >= NOW() - INTERVAL '6 hours'
          AND (
            SELECT COUNT(*) FROM adempiere.chuboe_offer_line ol
            WHERE ol.chuboe_offer_id=o.chuboe_offer_id AND ol.isactive='Y'
          ) = ${extracted.lines.length}
          AND EXISTS (
            SELECT 1 FROM adempiere.chuboe_offer_line ol
            WHERE ol.chuboe_offer_id=o.chuboe_offer_id AND ol.isactive='Y'
              AND ol.chuboe_mpn = '${firstMpn.replace(/'/g, "''")}'
          )
          AND EXISTS (
            SELECT 1 FROM adempiere.chuboe_offer_line ol
            WHERE ol.chuboe_offer_id=o.chuboe_offer_id AND ol.isactive='Y'
              AND ol.chuboe_mpn = '${lastMpn.replace(/'/g, "''")}'
          )
        LIMIT 1
      `;
      try {
        const dedupOut = execSync(`psql -A -t -c "${dedupSql.replace(/\n\s+/g, ' ').replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
        const trimmed = dedupOut.trim();
        if (trimmed) {
          const [dupSk, dupId] = trimmed.split('|');
          log(`  cross-forward dup detected: existing offer ${dupSk} (id ${dupId}) has same BP+type+lineCount+first/last MPN within 6h. Skipping write.`);
          breadcrumbs.write({
            cog: 'offer-poller', event: 'dup-skipped', account: config.account,
            uid, subject, partner: { id: partner.c_bpartner_id, name: partner.name },
            existingOfferSearchKey: dupSk, existingOfferId: Number(dupId),
            lineCount: extracted.lines.length,
          });
          if (!config.dryRun) await client.messageMove(String(uid), 'Processed', { uid: true });
          return { uid, status: 'dup-skipped', existingOfferSearchKey: dupSk };
        }
      } catch (e) {
        log(`  dedup check threw: ${e.message} (proceeding with write)`);
      }
    }

    if (config.dryRun) {
      log(`  [dry-run] would writeOffer BP=${partner.c_bpartner_id} type=${offerType} lines=${extracted.lines.length}`);
      breadcrumbs.write({
        cog: 'offer-poller', event: 'dry-run', account: config.account,
        uid, subject, partner: { id: partner.c_bpartner_id, name: partner.name },
        offerType, lineCount: extracted.lines.length, source: extracted.source,
      });
      return { uid, status: 'dry-run', lines: extracted.lines.length };
    }

    // Write offer
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
      breadcrumbs.write({
        cog: 'offer-poller', event: 'write-failed', account: config.account,
        uid, subject, partner: { id: partner.c_bpartner_id, name: partner.name },
        error: err.message,
      });
      await sendNotice({
        subject: `Offer Poller [${config.account}] — WRITE FAILED: ${partner.name}`,
        html: `<p style="color:#b00">writeOffer threw for ${escapeHtml(partner.name)}.</p>
               <p><b>Error:</b> ${escapeHtml(err.message)}</p>`,
      });
      await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      return { uid, status: 'error', reason: err.message };
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const clean = result.offerId != null
      && result.linesWritten === extracted.lines.length
      && result.errors.length === 0;
    log(`  writeOffer done: searchKey=${result.searchKey} offerId=${result.offerId} lines=${result.linesWritten}/${extracted.lines.length} errors=${result.errors.length} elapsed=${elapsed}s`);

    if (clean) {
      await client.messageMove(String(uid), 'Processed', { uid: true });
      // Consume any operator overrides that contributed to this success
      if (override) overrides.consumePartner(config.account, uid);
      if (linesOverride && overrides.consumeLines) overrides.consumeLines(config.account, uid);
      breadcrumbs.write({
        cog: 'offer-poller', event: 'loaded', account: config.account,
        uid, subject, outerFrom,
        partner: { id: partner.c_bpartner_id, name: partner.name, source: partner.source },
        offerId: result.offerId, searchKey: result.searchKey,
        offerType, lineCount: result.linesWritten, mpnsWritten: result.mpnsWritten,
        elapsedSec: elapsed, source: extracted.source,
        overrideUsed: !!override,
      });

      // ── Type-router handoff ────────────────────────────────────────────
      try {
        await router.dispatch({
          offerId: result.offerId,
          searchKey: result.searchKey,
          offerType,
          partner: { id: partner.c_bpartner_id, name: partner.name },
          lineCount: result.linesWritten,
          source: 'offer-poller',
        });
      } catch (e) {
        log(`  router.dispatch threw: ${e.message}`);
        breadcrumbs.write({
          cog: 'offer-poller', event: 'router-failed', account: config.account,
          offerId: result.offerId, searchKey: result.searchKey, error: e.message,
        });
      }

      return { uid, status: 'loaded', offerId: result.offerId, searchKey: result.searchKey, lines: result.linesWritten };
    } else {
      await client.messageMove(String(uid), 'NeedsReview', { uid: true });
      breadcrumbs.write({
        cog: 'offer-poller', event: 'partial-write', account: config.account,
        uid, subject, partner: { id: partner.c_bpartner_id, name: partner.name },
        offerId: result.offerId, searchKey: result.searchKey,
        linesWritten: result.linesWritten, linesAttempted: extracted.lines.length,
        errorCount: result.errors.length, errors: result.errors.slice(0, 5),
      });
      await sendNotice({
        subject: `Offer Poller [${config.account}] — PARTIAL: ${partner.name} (${result.errors.length} errors)`,
        html: `<p style="color:#b60">Offer <b>${escapeHtml(result.searchKey || '(no key)')}</b> loaded with errors.</p>
               <pre style="background:#fee;padding:8px;font-size:11px">${escapeHtml(result.errors.slice(0, 20).join('\n'))}</pre>`,
      });
      return { uid, status: 'partial', offerId: result.offerId, errors: result.errors.length };
    }
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

// ── Public entry point ─────────────────────────────────────────────────────

async function runOfferPoller(opts = {}) {
  const config = {
    account: opts.account || 'excess',
    inboxEmail: opts.inboxEmail || ACCOUNT_TO_EMAIL[opts.account] || null,
    defaultOfferType: opts.defaultOfferType || 'Customer Excess',
    lockName: opts.lockName || `offer-poller-${opts.account || 'excess'}`,
    fallbackSender: opts.fallbackSender || process.env.EXCESS_FALLBACK_SENDER || 'stockRFQ@orangetsunami.com',
    dryRun: !!opts.dryRun,
    uid: opts.uid || null,
    max: opts.max || null,
  };

  if (!config.inboxEmail) {
    throw new Error(`offer-poller: no inboxEmail configured for account '${config.account}'. Add to ACCOUNT_TO_EMAIL.`);
  }
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) throw new Error('WORKMAIL_PASS not set in ~/workspace/.env');

  const log = (...a) => console.log(new Date().toISOString(), '-', `[${config.account}]`, ...a);

  // Acquire lock
  const lock = acquireLock(config.lockName);
  if (!lock.acquired) {
    log(`previous run still active (pid=${lock.pid}, held since ${lock.heldSince}, age ${Math.round(lock.ageMs / 1000)}s) — skipping`);
    breadcrumbs.write({ cog: 'offer-poller', event: 'lock-skip', account: config.account, ageMs: lock.ageMs, pid: lock.pid });
    return { skipped: 'locked' };
  }

  // Notice sender — suppressed by default to avoid per-offer email spam.
  // All per-offer outcomes (loaded / needs-partner / needs-review / write-failed /
  // partial / unexpected-error) are written as breadcrumbs and surface in the
  // digest's section-4 exceptions table. Set OFFER_POLLER_VERBOSE_EMAIL=1 in
  // the cron env to re-enable per-offer emails for debugging.
  async function sendNotice({ subject, html, force = false }) {
    if (config.dryRun) { log(`[dry-run] would send: ${subject}`); return; }
    const verboseEnabled = process.env.OFFER_POLLER_VERBOSE_EMAIL === '1';
    if (!force && !verboseEnabled) {
      log(`(notice suppressed; visible in next digest) "${subject}"`);
      return;
    }
    try {
      await sendWithFallback({
        primary:  { from: config.inboxEmail,    pass, displayName: `Offer Poller (${config.account})` },
        fallback: { from: config.fallbackSender, pass, displayName: `Offer Poller (${config.account})` },
        mail: { to: JAKE_EMAIL, subject, html },
        log,
      });
    } catch (e) {
      log('notice email failed:', e.message);
    }
  }

  log(`starting (dryRun=${config.dryRun}, uid=${config.uid || 'all unseen'}, max=${config.max || 'none'})`);
  breadcrumbs.write({ cog: 'offer-poller', event: 'run-start', account: config.account, dryRun: config.dryRun });

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: config.inboxEmail, pass },
    logger: false,
  });

  let processed = 0;
  const counts = { loaded: 0, 'needs-partner': 0, 'needs-review': 0, 'dry-run': 0, error: 0, partial: 0, skipped: 0 };

  try {
    try {
      await client.connect();
    } catch (err) {
      log(`FATAL: cannot connect to ${config.inboxEmail}: ${err.message}`);
      breadcrumbs.write({ cog: 'offer-poller', event: 'connect-failed', account: config.account, error: err.message });
      return { error: 'connect', detail: err.message };
    }

    for (const f of ['Processed', 'NeedsPartner', 'NeedsReview', 'NotOffer']) {
      try { await client.mailboxCreate(f); } catch (e) { /* exists */ }
    }

    // ── Pass 1: process UNSEEN in INBOX (first attempts) ──────────────────
    const inboxLock = await client.getMailboxLock('INBOX');
    try {
      let uids;
      if (config.uid) {
        uids = [config.uid];
      } else {
        const search = await client.search({ seen: false }, { uid: true });
        uids = search || [];
      }
      if (config.max && uids.length > config.max) {
        log(`capping at --max ${config.max} of ${uids.length} UNSEEN`);
        uids = uids.slice(0, config.max);
      }
      log(`pass 1 (INBOX): ${uids.length} UNSEEN message(s) to process`);

      for (const uid of uids) {
        processed++;
        try {
          const r = await processMessage(client, uid, config, log, sendNotice, 'INBOX');
          counts[r.status] = (counts[r.status] || 0) + 1;
        } catch (err) {
          counts.error++;
          log(`  UID ${uid}: unexpected error: ${err.message}`);
          console.error(err.stack);
          // Move to NeedsPartner so the next cycle's retry sweep can recover.
          // Leaving the message in INBOX with Seen flag would make it invisible
          // to both UNSEEN scans and the retry sweep (which targets NeedsPartner).
          if (!config.dryRun) {
            try {
              await client.messageMove(String(uid), 'NeedsPartner', { uid: true });
            } catch (e) {
              // Move failed (already moved? folder issue?). Mark Seen as fallback.
              try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (e2) {}
            }
          }
          breadcrumbs.write({ cog: 'offer-poller', event: 'unexpected-error', account: config.account, uid, error: err.message });
        }
      }
    } finally {
      inboxLock.release();
    }

    // ── Pass 2: retry sweep over NeedsPartner ──────────────────────────────
    // Why: previous failures may now be resolvable because (a) operator replied
    // with a PARTNER directive (override is in the file), or (b) infrastructure
    // recovered (psql came back, partner-lookup now works against an email that
    // was unresolvable when the previous run hit a transient failure). Retrying
    // every cycle means the system self-heals without manual intervention.
    //
    // Bounded: capped at config.maxRetries (default 50) per cycle to avoid
    // burning hours on a stuck NeedsPartner backlog.
    if (!config.uid && !config.dryRun) {
      const retryCap = config.maxRetries || 50;
      const npLock = await client.getMailboxLock('NeedsPartner');
      let retried = 0, recovered = 0;
      try {
        const npStatus = await client.status('NeedsPartner', { messages: true });
        const npCount = npStatus.messages || 0;
        if (npCount === 0) {
          log(`pass 2 (NeedsPartner): empty, nothing to retry`);
        } else {
          // Fetch all UIDs in NeedsPartner (typically small)
          const allUids = [];
          for await (const m of client.fetch('1:*', { uid: true })) {
            allUids.push(m.uid);
          }
          const retryUids = allUids.slice(0, retryCap);
          log(`pass 2 (NeedsPartner): ${allUids.length} stuck message(s), retrying ${retryUids.length} (cap ${retryCap})`);

          for (const uid of retryUids) {
            retried++;
            try {
              const r = await processMessage(client, uid, config, log, sendNotice, 'NeedsPartner');
              if (r.status === 'loaded') recovered++;
              counts[r.status] = (counts[r.status] || 0) + 1;
            } catch (err) {
              counts.error++;
              log(`  UID ${uid} retry: unexpected error: ${err.message}`);
              breadcrumbs.write({ cog: 'offer-poller', event: 'retry-error', account: config.account, uid, error: err.message });
            }
          }
          log(`pass 2 (NeedsPartner) done: retried=${retried}, recovered=${recovered}, still-stuck=${retried - recovered}`);
          if (recovered > 0) {
            breadcrumbs.write({
              cog: 'offer-poller', event: 'retry-sweep-summary', sweep: 'NeedsPartner',
              account: config.account, retried, recovered, stillStuck: retried - recovered,
            });
          }
        }
      } finally {
        npLock.release();
      }
    }

    // ── Pass 3: retry sweep over NeedsReview ──────────────────────────────
    // Why: operator may have replied with LINES (paste line data) or IGNORE
    // (mark as junk). Or a code fix may now allow extraction to succeed.
    // Same bounded retry pattern as Pass 2.
    if (!config.uid && !config.dryRun) {
      const retryCap = config.maxRetries || 50;
      const nrLock = await client.getMailboxLock('NeedsReview');
      let retried = 0, recovered = 0, ignored = 0;
      try {
        const nrStatus = await client.status('NeedsReview', { messages: true });
        const nrCount = nrStatus.messages || 0;
        if (nrCount === 0) {
          log(`pass 3 (NeedsReview): empty, nothing to retry`);
        } else {
          const allUids = [];
          for await (const m of client.fetch('1:*', { uid: true })) {
            allUids.push(m.uid);
          }
          const retryUids = allUids.slice(0, retryCap);
          log(`pass 3 (NeedsReview): ${allUids.length} stuck message(s), retrying ${retryUids.length} (cap ${retryCap})`);

          for (const uid of retryUids) {
            // IGNORE override → move to NotOffer immediately, no need to re-process.
            const ig = overrides.getIgnore && overrides.getIgnore(config.account, uid);
            if (ig) {
              try {
                await client.messageMove(String(uid), 'NotOffer', { uid: true });
                if (overrides.consumeIgnore) overrides.consumeIgnore(config.account, uid);
                breadcrumbs.write({
                  cog: 'offer-poller', event: 'ignored-by-operator-on-retry',
                  account: config.account, uid, source: ig.source,
                });
                ignored++;
                counts['ignored-by-operator'] = (counts['ignored-by-operator'] || 0) + 1;
                continue;
              } catch (e) {
                log(`  UID ${uid}: IGNORE move failed: ${e.message}`);
              }
            }
            retried++;
            try {
              const r = await processMessage(client, uid, config, log, sendNotice, 'NeedsReview');
              if (r.status === 'loaded') recovered++;
              counts[r.status] = (counts[r.status] || 0) + 1;
            } catch (err) {
              counts.error++;
              log(`  UID ${uid} retry: unexpected error: ${err.message}`);
              breadcrumbs.write({ cog: 'offer-poller', event: 'retry-error', account: config.account, uid, error: err.message });
            }
          }
          log(`pass 3 (NeedsReview) done: retried=${retried}, recovered=${recovered}, ignored=${ignored}, still-stuck=${retried - recovered}`);
          if (recovered > 0 || ignored > 0) {
            breadcrumbs.write({
              cog: 'offer-poller', event: 'retry-sweep-summary', sweep: 'NeedsReview',
              account: config.account, retried, recovered, ignored, stillStuck: retried - recovered,
            });
          }
        }
      } finally {
        nrLock.release();
      }
    }
  } finally {
    try { await client.logout(); } catch (e) {}
    releaseLock(config.lockName);
  }

  log(`done. processed=${processed} ${JSON.stringify(counts)}`);
  breadcrumbs.write({ cog: 'offer-poller', event: 'run-end', account: config.account, processed, counts });
  return { processed, counts };
}

module.exports = {
  runOfferPoller,
  ACCOUNT_TO_EMAIL,
  linesPreviewHtml,
  // Exposed for unit tests / replay tools.
  extractLinesFromHtml,
  extractLinesFromBody,
  extractTablesFromHtml,
  matchHeaders,
};
