const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CACHE_FILE = path.join(__dirname, '../../data/vendor-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Failed to load vendor cache:', err.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save vendor cache:', err.message);
  }
}

function queryDB(vendorName) {
  try {
    const sql = `SELECT value, name FROM adempiere.c_bpartner WHERE name ILIKE '%${vendorName.replace(/'/g, "''")}%' AND isactive='Y' LIMIT 5`;
    const result = execFileSync('psql', ['-t', '-A', '-F', '|', '-c', sql], {
      env: { ...process.env, PGDATABASE: process.env.PGDATABASE || 'idempiere_replica' },
      timeout: 10000,
      encoding: 'utf-8'
    });
    const lines = result.trim().split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const [value, name] = lines[0].split('|');
      return { searchKey: value.trim(), name: name.trim() };
    }
  } catch (err) {
    logger.debug('Vendor DB lookup failed:', err.message);
  }
  return null;
}

function lookupVendor(vendorName) {
  if (!vendorName) return '';

  const cache = loadCache();
  const key = vendorName.toLowerCase().trim();

  if (key in cache) {
    return cache[key] || '';
  }

  const result = queryDB(vendorName);
  if (result) {
    cache[key] = result.searchKey;
    saveCache(cache);
    logger.debug(`Vendor resolved: "${vendorName}" → ${result.searchKey} (${result.name})`);
    return result.searchKey;
  }

  // Cache miss too
  cache[key] = '';
  saveCache(cache);
  logger.warn(`Vendor not found in DB: "${vendorName}"`);
  return '';
}

function lookupVendorByEmail(email) {
  if (!email) return '';

  const cache = loadCache();
  const key = `email:${email.toLowerCase().trim()}`;

  if (key in cache) {
    return cache[key] || '';
  }

  // Try to extract domain-based vendor name
  const domain = email.split('@')[1];
  if (!domain) return '';

  const vendorHint = domain.split('.')[0];
  const result = queryDB(vendorHint);
  if (result) {
    cache[key] = result.searchKey;
    saveCache(cache);
    return result.searchKey;
  }

  cache[key] = '';
  saveCache(cache);
  return '';
}

module.exports = { lookupVendor, lookupVendorByEmail };
