#!/usr/bin/env node
/**
 * One-shot batch processor for the stockrfq inbox backlog (~130 unseen UIDs).
 * Functionally equivalent to invoking the email-workflow-poller CLI once per
 * UID; consolidated to avoid 250+ child-process spawns inside a single agent
 * tick. Uses the same shared modules: partner-lookup, mfr-lookup, rfq-writer,
 * workflow-actions/stockrfq.
 *
 * Per-message logic mirrors the daemon's pattern: subject classifier → forwarded
 * sender extraction → MPN+qty regex (subject first, body second) → partner
 * resolve → writeRFQ → IMAP move.
 */

'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const WORKFLOW_ROOT = path.resolve(__dirname, '../../../shared');
const workflow = require(path.join(WORKFLOW_ROOT, 'workflow-actions/stockrfq.js'));
const { resolvePartner } = require(path.join(WORKFLOW_ROOT, 'partner-lookup'));
const { lookupMfr } = require(path.join(WORKFLOW_ROOT, 'mfr-lookup'));
const breadcrumbs = require(path.join(WORKFLOW_ROOT, 'breadcrumbs'));
const { writeRFQ } = require(path.join(WORKFLOW_ROOT, 'rfq-writer'));

const INBOX = workflow.inbox;
const UNQUALIFIED_BROKER_ID = workflow.constants.UNQUALIFIED_BROKER_ID;
const JAKE_USER_ID = workflow.constants.JAKE_USER_ID;
const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

if (!WORKMAIL_PASS) {
  console.error('FATAL: WORKMAIL_PASS not set');
  process.exit(1);
}

// UIDs passed as arg (comma-separated). If none, process all unseen.
const UID_ARG = process.argv[2];
const TARGET_UIDS = UID_ARG ? UID_ARG.split(',').map(u => parseInt(u, 10)).filter(Boolean) : null;

// ─── Subject classifier (legacy patterns) ───────────────────────────────────

const NOT_RFQ_PATTERNS = [
  /you have new held messages/i,
  /out of office/i,
  /automatic reply/i,
  /auto[- ]?reply/i,
  /delivery notification/i,
  /read receipt/i,
  /mailer[- ]daemon/i,
  /postmaster/i,
  /unsubscribe/i,
  /newsletter/i,
];

const ORDER_FOLLOWUP_PATTERNS = [
  /\bPO\b\s*\d{5,}/i,
  /\bCOV\d{5,}/i,
  /\bSO\d{5,}/i,
  /\bshipped\b|tracking number|has been shipped/i,
  /invoice|payment|remittance/i,
  /following up|follow up|checking in/i,
];

function classifySubject(subject) {
  if (NOT_RFQ_PATTERNS.some(p => p.test(subject))) return 'not_rfq';
  if (ORDER_FOLLOWUP_PATTERNS.some(p => p.test(subject))) return 'not_rfq';
  return null; // unknown → look at body
}

// ─── Forwarded headers / sender extraction ──────────────────────────────────

function extractForwardedSender(body) {
  if (!body) return null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!/^From:/i.test(trimmed)) continue;
    const emailMatch = trimmed.match(/[\w.\-+]+@[\w.\-]+\.\w+/);
    if (!emailMatch) continue;
    const lookahead = lines.slice(i + 1, i + 6).join('\n');
    const isForwardHeader =
      /^\s*Sent:/im.test(lookahead) ||
      /^\s*To:/im.test(lookahead) ||
      /^\s*Subject:/im.test(lookahead);
    if (!isForwardHeader) continue;
    if (/@astutegroup\.com$/i.test(emailMatch[0])) continue;
    let email = emailMatch[0];
    const ncMatch = trimmed.match(/\[([\w.\-+]+@[\w.\-]+\.\w+)\]/);
    if (ncMatch && /netcomponents\.com$/i.test(email)) email = ncMatch[1];
    const nameMatch = trimmed.match(/From:\s*(.+?)\s*[<\[]/i) || trimmed.match(/From:\s*(.+?)$/i);
    return { email, name: nameMatch ? nameMatch[1].trim() : '' };
  }
  return null;
}

// ─── MPN + qty extraction ───────────────────────────────────────────────────

