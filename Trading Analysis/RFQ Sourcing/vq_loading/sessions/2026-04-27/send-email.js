// One-off: Email the VQ upload CSV to Jake with summary.
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { createNotifier } = require('/home/analytics_user/workspace/astute-workinstructions/shared/notifier');

const SESSION = __dirname;
const CSV_PATH = path.join(SESSION, '2026-04-27-rfq1132932-upload-ready.csv');
const EXTRACTIONS = JSON.parse(fs.readFileSync(path.join(SESSION, '8370-extractions.json'), 'utf8'));

// Best price per RFQ line for the summary
const lineMap = {};
for (const r of EXTRACTIONS.records) {
  const k = r.rfqLine;
  if (!lineMap[k]) {
    lineMap[k] = { line: r.rfqLine, mpn: r.rfqMpn, mfr: r.mfrText, qty: r.qty, quotes: [] };
  }
  lineMap[k].quotes.push(r);
}

const lines = Object.values(lineMap).sort((a, b) => a.line - b.line);
for (const l of lines) {
  l.quotes.sort((a, b) => a.cost - b.cost);
  l.best = l.quotes[0];
  l.worst = l.quotes[l.quotes.length - 1];
  l.range = l.worst.cost - l.best.cost;
  l.spread = l.best.cost > 0 ? (l.range / l.best.cost) * 100 : 0;
}

const fmtUsd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const fmtQty = (n) => Number(n).toLocaleString('en-US');

let html = `<p>VQ Loading session for <strong>RFQ 1132932</strong> (Mercury Systems) — APAC bulk-summary email from <strong>Elaine Liang</strong> via James Diaz.</p>

<p><strong>78 broker quotes</strong> across <strong>${lines.length} RFQ lines</strong> from 16 brokers. All vendors resolved, all MPNs match RFQ canonical lines, validator passed.</p>

<h3>Best price per line</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:12px">
  <tr style="background:#f0f0f0"><th>Line</th><th>MPN</th><th>MFR</th><th>RFQ Qty</th><th>Best $</th><th>Best Vendor</th><th>DC</th><th>COO</th><th>Quotes</th><th>Spread</th></tr>`;

for (const l of lines) {
  html += `<tr><td>${l.line}</td><td>${l.mpn}</td><td>${l.mfr}</td><td style="text-align:right">${fmtQty(l.qty)}</td><td style="text-align:right"><strong>${fmtUsd(l.best.cost)}</strong></td><td>${l.best.vendorShortname}</td><td>${l.best.dateCode || ''}</td><td>${l.best.coo || ''}</td><td style="text-align:right">${l.quotes.length}</td><td style="text-align:right">${l.spread.toFixed(0)}%</td></tr>`;
}

html += `</table>

<h3>Broker activity</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:12px">
  <tr style="background:#f0f0f0"><th>Broker</th><th>Quotes</th><th>Vendor Search Key</th></tr>`;

const VENDOR_NAMES = {
  '1007571': 'Howeher Co.',
  '1003688': 'Wafer Electronic Technology',
  '1003648': 'PGC-IC Ltd',
  '1002391': 'Fixchips Global',
  '1003643': 'Onway (HK) Technology',
  '1003803': 'Hong Kong Ruifan',
  '1011368': 'Valley Electronics(HK)',
  '1007351': 'SSF Group (Asia)',
  '1002407': 'Macroquest',
  '1003610': 'Hang Lung Tenda Technology',
  '1004485': 'Topray Technology (HK)',
  '1005363': 'MTO Technology',
  '1006037': 'Corerine Technology',
  '1002629': 'Saviliter Technology',
  '1008484': 'CMARCH Electronics (HK)',
  '1002301': 'Archermind Technology (HK)',
};
const VENDOR_MAP = {
  'howeher':'1007571','wafer':'1003688','pgc':'1003648','fixchip':'1002391','onway':'1003643',
  'ruifan':'1003803','valley':'1011368','ssf':'1007351','macroquest':'1002407','hanglung waiyip':'1003610',
  'topray':'1004485','mto':'1005363','corerine':'1006037','saviliter':'1002629','cmarch':'1008484',
  'archermind':'1002301',
};

const byVendor = {};
for (const r of EXTRACTIONS.records) byVendor[r.vendorShortname] = (byVendor[r.vendorShortname] || 0) + 1;
const vendorRows = Object.entries(byVendor).sort((a, b) => b[1] - a[1]);
for (const [shortname, count] of vendorRows) {
  const sk = VENDOR_MAP[shortname];
  html += `<tr><td>${shortname}</td><td style="text-align:right">${count}</td><td>${sk} (${VENDOR_NAMES[sk]})</td></tr>`;
}
html += `</table>

<h3>Notes / things flagged</h3>
<ul>
  <li><strong>RFQ lines 20, 30, 60, 110, 120, 160, 170, 200, 230, 250</strong> — no APAC quotes in this email (Mercury RFQ has 25 lines; Elaine sourced 15 of them).</li>
  <li><strong>Line 90 (W25Q32FVSSIG)</strong> — Valley's chunk under that group actually quoted W25Q32JVSSIQ at $0.683 (source-side mislabel by Elaine). Both quotes preserved with notes; the $0.683 row is tagged to RFQ line 90 with "Quoted MPN: W25Q32JVSSIQ".</li>
  <li><strong>Line 90 (W25Q32FVSSIG)</strong> — fixchip quoted twice with identical values ($0.774, 25+, 2250pcs, Taiwan); duplicate-in-source preserved. Recommend deduping after import.</li>
  <li><strong>Line 10 (S29GL032N90BFI033)</strong> — corerine quoted $23, ~5× the -BFI032 quotes ($3.82–$5.48). Verifier confirmed extraction is correct; flag for buyer review (variant pricing or typo from broker).</li>
  <li><strong>Vendor MPN variants captured in Vendor Notes:</strong> DH82029PCH SLKM8 (no space), XC2C512-7FTG256I (with G), 85411AMILFT (with T), 2304NZGI-1LFT, S29GL032N90BFI033 — all linked to canonical RFQ MPNs.</li>
  <li><strong>Line 140 (MT40A2G8NRE-083E:B)</strong> — pgc quoted only 400 of 30,000 needed ($37.50 and $66.17) — partial coverage.</li>
</ul>

<p>CSV attached, ready for OT import. Email 8370 will be moved to Processed.</p>

<p>— Claude</p>
`;

const notifier = createNotifier({
  fromEmail: 'stockRFQ@orangetsunami.com',
  fromName: 'Stock RFQ',
});

(async () => {
  await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com',
    'VQ Loading: RFQ 1132932 (Mercury) — 78 APAC broker quotes, 15 lines, validator PASS',
    html,
    [{ filename: '2026-04-27-rfq1132932-upload-ready.csv', path: CSV_PATH }],
    { html: true }
  );
  console.log('Email sent to jake.harris@astutegroup.com');
})().catch((e) => { console.error(e); process.exit(1); });
