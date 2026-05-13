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
 *       Read full email as JSON: { uid, subject, from, to, cc, date, body,
 *                                   forwarded_headers: {originalFrom, originalCc, originalSubject},
 *                                   external_sender, internal_forwarder, attachments: [...] }
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

function enumerateAttachments(attachments) {
  return (attachments || [])
    .filter(a => a.filename && !/^image\//i.test(a.contentType || ''))
    .map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size }));
}

// ─── FORWARDED-HEADER PARSING ────────────────────────────────────────────────

function parseForwardedHeaders(body) {
  if (!body) return { originalFrom: null, originalCc: [], originalSubject: null };

  const text = body
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[a-zA-Z\/][^>@]*>/g, ' ');

  const fromMatch = text.match(/^[ \t]*From:[ \t]*(.+)$/im);
  const ccMatch = text.match(/^[ \t]*Cc:[ \t]*(.+)$/im);
  const subjMatch = text.match(/^[ \t]*Subject:[ \t]*(.+)$/im);

  const extractEmails = (line) => {
    if (!line) return [];
    const re = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
    return (line.match(re) || []).map(e => e.toLowerCase());
  };

  return {
    originalFrom: extractEmails(fromMatch && fromMatch[1])[0] || null,
    originalCc: extractEmails(ccMatch && ccMatch[1]),
    originalSubject: (subjMatch && subjMatch[1].trim()) || null,
  };
}

function isInternalAddress(addr) {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a.endsWith('@astutegroup.com') || a.endsWith('@orangetsunami.com');
}

// ─── COMMAND: list ───────────────────────────────────────────────────────────

async function cmdList() {
  const envelopes = await withInbox(async (client) => {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    if (uids.length === 0) return [];
    const out = [];
    for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, flags: true }, { uid: true })) {
      const env = msg.envelope || {};
      const from = env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '';
      const atts = [];
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
        const disp = (node.disposition || '').toLowerCase();
        const fname = (node.dispositionParameters && node.dispositionParameters.filename) ||
                      (node.parameters && node.parameters.name) || null;
        if (disp === 'attachment' && fname && !/^image\//i.test(node.type || '')) {
          atts.push(fname);
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
    const fwd = parseForwardedHeaders(bodyText);
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
      forwarded_headers: fwd,
      external_sender: externalSender,
      internal_forwarder: isInternalAddress(senderAddr) ? senderAddr : null,
      attachments: enumerateAttachments(parsed.attachments),
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
 * Save all non-image attachments for a given UID to a tmp directory.
 * Prints the directory path + filename list as JSON. The agent then uses
 * the Read tool on individual files to inspect xlsx/csv/pdf content.
 *
 * Inline images are skipped (Outlook signature noise — not real attachments).
 */
async function cmdDownloadAttachments(uid) {
  const os = require('os');
  const result = await withInbox(async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-${WORKFLOW_NAME}-${uid}-`));
    const files = [];
    for (const att of (parsed.attachments || [])) {
      if (!att.filename) continue;
      if (/^image\//i.test(att.contentType || '')) continue;
      const outPath = path.join(outDir, att.filename);
      fs.writeFileSync(outPath, att.content);
      files.push({
        filename: att.filename,
        path: outPath,
        size: att.size || att.content.length,
        contentType: att.contentType,
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

  // Fetch the current message's Message-ID + references so we can determine
  // the thread anchor for reply-stitching state management.
  let currentMessageId = null;
  let currentReferences = [];
  try {
    await withInbox(async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
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

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (cmd === 'list') return await cmdList();
    if (cmd === 'read') return await cmdRead(parseInt(argv[1], 10));
    if (cmd === 'download-attachments') return await cmdDownloadAttachments(parseInt(argv[1], 10));
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
    console.error('Usage: email-workflow-poller.js (list | read <uid> | download-attachments <uid> | route <uid> <action> --payload <json|file>) --workflow <name> [--dry-run]');
    console.error('Architecture: ~/workspace/astute-workinstructions/email-workflow-architecture.md');
    process.exit(2);
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