// Looks like a real MPN: starts with letter or digit, length >=4, has at least
// one letter (filters out pure numbers like "10000").
const MPN_RE = /\b([A-Z0-9][A-Z0-9\-\/.+:]{2,40})\b/gi;

// Junk MPN filters
function isJunkMpn(s) {
  if (!s) return true;
  const u = s.toUpperCase();
  if (/^HTTPS?:/i.test(u) || /^WWW\./i.test(u)) return true;
  if (/^[0-9]+$/.test(u)) return true; // pure number
  if (!/[A-Z]/.test(u)) return true; // no letter
  if (u.length < 4) return true;
  if (/^(THE|FROM|SUBJECT|SENT|TO|CC|RE|FW|FWD|EMAIL|MPN|QTY|PCS|MFR|MANUFACTURER|PART|NUMBER|QUANTITY|DATE|CODE|ROHS|BEST|REGARDS|THANK|THANKS|PLEASE|HELLO|DEAR|HI|TEAM|RFQ|QUOTE|STOCK|LEAD|TIME|OFFER|ACCEPTABLE|AVAILABLE|FEEDBACK|BUYER|SOURCING|PURCHASING|MATERIALS|ENGINEER|MARK|SIGNATURE|HTTP|WWW|MAILTO|HTML|UTF|ENCODING|DESCRIPTION|IC|MOSFET|RESISTOR|CAPACITOR|DIODE|TRANSISTOR|REGULATOR|CONNECTOR)$/i.test(u)) return true;
  return false;
}

// Parse "10k", "10,000", "10000pcs"
function parseQty(s) {
  if (s == null) return null;
  let str = String(s).trim().toLowerCase().replace(/[,\s]/g, '');
  // Strip suffixes
  str = str.replace(/pcs?$|ea$|units?$|pc$/i, '');
  const kMatch = str.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  const n = parseInt(str, 10);
  return isFinite(n) ? n : null;
}

