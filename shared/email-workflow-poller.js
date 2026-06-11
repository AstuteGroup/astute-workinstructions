#!/usr/bin/env node
/**
 * shared/email-workflow-poller.js
 *
 * Generic thin CLI for email-driven workflows. The LLM extraction + judgment
 * step is performed by Claude in-session via /schedule routine. No Anthropic
 * SDK / API key required.
 *
 * Architecture: see ~/workspace/astute-workinstructions/email-workflow-architecture.md
 *
 * COMMANDS (every command requires --workflow <name>):
 *   list  --workflow <name>
 *       List UNSEEN envelopes as JSON: [{uid, subject, from, date, attachment_names, has_attachment}, ...]
 *
 *   read <uid> --workflow <name>
 *       Read full email as JSON: { uid, subject, from, to, cc, date, body, body_html,
 *                                   forwarded_headers: {originalFrom, originalCc, originalSubject},
 *                                   external_sender, internal_forwarder, attachments: [...] }
 *
 *       body      = plain-text body (parsed.text, falling back to parsed.html if no
 *                   text/plain part). What agents have always read.
 *       body_html = raw HTML body (parsed.html) — '' if the message has no HTML
 *                   part. Use this when formatting matters: cell background colours
 *                   ("only red-highlighted rows"), bold, italic, strikethrough,
 *                   font colour. Agents should consult body_html when operator
 *                   instructions reference formatting; otherwise body suffices.
 *
 *   route <uid> <action> --workflow <name> --payload <json|file>
 *       Execute the routing decision via the workflow's action handler;
 *       move the email to the action's target folder.
 *
 * FLAGS:
 *   --dry-run     Print what would happen; do not modify state
 *   --workflow    Required; resolves to shared/workflow-actions/<name>.js
 *
 * WORKFLOW MODULE CONTRACT (shared/workflow-actions/<name>.js):
 *   module.exports = {
 *     inbox:           'someinbox@orangetsunami.com',
 *     sourceFolder:    'OutboundPending',         // optional; defaults to 'INBOX'
 *     notifierConfig:  { fromEmail, fromName, smtpUser?, smtpPass? },
 *     actions: {
 *       <name>: {
 *         folder:        'TargetFolder',           // post-handler move destination
 *         requires:      ['fieldA', 'fieldB'],     // payload field validation
 *         keepsPending:  true,                     // optional; skip sidecar auto-clear for need_info-style actions
 *         handler:       async (payload, ctx) => { ... }    // null = move-only
 *       },
 *     },
 *   };
 *
 *   Handler ctx: {
 *     uid, dryRun, jakeEmail, notifier, log, workflow, inbox,
 *     anchorMessageId,     // Message-ID of the thread anchor (for sidecar keys)
 *     currentMessageId,    // Message-ID of the message being routed
 *     currentReferences,   // References+In-Reply-To array
 *     pendingSidecar       // The matched sidecar (or null) — already-extracted state
 *   }
 *   Handler returns: any object — merged into the route output JSON.
 *
 * REPLY-STITCHING (automatic for any workflow):
 *   - `cmdRead` attaches `pending_state` to message JSON when a sidecar matches
 *     the message's References/In-Reply-To chain. Agent merges with current body.
 *   - `cmdRoute` clears the sidecar on terminal actions; need_info-style actions
 *     that should PERSIST state must declare `keepsPending: true`.
 *   - Helper: shared/workflow-pending-state.js (write/read/findByReferences/clear).
 */

'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { createNotifier } = require('./notifier');
const pending = require('./workflow-pending-state');

// ─── ARGS ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0];
const DRY_RUN = argv.includes('--dry-run');

function getFlag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}

const WORKFLOW_NAME = getFlag('workflow');
if (!WORKFLOW_NAME) {
  console.error('FATAL: --workflow <name> is required.');
  console.error('Example: node shared/email-workflow-poller.js list --workflow rfq-loading');
  process.exit(2);
}

// Load the workflow module from shared/workflow-actions/<name>.js
let workflow;
try {
  workflow = require(path.resolve(__dirname, 'workflow-actions', `${WORKFLOW_NAME}.js`));
} catch (err) {
  console.error(`FATAL: failed to load workflow module 'shared/workflow-actions/${WORKFLOW_NAME}.js'`);
  console.error(err.message);
  process.exit(2);
}

