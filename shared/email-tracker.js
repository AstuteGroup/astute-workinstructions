/**
 * Shared Email Tracker
 *
 * Factory that creates a tracker bound to a workflow's data directory.
 * Tracks processed email IDs (dedup), run stats, and retry queue.
 *
 * Usage:
 *   const { createTracker } = require('../shared/email-tracker');
 *   const tracker = createTracker('/path/to/workflow/data');
 *   if (!tracker.isProcessed(emailId)) { ... }
 *   tracker.markProcessed(emailId, { subject, from, recordsAdded: 3 });
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function createTracker(dataDir) {
  if (!dataDir) throw new Error('email-tracker: dataDir is required');

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const DATA_FILE = path.join(dataDir, 'processed-ids.json');
  const STATS_FILE = path.join(dataDir, 'stats.json');
  const RETRY_FILE = path.join(dataDir, 'retry-queue.json');

  // ============================================
  // Processed IDs tracking
  // ============================================

  function loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      }
    } catch (err) {
      logger.warn('Failed to load tracker data:', err.message);
    }
    return { processedIds: {}, lastRun: null };
  }

  function saveData(data) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save tracker data:', err.message);
    }
  }

  function isProcessed(id) {
    const data = loadData();
    return id in data.processedIds;
  }

  function markProcessed(id, metadata = {}) {
    const data = loadData();
    data.processedIds[id] = {
      date: new Date().toISOString(),
      ...metadata
    };
    data.lastRun = new Date().toISOString();
    saveData(data);
  }

  function getProcessedStats() {
    const data = loadData();
    return {
      processedCount: Object.keys(data.processedIds).length,
      lastRun: data.lastRun,
      recentIds: Object.entries(data.processedIds)
        .sort((a, b) => b[1].date.localeCompare(a[1].date))
        .slice(0, 10)
        .map(([id, meta]) => ({ id, ...meta }))
    };
  }

  function removeProcessed(id) {
    const data = loadData();
    delete data.processedIds[id];
    saveData(data);
  }

  // ============================================
  // Stats tracking
  // ============================================

  function loadStats() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      }
    } catch (err) {
      logger.warn('Failed to load stats:', err.message);
    }
    return {
      lastUpdated: null,
      totals: {
        emailsProcessed: 0,
        recordsGenerated: 0,
        recordsComplete: 0,
        recordsPartial: 0,
        moveFailures: 0
      },
      byKey: {},
      history: []
    };
  }

  function saveStats(stats) {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save stats:', err.message);
    }
  }

  function updateStats(delta) {
    const stats = loadStats();
    stats.lastUpdated = new Date().toISOString();

    for (const [key, value] of Object.entries(delta)) {
      if (key in stats.totals && typeof value === 'number') {
        stats.totals[key] += value;
      }
    }

    stats.history.push({
      timestamp: stats.lastUpdated,
      ...delta
    });

    if (stats.history.length > 100) {
      stats.history = stats.history.slice(-100);
    }

    saveStats(stats);
    return stats;
  }

  function getStats() {
    return loadStats();
  }

  function updateKeyStats(key, delta) {
    const stats = loadStats();

    if (!stats.byKey[key]) {
      stats.byKey[key] = {
        emailsProcessed: 0,
        recordsGenerated: 0,
        recordsComplete: 0,
        recordsPartial: 0
      };
    }

    for (const [k, value] of Object.entries(delta)) {
      if (k in stats.byKey[key] && typeof value === 'number') {
        stats.byKey[key][k] += value;
      }
    }

    stats.lastUpdated = new Date().toISOString();
    saveStats(stats);
    return stats;
  }

  // ============================================
  // Retry queue for failed email moves
  // ============================================

  function loadRetryQueue() {
    try {
      if (fs.existsSync(RETRY_FILE)) {
        return JSON.parse(fs.readFileSync(RETRY_FILE, 'utf-8'));
      }
    } catch (err) {
      logger.warn('Failed to load retry queue:', err.message);
    }
    return { pendingRetries: [] };
  }

  function saveRetryQueue(queue) {
    try {
      fs.writeFileSync(RETRY_FILE, JSON.stringify(queue, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save retry queue:', err.message);
    }
  }

  function addToRetryQueue(emailId, reason, metadata = {}) {
    const queue = loadRetryQueue();

    const existing = queue.pendingRetries.find(r => r.emailId === emailId);
    if (existing) {
      existing.attempts++;
      existing.lastAttempt = new Date().toISOString();
      existing.reason = reason;
    } else {
      queue.pendingRetries.push({
        emailId,
        reason,
        addedAt: new Date().toISOString(),
        lastAttempt: new Date().toISOString(),
        attempts: 1,
        ...metadata
      });
    }

    saveRetryQueue(queue);
    logger.info(`Added email ${emailId} to retry queue: ${reason}`);
    updateStats({ moveFailures: 1 });
  }

  function removeFromRetryQueue(emailId) {
    const queue = loadRetryQueue();
    queue.pendingRetries = queue.pendingRetries.filter(r => r.emailId !== emailId);
    saveRetryQueue(queue);
  }

  function getRetryQueue() {
    return loadRetryQueue();
  }

  function getPendingRetries(maxAttempts = 5) {
    const queue = loadRetryQueue();
    return queue.pendingRetries.filter(r => r.attempts < maxAttempts);
  }

  return {
    // Processed IDs
    isProcessed,
    markProcessed,
    getProcessedStats,
    removeProcessed,
    // Stats
    getStats,
    updateStats,
    updateKeyStats,
    // Retry queue
    addToRetryQueue,
    removeFromRetryQueue,
    getRetryQueue,
    getPendingRetries
  };
}

module.exports = { createTracker };
