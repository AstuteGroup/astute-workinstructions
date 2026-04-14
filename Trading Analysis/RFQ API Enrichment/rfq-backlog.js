/**
 * Tier 4 Backlog Manager — deferred PPV US/CA enrichment queue.
 *
 * New Tier 4 RFQs get queued here by enrich-poller.js. Each cron tick
 * drains the backlog (oldest first) with remaining DigiKey quota.
 * Items older than 7 days are pruned automatically.
 *
 * State file: ~/workspace/.rfq-enrichment-backlog.json
 */

const fs = require('fs');
const path = require('path');

const BACKLOG_FILE = path.resolve(process.env.HOME || '/home/analytics_user', 'workspace/.rfq-enrichment-backlog.json');
const MAX_AGE_DAYS = 7;

function readBacklog() {
  try {
    if (!fs.existsSync(BACKLOG_FILE)) return { version: 1, items: [] };
    const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
    if (!data || !Array.isArray(data.items)) return { version: 1, items: [] };
    return data;
  } catch {
    return { version: 1, items: [] };
  }
}

function writeBacklog(backlog) {
  try {
    const tmp = BACKLOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(backlog, null, 2), 'utf-8');
    fs.renameSync(tmp, BACKLOG_FILE);
  } catch (err) {
    console.error('WARN: failed to write backlog:', err.message);
  }
}

/**
 * Add RFQ rows to the backlog. Deduplicates by rfq_number.
 * Returns count of newly added items.
 */
function addToBacklog(rfqRows) {
  const backlog = readBacklog();
  const existing = new Set(backlog.items.map(i => i.rfq_number));
  let added = 0;
  for (const r of rfqRows) {
    if (existing.has(r.rfq_number)) continue;
    backlog.items.push({
      rfq_number: r.rfq_number,
      chuboe_rfq_id: r.chuboe_rfq_id,
      customer: r.customer,
      rfq_type: r.rfq_type,
      priority: r.priority || 'P3',
      line_mpns: Number(r.line_mpns) || 0,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      status: 'pending',
    });
    existing.add(r.rfq_number);
    added++;
  }
  if (added > 0) writeBacklog(backlog);
  return added;
}

/**
 * Get the next batch of pending items, oldest first.
 */
function nextBatch(maxCount = 10) {
  const backlog = readBacklog();
  return backlog.items
    .filter(i => i.status === 'pending')
    .sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt))
    .slice(0, maxCount);
}

/**
 * Mark an item as attempted. Outcome: 'success', 'error', 'quota_exhausted'.
 */
function markAttempted(rfqNumber, outcome) {
  const backlog = readBacklog();
  const item = backlog.items.find(i => i.rfq_number === rfqNumber);
  if (!item) return;
  item.attempts++;
  item.lastAttemptAt = new Date().toISOString();
  if (outcome === 'success') {
    item.status = 'done';
  } else if (outcome === 'quota_exhausted') {
    // Leave as pending for next tick
  } else {
    // error — leave as pending, will retry next tick
  }
  writeBacklog(backlog);
}

/**
 * Prune items older than maxAgeDays, plus completed items.
 * Returns count of pruned items.
 */
function pruneBacklog(maxAgeDays = MAX_AGE_DAYS) {
  const backlog = readBacklog();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const before = backlog.items.length;
  backlog.items = backlog.items.filter(i => {
    if (i.status === 'done') return false;
    if (new Date(i.queuedAt).getTime() < cutoff) return false;
    return true;
  });
  const pruned = before - backlog.items.length;
  if (pruned > 0) writeBacklog(backlog);
  return pruned;
}

/**
 * Summary stats for the backlog (used in email reports).
 */
function backlogStats() {
  const backlog = readBacklog();
  const pending = backlog.items.filter(i => i.status === 'pending');
  const oldest = pending.length > 0
    ? pending.reduce((a, b) => new Date(a.queuedAt) < new Date(b.queuedAt) ? a : b)
    : null;
  const ageHours = oldest ? Math.round((Date.now() - new Date(oldest.queuedAt).getTime()) / 3600000) : 0;
  return {
    total: backlog.items.length,
    pending: pending.length,
    oldestAgeHours: ageHours,
    totalLineMpns: pending.reduce((s, i) => s + (i.line_mpns || 0), 0),
  };
}

module.exports = { readBacklog, addToBacklog, nextBatch, markAttempted, pruneBacklog, backlogStats, BACKLOG_FILE };