// Validate workflow module shape
if (!workflow.inbox) { console.error('FATAL: workflow module missing `inbox`'); process.exit(2); }
if (!workflow.actions || typeof workflow.actions !== 'object') {
  console.error('FATAL: workflow module missing `actions` object'); process.exit(2);
}

const INBOX = workflow.inbox;
// Source folder the poller reads/moves FROM. Default INBOX — most inbound
// workflows scan unseen mail there. Outbound / staging workflows (e.g.,
// stockrfq-cq consuming OutboundPending) declare a different folder.
const SOURCE_FOLDER = workflow.sourceFolder || 'INBOX';
const JAKE_EMAIL = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

if (!WORKMAIL_PASS) {
  console.error('FATAL: WORKMAIL_PASS not set in ~/workspace/.env');
  process.exit(1);
}

const notifierConfig = workflow.notifierConfig || {};
const notifier = createNotifier({
  fromEmail: notifierConfig.fromEmail || INBOX,
  fromName: notifierConfig.fromName || WORKFLOW_NAME,
  smtpUser: notifierConfig.smtpUser || INBOX,
  smtpPass: notifierConfig.smtpPass || WORKMAIL_PASS,
});

// ─── IMAP HELPERS ────────────────────────────────────────────────────────────

function newClient() {
  return new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: INBOX, pass: WORKMAIL_PASS },
    logger: false,
  });
}

async function withInbox(fn) {
  const client = newClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(SOURCE_FOLDER);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Enumerate attachments, separating documents from images.
 *
 * Returns { documents: [...], images: [...] }
 *   - documents: non-image attachments (xlsx, csv, pdf, etc.)
 *   - images: image attachments with metadata for agent decision-making
 *
 * Image classification:
 *   - size >= 20KB → likely content (screenshot, photo of document)
 *   - size < 20KB → likely signature logo/icon (can ignore)
 *   - contentId (cid) present → inline image (signature block)
 *
 * The agent should use `download-attachments --include-images` then Read tool
 * on large images when email body is sparse.
 */
function enumerateAttachments(attachments) {
  const docs = [];
  const images = [];

  for (const a of (attachments || [])) {
    if (!a.filename) continue;
    const isImage = /^image\//i.test(a.contentType || '');
    const size = a.size || (a.content && a.content.length) || 0;

    if (isImage) {
      // Classify image: large (>= 20KB) likely content, small likely signature
      const isLikelyContent = size >= 20000 && !a.cid;
      images.push({
        filename: a.filename,
        contentType: a.contentType,
        size,
        isLikelyContent,
        contentId: a.cid || null,
      });
    } else {
      docs.push({ filename: a.filename, contentType: a.contentType, size });
    }
  }

  return { documents: docs, images };
}

// ─── FORWARDED-HEADER PARSING ────────────────────────────────────────────────
// Enhanced 2026-06-02 to handle mobile Outlook forwards

function parseForwardedHeaders(body, parsed) {
  if (!body) return { originalFrom: null, originalCc: [], originalSubject: null };

  const text = body
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[a-zA-Z\/][^>@]*>/g, ' ');

  const extractEmails = (line) => {
    if (!line) return [];
    const re = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
    return (line.match(re) || []).map(e => e.toLowerCase());
  };

  // ─── PATTERN 1: Desktop forward (original logic) ────────────────────────────
  const fromMatch = text.match(/^[ \t]*From:[ \t]*(.+)$/im);
  const ccMatch = text.match(/^[ \t]*Cc:[ \t]*(.+)$/im);
  const subjMatch = text.match(/^[ \t]*Subject:[ \t]*(.+)$/im);

  if (fromMatch || subjMatch) {
    // Desktop forward detected
    return {
      originalFrom: extractEmails(fromMatch && fromMatch[1])[0] || null,
      originalCc: extractEmails(ccMatch && ccMatch[1]),
      originalSubject: (subjMatch && subjMatch[1].trim()) || null,
      isMobileForward: false,
    };
  }

  // ─── PATTERN 2: Mobile Outlook forward ──────────────────────────────────────
  // Mobile forwards have "Get Outlook for iOS/Android" signature but often lack
  // inline From:/Subject: headers. Parse the content before the signature.

  const isMobileOutlook = /Get Outlook for (iOS|Android)/i.test(body);
  if (!isMobileOutlook) {
    return { originalFrom: null, originalCc: [], originalSubject: null };
  }

  // Strategy 1: Check for .eml attachment (some mobile clients attach original)
  if (parsed && parsed.attachments) {
    const emlAttachment = parsed.attachments.find(a =>
      a.filename && a.filename.toLowerCase().endsWith('.eml')
    );
    if (emlAttachment) {
      // For Phase 2: parse .eml attachment content
      return {
        originalFrom: null,
        originalCc: [],
        originalSubject: null,
        isMobileForward: true,
        hasEmlAttachment: true,
        emlFilename: emlAttachment.filename,
      };
    }
  }

  // Strategy 2: Extract emails from content BEFORE "Get Outlook" signature
  const parts = body.split(/Get Outlook for (iOS|Android)/i);
  if (parts.length > 1) {
    const contentBeforeSignature = parts[0];
    const emailsFound = contentBeforeSignature.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);

    if (emailsFound && emailsFound.length > 0) {
      // Filter out our own domain emails (those are the forwarder, not the original sender)
      const externalEmails = emailsFound
        .map(e => e.toLowerCase())
        .filter(e => !e.endsWith('@astutegroup.com') && !e.endsWith('@orangetsunami.com'));

      if (externalEmails.length > 0) {
        return {
          originalFrom: externalEmails[0],
          originalCc: externalEmails.slice(1),
          originalSubject: null, // Can't reliably extract from mobile forwards
          isMobileForward: true,
          mobileForwardBody: contentBeforeSignature.trim(),
        };
      }
    }
  }

  // Strategy 3: Look for "---------- Forwarded message ---------" marker
  const fwdMarkerMatch = text.match(/[-_]{5,}\s*(Forwarded message|Original message)/i);
  if (fwdMarkerMatch) {
    const afterMarker = text.substring(text.indexOf(fwdMarkerMatch[0]) + fwdMarkerMatch[0].length);
    const emailsInForward = afterMarker.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);

    if (emailsInForward) {
      const externalEmails = emailsInForward
        .map(e => e.toLowerCase())
        .filter(e => !e.endsWith('@astutegroup.com') && !e.endsWith('@orangetsunami.com'));

      if (externalEmails.length > 0) {
        return {
          originalFrom: externalEmails[0],
          originalCc: externalEmails.slice(1),
          originalSubject: null,
          isMobileForward: true,
        };
      }
    }
  }

  // Mobile forward detected but couldn't extract sender
  return {
    originalFrom: null,
    originalCc: [],
    originalSubject: null,
    isMobileForward: true,
    parseFailure: 'Mobile forward detected but could not extract sender',
  };
}

