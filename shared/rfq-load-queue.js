/**
 * RFQ Load Queue — file-based priority queue for the loader daemon
 *
 * Persists queued RFQ load jobs to a JSON file. The daemon reads/writes
 * this file; calling workflows enqueue new jobs. Priority ordering ensures
 * small RFQs (< 500 lines) are loaded before large ones.
 *
 * USAGE:
 *   const queue = require('../shared/rfq-load-queue');
 *
 *   // Enqueue from a workflow
 *   const jobId = queue.enqueue({
 *     bpartnerId: 1000383, type: 'PPV', userId: 1048311,
 *     lines: [...], description: 'Honeywell AMERICAS',
 *   });
 *
 *   // Daemon dispatching
 *   const item = queue.dequeue();        // next job by priority
 *   queue.updateItem(item.id, { status: 'loading' });
 *   // ... load ...
 *   queue.updateItem(item.id, { status: 'loaded', rfqId: 123, searchKey: '1132320' });
 *
 * QUEUE FILE: ~/workspace/.rfq-load-queue.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.rfq-load-queue.json');
const SMALL_THRESHOLD = 100; // lines — below this = high priority

// ─── FILE I/O ────────────────────────────────────────────────────────────────

function loadQueue() {
  try {
    const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { _format: 'rfq-load-queue v1', _updated: new Date().toISOString(), items: [] };
    }
    throw e;
  }
}

function saveQueue(data) {
  data._updated = new Date().toISOString();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── PRIORITY ────────────────────────────────────────────────────────────────

function assignPriority(lineCount) {
  return lineCount < SMALL_THRESHOLD ? 'high' : 'low';
}

// Sort: high before low, then FIFO by enqueuedAt
function prioritySort(a, b) {
  if (a.priority !== b.priority) {
    return a.priority === 'high' ? -1 : 1;
  }
  return new Date(a.enqueuedAt) - new Date(b.enqueuedAt);
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Add a new RFQ load job to the queue.
 *
 * @param {object} payload - Same shape as loadRFQ() opts:
 *   { bpartnerId, type, description, salesrepId, userId, statusId, lines[] }
 * @returns {string} Job ID
 */
function enqueue(payload) {
  if (!payload || !payload.lines || payload.lines.length === 0) {
    throw new Error('rfq-load-queue: payload must include lines[]');
  }

  const lineCount = payload.lines.length;
  const id = `rfqload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  const item = {
    id,
    status: 'queued',
    priority: assignPriority(lineCount),
    lineCount,
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    rfqId: null,
    searchKey: null,
    linesWritten: 0,
    mpnsWritten: 0,
    checkpoint: 0,
    errors: [],
    lastError: null,
    lastProgressAt: null,
    payload,
  };

  const data = loadQueue();
  data.items.push(item);
  saveQueue(data);

  return id;
}

/**
 * Return the next job to run, respecting priority ordering.
 * Does NOT change the item's status — caller must updateItem().
 *
 * @param {object} [opts]
 * @param {boolean} [opts.peek=false] - If true, return without side effects (for preemption check)
 * @returns {object|null} Queue item, or null if nothing queued
 */
function dequeue(opts = {}) {
  const data = loadQueue();
  const queued = data.items
    .filter(i => i.status === 'queued')
    .sort(prioritySort);

  return queued[0] || null;
}

/**
 * Update a job's fields in-place and persist.
 *
 * @param {string} id - Job ID
 * @param {object} updates - Partial fields to merge
 */
function updateItem(id, updates) {
  const data = loadQueue();
  const item = data.items.find(i => i.id === id);
  if (!item) throw new Error(`rfq-load-queue: item '${id}' not found`);

  Object.assign(item, updates);
  saveQueue(data);
}

/**
 * Get all items, optionally filtered by status.
 *
 * @param {string} [status] - Filter by status, or null for all
 * @returns {Array} Queue items
 */
function listItems(status) {
  const data = loadQueue();
  if (status) return data.items.filter(i => i.status === status);
  return data.items;
}

/**
 * Get a single item by ID.
 *
 * @param {string} id
 * @returns {object|null}
 */
function getItem(id) {
  const data = loadQueue();
  return data.items.find(i => i.id === id) || null;
}

/**
 * Remove completed/partial/error jobs older than retentionDays.
 *
 * @param {number} [retentionDays=7]
 * @returns {number} Number of items pruned
 */
function pruneCompleted(retentionDays = 7) {
  const data = loadQueue();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const before = data.items.length;

  data.items = data.items.filter(i => {
    if (i.status === 'queued' || i.status === 'loading') return true; // never prune active
    const completedAt = i.completedAt ? new Date(i.completedAt) : null;
    if (!completedAt) return true; // no completion date, keep
    return completedAt > cutoff;
  });

  const pruned = before - data.items.length;
  if (pruned > 0) saveQueue(data);
  return pruned;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  enqueue,
  dequeue,
  updateItem,
  listItems,
  getItem,
  pruneCompleted,
  SMALL_THRESHOLD,
  QUEUE_FILE,
};
