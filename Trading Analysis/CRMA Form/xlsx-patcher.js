/**
 * Surgical xlsx cell-value patcher.
 *
 * Opens an xlsx as a zip, modifies ONLY the target cells in xl/worksheets/sheetN.xml,
 * and writes back. All other zip entries (custom XML, drawings, printer settings,
 * data validations, styles, theme, etc.) are preserved byte-for-byte.
 *
 * Critical for forms sent to operations: their dropdowns, branding, and print
 * layout must not be altered.
 *
 * Existing cell attributes (s= style index, etc.) are preserved when updating
 * the value. Strings are written as inline strings (t="inlineStr") so we don't
 * have to touch sharedStrings.xml.
 *
 * Dates are converted to Excel serial (days since 1899-12-30, accounting for
 * the 1900 leap-year bug) and written as numbers — they pick up their date
 * format from the existing cell's style index.
 */
const AdmZip = require('adm-zip');

function colLetterToIndex(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

function dateToExcelSerial(d) {
  // Excel epoch: 1899-12-30 (with the 1900 leap-year bug accounted for)
  const epoch = Date.UTC(1899, 11, 30);
  return (d.getTime() - epoch) / 86400000;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Find the existing <c r="ADDR" ...> element in sheet xml.
 * Returns { match, start, end, attrs } or null.
 * Handles both self-closing (`<c r="C3" s="2"/>`) and content forms.
 */
function findCell(xml, addr) {
  // Match <c r="ADDR" ...attrs.../> or <c r="ADDR" ...attrs...>...</c>
  const re = new RegExp(`<c\\s+r="${addr}"([^/>]*?)(/>|>([\\s\\S]*?)</c>)`);
  const m = xml.match(re);
  if (!m) return null;
  return {
    match: m[0],
    start: m.index,
    end: m.index + m[0].length,
    attrs: m[1] || '',
    selfClosing: m[2] === '/>'
  };
}

/**
 * Extract style attribute from the existing cell attrs string, if any.
 */
function extractStyleAttr(attrs) {
  const m = attrs.match(/\bs="(\d+)"/);
  return m ? ` s="${m[1]}"` : '';
}

/**
 * Build the replacement <c> element for a value.
 */
function buildCellXml(addr, value, styleAttr) {
  if (value == null || value === '') {
    return `<c r="${addr}"${styleAttr}/>`;
  }
  if (value instanceof Date) {
    const serial = dateToExcelSerial(value);
    return `<c r="${addr}"${styleAttr}><v>${serial}</v></c>`;
  }
  if (typeof value === 'number') {
    return `<c r="${addr}"${styleAttr}><v>${value}</v></c>`;
  }
  // String: use inline string to avoid touching sharedStrings.xml
  return `<c r="${addr}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/**
 * Insert a new <c> element into the correct row in sheet xml.
 * Used when the target cell didn't exist in the source (uncommon — empty cells
 * usually exist as `<c r="ADDR" s="N"/>` for styled empties).
 */
function insertCell(xml, addr, cellXml) {
  const rowMatch = addr.match(/[A-Z]+(\d+)/);
  if (!rowMatch) throw new Error(`Bad cell address: ${addr}`);
  const rowNum = rowMatch[1];

  // Find the <row r="N" ...> element
  const rowRe = new RegExp(`<row\\s+r="${rowNum}"([^/>]*?)(/>|>([\\s\\S]*?)</row>)`);
  const rm = xml.match(rowRe);
  if (!rm) {
    throw new Error(`Row ${rowNum} not found in sheet — refusing to insert new row`);
  }
  if (rm[2] === '/>') {
    // Self-closing row — convert to opened, add cell
    const openTag = `<row r="${rowNum}"${rm[1]}>`;
    return xml.slice(0, rm.index) + openTag + cellXml + `</row>` + xml.slice(rm.index + rm[0].length);
  }
  // Insert cell at end of row, before </row>
  // (Excel tolerates out-of-order cells in a row but we'll just append.)
  const closeIdx = rm.index + rm[0].length - '</row>'.length;
  return xml.slice(0, closeIdx) + cellXml + xml.slice(closeIdx);
}

/**
 * Patch a workbook.
 *
 * @param {string} srcPath  — path to source xlsx
 * @param {string} outPath  — path to write patched xlsx
 * @param {Object} updates  — { 'C3': 'Jake Harris', 'E13': 8, 'C8': new Date(), ... }
 * @param {Object} [opts]
 * @param {string} [opts.sheetEntry='xl/worksheets/sheet1.xml']
 */
function patchXlsx(srcPath, outPath, updates, opts = {}) {
  const sheetEntry = opts.sheetEntry || 'xl/worksheets/sheet1.xml';
  const zip = new AdmZip(srcPath);
  const sheet = zip.getEntry(sheetEntry);
  if (!sheet) throw new Error(`Sheet entry not found: ${sheetEntry}`);

  let xml = sheet.getData().toString('utf-8');
  const stats = { updated: [], inserted: [], skipped: [] };

  // Sort by row then col so inserts (rare) happen in order
  const sortedAddrs = Object.keys(updates).sort((a, b) => {
    const ma = a.match(/([A-Z]+)(\d+)/);
    const mb = b.match(/([A-Z]+)(\d+)/);
    const ra = parseInt(ma[2], 10), rb = parseInt(mb[2], 10);
    if (ra !== rb) return ra - rb;
    return colLetterToIndex(ma[1]) - colLetterToIndex(mb[1]);
  });

  for (const addr of sortedAddrs) {
    const value = updates[addr];
    if (value == null || value === '') { stats.skipped.push(addr); continue; }

    const found = findCell(xml, addr);
    if (found) {
      const styleAttr = extractStyleAttr(found.attrs);
      const newCell = buildCellXml(addr, value, styleAttr);
      xml = xml.slice(0, found.start) + newCell + xml.slice(found.end);
      stats.updated.push(addr);
    } else {
      const newCell = buildCellXml(addr, value, '');
      xml = insertCell(xml, addr, newCell);
      stats.inserted.push(addr);
    }
  }

  zip.updateFile(sheetEntry, Buffer.from(xml, 'utf-8'));
  zip.writeZip(outPath);
  return stats;
}

module.exports = { patchXlsx };