function isInternalAddress(addr) {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a.endsWith('@astutegroup.com') || a.endsWith('@orangetsunami.com');
}

// ─── COMMAND: list ───────────────────────────────────────────────────────────
//
// SELF-HEALING: Before listing UNSEEN emails, this command automatically
// recovers any "stuck" emails — messages that were read (marked SEEN) but
// never routed out of the source folder. This happens when an agent crashes,
// times out, or is paused mid-processing.
//
// Recovery window: emails between 60 minutes and 24 hours old get auto-recovered.
// - Under 60 minutes: might still be in-flight (agent processing)
// - Over 24 hours: too old, probably intentionally marked as read (spam/test/etc.)
//   → flagged in Operations Digest for manual review, not auto-recovered.

const STUCK_MIN_AGE_MINS = 60;       // Don't recover if newer than this (might be in-flight)
const STUCK_MAX_AGE_MINS = 24 * 60;  // Don't auto-recover if older than this (needs manual review)

async function recoverStuckEmailsIfNeeded(client) {
  const minCutoff = new Date(Date.now() - STUCK_MIN_AGE_MINS * 60 * 1000);  // 60 min ago
  const maxCutoff = new Date(Date.now() - STUCK_MAX_AGE_MINS * 60 * 1000);  // 24 hours ago
  const seenUids = (await client.search({ seen: true }, { uid: true })) || [];
  if (seenUids.length === 0) return 0;

  const stuckUids = [];
  for await (const msg of client.fetch(seenUids, { envelope: true }, { uid: true })) {
    const env = msg.envelope || {};
    const msgDate = env.date ? new Date(env.date) : null;
    // Only recover emails in the window: older than 60 min but newer than 24 hours
    if (msgDate && msgDate < minCutoff && msgDate > maxCutoff) {
      stuckUids.push(msg.uid);
    }
  }

  if (stuckUids.length === 0) return 0;

  // Clear SEEN flag on stuck emails so they'll be picked up by the normal list
  let recovered = 0;
  for (const uid of stuckUids) {
    try {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      recovered++;
      console.error(`[poller] Recovered stuck email UID ${uid} (cleared SEEN flag)`);
    } catch (err) {
      console.error(`[poller] Failed to recover UID ${uid}: ${err.message}`);
    }
  }

  return recovered;
}

