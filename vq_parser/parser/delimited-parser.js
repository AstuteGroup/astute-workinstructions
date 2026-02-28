const { COLUMN_ALIASES } = require('../../config/columns');
const { cleanString, stripHtmlTags } = require('../utils/sanitize');
const logger = require('../utils/logger');

function fuzzyMatchColumn(headerText) {
  const normalized = cleanString(headerText).toLowerCase();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (normalized === alias || normalized.includes(alias)) {
        return field;
      }
    }
  }
  return null;
}

function detectDelimiter(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  const delimiters = [
    { char: '\t', name: 'tab' },
    { char: '|', name: 'pipe' },
    { char: ',', name: 'comma' },
  ];

  let bestDelimiter = null;
  let bestScore = 0;

  for (const { char, name } of delimiters) {
    // Count occurrences per line and check consistency
    const counts = lines.slice(0, 10).map(l => l.split(char).length - 1);
    const nonZero = counts.filter(c => c > 0);
    if (nonZero.length < 2) continue;

    // Check if count is consistent across lines
    const mode = nonZero.sort((a, b) => a - b)[Math.floor(nonZero.length / 2)];
    const consistent = nonZero.filter(c => c === mode).length;
    const score = (consistent / nonZero.length) * mode;

    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = char;
    }
  }

  // Check for multiple-space delimiter
  if (!bestDelimiter || bestScore < 2) {
    const spacePattern = /  +/;
    const spaceCounts = lines.slice(0, 10).map(l => (l.match(/  +/g) || []).length);
    const nonZero = spaceCounts.filter(c => c > 0);
    if (nonZero.length >= 2) {
      const mode = nonZero.sort((a, b) => a - b)[Math.floor(nonZero.length / 2)];
      const consistent = nonZero.filter(c => c === mode).length;
      const score = (consistent / nonZero.length) * mode;
      if (score > bestScore) {
        bestDelimiter = '  +'; // regex pattern for 2+ spaces
        bestScore = score;
      }
    }
  }

  return bestDelimiter;
}

function parseDelimitedText(text) {
  // Strip HTML if present
  const plainText = stripHtmlTags(text);
  const lines = plainText.split('\n').filter(l => l.trim());

  if (lines.length < 2) return { lines: [], confidence: 0 };

  const delimiter = detectDelimiter(plainText);
  if (!delimiter) return { lines: [], confidence: 0 };

  // Split lines by delimiter
  const splitLine = (line) => {
    if (delimiter === '  +') {
      return line.split(/  +/).map(s => s.trim());
    }
    return line.split(delimiter).map(s => s.trim());
  };

  // Find header row
  let headerIdx = -1;
  let columnMap = {};

  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const cells = splitLine(lines[i]);
    const matches = {};
    cells.forEach((text, j) => {
      const field = fuzzyMatchColumn(text);
      if (field) matches[j] = field;
    });

    if (Object.keys(matches).length >= 2) {
      headerIdx = i;
      columnMap = matches;
      break;
    }
  }

  if (headerIdx === -1) return { lines: [], confidence: 0 };

  // Parse data rows
  const result = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    if (cells.length < 2) continue;

    const line = {};
    let hasData = false;
    cells.forEach((value, j) => {
      if (columnMap[j] && value) {
        line[columnMap[j]] = cleanString(value);
        hasData = true;
      }
    });

    if (hasData && (line['chuboe_mpn'] || line['cost'])) {
      result.push(line);
    }
  }

  return {
    lines: result,
    confidence: result.length > 0 ? 0.7 : 0
  };
}

module.exports = { parseDelimitedText, detectDelimiter };
