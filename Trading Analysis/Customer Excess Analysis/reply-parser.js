#!/usr/bin/env node
/**
 * reply-parser.js — Cog 8: parses operator replies to digest emails
 * and feeds structured directives back into the pipeline.
 *
 * SCOPE: looks at UNSEEN messages in the excess@ inbox FROM the Astute
 * domain. Anything matching the directive grammar gets:
 *   - Recorded as a feedback override (consumed by offer-poller next run)
 *   - Logged to breadcrumbs (visible in next digest)
 *   - For PARTNER directives: the referenced UID is moved from
 *     NeedsPartner back to INBOX so the poller re-attempts processing
 *     with the operator's BP id.
 *   - For INTENT/SKIP directives: noted (V1 = breadcrumb only;
 *     consumed by analysis cog when it ships).
 *   - Anything from Astute domain that doesn't match grammar gets a
 *     clarification reply ("you said X but I need Y").
 *
 * GRAMMAR (case-insensitive, one directive per line):
 *
 *   PARTNER: <uid> = <BP id (6-8 digits) OR company name>
 *   INTENT:  <searchKey> = <spec-buy | proactive | reactive>
 *   SKIP:    <searchKey>
 *
 * USAGE:
 *   node reply-parser.js                  # process replies in excess@
 *   node reply-parser.js --account broker # check broker@ replies (when wired)
 *   node reply-parser.js --dry-run        # parse but don't move/respond
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const breadcrumbs = require('../../shared/breadcrumbs');
const overrides = require('../../shared/feedback-overrides');
const { resolvePartner, lookupById } = require('../../shared/partner-lookup');
const { sendWithFallback } = require('../../shared/verified-send');
const { acquireLock, releaseLock } = require('../../shared/lockfile');
const grammar = require('../../shared/workflow-reply-grammars');
const {
  PARTNER_RE, INTENT_RE, SKIP_RE, IGNORE_RE, YES_RE, NO_RE, LINES_RE,
  JUNK_CHECK_SUBJECT_RE,
  parseDirectives,
  looksLikeActionableReply,
} = grammar;

const ASTUTE_DOMAIN = 'astutegroup.com';
const JAKE_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';
const FALLBACK = process.env.EXCESS_FALLBACK_SENDER || 'stockRFQ@orangetsunami.com';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);

const ACCOUNT_TO_EMAIL = {
  excess: 'excess@orangetsunami.com',
  // broker / franchise — placeholders, wired when those inboxes exist
};

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { account: 'excess', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') args.account = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// ── Directive grammar ───────────────────────────────────────────────────────
// All regex patterns + parseDirectives now live in shared/workflow-reply-grammars.js
// (imported at top of file). The grammar is workflow-agnostic — what's done
// with each directive type is excess-specific and stays here in processReply().

// ── Resolving partner from a "BP id or company name" value ─────────────────

/**
 * Returns:
 *   { ok: true, bpId, name }                   — resolved cleanly
 *   { ok: false, reason: 'not-found'|'ambiguous', candidates? }
 */
function resolvePartnerValue(value) {
  // Numeric → look up by BP id directly
  if (/^\d{6,8}$/.test(value.trim())) {
    const p = lookupById(Number(value));
    if (p) return { ok: true, bpId: p.c_bpartner_id, name: p.name };
    return { ok: false, reason: 'not-found' };
  }
  // Otherwise treat as company name
  const r = resolvePartner({ companyName: value });
  if (r.matched) {
    return { ok: true, bpId: r.c_bpartner_id, name: r.name };
  }
  return { ok: false, reason: 'not-found' };
}

// ── Tabular-block parser (for LINES directive) ─────────────────────────────

const HEADER_SYNONYMS = {
  mpn:      ['mpn', 'part number', 'part #', 'partnumber', 'part no', 'manufacturer part number', 'mfr part number', 'mfg part number', 'p/n', 'pn'],
  qty:      ['qty', 'quantity', 'qty available', 'stock', 'available'],
  price:    ['price', 'unit price', 'cost', 'unit cost', 'each', 'usd'],
  mfr:      ['mfr', 'manufacturer', 'brand', 'mfg'],
  dateCode: ['dc', 'date code', 'datecode', 'd/c'],
  description: ['description', 'desc', 'details'],
  cpc:      ['cpc', 'customer part', 'customer part code'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-.:]/g, ' ').replace(/\s+/g, ' ');
}