async function cmdList() {
  const envelopes = await withInbox(async (client) => {
    // Self-healing: recover any stuck emails before listing
    const recovered = await recoverStuckEmailsIfNeeded(client);
    if (recovered > 0) {
      console.error(`[poller] Auto-recovered ${recovered} stuck email(s)`);
    }

    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    if (uids.length === 0) return [];
    const out = [];
    for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, flags: true }, { uid: true })) {
      const env = msg.envelope || {};
      const from = env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '';
      const atts = [];
      let hasLargeImage = false;
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
        const disp = (node.disposition || '').toLowerCase();
        const fname = (node.dispositionParameters && node.dispositionParameters.filename) ||
                      (node.parameters && node.parameters.name) || null;
        const isImage = /^image\//i.test(node.type || '');
        const size = node.size || 0;
        if (disp === 'attachment' && fname) {
          if (isImage) {
            // Large images (>= 20KB) likely content, not signature
            if (size >= 20000) hasLargeImage = true;
          } else {
            atts.push(fname);
          }
        }
      };
      walk(msg.bodyStructure);
      out.push({
        uid: msg.uid,
        subject: env.subject || '',
        from,
        date: env.date ? env.date.toISOString() : '',
        attachment_names: atts,
        has_attachment: atts.length > 0,
        has_large_image: hasLargeImage,
      });
    }
    return out;
  });
  console.log(JSON.stringify(envelopes, null, 2));
}

// ─── COMMAND: read ───────────────────────────────────────────────────────────

async function cmdRead(uid) {
  const result = await withInbox(async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const bodyText = parsed.text || parsed.html || '';
    const senderAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
    const fwd = parseForwardedHeaders(bodyText, parsed);
    const externalSender = isInternalAddress(senderAddr) ? fwd.originalFrom : senderAddr;
    // References header may be a string or an array depending on the parser.
    const refsRaw = parsed.references || (parsed.headers && parsed.headers.get('references')) || null;
    const references = Array.isArray(refsRaw)
      ? refsRaw
      : (typeof refsRaw === 'string' ? refsRaw.split(/\s+/).filter(Boolean) : []);
    return {
      uid,
      message_id: parsed.messageId || '',
      in_reply_to: parsed.inReplyTo || '',
      references,
      subject: parsed.subject || '',
      from: senderAddr,
      to: (parsed.to && parsed.to.text) || '',
      cc: (parsed.cc && parsed.cc.text) || '',
      date: parsed.date ? parsed.date.toISOString() : '',
      body: bodyText,
      body_html: parsed.html || '',
      forwarded_headers: fwd,
      external_sender: externalSender,
      internal_forwarder: isInternalAddress(senderAddr) ? senderAddr : null,
      ...enumerateAttachments(parsed.attachments),
    };
  });
  if (!result) { console.error(`UID ${uid} not found`); process.exit(2); }

  // Reply-stitching: hydrate pending_state if any sidecar matches this thread.
  // The sidecar is keyed on the thread anchor Message-ID; a reply's References
  // chain contains that anchor. See shared/workflow-pending-state.js.
  const stitchRefs = [
    ...(Array.isArray(result.references) ? result.references : []),
    ...(result.in_reply_to ? [result.in_reply_to] : []),
  ];
  const sidecar = pending.findByReferences(WORKFLOW_NAME, stitchRefs);
  if (sidecar) result.pending_state = sidecar;

  console.log(JSON.stringify(result, null, 2));
}

// ─── COMMAND: download-attachments ───────────────────────────────────────────

