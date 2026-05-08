/**
 * USITC Harmonized Tariff Schedule API client
 *
 * Free, public, no-auth REST endpoint at https://hts.usitc.gov/reststop.
 * Returns the official US duty schedule per HTS code: description, MFN/FTA/Column-2
 * rates, units, and footnotes (which reference Section 301 supplementary codes).
 *
 * What this is for:
 *   - Validating HTS codes returned by franchise APIs (DigiKey/Mouser).
 *   - Surfacing duty rates and Section 301/232/AD references that the franchise APIs
 *     do not return.
 *   - Looking up plain-English descriptions to help resolve DK/Mouser disagreements
 *     in `Trading Analysis/HTS ECCN Backfill/`.
 *
 * What this is NOT:
 *   - A classification engine. The USITC API is keyword search over the schedule
 *     text — it cannot map an MPN to an HTS code. Classification is a legal
 *     determination that requires part description + GRI rules + (often) a customs
 *     broker. DigiKey/Mouser remain the primary per-MPN source.
 *
 * Caching strategy:
 *   - Lazy chapter-level fetch. Looking up `8542.33.00.01` triggers a single fetch
 *     of the entire chapter 8542, cached for 30 days at `shared/data/hts-cache.json`.
 *     Subsequent lookups in 8542 are local. ~15 chapters cover most semis trading.
 *
 * Usage:
 *   const { lookupHts, parseFootnotes, searchHts } = require('../shared/hts-api');
 *
 *   const row = await lookupHts('8542.33.00.01');
 *   //   { htsno, description, general, special, other, footnotes, units,
 *   //     sec301Refs: ['9903.91.05'], sec232Refs: [], otherRefs: [] }
 *
 *   const sec301 = await lookupHts('9903.91.05');  // resolve the supplementary line
 *   const candidates = await searchHts('amplifier');  // up to 100 keyword matches
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://hts.usitc.gov/reststop';
const CACHE_FILE = path.resolve(__dirname, 'data', 'hts-cache.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------- code normalization ----------

/**
 * Strip non-digits, return a canonical "8542330001" form.
 * Handles inputs like "8542.33.00.01", "8542 33 00 01", "8542330001".
 */
function undottedHtsCode(code) {
  if (code == null) return '';
  return String(code).replace(/[^0-9]/g, '');
}

/**
 * Normalize to the dotted form the USITC API uses: "8542.33.00.01".
 * Standard 10-digit codes break as 4-2-2-2. Special chapters (9903/9902) follow
 * the same shape. Shorter inputs (chapter 4-digit, subheading 6-digit) are
 * preserved with appropriate dots.
 */
function dottedHtsCode(code) {
  const d = undottedHtsCode(code);
  if (d.length === 4) return d;
  if (d.length === 6) return `${d.slice(0, 4)}.${d.slice(4, 6)}`;
  if (d.length === 8) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  if (d.length === 10) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8, 10)}`;
  return d; // unrecognized length — return as-is (no dots)
}

function chapterOf(code) {
  return undottedHtsCode(code).slice(0, 4);
}

// ---------- low-level HTTP ----------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTS API ${res.statusCode}: ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`HTS API parse error: ${err.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('HTS API request timeout')); });
    req.on('error', reject);
  });
}

// ---------- on-disk cache ----------

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { chapters: {} };
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    return raw.chapters ? raw : { chapters: {} };
  } catch { return { chapters: {} }; }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error(`WARN: failed to write HTS cache: ${err.message}`);
  }
}

function chapterIsFresh(chapterEntry) {
  if (!chapterEntry || !chapterEntry.fetchedAt) return false;
  return (Date.now() - new Date(chapterEntry.fetchedAt).getTime()) < CACHE_TTL_MS;
}

// ---------- chapter fetch ----------

async function fetchChapter(chapter4) {
  // exportList returns rows with htsno >= from and < to (verified empirically).
  // Use chapter as `from` and chapter+1 as `to` to grab the whole chapter.
  const fromCode = chapter4;
  const next = (parseInt(chapter4, 10) + 1).toString().padStart(4, '0');
  const url = `${BASE_URL}/exportList?from=${fromCode}&to=${next}&format=JSON&styles=true`;
  const rows = await httpGetJson(url);
  if (!Array.isArray(rows)) throw new Error(`HTS chapter ${chapter4}: expected array`);
  return rows;
}

async function ensureChapter(chapter4) {
  const cache = readCache();
  if (chapterIsFresh(cache.chapters[chapter4])) {
    return cache.chapters[chapter4].rows;
  }
  const rows = await fetchChapter(chapter4);
  cache.chapters[chapter4] = { fetchedAt: new Date().toISOString(), rows };
  writeCache(cache);
  return rows;
}

// ---------- footnote parsing ----------

const SEC_301_RE = /9903\.\d{2}\.\d{2}/g; // China Section 301 supplementary chapter
const SEC_232_RE = /9903\.(?:8[0-5]|7[5-9])\.\d{2}/g; // 232 codes are also under 9903 — best-effort
const ANTIDUMPING_RE = /\bA\d{3}-\d{3}\b/g; // case numbering for AD/CVD

/**
 * Parse a USITC footnotes array, surface Section 301 / 232 / AD references.
 * Each footnote shape: { columns: ['general'], value: 'See 9903.91.05.', type: 'endnote' }
 */
