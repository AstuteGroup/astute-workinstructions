/**
 * shared/tracking-id.js
 *
 * Unified Email Tracking ID system.
 *
 * Problem: UIDs are per-inbox AND per-folder. When emails move folders, they
 * get new UIDs. Operators reference "UID 317" but we can't find it without
 * knowing inbox + folder. No single place to look up "what is this email?"
 *
 * Solution: Assign a stable tracking ID when an email first enters the system.
 * The tracking ID never changes regardless of folder moves, encodes the inbox
 * for immediate context, and maps to Message-ID (the true stable identifier).
 *
 * Format: {PREFIX}-{SEQUENCE}
 *   VQ-01542      → vq@ inbox, sequence 1542
 *   RFQ-00317     → rfqloading@ inbox, sequence 317
 *   STK-15099     → stockRFQ@ inbox, sequence 15099
 *
 * USAGE:
 *   const { assignTrackingId, lookupByTrackingId, lookupByMessageId, updateStatus } = require('./tracking-id');
 *
 *   // Assign on first read
 *   const trackingId = assignTrackingId({
 *     inbox: 'vq@orangetsunami.com',
 *     uid: 11948,
 *     messageId: '<abc123@host>',
 *     subject: 'RE: RFQ 1140528',
 *     from: 'nenad.pozder@astutegroup.com',
 *   });
 *   // Returns: 'VQ-11948'
 *
 *   // Lookup by tracking ID
 *   const record = lookupByTrackingId('VQ-11948');
 *
 *   // Lookup by Message-ID (for reply stitching)
 *   const record = lookupByMessageId('<abc123@host>');
 *
 *   // Update when email moves or status changes
 *   updateStatus('VQ-11948', { currentFolder: 'Processed', status: 'loaded' });
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(
  process.env.HOME || '/home/analytics_user',
  '.email-tracking-registry.jsonl'
);

// Sequence counters persist separately so we don't have to scan the whole registry
const SEQUENCE_PATH = path.join(
  process.env.HOME || '/home/analytics_user',
  '.email-tracking-sequences.json'
);

// Inbox → Prefix mapping
const INBOX_PREFIXES = {
  'rfqloading@orangetsunami.com': 'RFQ',
  'vq@orangetsunami.com': 'VQ',
  'stockrfq@orangetsunami.com': 'STK',   // lowercase for matching
  'excess@orangetsunami.com': 'EXC',
  'tracking@orangetsunami.com': 'TRK',
  'brokeroffers@orangetsunami.com': 'BRK',
  'lamkitting@orangetsunami.com': 'LAM',
  'vortex@orangetsunami.com': 'VTX',
};

// Reverse lookup: prefix → inbox
const PREFIX_TO_INBOX = Object.fromEntries(
  Object.entries(INBOX_PREFIXES).map(([inbox, prefix]) => [prefix, inbox])
);

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────

// Cache for fast lookups — loaded lazily on first access
let registryCache = null;       // Map: trackingId → record
let messageIdIndex = null;      // Map: messageId → trackingId
let sequenceCounters = null;    // { prefix: nextSequence }

function ensureCacheLoaded() {
  if (registryCache !== null) return;

  registryCache = new Map();
  messageIdIndex = new Map();

  // Load existing registry
  if (fs.existsSync(REGISTRY_PATH)) {
    const lines = fs.readFileSync(REGISTRY_PATH, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.trackingId) {
          registryCache.set(record.trackingId, record);
          if (record.messageId) {
            messageIdIndex.set(record.messageId, record.trackingId);
          }
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  }

  // Load sequence counters
  if (fs.existsSync(SEQUENCE_PATH)) {
    try {
      sequenceCounters = JSON.parse(fs.readFileSync(SEQUENCE_PATH, 'utf-8'));
    } catch (e) {
      sequenceCounters = {};
    }
  } else {
    sequenceCounters = {};
  }
}

function saveSequenceCounters() {
  fs.writeFileSync(SEQUENCE_PATH, JSON.stringify(sequenceCounters, null, 2));
}

function appendToRegistry(record) {
  fs.appendFileSync(REGISTRY_PATH, JSON.stringify(record) + '\n');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Get prefix for an inbox address.
 */
function getPrefixForInbox(inbox) {
  const normalized = inbox.toLowerCase().trim();
  return INBOX_PREFIXES[normalized] || 'UNK';
}

/**
 * Format tracking ID with zero-padded sequence.
 * Uses 5 digits for sequences (00001-99999), enough for years of emails.
 */
function formatTrackingId(prefix, sequence) {
  return `${prefix}-${String(sequence).padStart(5, '0')}`;
}

/**
 * Parse a tracking ID into { prefix, sequence }.
 */