/**
 * Save attachments for a given UID to a tmp directory. Prints the directory
 * path + filename list as JSON. The agent then uses the Read tool on individual
 * files to inspect xlsx/csv/pdf content (or PNG/JPG via Claude Vision).
 *
 * Default: skips image/* attachments — most are Outlook signature noise.
 * With --include-images: writes images too. Required for VQ Loading (APAC
 * brokers paste quote screenshots inline as PNGs); each file gets `isImage`
 * + `kind` in the returned list so the agent can prioritize larger images
 * (likely real content) over small signature/logo images.
 */
async function cmdDownloadAttachments(uid, { includeImages = false } = {}) {
  const os = require('os');
  const result = await withInbox(async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-${WORKFLOW_NAME}-${uid}-`));
    const files = [];
    for (const att of (parsed.attachments || [])) {
      if (!att.filename) continue;
      const isImage = /^image\//i.test(att.contentType || '');
      if (isImage && !includeImages) continue;
      const outPath = path.join(outDir, att.filename);
      fs.writeFileSync(outPath, att.content);
      files.push({
        filename: att.filename,
        path: outPath,
        size: att.size || att.content.length,
        contentType: att.contentType,
        isImage,
        contentId: att.cid || null,
      });
    }
    return { dir: outDir, files };
  });
  if (!result) { console.error(`UID ${uid} not found`); process.exit(2); }
  console.log(JSON.stringify(result, null, 2));
}

// ─── COMMAND: route ──────────────────────────────────────────────────────────

async function cmdRoute(uid, actionName, payload) {
  const action = workflow.actions[actionName];
  if (!action) {
    console.error(`Unknown action '${actionName}' for workflow '${WORKFLOW_NAME}'.`);
    console.error(`Valid actions: ${Object.keys(workflow.actions).join(', ')}`);
    process.exit(2);
  }

  // Validate payload requires
  if (Array.isArray(action.requires)) {
    for (const field of action.requires) {
      if (payload[field] == null || (Array.isArray(payload[field]) && payload[field].length === 0)) {
        throw new Error(`Action '${actionName}' requires payload field '${field}'`);
      }
    }
  }

  const folder = action.folder;
  const result = { uid, workflow: WORKFLOW_NAME, action: actionName, folder };

  // Fetch the current message's Message-ID + references + envelope From so we
  // can determine the thread anchor for reply-stitching state management AND
  // give the handler a deterministic envelope-From for escalation routing
  // (agent-supplied outerFrom drifts under load — see UID 8598, 2026-05-22).
  let currentMessageId = null;
  let currentReferences = [];
  let currentFrom = null;
  let currentCc = '';
  try {
    await withInbox(async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && !msg.source) {
        console.error(`[poller] WARNING: UID ${uid} fetched but msg.source is null/undefined — sidecar cannot be created (reply-stitching will fail)`);
      }
      if (msg && msg.source) {
        const parsed = await simpleParser(msg.source);
        currentMessageId = parsed.messageId || null;
        const refsRaw = parsed.references
          || (parsed.headers && parsed.headers.get && parsed.headers.get('references'))
          || null;
        currentReferences = Array.isArray(refsRaw)
          ? refsRaw
          : (typeof refsRaw === 'string' ? refsRaw.split(/\s+/).filter(Boolean) : []);
        if (parsed.inReplyTo) currentReferences.push(parsed.inReplyTo);
        // Envelope From — single address, lowercased. simpleParser returns
        // parsed.from.value[0].address for the standard single-sender case.
        if (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) {
          currentFrom = String(parsed.from.value[0].address).toLowerCase();
        }
        currentCc = (parsed.cc && parsed.cc.text) || '';
      }
    });
  } catch (e) {
    // Non-fatal — sidecar management just won't have an anchor.
    console.error(`[poller] could not fetch current message for sidecar anchor: ${e.message}`);
  }

  // Thread-anchor resolution priority:
  //   1. payload.original_message_id (agent passed it explicitly — continuation)
  //   2. existing sidecar matched by this message's references chain
  //   3. this message's own Message-ID (initial routing, no prior state)
  const existingSidecar = pending.findByReferences(WORKFLOW_NAME, currentReferences);
  const anchorMessageId = payload.original_message_id
    || (existingSidecar && existingSidecar.original_message_id)
    || currentMessageId;

  // Build context for the handler
  const ctx = {
    uid,
    dryRun: DRY_RUN,
    jakeEmail: JAKE_EMAIL,
    notifier,
    workflow: WORKFLOW_NAME,
    log: (...args) => console.error('[poller]', ...args),
    inbox: INBOX,
    anchorMessageId,
    currentMessageId,
    currentReferences,
    currentFrom,         // envelope From (lowercased) — authoritative; use
                         // this for escalation routing, not agent-supplied
                         // outerFrom which can drift on complex forwards.
    currentCc,           // envelope Cc header text — handler uses this to
                         // decide whether the buyer was already on the chain
                         // and should be included on escalation emails.
    pendingSidecar: existingSidecar,
  };

  // Run handler (if any)
  if (typeof action.handler === 'function') {
    try {
      const handlerResult = await action.handler(payload, ctx);
      if (handlerResult && typeof handlerResult === 'object') {
        Object.assign(result, handlerResult);
      }
    } catch (err) {
      console.error(`ERROR: action '${actionName}' handler threw: ${err.message}`);
      console.error(err.stack);
      process.exit(1);
    }
  }

  // ── RATE-LIMIT DEFERRAL ──────────────────────────────────────────────────────
  // If handler returns rateLimited: true, the write was blocked due to budget
  // exhaustion. Do NOT move the email — leave it UNSEEN in Inbox so it gets
  // picked up on the next poll cycle when budget resets. No notification needed.
  if (result.rateLimited) {
    result.deferred = true;
    result.deferred_reason = result.rateLimitReason || 'budget exhausted';
    console.log(JSON.stringify(result, null, 2));
    return; // Exit without moving email or clearing sidecar
  }

  // Move email
  if (folder) {
    if (DRY_RUN) {
      result.would_move_to = folder;
      result.dry_run = true;
    } else {
      await withInbox(async (client) => {
        try { await client.mailboxCreate(folder); } catch { /* exists */ }
        await client.messageMove(String(uid), folder, { uid: true });
      });
      result.moved_to = folder;
    }
  }

  // Reply-stitching cleanup: clear the sidecar unless this action declares
  // keepsPending (i.e., need_info-style actions that PERSIST state intentionally).
  if (!DRY_RUN && anchorMessageId && !action.keepsPending) {
    const cleared = pending.clearSidecar(WORKFLOW_NAME, anchorMessageId);
    if (cleared) result.cleared_pending_state = anchorMessageId;
  }

  console.log(JSON.stringify(result, null, 2));
}

// ─── COMMAND: recover-stuck ───────────────────────────────────────────────────
//
// Finds SEEN emails still in the source folder that are older than a threshold
// (default 60 minutes). These are "stuck" — they were read by the agent but
// never routed (agent crashed, timed out, or was paused mid-processing).
//
// Recovery action: clear the SEEN flag so the email shows up in the next `list`
// call and gets re-processed.
//
// Usage: email-workflow-poller.js recover-stuck --workflow <name> [--threshold-mins 60] [--dry-run]

async function cmdRecoverStuck() {
  const thresholdIdx = argv.indexOf('--threshold-mins');
  const thresholdMins = thresholdIdx >= 0 ? parseInt(argv[thresholdIdx + 1], 10) : 60;
  const cutoffTime = new Date(Date.now() - thresholdMins * 60 * 1000);

  const result = await withInbox(async (client) => {
    // Search for SEEN emails (opposite of our normal UNSEEN search)
    const seenUids = (await client.search({ seen: true }, { uid: true })) || [];
    if (seenUids.length === 0) {
      return { stuck: [], recovered: [], message: 'No SEEN emails in source folder' };
    }

    // Fetch envelopes to check dates
    const stuck = [];
    for await (const msg of client.fetch(seenUids, { envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const msgDate = env.date ? new Date(env.date) : null;
      if (msgDate && msgDate < cutoffTime) {
        stuck.push({
          uid: msg.uid,
          subject: env.subject || '',
          from: env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '',
          date: msgDate.toISOString(),
          ageMinutes: Math.round((Date.now() - msgDate.getTime()) / 60000),
        });
      }
    }

    if (stuck.length === 0) {
      return { stuck: [], recovered: [], message: `No SEEN emails older than ${thresholdMins} minutes` };
    }

    // Clear SEEN flag on stuck emails (unless dry-run)
    const recovered = [];
    if (!DRY_RUN) {
      for (const email of stuck) {
        try {
          await client.messageFlagsRemove(String(email.uid), ['\\Seen'], { uid: true });
          recovered.push(email.uid);
        } catch (err) {
          console.error(`[poller] failed to clear SEEN on UID ${email.uid}: ${err.message}`);
        }
      }
    }

    return {
      stuck,
      recovered: DRY_RUN ? [] : recovered,
      wouldRecover: DRY_RUN ? stuck.map(e => e.uid) : [],
      message: DRY_RUN
        ? `Would clear SEEN flag on ${stuck.length} stuck email(s)`
        : `Cleared SEEN flag on ${recovered.length} stuck email(s)`,
      thresholdMins,
      dryRun: DRY_RUN,
    };
  });

  console.log(JSON.stringify(result, null, 2));
}

// ─── COMMAND: check-stuck ─────────────────────────────────────────────────────
//
// Like recover-stuck but read-only. Returns stuck email info without modifying
// anything. Useful for monitoring/alerting (e.g., Operations Digest).
//
// Usage: email-workflow-poller.js check-stuck --workflow <name> [--threshold-mins 60]

async function cmdCheckStuck() {
  const thresholdIdx = argv.indexOf('--threshold-mins');
  const thresholdMins = thresholdIdx >= 0 ? parseInt(argv[thresholdIdx + 1], 10) : 60;
  const cutoffTime = new Date(Date.now() - thresholdMins * 60 * 1000);

  const result = await withInbox(async (client) => {
    const seenUids = (await client.search({ seen: true }, { uid: true })) || [];
    if (seenUids.length === 0) {
      return { stuck: [], count: 0, workflow: WORKFLOW_NAME, sourceFolder: SOURCE_FOLDER };
    }

    const stuck = [];
    for await (const msg of client.fetch(seenUids, { envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const msgDate = env.date ? new Date(env.date) : null;
      if (msgDate && msgDate < cutoffTime) {
        stuck.push({
          uid: msg.uid,
          subject: (env.subject || '').slice(0, 60),
          from: env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '',
          date: msgDate.toISOString(),
          ageMinutes: Math.round((Date.now() - msgDate.getTime()) / 60000),
        });
      }
    }

    return {
      stuck,
      count: stuck.length,
      workflow: WORKFLOW_NAME,
      sourceFolder: SOURCE_FOLDER,
      inbox: INBOX,
      thresholdMins,
    };
  });

  console.log(JSON.stringify(result, null, 2));
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (cmd === 'list') return await cmdList();
    if (cmd === 'read') return await cmdRead(parseInt(argv[1], 10));
    if (cmd === 'download-attachments') {
      const includeImages = argv.includes('--include-images');
      return await cmdDownloadAttachments(parseInt(argv[1], 10), { includeImages });
    }
    if (cmd === 'route') {
      const uid = parseInt(argv[1], 10);
      const actionName = argv[2];
      const payloadIdx = argv.indexOf('--payload');
      let payload = {};
      if (payloadIdx >= 0) {
        const raw = argv[payloadIdx + 1];
        if (raw && fs.existsSync(raw)) payload = JSON.parse(fs.readFileSync(raw, 'utf-8'));
        else payload = JSON.parse(raw || '{}');
      }
      return await cmdRoute(uid, actionName, payload);
    }
    if (cmd === 'recover-stuck') return await cmdRecoverStuck();
    if (cmd === 'check-stuck') return await cmdCheckStuck();
    console.error('Usage: email-workflow-poller.js <command> --workflow <name> [options]');
    console.error('');
    console.error('Commands:');
    console.error('  list                           List UNSEEN emails as JSON');
    console.error('  read <uid>                     Read full email as JSON');
    console.error('  download-attachments <uid>     Save attachments to temp dir');
    console.error('  route <uid> <action>           Execute routing decision');
    console.error('  check-stuck                    Check for stuck (SEEN but not routed) emails');
    console.error('  recover-stuck                  Clear SEEN flag on stuck emails for reprocessing');
    console.error('');
    console.error('Options:');
    console.error('  --workflow <name>              Required; resolves to workflow-actions/<name>.js');
    console.error('  --dry-run                      Preview without modifying state');
    console.error('  --threshold-mins <N>           For stuck commands: age threshold (default 60)');
    console.error('  --include-images               For download-attachments: include image files');
    console.error('  --payload <json|file>          For route: action payload');
    console.error('');
    console.error('Architecture: ~/workspace/astute-workinstructions/email-workflow-architecture.md');
    process.exit(2);
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
