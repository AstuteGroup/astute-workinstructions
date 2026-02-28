const { parseHtmlTables } = require('./table-parser');
const { parseDelimitedText } = require('./delimited-parser');
const { parseWithRegex } = require('./regex-parser');
const { detectFlags, isFullNoBid } = require('./flag-detector');
const logger = require('../utils/logger');

const MIN_CONFIDENCE = 0.3;

function extractQuoteData(emailBody, subject = '') {
  const fullText = (subject + '\n' + emailBody);

  // Step 1: Check for flags
  const flags = detectFlags(fullText);

  // Step 2: If full no-bid, return early with flag
  if (isFullNoBid(emailBody)) {
    logger.info('Detected NO-BID email');
    return {
      lines: [],
      flags,
      confidence: 1.0,
      strategy: 'no-bid',
      noBid: true
    };
  }

  // Step 3: Run parsing strategies
  const strategies = [
    { name: 'html-table', fn: () => parseHtmlTables(emailBody) },
    { name: 'delimited', fn: () => parseDelimitedText(emailBody) },
    { name: 'regex', fn: () => parseWithRegex(emailBody) },
  ];

  let bestResult = { lines: [], confidence: 0 };
  let bestStrategy = 'none';

  for (const { name, fn } of strategies) {
    try {
      const result = fn();
      logger.debug(`Strategy "${name}": ${result.lines.length} lines, confidence ${result.confidence}`);

      if (result.confidence > bestResult.confidence || (result.confidence === bestResult.confidence && result.lines.length > bestResult.lines.length)) {
        bestResult = result;
        bestStrategy = name;
      }
    } catch (err) {
      logger.warn(`Strategy "${name}" failed:`, err.message);
    }
  }

  if (bestResult.confidence < MIN_CONFIDENCE) {
    // If we detected no-bid flags but couldn't parse lines, treat as no-bid
    const noBidFlags = flags.filter(f => f === 'NO-BID' || f === 'NO QUOTE');
    if (noBidFlags.length > 0) {
      logger.info('No parseable lines but NO-BID flag detected');
      return {
        lines: [],
        flags,
        confidence: 1.0,
        strategy: 'no-bid',
        noBid: true,
        needsManualReview: false
      };
    }

    logger.warn('All parsing strategies below confidence threshold');
    return {
      lines: [],
      flags,
      confidence: bestResult.confidence,
      strategy: bestStrategy,
      needsManualReview: true
    };
  }

  return {
    lines: bestResult.lines,
    flags,
    confidence: bestResult.confidence,
    strategy: bestStrategy,
    noBid: false,
    needsManualReview: false
  };
}

module.exports = { extractQuoteData };
