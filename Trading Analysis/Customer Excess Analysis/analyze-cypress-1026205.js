/**
 * Cypress Mfg list — Reactive analysis (15 MPNs from Ben Ortiz, 4/30/2026).
 *
 * Source: inline HTML table in James Diaz's forward, recovered after the
 * offer-poller HTML-table extractor was added (2026-05-06). Loaded as
 * chuboe_offer 1026205 / search key 1026098, BP 1002805 Cypress Technologies LP.
 *
 * Intent: REACTIVE — Cypress is a CM/EMS customer offloading excess; the
 * action item is "match each MPN against open RFQs / recent sales / franchise
 * supply" and call out the high-leverage lines.
 *
 * Per workflow doc, no disk writes — xlsx + html built as in-memory buffers,
 * sent directly via nodemailer attachments.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const path = require('path');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const { analyzeOffer } = require(path.join(REPO, 'shared/offer-analyzer'));

const OFFER_ID = parseInt(process.env.CYPRESS_OFFER_ID || '1026205', 10);
const PARTNER_NAME = 'Cypress Technologies LP';
const SOURCE_NOTE = "Ben Ortiz @ cypressmfg.com — list shared 5/1, originally requested 4/30 'Supplier Discussion'";
const FROM_EMAIL = 'excess@orangetsunami.com';
const TO_EMAIL = process.env.CYPRESS_TO_EMAIL || 'jake.harris@astutegroup.com';

// ─── XLSX OUTPUT ─────────────────────────────────────────────────────────────

function buildXlsxBuffer(result) {
  const wb = XLSX.utils.book_new();
  const total = result.lineCount;
  const uniqueMpns = result.uniqueMpnCount;
  const pct = n => total > 0 ? +(n / total).toFixed(4) : 0;
  const uPct = n => uniqueMpns > 0 ? +(n / uniqueMpns).toFixed(4) : 0;

  // Sheet 1: Summary
  const summary = [
    [`${PARTNER_NAME} Excess — Reactive Analysis`],
    [],
    ['Partner', PARTNER_NAME],
    ['Offer search key', result.offers[0].searchKey],
    ['chuboe_offer_id', result.offers[0].offerId],
    ['Source', SOURCE_NOTE],
    ['Analysis date', new Date().toISOString().slice(0, 10)],
    ['Intent', result.intent],
    [],
    ['Volume'],
    ['Total offer lines', total],
    ['Unique MPNs', uniqueMpns],
    [],
    ['Per-unique-MPN tier', 'Count', '%'],
    ['HOT',      result.stats.uniqueMpnTier.HOT,      uPct(result.stats.uniqueMpnTier.HOT)],
    ['WARM',     result.stats.uniqueMpnTier.WARM,     uPct(result.stats.uniqueMpnTier.WARM)],
    ['COOL',     result.stats.uniqueMpnTier.COOL,     uPct(result.stats.uniqueMpnTier.COOL)],
    ['SKIP',     result.stats.uniqueMpnTier.SKIP,     uPct(result.stats.uniqueMpnTier.SKIP)],
    ['UNSCORED', result.stats.uniqueMpnTier.UNSCORED, uPct(result.stats.uniqueMpnTier.UNSCORED)],
    [],
    ['Per-line franchise state', 'Lines', '%'],
    ['IN_STOCK',                result.stats.IN_STOCK,                pct(result.stats.IN_STOCK)],
    ['FRANCHISE_OUT_OF_STOCK',  result.stats.FRANCHISE_OUT_OF_STOCK,  pct(result.stats.FRANCHISE_OUT_OF_STOCK)],
    ['NO_LISTING_INTERNAL',     result.stats.NO_LISTING_INTERNAL,     pct(result.stats.NO_LISTING_INTERNAL)],
    ['NO_LISTING_MILSPEC',      result.stats.NO_LISTING_MILSPEC,      pct(result.stats.NO_LISTING_MILSPEC)],
    ['NO_LISTING_UNKNOWN',      result.stats.NO_LISTING_UNKNOWN,      pct(result.stats.NO_LISTING_UNKNOWN)],
    [],
    ['Demand signals', 'Lines', '%'],
    ['Active open RFQ (90d)', result.stats.activeRfq, pct(result.stats.activeRfq)],
    ['Prior SO (12mo)',       result.stats.priorSo,   pct(result.stats.priorSo)],
    ['Zero demand',           result.stats.zeroDemand, pct(result.stats.zeroDemand)],
  ];
  const ws = XLSX.utils.aoa_to_sheet(summary);
  ws['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 10 }];
  for (const r of [13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 27, 28, 29]) {
    const a = `C${r + 1}`;
    if (ws[a] && typeof ws[a].v === 'number') ws[a].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');

  // Sheet 2: Per-MPN — the headline
  const mpnHeaders = [
    'MPN', 'MFR', 'Description', 'Qty', 'Offered $', 'Best Comparable $',
    'Comparable Source', 'Cmp Age (d)', 'Offered/Cmp',
    'State', 'Tier', 'Score',
    'Franchise Stock', 'Carrying', 'In Stock',
    'Active RFQs (90d)', 'Recent Sales (broker)', 'Recent Sales (cust)',
    'Top Recent Customer', 'Flags',
  ];
  const tierRank = { HOT: 0, WARM: 1, COOL: 2, SKIP: 3, UNSCORED: 4 };
  const mpnRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    const linesForMpn = result.enrichedLines.filter(l => l.mpn === mpn);
    const sample = linesForMpn[0] || {};
    const totalQty = linesForMpn.reduce((s, l) => s + (l.qty || 0), 0);
    const offered = sample.price ?? null;
    const cmp = m.bestComparable;
    const ratio = (cmp && offered && cmp.price > 0) ? offered / cmp.price : null;
    const topCustomer = (m.demand.historicalRfqs?.[0]?.customer)
                     || (m.demand.historicalSales?.[0]?.customer) || '';
    mpnRows.push([
      mpn, m.mfrText || '', sample.description || '',
      totalQty, offered ?? '',
      cmp ? cmp.price : '', cmp ? cmp.source : '', cmp ? cmp.ageDays : '',
      ratio ?? '',
      m.state || sample.state || '',
      sample.tier || 'UNSCORED',
      sample.rawScore ?? '',
      m.franchise?.totalStock ?? 0,
      m.franchise?.distributorsCarrying ?? 0,
      m.franchise?.distributorsWithStock ?? 0,
      m.demand.activeRfqCount ?? 0,
      m.demand.brokerSaleCount ?? 0,
      m.demand.customerSaleCount ?? 0,
      topCustomer,
      (sample.flags || []).join('; '),
    ]);
  }
  mpnRows.sort((a, b) => (tierRank[a[10]] - tierRank[b[10]]) || (b[3] - a[3]));
  const wsMpn = XLSX.utils.aoa_to_sheet([mpnHeaders, ...mpnRows]);
  wsMpn['!cols'] = [
    { wch: 22 }, { wch: 18 }, { wch: 38 }, { wch: 8 }, { wch: 11 },
    { wch: 14 }, { wch: 16 }, { wch: 11 }, { wch: 12 },
    { wch: 24 }, { wch: 9 }, { wch: 7 },
    { wch: 13 }, { wch: 10 }, { wch: 10 },
    { wch: 14 }, { wch: 16 }, { wch: 16 },
    { wch: 28 }, { wch: 24 },
  ];
  for (let r = 1; r <= mpnRows.length; r++) {
    for (const col of ['E', 'F']) {
      const a = `${col}${r + 1}`;
      if (wsMpn[a] && typeof wsMpn[a].v === 'number') wsMpn[a].z = '$#,##0.0000';
    }
    const ratioA = `I${r + 1}`;
    if (wsMpn[ratioA] && typeof wsMpn[ratioA].v === 'number') wsMpn[ratioA].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, wsMpn, 'Per-MPN');

  // Sheet 3: Historical RFQs (top across all MPNs)
  const rfqHeaders = ['MPN', 'MFR', 'RFQ #', 'Customer', 'Type', 'Qty', 'Target $', 'Date', 'Age (d)'];
  const rfqRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const r of (m.demand.historicalRfqs || [])) {
      rfqRows.push([
        mpn, m.mfrText || '',
        r.rfqSearchKey, r.customer, r.rfqType,
        r.qty, r.targetPrice ?? '',
        r.date, r.ageDays,
      ]);
    }
  }
  if (rfqRows.length) {
    rfqRows.sort((a, b) => a[8] - b[8]);
    const wsRfq = XLSX.utils.aoa_to_sheet([rfqHeaders, ...rfqRows]);
    wsRfq['!cols'] = [
      { wch: 22 }, { wch: 18 }, { wch: 9 }, { wch: 30 }, { wch: 14 },
      { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 },
    ];
    for (let r = 1; r <= rfqRows.length; r++) {
      const a = `G${r + 1}`;
      if (wsRfq[a] && typeof wsRfq[a].v === 'number') wsRfq[a].z = '$#,##0.0000';
    }
    XLSX.utils.book_append_sheet(wb, wsRfq, 'Historical RFQs');
  }

  // Sheet 4: Historical Sales
  const saleHeaders = ['MPN', 'MFR', 'Customer', 'Qty', 'Sold $', 'Date', 'Age (d)', 'Channel'];
  const saleRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const s of (m.demand.historicalSales || [])) {
      saleRows.push([
        mpn, m.mfrText || '',
        s.customer, s.qty, s.soldPrice ?? '',
        s.date, s.ageDays, s.isBroker ? 'Broker' : 'Customer',
      ]);
    }
  }
  if (saleRows.length) {
    saleRows.sort((a, b) => a[6] - b[6]);
    const wsSale = XLSX.utils.aoa_to_sheet([saleHeaders, ...saleRows]);
    wsSale['!cols'] = [
      { wch: 22 }, { wch: 18 }, { wch: 30 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 },
    ];
    for (let r = 1; r <= saleRows.length; r++) {
      const a = `E${r + 1}`;
      if (wsSale[a] && typeof wsSale[a].v === 'number') wsSale[a].z = '$#,##0.0000';
    }
    XLSX.utils.book_append_sheet(wb, wsSale, 'Historical Sales');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── HTML EMAIL ──────────────────────────────────────────────────────────────

function buildHtml(result) {
  const total = result.lineCount;
  const uniqueMpns = result.uniqueMpnCount;
  const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0.0%';
  const uPct = n => uniqueMpns > 0 ? ((n / uniqueMpns) * 100).toFixed(1) + '%' : '0.0%';
  const cell = (v, align = 'left') => `<td align="${align}" style="padding:4px 10px;border:1px solid #ccc">${v}</td>`;
  const fmt$ = n => '$' + (Number(n) || 0).toFixed(4);
  const fmtPct = n => (n * 100).toFixed(0) + '%';

  // Headline table — every MPN on one row, sorted by tier then qty
  const tierRank = { HOT: 0, WARM: 1, COOL: 2, SKIP: 3, UNSCORED: 4 };
  const headlineRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    const sample = result.enrichedLines.find(l => l.mpn === mpn) || {};
    const cmp = m.bestComparable;
    const ratio = (cmp && sample.price && cmp.price > 0) ? sample.price / cmp.price : null;
    headlineRows.push({
      mpn, mfr: m.mfrText, desc: sample.description || '',
      qty: sample.qty || 0, offered: sample.price,
      cmpPrice: cmp?.price, cmpSource: cmp?.source, cmpAge: cmp?.ageDays,
      ratio,
      state: m.state || sample.state || '',
      tier: sample.tier || 'UNSCORED',
      score: sample.rawScore,
      activeRfqs: m.demand?.activeRfqCount || 0,
      brokerSales: m.demand?.brokerSaleCount || 0,
      custSales: m.demand?.customerSaleCount || 0,
      topCustomer: (m.demand?.historicalRfqs?.[0]?.customer)
                || (m.demand?.historicalSales?.[0]?.customer) || '',
      flags: sample.flags || [],
    });
  }
  headlineRows.sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || (b.qty - a.qty));

  const tierColor = t => t === 'HOT' ? 'background:#fff4e0' : t === 'WARM' ? 'background:#fff8eb' : t === 'UNSCORED' ? 'background:#f8f8f8' : '';
  const ratioColor = r => r == null ? '' : r < 0.30 ? 'background:#e8f5e8' : r < 0.60 ? 'background:#fff4e0' : 'background:#f8f8f8';

  const headlineHtml = `<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
    <tr style="background:#f0f0f0">
      <th align="left"  style="padding:4px 8px;border:1px solid #ccc">MPN</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Qty</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Offered</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Best Cmp</th>
      <th align="left"  style="padding:4px 8px;border:1px solid #ccc">Cmp Source</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Ratio</th>
      <th align="left"  style="padding:4px 8px;border:1px solid #ccc">State</th>
      <th align="left"  style="padding:4px 8px;border:1px solid #ccc">Tier</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Active RFQs</th>
      <th align="right" style="padding:4px 8px;border:1px solid #ccc">Recent Sales (B/C)</th>
      <th align="left"  style="padding:4px 8px;border:1px solid #ccc">Top Customer</th>
    </tr>
    ${headlineRows.map(r => `<tr style="${tierColor(r.tier)}">
      ${cell('<code>' + r.mpn + '</code>')}
      ${cell(Number(r.qty || 0).toLocaleString(), 'right')}
      ${cell(r.offered != null ? fmt$(r.offered) : '—', 'right')}
      ${cell(r.cmpPrice != null ? fmt$(r.cmpPrice) : '—', 'right')}
      ${cell(r.cmpSource ? (r.cmpSource + (r.cmpAge > 0 ? ` (${r.cmpAge}d)` : '')) : '—')}
      <td align="right" style="padding:4px 8px;border:1px solid #ccc;${ratioColor(r.ratio)}">${r.ratio != null ? '<b>' + fmtPct(r.ratio) + '</b>' : '—'}</td>
      ${cell(r.state || '—')}
      ${cell('<b>' + r.tier + '</b>')}
      ${cell(r.activeRfqs, 'right')}
      ${cell(r.brokerSales + ' / ' + r.custSales, 'right')}
      ${cell(r.topCustomer || '—')}
    </tr>`).join('')}
  </table>`;

  // Top historical activity (last 12mo RFQs + last 24mo sales, top 10 by recency)
  const allRfqs = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const r of (m.demand.historicalRfqs || [])) allRfqs.push({ mpn, ...r });
  }
  allRfqs.sort((a, b) => a.ageDays - b.ageDays);
  const topRfqs = allRfqs.slice(0, 10);

  const allSales = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const s of (m.demand.historicalSales || [])) allSales.push({ mpn, ...s });
  }
  allSales.sort((a, b) => a.ageDays - b.ageDays);
  const topSales = allSales.slice(0, 10);

  return `<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#222;max-width:980px">
<h2 style="margin-bottom:4px">Cypress Mfg Excess — Reactive Analysis</h2>
<p style="color:#666;margin-top:0">
Source: ${SOURCE_NOTE}<br>
OT offer search key: <b>${result.offers[0].searchKey}</b> (chuboe_offer_id ${result.offers[0].offerId})<br>
Loaded: 2026-05-06 via patched offer-poller (HTML inline-table extractor).<br>
Intent: <b>REACTIVE</b> — match each MPN against open RFQs / recent sales / franchise supply.
</p>

<h3>Inline note from James Diaz</h3>
<blockquote style="border-left:3px solid #888;margin:8px 0;padding:6px 12px;color:#444;font-size:12px">
"Sorry for the delay I was waiting for the TP from Ben, he'd like to get offers on each line ideally; can you see if there's any demand here?"
</blockquote>

<h3>15 lines — sorted by tier, then qty</h3>
${headlineHtml}
<p style="color:#666;font-size:11px;margin-top:0">
Color key — tier: <span style="background:#fff4e0;padding:1px 6px">HOT</span>
<span style="background:#fff8eb;padding:1px 6px">WARM</span>
<span style="background:#f8f8f8;padding:1px 6px">UNSCORED</span>
&nbsp;&nbsp; ratio: <span style="background:#e8f5e8;padding:1px 6px">&lt;30%</span>
<span style="background:#fff4e0;padding:1px 6px">30–60%</span>
<span style="background:#f8f8f8;padding:1px 6px">≥60%</span>
&nbsp;&nbsp;<i>(B/C = Broker/Customer recent sales, last 24mo)</i>
</p>

<h3>Roll-up</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Per-MPN tier</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Count</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr style="background:#fff4e0">${cell('<b>HOT</b>')}${cell(result.stats.uniqueMpnTier.HOT, 'right')}${cell(uPct(result.stats.uniqueMpnTier.HOT), 'right')}</tr>
  <tr style="background:#fff8eb">${cell('<b>WARM</b>')}${cell(result.stats.uniqueMpnTier.WARM, 'right')}${cell(uPct(result.stats.uniqueMpnTier.WARM), 'right')}</tr>
  <tr>${cell('COOL')}${cell(result.stats.uniqueMpnTier.COOL, 'right')}${cell(uPct(result.stats.uniqueMpnTier.COOL), 'right')}</tr>
  <tr>${cell('SKIP')}${cell(result.stats.uniqueMpnTier.SKIP, 'right')}${cell(uPct(result.stats.uniqueMpnTier.SKIP), 'right')}</tr>
  <tr style="background:#f8f8f8">${cell('UNSCORED')}${cell(result.stats.uniqueMpnTier.UNSCORED, 'right')}${cell(uPct(result.stats.uniqueMpnTier.UNSCORED), 'right')}</tr>
</table>

<h3>Recent matching activity</h3>
${topRfqs.length === 0 ? '<p style="color:#888">No matching open or historical RFQs in last 12 months across the 15 MPNs.</p>' : `
<p style="color:#444;font-size:12px">Top 10 most recent RFQs across the lot:</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">MPN</th>
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">RFQ #</th>
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">Customer</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Qty</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Target</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Days Ago</th>
  </tr>
  ${topRfqs.map(r => `<tr>
    ${cell('<code>' + r.mpn + '</code>')}
    ${cell(r.rfqSearchKey)}
    ${cell(r.customer)}
    ${cell((r.qty || 0).toLocaleString(), 'right')}
    ${cell(r.targetPrice ? fmt$(r.targetPrice) : '—', 'right')}
    ${cell(r.ageDays + 'd', 'right')}
  </tr>`).join('')}
</table>`}

${topSales.length === 0 ? '<p style="color:#888">No matching sales in last 24 months across the 15 MPNs.</p>' : `
<p style="color:#444;font-size:12px;margin-top:16px">Top 10 most recent sales:</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">MPN</th>
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">Customer</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Qty</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Sold @</th>
    <th align="right" style="padding:4px 8px;border:1px solid #ccc">Days Ago</th>
    <th align="left" style="padding:4px 8px;border:1px solid #ccc">Channel</th>
  </tr>
  ${topSales.map(s => `<tr>
    ${cell('<code>' + s.mpn + '</code>')}
    ${cell(s.customer)}
    ${cell((s.qty || 0).toLocaleString(), 'right')}
    ${cell(fmt$(s.soldPrice), 'right')}
    ${cell(s.ageDays + 'd', 'right')}
    ${cell(s.isBroker ? 'Broker' : 'Customer')}
  </tr>`).join('')}
</table>`}

<h3>What James asked for</h3>
<ul>
  <li><b>Demand check</b> — does Astute have buyers in pipeline or recent history? Per-MPN columns "Active RFQs" + "Recent Sales (B/C)" + "Top Customer" answer this.</li>
  <li><b>Offer back to Cypress</b> — for HOT/WARM lines, confirm with the historical buyer or open RFQ before quoting back. For UNSCORED (NO_LISTING_*), need to push back to Ben for industry MPNs / cross-references where available.</li>
  <li><b>The "Per-MPN" sheet</b> in the attached xlsx is sortable by every column. "Historical RFQs" + "Historical Sales" sheets have the rows behind the headline numbers.</li>
  <li><b>Heads-up</b> on row "2343" (Adafruit ADDRESS LED DISC 10pk) — qty matches the MPN literally; that's "Adafruit 2343" the part, not a typo.</li>
  <li><b>Heat-shrink boots (770-*)</b> are Glenair products; they may not have franchise coverage in our APIs and will likely come back UNSCORED.</li>
</ul>

<p style="color:#666;font-size:11px;margin-top:20px">
Pipeline: fetch ${result.timing.fetchMs}ms · demand ${result.timing.demandMs}ms · franchise ${result.timing.franchiseMs}ms (${uniqueMpns} unique MPNs) · score ${result.timing.scoreMs}ms · total ${result.timing.totalMs}ms.<br>
Generated 2026-05-06 from analyze-cypress-1026205.js, using shared/offer-analyzer.
</p>
</body></html>`;
}

// ─── EMAIL SENDER ────────────────────────────────────────────────────────────

async function sendEmail(htmlBody, xlsxBuffer, result) {
  if (!process.env.WORKMAIL_PASS) throw new Error('WORKMAIL_PASS not set');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user: FROM_EMAIL, pass: process.env.WORKMAIL_PASS },
  });
  return transporter.sendMail({
    from: `"Customer Excess Analysis" <${FROM_EMAIL}>`,
    to: TO_EMAIL,
    subject: `Cypress Mfg excess — ${result.uniqueMpnCount} MPNs · ${result.stats.uniqueMpnTier.HOT}H/${result.stats.uniqueMpnTier.WARM}W (sk ${result.offers[0].searchKey})`,
    html: htmlBody,
    attachments: [
      { filename: `Cypress_Mfg_Excess_Analysis_${result.offers[0].searchKey}.xlsx`, content: xlsxBuffer },
    ],
  });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  console.error(`=== Cypress Mfg Excess Analysis ===`);
  console.error(`Offer ID: ${OFFER_ID}\n`);

  const result = await analyzeOffer({
    offerId: OFFER_ID,
    intent: 'reactive',
    franchiseConcurrency: 10,
    onProgress: (done, total) => process.stderr.write(`  franchise: ${done}/${total} unique MPNs\r`),
  });

  console.error('\n=== Stats ===');
  console.error(`Lines: ${result.lineCount}, unique MPNs: ${result.uniqueMpnCount}`);
  console.error(`Per-MPN tier: HOT=${result.stats.uniqueMpnTier.HOT} WARM=${result.stats.uniqueMpnTier.WARM} COOL=${result.stats.uniqueMpnTier.COOL} SKIP=${result.stats.uniqueMpnTier.SKIP} UNSCORED=${result.stats.uniqueMpnTier.UNSCORED}`);
  console.error(`Per-line state: IN_STOCK=${result.stats.IN_STOCK} OOS=${result.stats.FRANCHISE_OUT_OF_STOCK} INTERNAL=${result.stats.NO_LISTING_INTERNAL} MILSPEC=${result.stats.NO_LISTING_MILSPEC} UNKNOWN=${result.stats.NO_LISTING_UNKNOWN}`);
  console.error(`Active RFQs: ${result.stats.activeRfq}, prior SO: ${result.stats.priorSo}`);
  console.error(`Timing: ${JSON.stringify(result.timing)}\n`);

  console.error('=== Build outputs + email ===');
  const xlsx = buildXlsxBuffer(result);
  console.error(`  xlsx: ${(xlsx.length / 1024).toFixed(0)} KB`);
  const html = buildHtml(result);
  if (process.env.CYPRESS_DRY_RUN === '1') {
    require('fs').writeFileSync('/home/analytics_user/workspace/cypress-report.html', html);
    require('fs').writeFileSync('/home/analytics_user/workspace/cypress-report.xlsx', xlsx);
    console.error('  Dry run — wrote cypress-report.html + .xlsx for inspection. Skipping email.');
    return;
  }
  console.error('  Sending email...');
  const info = await sendEmail(html, xlsx, result);
  console.error(`  ✓ Sent — messageId: ${info.messageId}`);
  console.error(`  response:  ${info.response}`);
})().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