function parseFootnotes(footnotes) {
  const refs = { sec301Refs: [], sec232Refs: [], antidumpingRefs: [], otherRefs: [] };
  if (!Array.isArray(footnotes)) return refs;

  for (const fn of footnotes) {
    const text = (fn && fn.value) ? String(fn.value) : '';
    if (!text) continue;

    const m301 = text.match(SEC_301_RE) || [];
    const m232 = text.match(SEC_232_RE) || [];
    const mAd = text.match(ANTIDUMPING_RE) || [];

    for (const r of m301) if (!refs.sec301Refs.includes(r)) refs.sec301Refs.push(r);
    for (const r of m232) if (!refs.sec232Refs.includes(r)) refs.sec232Refs.push(r);
    for (const r of mAd) if (!refs.antidumpingRefs.includes(r)) refs.antidumpingRefs.push(r);

    // Anything that mentions "See" but didn't match the patterns above
    if (/\bSee\b/.test(text) && !m301.length && !m232.length && !mAd.length) {
      refs.otherRefs.push(text.trim());
    }
  }
  return refs;
}

// ---------- public API ----------

/**
 * Walk up the HTS hierarchy from a 10-digit statistical suffix to find the row
 * that carries the duty rate. Duty rates are typically set at the 8-digit tariff
 * line; the 10-digit suffix is just for statistical reporting and inherits duty
 * from its parent. Returns the closest ancestor (including self) whose `general`
 * field is non-empty.
 */
function findDutyAncestor(rows, targetUndotted) {
  // Try progressively shorter prefixes: 10 → 8 → 6 → 4
  const candidates = [];
  if (targetUndotted.length >= 10) candidates.push(targetUndotted.slice(0, 10));
  if (targetUndotted.length >= 8) candidates.push(targetUndotted.slice(0, 8));
  if (targetUndotted.length >= 6) candidates.push(targetUndotted.slice(0, 6));
  if (targetUndotted.length >= 4) candidates.push(targetUndotted.slice(0, 4));

  for (const cand of candidates) {
    const found = rows.find(r => {
      const u = undottedHtsCode(r.htsno);
      return u === cand && r.general && r.general.trim() !== '';
    });
    if (found) return found;
  }
  return null;
}

/**
 * Look up a single HTS code. Hits the chapter-level cache first.
 * Returns null if the code isn't found in the schedule.
 *
 * Returned shape combines (a) the most-specific row's description + footnotes
 * with (b) the closest duty-bearing ancestor's rates. `dutyHtsno` indicates
 * which ancestor the rates came from so callers can audit.
 */
async function lookupHts(code) {
  const dotted = dottedHtsCode(code);
  const chapter4 = chapterOf(code);
  if (!chapter4 || chapter4.length !== 4) {
    throw new Error(`Invalid HTS code: ${code}`);
  }

  const rows = await ensureChapter(chapter4);
  const wantUndotted = undottedHtsCode(dotted);
  const match = rows.find(r => undottedHtsCode(r.htsno) === wantUndotted);
  if (!match) return null;

  // Duty inheritance: 10-digit stat lines carry no rate of their own
  const dutyRow = (match.general && match.general.trim() !== '')
    ? match
    : findDutyAncestor(rows, wantUndotted);

  // Collect footnotes from BOTH the leaf and its duty ancestor — Section 301
  // refs typically attach at the 8-digit level, not the 10-digit
  const allFootnotes = [
    ...(Array.isArray(match.footnotes) ? match.footnotes : []),
    ...(dutyRow && dutyRow !== match && Array.isArray(dutyRow.footnotes) ? dutyRow.footnotes : []),
  ];
  const refs = parseFootnotes(allFootnotes);

  return {
    htsno: match.htsno,
    description: match.description || '',
    dutyHtsno: dutyRow ? dutyRow.htsno : null,
    general: dutyRow ? (dutyRow.general || '') : '',
    special: dutyRow ? (dutyRow.special || '') : '',
    other: dutyRow ? (dutyRow.other || '') : '',
    units: Array.isArray(match.units) && match.units.length ? match.units : (dutyRow && Array.isArray(dutyRow.units) ? dutyRow.units : []),
    footnotes: allFootnotes,
    additionalDuties: (match.additionalDuties || match.addiitionalDuties || (dutyRow && (dutyRow.additionalDuties || dutyRow.addiitionalDuties)) || ''),
    quotaQuantity: match.quotaQuantity || (dutyRow && dutyRow.quotaQuantity) || '',
    ...refs,
  };
}

/**
 * Keyword search over the tariff schedule. Returns up to 100 candidate rows.
 * Useful for: classifying when no disty data, surfacing alternative codes for
 * disagreement resolution, validating part descriptions match a code's text.
 */
async function searchHts(keyword, opts = {}) {
  const limit = opts.limit || 100;
  const url = `${BASE_URL}/search?keyword=${encodeURIComponent(keyword)}`;
  const rows = await httpGetJson(url);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map(r => ({
    htsno: r.htsno,
    description: r.description || '',
    general: r.general || '',
    special: r.special || '',
    other: r.other || '',
    units: Array.isArray(r.units) ? r.units : [],
    footnotes: Array.isArray(r.footnotes) ? r.footnotes : [],
  }));
}

/**
 * Force-refresh a chapter's cache. Useful after the annual HTS revision (Jan)
 * or when Section 301 lists update.
 */
async function refreshChapter(chapter4) {
  const cache = readCache();
  const rows = await fetchChapter(chapter4);
  cache.chapters[chapter4] = { fetchedAt: new Date().toISOString(), rows };
  writeCache(cache);
  return rows.length;
}

module.exports = {
  lookupHts,
  searchHts,
  parseFootnotes,
  refreshChapter,
  // helpers exposed for tests / callers that need them
  undottedHtsCode,
  dottedHtsCode,
  chapterOf,
  CACHE_FILE,
};
