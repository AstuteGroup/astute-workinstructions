const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '../../data/processed-ids.json');

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

function getStats() {
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

module.exports = { isProcessed, markProcessed, getStats, removeProcessed };