function matchHeaders(headers) {
  const normed = headers.map(normalizeHeader);
  const find = key => {
    const syns = HEADER_SYNONYMS[key];
    for (let i = 0; i < normed.length; i++) if (syns.some(s => normed[i] === s)) return i;
    for (let i = 0; i < normed.length; i++) if (syns.some(s => normed[i].includes(s))) return i;
    return -1;
  };
  return {
    mpnIdx: find('mpn'), qtyIdx: find('qty'), priceIdx: find('price'),
    mfrIdx: find('mfr'), dateCodeIdx: find('dateCode'),
    descriptionIdx: find('description'), cpcIdx: find('cpc'),
  };
}

/**
 * Parse a captured tabular block (everything after "LINES: <uid>" until a
 * blank line or another directive). First non-empty row is the header; rest
 * are data rows. Tab- or 2+-space-delimited.
 *
 * Returns array of line objects in the same shape the offer-writeback expects:
 *   { mpn, qty?, price?, mfrText?, dateCode?, description?, cpc? }
 */
function parseLinesBlock(block) {
  if (!block) return [];
  const rows = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (rows.length < 2) return []; // need header + at least one data row

  const headers = rows[0].split(/\s{2,}|\t/).map(c => c.trim());
  const idx = matchHeaders(headers);
  if (idx.mpnIdx < 0) return []; // header row must include an MPN column

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(/\s{2,}|\t/).map(c => c.trim());
    const mpn = idx.mpnIdx >= 0 ? cells[idx.mpnIdx] : '';
    if (!mpn) continue;
    const line = { mpn };
    if (idx.qtyIdx >= 0 && cells[idx.qtyIdx]) {
      const n = Number(String(cells[idx.qtyIdx]).replace(/[, ]/g, ''));
      if (!isNaN(n) && n > 0) line.qty = n;
    }
    if (idx.priceIdx >= 0 && cells[idx.priceIdx]) {
      const n = Number(String(cells[idx.priceIdx]).replace(/[$, ]/g, ''));
      if (!isNaN(n) && n > 0) line.price = n;
    }
    if (idx.mfrIdx >= 0 && cells[idx.mfrIdx]) line.mfrText = cells[idx.mfrIdx];
    if (idx.dateCodeIdx >= 0 && cells[idx.dateCodeIdx]) line.dateCode = cells[idx.dateCodeIdx];
    if (idx.descriptionIdx >= 0 && cells[idx.descriptionIdx]) line.description = cells[idx.descriptionIdx];
    if (idx.cpcIdx >= 0 && cells[idx.cpcIdx]) line.cpc = cells[idx.cpcIdx];
    out.push(line);
  }
  return out;
}

// ── Substantive-reply detector ──────────────────────────────────────────────
// looksLikeActionableReply lives in shared/workflow-reply-grammars.js
// (imported at top of file). Used to differentiate one-word acks ("thanks")
// from substantive operator replies that need a kickback.

// ── Email helpers ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Send a kickback when the reply has substantive text but no directive
 * matched at all. Distinct from sendClarification (which fires when at
 * least one directive was attempted but failed). The intent here is to
 * flag *new* shapes of operator feedback we may need to support.
 */
