const { downloadAttachments, cleanupAttachments } = require('./downloader');
const { parsePDF } = require('./pdf-parser');
const { parseExcel, parseCSV } = require('./excel-parser');
const logger = require('../utils/logger');

/**
 * Process all attachments for a message and extract quote data
 * @param {string} messageId - The email message ID
 * @param {string} folder - The folder containing the message
 * @returns {Promise<{lines: Array, confidence: number, strategy: string, attachmentFile: string}>}
 */
async function processAttachments(messageId, folder = 'INBOX') {
  const attachments = downloadAttachments(messageId, folder);

  if (attachments.length === 0) {
    return { lines: [], confidence: 0, strategy: 'no-attachments' };
  }

  let bestResult = { lines: [], confidence: 0, strategy: 'none' };
  let bestFile = '';

  for (const attachment of attachments) {
    logger.info(`Processing attachment: ${attachment.filename} (${attachment.type})`);

    let result;

    try {
      switch (attachment.type) {
        case 'pdf':
          result = await parsePDF(attachment.path);
          break;
        case 'excel':
          result = parseExcel(attachment.path);
          break;
        case 'csv':
          result = parseCSV(attachment.path);
          break;
        case 'text':
          // Could add text file parsing if needed
          result = { lines: [], confidence: 0, strategy: 'text-skip' };
          break;
        default:
          logger.debug(`Skipping unknown attachment type: ${attachment.type}`);
          result = { lines: [], confidence: 0, strategy: 'unknown-type' };
      }

      if (result.confidence > bestResult.confidence) {
        bestResult = result;
        bestFile = attachment.filename;
      }

    } catch (err) {
      logger.error(`Failed to process attachment ${attachment.filename}: ${err.message}`);
    }
  }

  return {
    lines: bestResult.lines,
    confidence: bestResult.confidence,
    strategy: bestResult.strategy,
    attachmentFile: bestFile
  };
}

module.exports = { processAttachments, downloadAttachments, cleanupAttachments };
