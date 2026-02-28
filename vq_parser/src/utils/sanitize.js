function cleanString(str) {
  if (!str) return '';
  return str
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ')
    .trim();
}

function stripCurrency(str) {
  if (!str) return '';
  let cleaned = str.replace(/[$€£¥]/g, '').trim();

  // Handle European format: "0,55" → "0.55" (comma as decimal)
  // But keep US format: "1,000.55" → "1000.55" (comma as thousands separator)
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    // No dot, so comma is likely decimal separator: "0,55" → "0.55"
    cleaned = cleaned.replace(',', '.');
  } else {
    // Has both or just dot, comma is thousands separator: "1,000.55" → "1000.55"
    cleaned = cleaned.replace(/,/g, '');
  }

  return cleaned;
}

function normalizePartNumber(str) {
  if (!str) return '';
  return str.toUpperCase().replace(/\s+/g, '').trim();
}

function extractNumber(str) {
  if (!str) return '';
  const match = String(str).replace(/,/g, '').match(/([\d]+\.?\d*)/);
  return match ? match[1] : '';
}

function normalizeRoHS(str) {
  if (!str) return '';
  const s = str.toLowerCase().trim();
  if (s === 'y' || s === 'yes' || s === 'compliant' || s === 'rohs compliant' || s === 'rohs') return 'Y';
  if (s === 'n' || s === 'no' || s === 'non-compliant') return 'N';
  return '';
}

function stripHtmlTags(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
}

module.exports = { cleanString, stripCurrency, normalizePartNumber, extractNumber, normalizeRoHS, stripHtmlTags };