function parseTrackingId(trackingId) {
  const match = trackingId.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return {
    prefix: match[1],
    sequence: parseInt(match[2], 10),
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Assign a tracking ID to an email. Idempotent — if the Message-ID already
 * has a tracking ID, returns the existing one.
 *
 * @param {object} opts
 * @param {string} opts.inbox          The inbox email address (e.g., 'vq@orangetsunami.com')
 * @param {number} opts.uid            The IMAP UID (for reference, not used in tracking ID)
 * @param {string} opts.messageId      The RFC822 Message-ID header
 * @param {string} [opts.subject]      Email subject
 * @param {string} [opts.from]         Sender email
 * @param {string} [opts.folder]       Current folder (default: 'INBOX')
 * @returns {string} The tracking ID (e.g., 'VQ-11948')
 */
function assignTrackingId(opts) {
  const { inbox, uid, messageId, subject, from, folder = 'INBOX' } = opts;

  if (!inbox || !messageId) {
    throw new Error('assignTrackingId requires inbox and messageId');
  }

  ensureCacheLoaded();

  // Check if already assigned
  const existingId = messageIdIndex.get(messageId);
  if (existingId) {
    return existingId;
  }

  // Get prefix and next sequence
  const prefix = getPrefixForInbox(inbox);
  const nextSeq = (sequenceCounters[prefix] || 0) + 1;
  sequenceCounters[prefix] = nextSeq;
  saveSequenceCounters();

  const trackingId = formatTrackingId(prefix, nextSeq);
  const now = new Date().toISOString();

  const record = {
    trackingId,
    inbox: inbox.toLowerCase(),
    messageId,
    uid,
    subject: subject || null,
    from: from || null,
    receivedAt: now,
    currentFolder: folder,
    status: 'unprocessed',
    lastUpdated: now,
  };

  // Update cache
  registryCache.set(trackingId, record);
  messageIdIndex.set(messageId, trackingId);

  // Persist
  appendToRegistry(record);

  return trackingId;
}

/**
 * Look up a record by tracking ID.
 *
 * @param {string} trackingId  e.g., 'VQ-11948'
 * @returns {object|null} The record, or null if not found
 */
function lookupByTrackingId(trackingId) {
  ensureCacheLoaded();
  return registryCache.get(trackingId) || null;
}

/**
 * Look up a record by Message-ID.
 *
 * @param {string} messageId  The RFC822 Message-ID header
 * @returns {object|null} The record, or null if not found
 */
function lookupByMessageId(messageId) {
  ensureCacheLoaded();
  const trackingId = messageIdIndex.get(messageId);
  if (!trackingId) return null;
  return registryCache.get(trackingId) || null;
}

/**
 * Look up a record by original UID + inbox.
 * Less reliable than Message-ID (UIDs change on folder move) but useful
 * for backwards compatibility with existing breadcrumbs.
 *
 * @param {number} uid     The original IMAP UID
 * @param {string} inbox   The inbox email address
 * @returns {object|null} The record, or null if not found
 */
function lookupByUid(uid, inbox) {
  ensureCacheLoaded();
  const normalizedInbox = inbox.toLowerCase();
  for (const record of registryCache.values()) {
    if (record.uid === uid && record.inbox === normalizedInbox) {
      return record;
    }
  }
  return null;
}

/**
 * Update a tracking record's status/folder/metadata.
 *
 * @param {string} trackingId  The tracking ID to update
 * @param {object} updates     Fields to update (currentFolder, status, rfqSearchKey, etc.)
 * @returns {object|null} The updated record, or null if not found
 */
function updateStatus(trackingId, updates) {
  ensureCacheLoaded();

  const record = registryCache.get(trackingId);
  if (!record) return null;

  // Apply updates
  Object.assign(record, updates, {
    lastUpdated: new Date().toISOString(),
  });

  // Update cache
  registryCache.set(trackingId, record);

  // Rewrite the registry file (simple approach — could optimize with append-only updates)
  rewriteRegistry();

  return record;
}

/**
 * Rewrite the entire registry from cache.
 * Called after updates to ensure persistence.
 */
function rewriteRegistry() {
  const lines = [];
  for (const record of registryCache.values()) {
    lines.push(JSON.stringify(record));
  }
  fs.writeFileSync(REGISTRY_PATH, lines.join('\n') + '\n');
}

/**
 * Get all records for an inbox (for debugging/reporting).
 *
 * @param {string} inbox  The inbox email address
 * @param {object} [opts]
 * @param {string} [opts.status]  Filter by status
 * @param {number} [opts.limit]   Max records to return
 * @returns {object[]} Array of records
 */
function listByInbox(inbox, opts = {}) {
  ensureCacheLoaded();
  const { status, limit } = opts;
  const normalizedInbox = inbox.toLowerCase();

  const results = [];
  for (const record of registryCache.values()) {
    if (record.inbox !== normalizedInbox) continue;
    if (status && record.status !== status) continue;
    results.push(record);
    if (limit && results.length >= limit) break;
  }

  // Sort by receivedAt descending (most recent first)
  results.sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));

  return results;
}

/**
 * Get registry stats (for debugging/monitoring).
 */
function getStats() {
  ensureCacheLoaded();

  const stats = {
    totalRecords: registryCache.size,
    byInbox: {},
    byStatus: {},
  };

  for (const record of registryCache.values()) {
    const inbox = record.inbox || 'unknown';
    const status = record.status || 'unknown';

    stats.byInbox[inbox] = (stats.byInbox[inbox] || 0) + 1;
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
  }

  return stats;
}

/**
 * Force reload cache from disk (for testing or after external edits).
 */
function reloadCache() {
  registryCache = null;
  messageIdIndex = null;
  sequenceCounters = null;
  ensureCacheLoaded();
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  // Core API
  assignTrackingId,
  lookupByTrackingId,
  lookupByMessageId,
  lookupByUid,
  updateStatus,

  // Utilities
  listByInbox,
  getStats,
  reloadCache,

  // Helpers (exposed for testing)
  getPrefixForInbox,
  parseTrackingId,
  formatTrackingId,

  // Constants (exposed for reference)
  INBOX_PREFIXES,
  PREFIX_TO_INBOX,
  REGISTRY_PATH,
};
