/**
 * Blue Origin Customer Excess (offer 1024645) — Analyzer
 *
 * Thin wrapper on shared/offer-analyzer. 18 lines, all rad-hard / mil-spec
 * (Microsemi JANS, Vectron, TE2V, ADI RH, 5962-prefix). Intent = REACTIVE
 * (too small for consignment-style lot summary; the play is RFQ/SO matching).
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const path = require('path');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const { analyzeOffer } = require(path.join(REPO, 'shared/offer-analyzer'));

const OFFER_ID = 1024752;        // chuboe_offer_id
const OFFER_SEARCH_KEY = '1024645';
const PARTNER_NAME = 'Blue Origin';
const FROM_EMAIL = 'excess@orangetsunami.com';
const TO_EMAIL = 'jake.harris@astutegroup.com';

// ─── XLSX OUTPUT ─────────────────────────────────────────────────────────────

function buildXlsxBuffer(result) {
  const wb = XLSX.utils.book_new();
  const total = result.lineCount;
  const uniqueMpns = result.uniqueMpnCount;
  const pct = n => total > 0 ? +(n / total).toFixed(4) : 0;

  // Sheet 1: Lot Summary
  const summary = [
    [`${PARTNER_NAME} Customer Excess — Reactive Analysis`],
    [],
    ['Partner', PARTNER_NAME],
    ['Offer search key', OFFER_SEARCH_KEY],
    ['chuboe_offer_id', OFFER_ID],
    ['Offer description', result.offers[0].description || ''],
    ['Analysis date', new Date().toISOString().slice(0, 10)],
    ['Intent', result.intent],
    [],
    ['Volume'],
    ['Total offer lines', total],
    ['Unique MPNs', uniqueMpns],
    [],
    ['Per-line franchise state', 'Lines', '%'],
    ['IN_STOCK',                                       result.stats.IN_STOCK,                pct(result.stats.IN_STOCK)],
    ['FRANCHISE_OUT_OF_STOCK (real scarcity)',         result.stats.FRANCHISE_OUT_OF_STOCK,  pct(result.stats.FRANCHISE_OUT_OF_STOCK)],
    ['NO_LISTING_INTERNAL (push back to customer)',    result.stats.NO_LISTING_INTERNAL,    pct(result.stats.NO_LISTING_INTERNAL)],
    ['NO_LISTING_MILSPEC (mil-spec one-offs)',         result.stats.NO_LISTING_MILSPEC,     pct(result.stats.NO_LISTING_MILSPEC)],
    ['NO_LISTING_UNKNOWN',                             result.stats.NO_LISTING_UNKNOWN,     pct(result.stats.NO_LISTING_UNKNOWN)],
    [],
    ['Demand signals', 'Lines', '%'],
    ['With active RFQ (90d)', result.stats.activeRfq, pct(result.stats.activeRfq)],
    ['With prior SO (12mo)',  result.stats.priorSo,   pct(result.stats.priorSo)],
    ['Zero demand signal',    result.stats.zeroDemand, pct(result.stats.zeroDemand)],
    [],
    ['Notes'],
    ['Blue Origin offer is small (18 lines) — analysis is REACTIVE: surface any open RFQs/recent SOs.'],
    ['Heavy on rad-hard / mil-spec parts (JANS Microsemi, Vectron, TE2V, ADI RH, 5962-prefix).'],
    ['Most lines expected NO_LISTING_MILSPEC — that is normal for this commodity profile.'],
    ['All lines have priceentered=0 (Customer Excess — Blue Origin did not submit prices).'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(summary);
  ws['!cols'] = [{ wch: 50 }, { wch: 14 }, { wch: 10 }];
  for (const r of [14, 15, 16, 17, 18, 21, 22, 23]) {
    const addr = `C${r + 1}`;
    if (ws[addr] && typeof ws[addr].v === 'number') ws[addr].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Lot Summary');

  // Sheet 2: Per-Line Detail (the headline view at 18 lines)
  const headers = ['Line', 'MPN', 'MFR', 'Date Code', 'Qty', 'Price',
                   'State', 'Tier', 'Score',
                   'Franchise Stock', 'Distributors Carrying', 'Distributors w/ Stock',
                   'Lowest Franchise Price',
                   'Active RFQ Count', 'Broker SO Count', 'Cust SO Count',
                   'Demand Strength', 'Top Buyers', 'Flags'];
  const tierRank = { HOT: 0, WARM: 1, COOL: 2, SKIP: 3, UNSCORED: 4 };
  const sorted = [...result.enrichedLines].sort((a, b) => {
    const ta = tierRank[a.tier] ?? 5;
    const tb = tierRank[b.tier] ?? 5;
    if (ta !== tb) return ta - tb;
    return (b.rawScore || 0) - (a.rawScore || 0);
  });
  const rows = sorted.map(l => {
    const m = result.perMpnEnrichment.get(l.mpn) || {};
    const f = m.franchise || {};
    const d = m.demand || {};
    return [
      l.lineNum, l.mpn, l.mfrText, l.dateCode || '', l.qty || 0,
      l.price != null && l.price !== 0 ? l.price : '',
      l.state, l.tier, l.rawScore == null ? '' : l.rawScore,
      f.totalStock || 0, f.distributorsCarrying || 0, f.distributorsWithStock || 0,
      f.lowestPrice != null ? f.lowestPrice : '',
      d.activeRfqCount || 0, d.brokerSaleCount || 0, d.customerSaleCount || 0,
      d.demandStrength || 'NONE',
      d.topBuyers && d.topBuyers.length ? d.topBuyers.slice(0, 5).map(b => b.name).join('; ') : '',
      (l.flags || []).join('; '),
    ];
  });
  const wsDet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  wsDet['!cols'] = [
    { wch: 6 }, { wch: 32 }, { wch: 24 }, { wch: 10 }, { wch: 8 }, { wch: 12 },
    { wch: 22 }, { wch: 9 }, { wch: 7 },
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
    { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 36 }, { wch: 32 },
  ];
  for (let r = 1; r <= rows.length; r++) {
    for (const col of ['F', 'M']) {
      const addr = `${col}${r + 1}`;
      if (wsDet[addr] && typeof wsDet[addr].v === 'number') wsDet[addr].z = '$#,##0.0000';
    }
  }
  XLSX.utils.book_append_sheet(wb, wsDet, 'Per-Line Analysis');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── HTML EMAIL BODY ─────────────────────────────────────────────────────────

function buildHtml(result) {
  const total = result.lineCount;
  const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0.0%';
  const cell = (v, align = 'left') => `<td align="${align}" style="padding:4px 10px;border:1px solid #ccc">${v}</td>`;

  // Top opportunities — anything above SKIP
  const tierRank = { HOT: 0, WARM: 1, COOL: 2, SKIP: 3, UNSCORED: 4 };
  const top = [...result.enrichedLines]
    .filter(l => l.tier === 'HOT' || l.tier === 'WARM')
    .sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || ((b.rawScore || 0) - (a.rawScore || 0)));

  const topRows = top.map(l => {
    const m = result.perMpnEnrichment.get(l.mpn) || {};
    const d = m.demand || {};
    return `<tr>
      ${cell(l.tier)}
      ${cell(l.mpn)}
      ${cell(l.mfrText)}
      ${cell(l.qty || 0, 'right')}
      ${cell(l.dateCode || '')}
      ${cell(d.activeRfqCount || 0, 'right')}
      ${cell((d.brokerSaleCount || 0) + (d.customerSaleCount || 0), 'right')}
      ${cell(l.rawScore == null ? '' : l.rawScore, 'right')}
    </tr>`;
  }).join('');

  return `<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#222;max-width:820px">
<h2 style="margin-bottom:4px">Blue Origin Customer Excess — Reactive Analysis</h2>
<p style="color:#666;margin-top:0">
OT offer search key: <b>${OFFER_SEARCH_KEY}</b> (chuboe_offer_id ${OFFER_ID})<br>
Description: ${result.offers[0].description || ''}<br>
Intent: <b>${result.intent}</b> &mdash; small lot (18 lines) of rad-hard/mil-spec parts; the play is matching against open demand, not lot-level pursuit.
</p>

<h3>Volume</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Metric</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Value</th></tr>
  <tr>${cell('Total offer lines')}${cell(total, 'right')}</tr>
  <tr>${cell('Unique MPNs')}${cell(result.uniqueMpnCount, 'right')}</tr>
</table>

<h3>Franchise state</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">State</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Lines</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr style="background:#e8f5e8">${cell('<b>IN_STOCK</b>')}${cell(result.stats.IN_STOCK, 'right')}${cell(pct(result.stats.IN_STOCK), 'right')}</tr>
  <tr style="background:#fff4e0">${cell('<b>FRANCHISE_OUT_OF_STOCK</b> (real scarcity)')}${cell(result.stats.FRANCHISE_OUT_OF_STOCK, 'right')}${cell(pct(result.stats.FRANCHISE_OUT_OF_STOCK), 'right')}</tr>
  <tr style="background:#fde0e0">${cell('<b>NO_LISTING_INTERNAL</b> (push back to Blue Origin)')}${cell(result.stats.NO_LISTING_INTERNAL, 'right')}${cell(pct(result.stats.NO_LISTING_INTERNAL), 'right')}</tr>
  <tr>${cell('<b>NO_LISTING_MILSPEC</b>')}${cell(result.stats.NO_LISTING_MILSPEC, 'right')}${cell(pct(result.stats.NO_LISTING_MILSPEC), 'right')}</tr>
  <tr style="background:#f8f8f8">${cell('<b>NO_LISTING_UNKNOWN</b>')}${cell(result.stats.NO_LISTING_UNKNOWN, 'right')}${cell(pct(result.stats.NO_LISTING_UNKNOWN), 'right')}</tr>
</table>

<h3>Demand signals</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Signal</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Lines</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr>${cell('Active open RFQ (90d)')}${cell(result.stats.activeRfq, 'right')}${cell(pct(result.stats.activeRfq), 'right')}</tr>
  <tr>${cell('Prior SO history (12mo)')}${cell(result.stats.priorSo, 'right')}${cell(pct(result.stats.priorSo), 'right')}</tr>
  <tr>${cell('Zero demand signal')}${cell(result.stats.zeroDemand, 'right')}${cell(pct(result.stats.zeroDemand), 'right')}</tr>
</table>

${topRows ? `
<h3>HOT &amp; WARM lines (act on these)</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">Tier</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">MPN</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">MFR</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Qty</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">DC</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Active RFQs</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Prior SOs</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Score</th>
  </tr>
  ${topRows}
</table>
` : '<p><i>No HOT/WARM tier lines surfaced. See Per-Line Analysis sheet for full detail.</i></p>'}

<h3>What to do with this</h3>
<ul>
  <li><b>Per-Line Analysis sheet</b> in the attachment is the full picture for all 18 lines.</li>
  <li>Reactive intent = <b>match against open RFQs/CQs and recent SO history</b>. Any line with active demand is the immediate play.</li>
  <li>Lines flagged <b>NO_LISTING_INTERNAL</b> need pushback to Blue Origin for an industry MPN.</li>
  <li>Lines flagged <b>NO_LISTING_MILSPEC</b> are legitimate one-offs &mdash; broker channel research case-by-case.</li>
  <li>All prices are 0 because Blue Origin didn't submit them; these are excess inventory positions to <i>place</i>, not <i>buy</i>.</li>
</ul>

<p style="color:#666;font-size:11px;margin-top:20px">Generated via shared <code>offer-analyzer</code> cog &mdash; same path used for Sanmina, GE Aerospace.</p>
</body></html>`;
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

async function sendEmail(htmlBody, xlsxBuffer) {
  if (!process.env.WORKMAIL_PASS) throw new Error('WORKMAIL_PASS not set');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user: FROM_EMAIL, pass: process.env.WORKMAIL_PASS },
  });
  return transporter.sendMail({
    from: `"Market Offer Analysis" <${FROM_EMAIL}>`,
    to: TO_EMAIL,
    subject: `Blue Origin Customer Excess — Reactive Analysis (offer ${OFFER_SEARCH_KEY}, 18 lines)`,
    html: htmlBody,
    attachments: [
      { filename: 'Blue_Origin_Excess_Analysis.xlsx', content: xlsxBuffer },
    ],
  });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  console.error(`=== Blue Origin Customer Excess Analysis ===`);
  console.error(`Offer ID: ${OFFER_ID} (search key ${OFFER_SEARCH_KEY})`);
  console.error('');

  const result = await analyzeOffer({
    offerId: OFFER_ID,
    intent: 'reactive',
    franchiseConcurrency: 10,
    onProgress: (done, total) => {
      process.stderr.write(`  franchise: ${done}/${total} unique MPNs\n`);
    },
  });

  console.error('');
  console.error('=== Stats ===');
  console.error(`Lines: ${result.lineCount}`);
  console.error(`Unique MPNs: ${result.uniqueMpnCount}`);
  console.error(`Per-line state:`);
  for (const k of ['IN_STOCK', 'FRANCHISE_OUT_OF_STOCK', 'NO_LISTING_INTERNAL', 'NO_LISTING_MILSPEC', 'NO_LISTING_UNKNOWN']) {
    console.error(`  ${k.padEnd(24)} ${result.stats[k]}`);
  }
  console.error(`Per-unique-MPN tier:`);
  for (const k of ['HOT', 'WARM', 'COOL', 'SKIP', 'UNSCORED']) {
    console.error(`  ${k.padEnd(10)} ${result.stats.uniqueMpnTier[k]}`);
  }
  console.error('');
  console.error('Timing:', JSON.stringify(result.timing));
  console.error('');

  console.error('=== Building outputs + sending email ===');
  const xlsx = buildXlsxBuffer(result);
  console.error(`  xlsx buffer: ${(xlsx.length / 1024).toFixed(0)} KB`);
  const html = buildHtml(result);
  console.error('  Sending email...');
  const info = await sendEmail(html, xlsx);
  console.error(`  ✓ Sent — messageId: ${info.messageId}`);
  console.error(`  response: ${info.response}`);
})().catch(err => {
  console.error('UNHANDLED:', err.stack || err.message || err);
  process.exit(1);
});