async function sendKickback({ to, originalSubject, fromAddress, account, replyText }) {
  const subject = `Re: ${originalSubject || 'your reply'} — I didn't understand`;
  const html = `<p>I got your reply but couldn't match it to any of my directive grammars. <b>If you wanted me to do something specific, I may need a new way to handle it.</b></p>
<p>Here's what you sent:</p>
<pre style="background:#fdf6e3;padding:8px;font-size:12px;border-left:4px solid #b58900">${escapeHtml(replyText.slice(0, 2000))}</pre>
<p>Available directives today (case-insensitive, one per line):</p>
<pre style="background:#f5f5f5;padding:8px;font-size:12px">PARTNER: &lt;uid&gt; = &lt;BP id (6-8 digits) OR company name&gt;
LINES:   &lt;uid&gt;
         &lt;tab-separated table starting with header row: MPN, Qty, Price, ...&gt;
IGNORE:  &lt;uid&gt;       (or JUNK: &lt;uid&gt;)
YES                  (or YES: &lt;uid&gt;) — confirms a junk-check question
NO                   (or NO:  &lt;uid&gt;) — rejects a junk-check question
INTENT:  &lt;searchKey&gt; = &lt;spec-buy | proactive | reactive&gt;
SKIP:    &lt;searchKey&gt;</pre>
<p>If your reply needs a kind of action that isn't in this list, just describe what you want done and we'll build a new directive for it. Either way, this exchange will show up in the next operator digest so I don't lose track of what you asked for.</p>`;
  const pass = process.env.WORKMAIL_PASS;
  const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
  await sendWithFallback({
    primary:  { from: ACCOUNT_TO_EMAIL[account], pass, displayName: 'Reply Parser' },
    fallback: { from: FALLBACK,                  pass, displayName: 'Reply Parser' },
    mail: { to, subject, html },
    log,
  });
}

async function sendClarification({ to, originalSubject, fromAddress, account, problems }) {
  const subject = `Re: ${originalSubject || 'your reply'} — clarification needed`;
  const lines = problems.map(p => `<li>${escapeHtml(p)}</li>`).join('\n');
  const html = `<p>I got your reply but couldn't fully action it. Issues:</p>
<ul>${lines}</ul>
<p>Grammar reminder (case-insensitive, one per line):</p>
<pre style="background:#f5f5f5;padding:8px;font-size:12px">PARTNER: &lt;uid&gt; = &lt;BP id (6-8 digits) OR company name&gt;
LINES:   &lt;uid&gt;
         &lt;tab-separated table starting with header row: MPN, Qty, Price, ...&gt;
IGNORE:  &lt;uid&gt;       (or JUNK: &lt;uid&gt;)
YES                  (or YES: &lt;uid&gt;) — confirms a junk-check question
NO                   (or NO:  &lt;uid&gt;) — rejects a junk-check question
INTENT:  &lt;searchKey&gt; = &lt;spec-buy | proactive | reactive&gt;
SKIP:    &lt;searchKey&gt;</pre>
<p>Reply with a corrected directive and I'll pick it up on the next reply-parser run.</p>`;
  const pass = process.env.WORKMAIL_PASS;
  const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
  await sendWithFallback({
    primary:  { from: ACCOUNT_TO_EMAIL[account], pass, displayName: 'Reply Parser' },
    fallback: { from: FALLBACK,                  pass, displayName: 'Reply Parser' },
    mail: { to, subject, html },
    log,
  });
}

// ── Main per-message processor ─────────────────────────────────────────────

