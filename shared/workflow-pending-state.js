/**
 * shared/workflow-pending-state.js
 *
 * Generic sidecar-state helper for email workflows that use a need_info →
 * reply-stitching loop. Any workflow that consumes shared/email-workflow-poller.js
 * gets reply-stitching for free if its need_info handler writes a sidecar here.
 *
 * Sidecars live at:
 *   ~/workspace/.<workflow>-pending/<sanitized-message-id>.json
 *
 * Record shape (all fields optional except workflow, original_message_id,
 * retry_count, created_at, updated_at — those are managed here):
 *   {
 *     workflow:              "rfq-loading",
 *     original_message_id:   "<X1@host>",          // Message-ID of the first email in the thread
 *     original_uid:          117,                   // optional, useful for folder-back-fetch
 *     original_subject:      "FW: McMaster AMAT RFQs",
 *     original_recipient:    "josh.syre@astutegroup.com",
 *     extracted:             { ...whatever the agent already parsed... },
 *     missing:               ["qty", "rfq_type"],
 *     retry_count:           0,                     // bumped on each subsequent need_info round
 *     created_at:            "2026-05-13T15:13:43Z",
 *     updated_at:            "2026-05-13T20:30:00Z"
 *   }
 *
 * Lookup by References array: when a reply lands, the poller passes the
 * reply's `references` (which includes the original Message-ID at the head
 * of the thread chain) to findByReferences(). First match wins.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/analytics_user';

function dirFor(workflow) {
  if (!workflow || typeof workflow !== 'string') {
    throw new Error('workflow-pending-state: workflow name required');
  }
  return path.join(HOME, 'workspace', `.${workflow}-pending`);
}

function ensureDir(workflow) {
  const d = dirFor(workflow);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function sanitize(messageId) {
  if (!messageId) return '';
  return String(messageId)
    .replace(/^<|>$/g, '')
    .replace(/[^a-zA-Z0-9._@+-]/g, '_');
}

function fileFor(workflow, messageId) {
  return path.join(dirFor(workflow), `${sanitize(messageId)}.json`);
}

function readSidecar(workflow, messageId) {
  if (!messageId) return null;
  const file = fileFor(workflow, messageId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

/**
 * Create or update a sidecar. On update, retry_count is bumped automatically
 * (the caller can override by passing retry_count explicitly).
 */
function writeSidecar(workflow, messageId, data) {
  if (!messageId) throw new Error('writeSidecar requires messageId');
  ensureDir(workflow);
  const file = fileFor(workflow, messageId);
  const now = new Date().toISOString();
  const existing = readSidecar(workflow, messageId);
  const record = existing
    ? {
        ...existing,
        ...data,
        retry_count: (typeof data.retry_count === 'number')
          ? data.retry_count
          : (existing.retry_count || 0) + 1,
        updated_at: now,
      }
    : {
        workflow,
        original_message_id: messageId,
        retry_count: 0,
        created_at: now,
        ...data,
        updated_at: now,
      };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

/**
 * Look up a sidecar by any entry in an array of message-ids (typically the
 * `references` array on a reply). Returns the first match or null.
 */
function findByReferences(workflow, references) {
  if (!Array.isArray(references) || references.length === 0) return null;
  for (const ref of references) {
    const record = readSidecar(workflow, ref);
    if (record) return record;
  }
  return null;
}

function clearSidecar(workflow, messageId) {
  if (!messageId) return false;
  const file = fileFor(workflow, messageId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function listSidecars(workflow) {
  const d = dirFor(workflow);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

module.exports = {
  writeSidecar,
  readSidecar,
  findByReferences,
  clearSidecar,
  listSidecars,
  _dirFor: dirFor,
  _sanitize: sanitize,
};
