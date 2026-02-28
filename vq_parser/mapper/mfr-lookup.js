const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CACHE_FILE = path.join(__dirname, '../../data/mfr-cache.json');

// Common manufacturer aliases
const MFR_ALIASES = {
  'TI': 'Texas Instruments',
  'ST': 'STMicroelectronics',
  'ADI': 'Analog Devices',
  'AD': 'Analog Devices',
  'NXP': 'NXP Semiconductors',
  'ON': 'ON Semiconductor',
  'ONSEMI': 'ON Semiconductor',
  'MCHP': 'Microchip Technology',
  'MICROCHIP': 'Microchip Technology',
  'XILINX': 'AMD',
  'ALTERA': 'Intel',
  'MAXIM': 'Analog Devices',
  'LINEAR': 'Analog Devices',
  'LINEAR TECH': 'Analog Devices',
  'LINEAR TECHNOLOGY': 'Analog Devices',
  'BROADCOM': 'Broadcom',
  'AVAGO': 'Broadcom',
  'INFINEON': 'Infineon',
  'IR': 'Infineon',
  'INTERNATIONAL RECTIFIER': 'Infineon',
  'VISHAY': 'Vishay',
  'MURATA': 'Murata',
  'TDK': 'TDK',
  'SAMSUNG': 'Samsung',
  'MICRON': 'Micron',
  'PULS': 'PULS',
  'MARVELL': 'Marvell',
  'INTEL': 'Intel',
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Failed to load mfr cache:', err.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save mfr cache:', err.message);
  }
}

function queryDB(mfrName) {
  try {
    const sql = `SELECT name FROM adempiere.chuboe_mfr WHERE name ILIKE '%${mfrName.replace(/'/g, "''")}%' AND isactive='Y' LIMIT 3`;
    const result = execFileSync('psql', ['-t', '-A', '-c', sql], {
      env: { ...process.env, PGDATABASE: process.env.PGDATABASE || 'idempiere_replica' },
      timeout: 10000,
      encoding: 'utf-8'
    });
    const lines = result.trim().split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      return lines[0].trim();
    }
  } catch (err) {
    logger.debug('MFR DB lookup failed:', err.message);
  }
  return null;
}

function normalizeMfr(mfrText) {
  if (!mfrText) return '';

  const trimmed = mfrText.trim();
  const upper = trimmed.toUpperCase();

  // Check aliases first
  if (MFR_ALIASES[upper]) {
    return MFR_ALIASES[upper];
  }

  const cache = loadCache();
  const key = upper;

  if (key in cache) {
    return cache[key] || trimmed;
  }

  // Try DB lookup
  const dbResult = queryDB(trimmed);
  if (dbResult) {
    cache[key] = dbResult;
    saveCache(cache);
    return dbResult;
  }

  // Cache as-is
  cache[key] = trimmed;
  saveCache(cache);
  return trimmed;
}

module.exports = { normalizeMfr };
