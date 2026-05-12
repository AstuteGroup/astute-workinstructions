// Regenerate a BOS snapshot from an OOB xlsx with the new line-key schema.
// Standalone replica of bos-report's bucketize + buildSnapshot, parameterized
// by an as-of date so historical snapshots stay accurate.
//
// Usage: node backfill-snapshot.js <oob.xlsx> <asof-YYYY-MM-DD>
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const inputPath = args[0];
const asofStr = args[1];
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(asofStr || '')) {
  console.error('Usage: node backfill-snapshot.js <oob.xlsx> <asof-YYYY-MM-DD>');
  process.exit(1);
}

const ASOF = new Date(asofStr + 'T00:00:00Z');

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const REGION_MAP_PATH = path.join(__dirname, 'ise-regions.json');

let REGION_MAP = {}, DEFAULT_REGION = '(Unmapped)';
try {
  const raw = JSON.parse(fs.readFileSync(REGION_MAP_PATH, 'utf-8'));
  REGION_MAP = raw.regions || {};
  DEFAULT_REGION = raw.default_region || '(Unmapped)';
} catch {}
const regionFor = (ise) => REGION_MAP[String(ise || '').trim()] || DEFAULT_REGION;

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, mo, d, y] = m;
  y = parseInt(y, 10);
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, parseInt(mo, 10) - 1, parseInt(d, 10)));
}
const isQuery       = d => d && d.getUTCMonth()===6  && d.getUTCDate()===7  && (d.getUTCFullYear()===2000 || d.getUTCFullYear()===2700);
const isPlaceholder = d => d && d.getUTCMonth()===7  && d.getUTCDate()===8  && (d.getUTCFullYear()===2000 || d.getUTCFullYear()===2800);
const isBlanket     = d => d && d.getUTCMonth()===11 && d.getUTCDate()===25 && d.getUTCFullYear()===2012;

const AGING_BANDS = [
  { label: 'Fresh (0-7d)',   min: 0,  max: 7 },
  { label: 'Stale (8-30d)',  min: 8,  max: 30 },
  { label: 'Chronic (30+d)', min: 31, max: Infinity }
];
const agingBand = days => {
  for (const b of AGING_BANDS) if (days >= b.min && days <= b.max) return b.label;
  return AGING_BANDS[0].label;
};

const lineKey = r => `${String(r['Order']||r['Customer Order']||'').trim()}|${String(r['Line']||'').trim()}|${String(r['Item']||'').trim()}`;

const wb = XLSX.readFile(inputPath);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });

const buckets = { query: [], placeholder: [], pastDue: [] };
for (const r of rows) {
  r._region = regionFor(r['Internal Salesperson']);
  const qty = Number(r['Qty Ordered']||0);
  const inv = Number(r['Invoiced']||0);
  const open = qty > inv;
  const d = parseDate(r['Promise Date']);
  if (isQuery(d)) { buckets.query.push(r); continue; }
  if (isPlaceholder(d)) { buckets.placeholder.push(r); continue; }
  if (open && d && d < ASOF && !isBlanket(d)) {
    const days = Math.floor((ASOF - d) / 86400000);
    r._daysPast = days;
    r._agingBand = agingBand(days);
    buckets.pastDue.push(r);
  }
}

const tallyBy = (rows, fn) => {
  const o = {};
  for (const r of rows) { const k = fn(r) || '(blank)'; o[k] = (o[k]||0) + 1; }
  return o;
};
const byCse = r => (r['Customer CSE'] || '(blank)').toString().trim() || '(blank)';
const byRegion = r => r._region;

const snap = {
  runDate: asofStr,
  totals: { query: buckets.query.length, placeholder: buckets.placeholder.length, pastDue: buckets.pastDue.length },
  byRegion: { query: tallyBy(buckets.query, byRegion), placeholder: tallyBy(buckets.placeholder, byRegion), pastDue: tallyBy(buckets.pastDue, byRegion) },
  byBos:    { query: tallyBy(buckets.query, byCse),    placeholder: tallyBy(buckets.placeholder, byCse),    pastDue: tallyBy(buckets.pastDue, byCse) },
  aging: {
    fresh:   buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[0].label).length,
    stale:   buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[1].label).length,
    chronic: buckets.pastDue.filter(r => r._agingBand === AGING_BANDS[2].label).length,
  },
  pastDueKeys: buckets.pastDue.map(lineKey),
  allKeys: rows.map(lineKey)
};

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
const out = path.join(SNAPSHOT_DIR, `${asofStr}.json`);
fs.writeFileSync(out, JSON.stringify(snap, null, 2));
console.log(`Wrote ${out}`);
console.log(`  totals: query=${snap.totals.query} placeholder=${snap.totals.placeholder} pastDue=${snap.totals.pastDue}`);
console.log(`  pastDueKeys=${snap.pastDueKeys.length}  allKeys=${snap.allKeys.length}`);
