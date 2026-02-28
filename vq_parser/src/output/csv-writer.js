const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const path = require('path');
const { VQ_COLUMNS } = require('../../config/columns');
const logger = require('../utils/logger');

function generateFilename(rfq, vendorName, outputDir) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').substring(0, 15);
  const cleanVendor = (vendorName || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const filename = `VQ_${rfq}_${cleanVendor}_${timestamp}.csv`;
  return path.join(outputDir, filename);
}

function writeCSV(rows, rfq, vendorName, outputDir) {
  if (!rows || rows.length === 0) {
    logger.warn('No rows to write');
    return null;
  }

  outputDir = outputDir || process.env.OUTPUT_DIR || path.join(__dirname, '../../output');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filepath = generateFilename(rfq, vendorName, outputDir);

  // Build ordered data array
  const data = rows.map(row => VQ_COLUMNS.map(col => row[col] || ''));

  const csv = stringify([VQ_COLUMNS, ...data]);

  fs.writeFileSync(filepath, csv, 'utf-8');
  logger.info(`CSV written: ${filepath} (${rows.length} rows)`);
  return filepath;
}

module.exports = { writeCSV, generateFilename };