async function processReply(client, uid, account, dryRun, log) {
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) return { uid, status: 'skipped', reason: 'no-source' };
  const parsed = await simpleParser(msg.source);
  const subject = parsed.subject || '';
  const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();
  const body = parsed.text || '';

  // Filter: must be from an Astute-domain sender
  if (!fromAddr.endsWith(`@${ASTUTE_DOMAIN}`)) {
    log(`  UID ${uid}: not from Astute domain (${fromAddr}) — skipping`);
    return { uid, status: 'skipped', reason: 'not-astute' };
  }

  // Skip if this is the digest itself echoing back (rare, but the digest is
  // sent FROM excess@ TO jake.harris@; if jake replies it'll arrive back at
  // excess@. The PARENT message is not jake's reply, so we don't want to
  // re-process the digest as if it were a reply.)
  if (fromAddr === ACCOUNT_TO_EMAIL[account]) {
    log(`  UID ${uid}: from self (${fromAddr}) — skipping`);
    return { uid, status: 'skipped', reason: 'self' };
  }

  log(`  UID ${uid}: reply from ${fromAddr} subject="${subject}"`);

  // Strip any quoted prior-message blocks below "On <date> wrote:" or similar
  // so we only parse the operator's typed text (their reply is at the top).
  const topOfReply = body.split(/^(?:On\s.+wrote:|From:\s|-+\s*Original Message\s*-+)/m)[0] || body;

  // If the reply subject carries a junk-check UID (e.g., "Re: Junk check — UID 97: ..."),
  // bare YES/NO in the body resolves to that UID without needing explicit "YES: 97".
  const subjectMatch = JUNK_CHECK_SUBJECT_RE.exec(subject);
  const subjectUid = subjectMatch ? Number(subjectMatch[1]) : null;
  const { directives, unparsed } = parseDirectives(topOfReply, { subjectUid });

  if (directives.length === 0 && unparsed.length === 0) {
    // No directives, no malformed lines. Two sub-cases:
    //   (a) trivial reply ("thanks", "ok", "got it") → silent skip, no email back
    //   (b) substantive reply ("please change partner X to Y") → kickback so we
    //       can flag a possibly-new directive shape and the operator knows
    //       their reply landed but wasn't actioned.
    const isActionable = looksLikeActionableReply(topOfReply);
    if (!isActionable) {
      log(`  UID ${uid}: no directives, trivial reply — silent skip`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'no-directives', account, uid, fromAddr, subject,
      });
      if (!dryRun) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      return { uid, status: 'no-directives' };
    }
    log(`  UID ${uid}: no directives but reply looks actionable — sending kickback`);
    breadcrumbs.write({
      cog: 'reply-parser', event: 'unrecognized-reply',
      account, uid, fromAddr, subject,
      replyPreview: topOfReply.slice(0, 300),
    });
    if (!dryRun) {
      try {
        await sendKickback({ to: fromAddr, originalSubject: subject, fromAddress: fromAddr, account, replyText: topOfReply });
      } catch (e) {
        log(`  kickback email failed: ${e.message}`);
      }
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    }
    return { uid, status: 'unrecognized-reply' };
  }

  const applied = [];
  const problems = [];

  // Apply each directive. For each: write the override to feedback-overrides
  // (the offer-poller's NeedsPartner / NeedsReview retry sweep applies them
  // on the next cycle). We do NOT move messages between folders here — the
  // sweep handles that based on the override.
  for (const d of directives) {
    if (d.type === 'PARTNER') {
      const r = resolvePartnerValue(d.value);
      if (!r.ok) {
        problems.push(`PARTNER: ${d.uid} = "${d.value}" → no BP found. Try the BP id directly (6-8 digits) or a more specific company name.`);
        breadcrumbs.write({
          cog: 'reply-parser', event: 'partner-unresolved',
          account, uid: d.uid, value: d.value, reason: r.reason,
        });
        continue;
      }
      if (!dryRun) overrides.setPartner(account, d.uid, r.bpId, `user-reply uid=${uid}`);
      applied.push(`PARTNER: UID ${d.uid} → ${r.name} (BP ${r.bpId})`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'partner-applied',
        account, targetUid: d.uid, bpId: r.bpId, partnerName: r.name,
        replyUid: uid, fromAddr,
      });
    } else if (d.type === 'INTENT') {
      if (!dryRun) overrides.setIntent(d.searchKey, d.intent, `user-reply uid=${uid}`);
      applied.push(`INTENT: ${d.searchKey} = ${d.intent}`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'intent-applied',
        searchKey: d.searchKey, intent: d.intent, replyUid: uid, fromAddr,
      });
    } else if (d.type === 'SKIP') {
      if (!dryRun) overrides.setSkip(d.searchKey, `user-reply uid=${uid}`);
      applied.push(`SKIP: ${d.searchKey}`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'skip-applied',
        searchKey: d.searchKey, replyUid: uid, fromAddr,
      });
    } else if (d.type === 'IGNORE' || d.type === 'YES') {
      // YES = "yes, this is junk." Same effect as IGNORE: route to NotOffer on next sweep.
      if (!dryRun) overrides.setIgnore(account, d.uid, `user-reply uid=${uid} (${d.type})`);
      applied.push(`${d.type}: UID ${d.uid} → marked as junk; will move to NotOffer on next sweep`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'ignore-applied',
        account, targetUid: d.uid, source: d.type, replyUid: uid, fromAddr,
      });
    } else if (d.type === 'NO') {
      // NO = "no, this is NOT junk — process it." Force-process bypasses the classifier.
      if (!dryRun) overrides.setForceProcess(account, d.uid, `user-reply uid=${uid} (NO)`);
      applied.push(`NO: UID ${d.uid} → not junk; will process on next sweep bypassing classifier`);
      breadcrumbs.write({
        cog: 'reply-parser', event: 'forceProcess-applied',
        account, targetUid: d.uid, replyUid: uid, fromAddr,
      });
    } else if (d.type === 'LINES') {
      // Parse the captured tabular block using the offer-poller's matchHeaders helper.
      const parsedLines = parseLinesBlock(d.block);
      if (parsedLines.length === 0) {
        problems.push(`LINES: ${d.uid} → could not parse the line table. Make sure the first row is a header (MPN, Qty, Price, ...) and rows below it are tab-separated.`);
        breadcrumbs.write({
          cog: 'reply-parser', event: 'lines-unparsed',
          account, targetUid: d.uid, replyUid: uid, blockPreview: d.block.slice(0, 200),
        });
      } else {
        if (!dryRun) overrides.setLines(account, d.uid, parsedLines, `user-reply uid=${uid}`);
        applied.push(`LINES: UID ${d.uid} → ${parsedLines.length} line(s) captured; will writeOffer on next sweep`);
        breadcrumbs.write({
          cog: 'reply-parser', event: 'lines-applied',
          account, targetUid: d.uid, lineCount: parsedLines.length, replyUid: uid, fromAddr,
        });
      }
    }
  }

  // Reply may also include a corrected attachment (xlsx/csv). If so, capture
  // the file path and store as a LINES override. The reply-parser's LINES
  // implementation already covers paste-style input; attachments are a sister
  // path that lets the operator forward a fixed file.
  // (V1 punt: implement only the paste path. Attachments can be added when the
  //  use case actually arises — per operator: "build others as they arise.")

  for (const line of unparsed) {
    problems.push(`Could not parse: <code>${line}</code>`);
  }

  // Send clarification if anything failed to parse / resolve
  if (problems.length > 0 && !dryRun) {
    try {
      await sendClarification({
        to: fromAddr, originalSubject: subject, fromAddress: fromAddr, account, problems,
      });
      breadcrumbs.write({
        cog: 'reply-parser', event: 'clarification-sent',
        account, replyUid: uid, fromAddr, problemCount: problems.length,
      });
    } catch (e) {
      log(`  clarification email failed: ${e.message}`);
    }
  }

  if (!dryRun) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  log(`  UID ${uid}: applied ${applied.length}, problems ${problems.length}`);
  return { uid, status: 'processed', applied, problems };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ACCOUNT_TO_EMAIL[args.account]) {
    console.error(`Unknown account: ${args.account}. Available: ${Object.keys(ACCOUNT_TO_EMAIL).join(', ')}`);
    process.exit(2);
  }
  const inboxEmail = ACCOUNT_TO_EMAIL[args.account];
  const pass = process.env.WORKMAIL_PASS;
  if (!pass) { console.error('FATAL: WORKMAIL_PASS not set'); process.exit(1); }

  const log = (...a) => console.log(new Date().toISOString(), '-', `[reply-${args.account}]`, ...a);

  const lock = acquireLock(`reply-parser-${args.account}`);
  if (!lock.acquired) {
    log(`previous run still active (pid=${lock.pid}) — skipping`);
    return;
  }

  log(`starting (dryRun=${args.dryRun})`);

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: inboxEmail, pass }, logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    log('FATAL: connect failed:', err.message);
    releaseLock(`reply-parser-${args.account}`);
    process.exit(2);
  }

  let processed = 0, applied = 0, problems = 0;
  try {
    const lockBox = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      log(`scanning ${uids.length} UNSEEN message(s) for replies`);
      for (const uid of uids) {
        try {
          const r = await processReply(client, uid, args.account, args.dryRun, log);
          if (r.status === 'processed') {
            processed++;
            applied += (r.applied || []).length;
            problems += (r.problems || []).length;
          }
        } catch (err) {
          log(`  UID ${uid}: error: ${err.message}`);
          breadcrumbs.write({
            cog: 'reply-parser', event: 'error',
            account: args.account, uid, error: err.message,
          });
        }
      }
    } finally {
      lockBox.release();
    }
  } finally {
    try { await client.logout(); } catch (e) {}
    releaseLock(`reply-parser-${args.account}`);
  }

  log(`done. processed=${processed} applied=${applied} problems=${problems}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err.message); console.error(err.stack); process.exit(1); });
}

module.exports = { parseDirectives, resolvePartnerValue };
