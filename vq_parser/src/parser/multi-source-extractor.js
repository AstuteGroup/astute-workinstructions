const { extractQuoteData } = require('./extractor');
const { extractQuoteLinks, fetchAndParseQuoteUrl } = require('./link-extractor');
const { processAttachments, cleanupAttachments } = require('../attachment');
const logger = require('../utils/logger');

/**
 * Source priority:
 * 1. Attachments (PDF, Excel, CSV) - most reliable
 * 2. Email body (HTML tables, structured text)
 * 3. Hyperlinks (fetch and parse quote portal pages)
 */

/**
 * Extract quote data from all available sources
 * @param {string} messageId - The email message ID
 * @param {string} emailBody - The email body text
 * @param {string} subject - The email subject
 * @param {string} folder - The folder containing the message
 * @param {boolean} hasAttachment - Whether the email has attachments
 * @returns {Promise<{lines: Array, confidence: number, strategy: string, source: string, flags: Array}>}
 */
async function extractFromAllSources(messageId, emailBody, subject, folder = 'INBOX', hasAttachment = false) {
  const results = [];

  // Source 1: Try attachments first if email has them
  if (hasAttachment) {
    logger.info('Checking attachments...');
    try {
      const attachmentResult = await processAttachments(messageId, folder);

      if (attachmentResult.confidence > 0.3) {
        results.push({
          ...attachmentResult,
          source: 'attachment',
          sourceDetail: attachmentResult.attachmentFile
        });
      }
    } catch (err) {
      logger.error(`Attachment processing failed: ${err.message}`);
    }
  }

  // Source 2: Try email body parsing
  logger.info('Parsing email body...');
  try {
    const bodyResult = extractQuoteData(emailBody, subject);

    if (bodyResult.confidence > 0.3 || bodyResult.noBid) {
      results.push({
        lines: bodyResult.lines,
        confidence: bodyResult.confidence,
        strategy: bodyResult.strategy,
        flags: bodyResult.flags || [],
        noBid: bodyResult.noBid,
        source: 'body'
      });
    }
  } catch (err) {
    logger.error(`Body parsing failed: ${err.message}`);
  }

  // Source 3: Try hyperlinks in email
  logger.info('Checking for quote links...');
  try {
    const links = extractQuoteLinks(emailBody);

    if (links.length > 0) {
      logger.info(`Found ${links.length} potential quote link(s)`);

      // Try first few links
      for (const link of links.slice(0, 2)) {
        try {
          const linkResult = await fetchAndParseQuoteUrl(link);

          if (linkResult.confidence > 0.3) {
            results.push({
              ...linkResult,
              source: 'link',
              sourceDetail: link
            });
            break; // Stop after first successful link
          }
        } catch (err) {
          logger.debug(`Link fetch failed for ${link}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Link extraction failed: ${err.message}`);
  }

  // Cleanup attachments after processing
  try {
    cleanupAttachments(messageId);
  } catch {
    // Ignore cleanup errors
  }

  // Select best result
  if (results.length === 0) {
    return {
      lines: [],
      confidence: 0,
      strategy: 'none',
      source: 'none',
      flags: [],
      needsManualReview: true
    };
  }

  // Sort by confidence and prefer certain sources
  results.sort((a, b) => {
    // Prefer no-bid results
    if (a.noBid && !b.noBid) return -1;
    if (!a.noBid && b.noBid) return 1;

    // Then by confidence
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    // Prefer attachments over body over links
    const sourcePriority = { attachment: 3, body: 2, link: 1 };
    return (sourcePriority[b.source] || 0) - (sourcePriority[a.source] || 0);
  });

  const best = results[0];

  logger.info(`Best source: ${best.source} (${best.strategy}), confidence: ${best.confidence}, lines: ${best.lines?.length || 0}`);

  return {
    lines: best.lines || [],
    confidence: best.confidence,
    strategy: best.strategy,
    source: best.source,
    sourceDetail: best.sourceDetail,
    flags: best.flags || [],
    noBid: best.noBid || false,
    needsManualReview: best.confidence < 0.3 && !best.noBid,
    allResults: results.map(r => ({
      source: r.source,
      strategy: r.strategy,
      confidence: r.confidence,
      lineCount: r.lines?.length || 0
    }))
  };
}

module.exports = { extractFromAllSources };