// Extract from a single subject like "FW: LM5022MM/NOPB 10000pcs" or
// "FW: ❗TP  #LIS3DHTR    47894pcs"
function extractFromSubjectLine(subject) {
  let s = subject || '';
  s = s.replace(/^(FW|Fwd|Re):\s*/gi, '').replace(/^(FW|Fwd|Re):\s*/gi, '');
  s = s.replace(/[❗#]/g, ' ').replace(/^\[External\]\s*/i, '').replace(/^TP\s+/i, '');

  // NetComponents-style: "RFQ from netCOMPONENTS Member (Vendor | MPN)"
  const ncMatch = s.match(/RFQ\s+from\s+netCOMPONENTS\s+Member\s*\(([^|]+)\|\s*([^)]+)\)/i);
  if (ncMatch) {
    return [{ mpn: ncMatch[2].trim(), qty: 0, vendorHint: ncMatch[1].trim() }];
  }

  // Pattern: "RFQ on <MPN> from <Vendor>"
  const rfqOnMatch = s.match(/RFQ\s+on\s+([^\s]+)\s+from\s+(.+)/i);
  if (rfqOnMatch) return [{ mpn: rfqOnMatch[1].trim(), qty: 0, vendorHint: rfqOnMatch[2].trim() }];

  // Pattern: "Request for Offer – <MPN> | <MFR>"
  const rfoMatch = s.match(/Request for (?:Offer|Quote|Quotation)[^a-z0-9]+([A-Z0-9][A-Z0-9\-\/.+:]+)\s*\|\s*(.+)/i);
  if (rfoMatch) return [{ mpn: rfoMatch[1].trim(), qty: 0, mfr: rfoMatch[2].trim() }];

  // Generic: pick first MPN candidate + first qty number
  const candidates = (s.match(MPN_RE) || []).filter(m => !isJunkMpn(m));
  if (!candidates.length) return [];
  const mpn = candidates[0];

  // Look for qty after the MPN in the subject
  const after = s.split(mpn).slice(1).join(mpn);
  const qtyMatch = after.match(/(\d{1,3}(?:[,\s]\d{3})+|\d+\s*[kK]|\d{2,7})\s*(?:PCS|pcs|EA|UNITS?)?/);
  const qty = qtyMatch ? parseQty(qtyMatch[1]) : 0;
  return [{ mpn, qty: qty || 0 }];
}

// Extract from body — handles tables (MPN,Qty) and prose
function extractFromBody(body, subjectMpn) {
  if (!body) return [];
  const text = body.replace(/\r/g, '');

  // 1. Look for "MPN: X" / "Part Number: X" / "Quantity: N" pairs
  const labeledMpn = text.match(/(?:MPN|Mfr Part(?:\s*Number)?|Part Number|P\/N)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.+:]{3,40})/i);
  const labeledQty = text.match(/(?:Quantity|Qty|QTY)\s*[:#]?\s*([\d,kK]+)\s*(?:pcs|ea|units?)?/i);
  if (labeledMpn) {
    const mpn = labeledMpn[1].trim();
    if (!isJunkMpn(mpn)) {
      const qty = labeledQty ? parseQty(labeledQty[1]) : 0;
      return [{ mpn, qty: qty || 0 }];
    }
  }

  // 2a. VERTICAL TABLE: each cell on its own line. Detect by finding the
  // header sequence "MPN", optional "MFR/Manufacturer/Description", "Qty/Quantity"
  // (each on a separate line) and inferring column count from how many header
  // lines appear before the first data row. After the header, group lines into
  // chunks of N (column count) and treat:
  //   - line 0 → MPN
  //   - line 1..N-2 → desc / mfr (last one wins as mfr)
  //   - line N-1 → qty
  const vertRows = (() => {
    const allLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    // Look for an MPN header followed within a few lines by a Qty header
    let mpnIdx = -1, qtyIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
      if (mpnIdx < 0 && /^MPN$/i.test(allLines[i])) mpnIdx = i;
      else if (mpnIdx >= 0 && qtyIdx < 0 && /^(Qty|Quantity)$/i.test(allLines[i])) {
        qtyIdx = i;
        break;
      }
    }
    if (mpnIdx < 0 || qtyIdx < 0) return [];
    const colCount = (qtyIdx - mpnIdx) + 1;
    if (colCount < 2 || colCount > 8) return [];
    const rows = [];
    let i = qtyIdx + 1;
    const mfrIdxInRow = colCount === 3 ? 1 : (colCount === 4 ? 1 : -1);
    while (i + colCount - 1 < allLines.length) {
      const rowLines = allLines.slice(i, i + colCount);
      const rowMpn = rowLines[0];
      const rowQty = rowLines[colCount - 1];
      // Validate
      if (!/^[A-Z0-9][A-Z0-9\-\/.+:]{2,40}$/i.test(rowMpn) || isJunkMpn(rowMpn)) break;
      const qty = parseQty(rowQty);
      if (qty == null) break;
      const row = { mpn: rowMpn, qty };
      if (mfrIdxInRow >= 0 && rowLines[mfrIdxInRow]) row.mfr = rowLines[mfrIdxInRow];
      rows.push(row);
      i += colCount;
    }
    return rows;
  })();
  if (vertRows.length >= 1) {
    const seen = new Set();
    const out = [];
    for (const r of vertRows) {
      const key = r.mpn.toUpperCase();
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    if (out.length >= 2) return out;
    // single row from vertical table — accept too
    if (out.length === 1 && out[0].qty > 0) return out;
  }

  // 2b. Horizontal tabular: "<MPN>  <desc>  <qty>" rows on a single line.
  const tableRows = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 4 && l.length < 200);
  for (const line of lines) {
    const tokens = line.split(/\s{2,}|\t|\s*\|\s*/);
    if (tokens.length >= 2) {
      const mpnTok = tokens.find(t => /^[A-Z0-9][A-Z0-9\-\/.+:]{3,40}$/i.test(t) && !isJunkMpn(t));
      const qtyTok = [...tokens].reverse().find(t => /^[\d,]{2,12}$/.test(t.replace(/[\s,]/g, '')));
      if (mpnTok && qtyTok) {
        const qty = parseQty(qtyTok);
        if (qty != null && qty > 0 && qty < 100_000_000) {
          tableRows.push({ mpn: mpnTok, qty });
        }
      }
    }
  }
  if (tableRows.length >= 2) {
    const seen = new Set();
    const out = [];
    for (const r of tableRows) {
      const key = r.mpn.toUpperCase();
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    return out;
  }

  // 3. Fall back to single MPN+qty in body — search for a number near the
  // subject's MPN.
  if (subjectMpn) {
    const re = new RegExp(`${subjectMpn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,200}?(\\d{1,3}(?:[,]\\d{3})*|\\d+\\s*[kK]|\\d{2,7})\\s*(?:PCS|pcs|EA|UNITS?|pieces?)`, 'i');
    const m = text.match(re);
    if (m) {
      const qty = parseQty(m[1]);
      if (qty != null && qty > 0) return [{ mpn: subjectMpn, qty }];
    }
  }
  return [];
}

// ─── Per-UID processing ─────────────────────────────────────────────────────

async function processUid(client, uid) {
  const result = { uid, action: null, reason: null, customer: null, lines: 0, rfqId: null, error: null };

  let parsed;
  try {
    const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) { result.action = 'error'; result.error = 'fetch failed'; return result; }
    parsed = await simpleParser(msg.source);
  } catch (err) {
    result.action = 'error'; result.error = `read: ${err.message}`; return result;
  }

  const subject = parsed.subject || '';
  const body = parsed.text || '';

  // 1. Subject classifier
  const subjectClass = classifySubject(subject);
  if (subjectClass === 'not_rfq') {
    return { ...result, action: 'not_rfq', reason: 'subject pattern (held/order/followup/newsletter)' };
  }

  // 2. Sender extraction
  const senderAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
  const isInternal = /@(astutegroup|orangetsunami)\.com$/i.test(senderAddr);
  let extSender = null;
  if (isInternal) {
    extSender = extractForwardedSender(body);
  } else {
    extSender = { email: senderAddr, name: (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].name) || '' };
  }
  if (!extSender || !extSender.email) {
    return { ...result, action: 'not_rfq', reason: 'no external sender (internal-only thread)' };
  }
  // Reject internal sender as customer
  if (/@(astutegroup|orangetsunami)\.com$/i.test(extSender.email)) {
    return { ...result, action: 'not_rfq', reason: 'sender resolves to internal Astute address' };
  }

  // 3. MPN+qty extraction
  let extractedLines = extractFromSubjectLine(subject);
  // Always try body too — it may have additional lines or correct qty
  const bodyLines = extractFromBody(body, extractedLines[0] && extractedLines[0].mpn);
  if (bodyLines.length > 0) {
    // Prefer body extraction if it has more lines; otherwise merge qty if subject didn't have one
    if (bodyLines.length > extractedLines.length) {
      extractedLines = bodyLines;
    } else if (extractedLines.length === 1 && bodyLines.length === 1
               && extractedLines[0].mpn.toUpperCase() === bodyLines[0].mpn.toUpperCase()
               && (!extractedLines[0].qty || extractedLines[0].qty === 0)) {
      extractedLines = [{ ...extractedLines[0], qty: bodyLines[0].qty }];
    }
  }

  // Filter junk
  extractedLines = extractedLines.filter(l => l && l.mpn && !isJunkMpn(l.mpn));
  if (!extractedLines.length) {
    return { ...result, action: 'needs_review', reason: 'no parseable lines' };
  }

  // 4. Partner resolution
  let bpartnerId = UNQUALIFIED_BROKER_ID;
  let customerName = extSender.name || extSender.email;
  let isUB = true;
  try {
    const partner = resolvePartner({
      email: extSender.email,
      companyName: extSender.name || '',
      partnerType: 'customer',
    });
    if (partner && partner.matched) {
      bpartnerId = parseInt(partner.c_bpartner_id, 10);
      customerName = partner.name;
      isUB = false;
    }
  } catch (err) {
    // partner lookup transient: fall through to UB
    console.error(`[uid ${uid}] partner-lookup error: ${err.message}`);
  }

  // 5. MFR resolution per line
  const writeLines = extractedLines.map(l => {
    const out = { mpn: l.mpn.trim(), qty: parseInt(l.qty, 10) || 0 };
    if (l.mfr) {
      const mfrResult = lookupMfr(l.mfr);
      if (mfrResult) {
        out.mfrText = mfrResult.canonical || l.mfr;
        if (mfrResult.id) out.mfrId = mfrResult.id;
      } else {
        out.mfrText = l.mfr;
      }
    }
    if (l.targetPrice != null) out.targetPrice = l.targetPrice;
    if (l.cpc) out.cpc = l.cpc;
    return out;
  });

  // 6. Apply UB description prefix
  if (isUB && customerName) {
    for (const w of writeLines) {
      w.description = customerName;
    }
  }

  // 7. writeRFQ
  let rfqId = null;
  try {
    const rfqDesc = subject.replace(/^(FW|Fwd|Re):\s*/gi, '').slice(0, 2000);
    const wr = await writeRFQ({
      bpartnerId,
      type: 'Stock',
      description: rfqDesc,
      salesrepId: JAKE_USER_ID,
      userId: JAKE_USER_ID,
      lines: writeLines,
    });
    rfqId = wr.rfqId;
    if (!rfqId) {
      return { ...result, action: 'error', error: `writeRFQ no rfqId. errors: ${(wr.errors || []).join('; ')}` };
    }
    breadcrumbs.write({
      cog: 'stockrfq-agent',
      event: 'loaded',
      uid,
      sourceUid: uid,
      bpartnerId,
      type: 'Stock',
      rfqId,
      searchKey: wr.searchKey,
      linesWritten: wr.linesWritten,
      errorCount: (wr.errors || []).length,
    });
  } catch (err) {
    return { ...result, action: 'error', error: `writeRFQ: ${err.message}` };
  }

  return {
    uid,
    action: 'load_rfq',
    customer: customerName,
    bpartnerId,
    isUB,
    lines: writeLines.length,
    rfqId,
  };
}

