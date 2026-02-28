const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ACCOUNT = process.env.HIMALAYA_ACCOUNT || 'vq';
const TEMP_DIR = '/tmp/vq-attachments';

/**
 * Download attachments for a given message ID
 * @param {string} messageId - The email message ID
 * @param {string} folder - The folder containing the message
 * @returns {Array<{filename: string, path: string, type: string}>} Downloaded attachment info
 */
function downloadAttachments(messageId, folder = 'INBOX') {
  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Create message-specific subdirectory
  const msgDir = path.join(TEMP_DIR, `msg_${messageId}`);
  if (!fs.existsSync(msgDir)) {
    fs.mkdirSync(msgDir, { recursive: true });
  }

  try {
    // Run himalaya attachment download
    const cmd = `himalaya attachment download --account ${ACCOUNT} --folder "${folder}" ${messageId}`;
    const output = execSync(cmd, {
      encoding: 'utf-8',
      cwd: msgDir,
      timeout: 30000
    });

    logger.debug(`Attachment download output: ${output}`);

    // Find downloaded files in temp dir and msgDir
    const attachments = [];

    // Check /tmp for files (himalaya downloads there by default)
    const tmpFiles = fs.readdirSync('/tmp').filter(f => {
      const fpath = path.join('/tmp', f);
      try {
        const stat = fs.statSync(fpath);
        // Only include files modified in the last minute
        return stat.isFile() && (Date.now() - stat.mtimeMs) < 60000;
      } catch {
        return false;
      }
    });

    // Also check msgDir
    const msgDirFiles = fs.existsSync(msgDir) ? fs.readdirSync(msgDir) : [];

    const allFiles = [...new Set([...tmpFiles, ...msgDirFiles])];

    for (const filename of allFiles) {
      // Try both locations
      let filepath = path.join('/tmp', filename);
      if (!fs.existsSync(filepath)) {
        filepath = path.join(msgDir, filename);
      }
      if (!fs.existsSync(filepath)) continue;

      const ext = path.extname(filename).toLowerCase();
      let type = 'unknown';

      if (ext === '.pdf') type = 'pdf';
      else if (ext === '.xlsx' || ext === '.xls') type = 'excel';
      else if (ext === '.csv') type = 'csv';
      else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext)) type = 'image';
      else if (ext === '.txt') type = 'text';

      // Skip images (usually signatures)
      if (type !== 'image') {
        attachments.push({
          filename,
          path: filepath,
          type
        });
      }
    }

    logger.info(`Downloaded ${attachments.length} relevant attachment(s) for message ${messageId}`);
    return attachments;

  } catch (err) {
    logger.error(`Failed to download attachments for message ${messageId}: ${err.message}`);
    return [];
  }
}

/**
 * Clean up downloaded attachments for a message
 * @param {string} messageId - The message ID
 */
function cleanupAttachments(messageId) {
  const msgDir = path.join(TEMP_DIR, `msg_${messageId}`);
  if (fs.existsSync(msgDir)) {
    try {
      fs.rmSync(msgDir, { recursive: true });
    } catch (err) {
      logger.warn(`Failed to cleanup attachments for ${messageId}: ${err.message}`);
    }
  }
}

module.exports = { downloadAttachments, cleanupAttachments, TEMP_DIR };