// ─── Move helper ────────────────────────────────────────────────────────────

async function moveUid(client, uid, folder) {
  try { await client.mailboxCreate(folder); } catch { /* exists */ }
  await client.messageMove(String(uid), folder, { uid: true });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: INBOX, pass: WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    let uids = TARGET_UIDS;
    if (!uids) {
      uids = (await client.search({ seen: false }, { uid: true })) || [];
    }
    console.error(`Processing ${uids.length} UIDs...`);

    const summary = { processed: 0, load_rfq: 0, needs_review: 0, not_rfq: 0, errors: 0, errs: [] };

    for (const uid of uids) {
      const r = await processUid(client, uid);
      summary.processed++;

      let folder = null;
      if (r.action === 'load_rfq') {
        summary.load_rfq++;
        folder = 'Processed';
        console.log(`uid=${uid} LOAD rfqId=${r.rfqId} customer="${r.customer}"${r.isUB ? ' [UB]' : ''} lines=${r.lines}`);
      } else if (r.action === 'not_rfq') {
        summary.not_rfq++;
        folder = 'NotRFQ';
        console.log(`uid=${uid} NOT_RFQ reason="${r.reason}"`);
      } else if (r.action === 'needs_review') {
        summary.needs_review++;
        folder = 'NeedsReview';
        console.log(`uid=${uid} NEEDS_REVIEW reason="${r.reason}"`);
      } else if (r.action === 'error') {
        summary.errors++;
        summary.errs.push(`uid=${uid}: ${r.error}`);
        console.error(`uid=${uid} ERROR: ${r.error}`);
        // Leave in INBOX for retry; no move
      }

      if (folder) {
        try {
          await moveUid(client, uid, folder);
        } catch (err) {
          summary.errors++;
          summary.errs.push(`uid=${uid} move failed: ${err.message}`);
          console.error(`uid=${uid} MOVE FAIL: ${err.message}`);
        }
      }
    }

    // Re-attach breadcrumbs for needs_review / not_rfq
    console.log('---');
    console.log(`SUMMARY: processed=${summary.processed} load_rfq=${summary.load_rfq} needs_review=${summary.needs_review} not_rfq=${summary.not_rfq} errors=${summary.errors}`);
    if (summary.errs.length) {
      console.log('ERRORS:');
      for (const e of summary.errs) console.log(`  ${e}`);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
