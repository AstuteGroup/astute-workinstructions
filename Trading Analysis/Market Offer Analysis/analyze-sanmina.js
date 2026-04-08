/**
 * Sanmina Q2FY26 E&O — Analyzer (thin wrapper on shared/offer-analyzer)
 *
 * This is the first analyzer that uses the new shared cog. It's ~150 lines
 * vs the ~600-line analyze-ge-batch1.js / analyze-ge-batch2.js predecessors —
 * because all the dedupe-by-MPN, three-state coverage, scoring, and bulk
 * demand logic now lives in shared/offer-analyzer.js.
 *
 * The wrapper's only job: customer-specific framing for the email + xlsx
 * layout. Output building stays per-wrapper for now (becomes the next shared
 * cog: shared/offer-report.js).
 *
 * NO disk writes — xlsx + html built as in-memory buffers, sent directly via
 * nodemailer attachments. Per feedback_outputs_emailed_not_persisted.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const path = require('path');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const { analyzeOffer } = require(path.join(REPO, 'shared/offer-analyzer'));

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const OFFER_ID = parseInt(process.env.SANMINA_OFFER_ID || '1026035', 10);
const PARTNER_NAME = 'Sanmina Corporation';
const FROM_EMAIL = 'excess@orangetsunami.com';
const TO_EMAIL = 'jake.harris@astutegroup.com';

if (!OFFER_ID) {
  console.error('FATAL: pass SANMINA_OFFER_ID env var (set after the loader completes)');
  process.exit(1);
}

// ─── XLSX OUTPUT BUILDER ─────────────────────────────────────────────────────

function buildXlsxBuffer(result) {
  const wb = XLSX.utils.book_new();
  const total = result.lineCount;
  const uniqueMpns = result.uniqueMpnCount;
  const pct = n => total > 0 ? +(n / total).toFixed(4) : 0;
  const uPct = n => uniqueMpns > 0 ? +(n / uniqueMpns).toFixed(4) : 0;

  // Sheet 1: Lot Summary
  const summary = [
    [`${PARTNER_NAME} Q2FY26 E&O — Lot Analysis`],
    [],
    ['Partner', PARTNER_NAME],
    ['Offer search key', result.offers[0].searchKey],
    ['chuboe_offer_id', result.offers[0].offerId],
    ['Source', 'Candidates top 02-17-2026 excess plant approved v2.1.xlsx'],
    ['Analysis date', new Date().toISOString().slice(0, 10)],
    ['Intent', result.intent],
    [],
    ['Volume'],
    ['Total offer lines (date code/lot positions)', total],
    ['Unique MPNs (the analysis surface)',          uniqueMpns],
    ['Avg lines per unique MPN',                    +(total / uniqueMpns).toFixed(1)],
    [],
    ['Per-unique-MPN tier breakdown', 'Count', '%'],
    ['HOT (top opportunity)',         result.stats.uniqueMpnTier.HOT,      uPct(result.stats.uniqueMpnTier.HOT)],
    ['WARM (worth pursuing)',         result.stats.uniqueMpnTier.WARM,     uPct(result.stats.uniqueMpnTier.WARM)],
    ['COOL (marginal)',               result.stats.uniqueMpnTier.COOL,     uPct(result.stats.uniqueMpnTier.COOL)],
    ['SKIP (commodity / no signal)',  result.stats.uniqueMpnTier.SKIP,     uPct(result.stats.uniqueMpnTier.SKIP)],
    ['UNSCORED (NO_LISTING_*)',       result.stats.uniqueMpnTier.UNSCORED, uPct(result.stats.uniqueMpnTier.UNSCORED)],
    [],
    ['Per-line franchise state breakdown', 'Lines', '%'],
    ['IN_STOCK',                                         result.stats.IN_STOCK,                pct(result.stats.IN_STOCK)],
    ['FRANCHISE_OUT_OF_STOCK (real scarcity)',           result.stats.FRANCHISE_OUT_OF_STOCK,  pct(result.stats.FRANCHISE_OUT_OF_STOCK)],
    ['NO_LISTING_INTERNAL (push back to customer)',      result.stats.NO_LISTING_INTERNAL,    pct(result.stats.NO_LISTING_INTERNAL)],
    ['NO_LISTING_MILSPEC (mil-spec one-offs)',           result.stats.NO_LISTING_MILSPEC,     pct(result.stats.NO_LISTING_MILSPEC)],
    ['NO_LISTING_UNKNOWN (no franchise hit)',            result.stats.NO_LISTING_UNKNOWN,     pct(result.stats.NO_LISTING_UNKNOWN)],
    [],
    ['Demand signals', 'Lines', '%'],
    ['With active RFQ (90d)', result.stats.activeRfq, pct(result.stats.activeRfq)],
    ['With prior SO (12mo)',  result.stats.priorSo,   pct(result.stats.priorSo)],
    ['Zero demand signal',    result.stats.zeroDemand, pct(result.stats.zeroDemand)],
    [],
    ['Notes'],
    ['Sanmina provided per-(date code, lot) detail — every position loaded as a distinct line.'],
    [`The analysis surface is ${uniqueMpns} unique MPNs; franchise enrichment ran ${uniqueMpns} times (not ${total}).`],
    ['Sanmina data has Σ(MPN On Hand) inconsistencies vs OnHand/Excess — captured faithfully, pending real opportunity to clarify.'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(summary);
  ws['!cols'] = [{ wch: 50 }, { wch: 14 }, { wch: 10 }];
  // % formatting on count rows
  for (const r of [15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30, 31]) {
    const addr = `C${r + 1}`;
    if (ws[addr] && typeof ws[addr].v === 'number') ws[addr].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Lot Summary');

  // Sheet 2: Per-Unique-MPN view — the headline analysis surface
  // Now includes offered price, best comparable, ratio, RFQ/sales counts.
  const mpnHeaders = [
    'MPN', 'MFR', 'CPC', 'State', 'Tier', 'Lines', 'Total Qty',
    'Offered Price', 'Best Comparable', 'Comparable Source', 'Comparable Age (d)',
    'Offered / Comparable',
    'Franchise Stock', 'Carrying', 'In Stock',
    'Recent RFQs', 'Recent Sales (broker)', 'Recent Sales (cust)',
    'Top Recent Customer'
  ];
  const mpnRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    const linesForMpn = result.enrichedLines.filter(l => l.mpn === mpn);
    const sample = linesForMpn[0];
    const totalQty = linesForMpn.reduce((s, l) => s + (l.qty || 0), 0);
    const offered = sample ? sample.price : null;
    const cmp = m.bestComparable;
    const ratio = (cmp && offered && cmp.price > 0) ? (offered / cmp.price) : null;
    // Most recent customer name from either RFQ or sale
    const topCustomer = (m.demand.historicalRfqs[0]?.customer)
                     || (m.demand.historicalSales[0]?.customer)
                     || '';
    mpnRows.push([
      mpn, m.mfrText || '', m.cpc || '', m.state, sample ? sample.tier : 'UNSCORED',
      linesForMpn.length, totalQty,
      offered != null ? offered : '',
      cmp ? cmp.price : '',
      cmp ? cmp.source : '',
      cmp ? cmp.ageDays : '',
      ratio != null ? ratio : '',
      m.franchise ? m.franchise.totalStock : 0,
      m.franchise ? (m.franchise.distributorsCarrying || 0) : 0,
      m.franchise ? m.franchise.distributorsWithStock : 0,
      m.demand.historicalRfqs.length,
      m.demand.brokerSaleCount,
      m.demand.customerSaleCount,
      topCustomer,
    ]);
  }
  // Sort: HOT/WARM first, then by total qty desc
  const tierRank = { HOT: 0, WARM: 1, COOL: 2, SKIP: 3, UNSCORED: 4 };
  mpnRows.sort((a, b) => (tierRank[a[4]] - tierRank[b[4]]) || (b[6] - a[6]));
  const wsMpn = XLSX.utils.aoa_to_sheet([mpnHeaders, ...mpnRows]);
  wsMpn['!cols'] = [
    { wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 9 }, { wch: 7 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 },
    { wch: 18 },
    { wch: 14 }, { wch: 10 }, { wch: 10 },
    { wch: 11 }, { wch: 18 }, { wch: 16 },
    { wch: 32 },
  ];
  // Currency formatting on Offered Price (H), Best Comparable (I)
  for (let r = 1; r <= mpnRows.length; r++) {
    for (const col of ['H', 'I']) {
      const addr = `${col}${r + 1}`;
      if (wsMpn[addr] && typeof wsMpn[addr].v === 'number') wsMpn[addr].z = '$#,##0.0000';
    }
    // % format for ratio (L)
    const ratioAddr = `L${r + 1}`;
    if (wsMpn[ratioAddr] && typeof wsMpn[ratioAddr].v === 'number') wsMpn[ratioAddr].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, wsMpn, 'Per-MPN Summary');

  // Sheet 2b: Historical RFQ Detail (the actual rows the cog pulled)
  const rfqDetailHeaders = ['MPN', 'MFR', 'CPC', 'RFQ #', 'Customer', 'Type', 'Qty', 'Target', 'Date', 'Age (d)', 'Is Vendor'];
  const rfqDetailRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const r of m.demand.historicalRfqs) {
      rfqDetailRows.push([
        mpn, m.mfrText || '', m.cpc || '',
        r.rfqSearchKey, r.customer, r.rfqType,
        r.qty, r.targetPrice != null ? r.targetPrice : '',
        r.date, r.ageDays, r.isVendor ? 'Y' : 'N',
      ]);
    }
  }
  if (rfqDetailRows.length > 0) {
    rfqDetailRows.sort((a, b) => (a[9] - b[9])); // by age ascending (newest first)
    const wsRfq = XLSX.utils.aoa_to_sheet([rfqDetailHeaders, ...rfqDetailRows]);
    wsRfq['!cols'] = [
      { wch: 28 }, { wch: 20 }, { wch: 22 }, { wch: 9 }, { wch: 35 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 9 },
    ];
    for (let r = 1; r <= rfqDetailRows.length; r++) {
      const addr = `H${r + 1}`;
      if (wsRfq[addr] && typeof wsRfq[addr].v === 'number') wsRfq[addr].z = '$#,##0.0000';
    }
    XLSX.utils.book_append_sheet(wb, wsRfq, 'Historical RFQs');
  }

  // Sheet 2c: Historical Sales Detail
  const saleDetailHeaders = ['MPN', 'MFR', 'CPC', 'Customer', 'Qty', 'Sold Price', 'Date', 'Age (d)', 'Is Broker'];
  const saleDetailRows = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const s of m.demand.historicalSales) {
      saleDetailRows.push([
        mpn, m.mfrText || '', m.cpc || '',
        s.customer, s.qty, s.soldPrice != null ? s.soldPrice : '',
        s.date, s.ageDays, s.isBroker ? 'Y' : 'N',
      ]);
    }
  }
  if (saleDetailRows.length > 0) {
    saleDetailRows.sort((a, b) => (a[7] - b[7])); // by age ascending
    const wsSales = XLSX.utils.aoa_to_sheet([saleDetailHeaders, ...saleDetailRows]);
    wsSales['!cols'] = [
      { wch: 28 }, { wch: 20 }, { wch: 22 }, { wch: 35 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 8 }, { wch: 9 },
    ];
    for (let r = 1; r <= saleDetailRows.length; r++) {
      const addr = `F${r + 1}`;
      if (wsSales[addr] && typeof wsSales[addr].v === 'number') wsSales[addr].z = '$#,##0.0000';
    }
    XLSX.utils.book_append_sheet(wb, wsSales, 'Historical Sales');
  }

  // Sheet 3: Per-Line Detail (all 1986 date code/lot positions)
  const detHeaders = ['Line', 'MPN', 'CPC', 'MFR', 'Date Code', 'Description (Org+Lot)',
                      'Qty', 'Price', 'State', 'Tier', 'Score', 'Flags'];
  const sortedLines = [...result.enrichedLines].sort((a, b) => {
    if (a.rawScore == null && b.rawScore == null) return 0;
    if (a.rawScore == null) return 1;
    if (b.rawScore == null) return -1;
    return b.rawScore - a.rawScore;
  });
  const detRows = sortedLines.map(l => [
    l.lineNum, l.mpn, l.cpc, l.mfrText, l.dateCode, l.description,
    l.qty || 0, l.price != null ? l.price : '',
    l.state, l.tier, l.rawScore == null ? '' : l.rawScore,
    l.flags.join('; '),
  ]);
  const wsDet = XLSX.utils.aoa_to_sheet([detHeaders, ...detRows]);
  wsDet['!cols'] = [
    { wch: 7 }, { wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 10 }, { wch: 50 },
    { wch: 10 }, { wch: 14 }, { wch: 22 }, { wch: 9 }, { wch: 7 }, { wch: 36 },
  ];
  for (let r = 1; r <= detRows.length; r++) {
    const addr = `H${r + 1}`;
    if (wsDet[addr] && typeof wsDet[addr].v === 'number') wsDet[addr].z = '$#,##0.0000';
  }
  XLSX.utils.book_append_sheet(wb, wsDet, 'Per-Line Detail');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── HTML EMAIL BODY ─────────────────────────────────────────────────────────

function buildHtml(result) {
  const total = result.lineCount;
  const uniqueMpns = result.uniqueMpnCount;
  const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0.0%';
  const uPct = n => uniqueMpns > 0 ? ((n / uniqueMpns) * 100).toFixed(1) + '%' : '0.0%';
  const cell = (v, align = 'left') => `<td align="${align}" style="padding:4px 10px;border:1px solid #ccc">${v}</td>`;
  const partner = result.offers[0].partner;

  return `<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#222;max-width:820px">
<h2 style="margin-bottom:4px">Sanmina Corporation Q2FY26 E&amp;O — Analysis</h2>
<p style="color:#666;margin-top:0">
Source: 4/8/2026 — Ilce Tejeda / John Gorham @ Sanmina<br>
OT offer search key: <b>${result.offers[0].searchKey}</b> (chuboe_offer_id ${result.offers[0].offerId})<br>
Source file: <code>Candidates top 02-17-2026 excess plant approved v2.1.xlsx</code><br>
First analysis to use the new shared <code>offer-analyzer</code> cog with dedupe-by-MPN.
</p>

<h3>Volume</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">Metric</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Value</th>
  </tr>
  <tr>${cell('Total lines loaded (one per Date Code/Lot position)')}${cell(total.toLocaleString(), 'right')}</tr>
  <tr>${cell('<b>Unique MPNs (the analysis surface)</b>')}${cell('<b>' + uniqueMpns + '</b>', 'right')}</tr>
  <tr>${cell('Avg lines per unique MPN')}${cell((total / uniqueMpns).toFixed(1), 'right')}</tr>
  <tr>${cell('Franchise API calls (deduped by MPN)')}${cell(uniqueMpns + ' (not ' + total + ')', 'right')}</tr>
</table>

<h3>Per-Unique-MPN tier breakdown (only 25 parts to evaluate)</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Tier</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Count</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr style="background:#fff4e0">${cell('<b>HOT</b> (top opportunity)')}${cell(result.stats.uniqueMpnTier.HOT, 'right')}${cell(uPct(result.stats.uniqueMpnTier.HOT), 'right')}</tr>
  <tr style="background:#fff8eb">${cell('<b>WARM</b> (worth pursuing)')}${cell(result.stats.uniqueMpnTier.WARM, 'right')}${cell(uPct(result.stats.uniqueMpnTier.WARM), 'right')}</tr>
  <tr>${cell('COOL (marginal)')}${cell(result.stats.uniqueMpnTier.COOL, 'right')}${cell(uPct(result.stats.uniqueMpnTier.COOL), 'right')}</tr>
  <tr>${cell('SKIP (commodity / no signal)')}${cell(result.stats.uniqueMpnTier.SKIP, 'right')}${cell(uPct(result.stats.uniqueMpnTier.SKIP), 'right')}</tr>
  <tr style="background:#f8f8f8">${cell('UNSCORED (NO_LISTING_*)')}${cell(result.stats.uniqueMpnTier.UNSCORED, 'right')}${cell(uPct(result.stats.uniqueMpnTier.UNSCORED), 'right')}</tr>
</table>

<h3>Franchise state (per-line, including all date code/lot positions)</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">State</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Lines</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr style="background:#e8f5e8">${cell('<b>IN_STOCK</b>')}${cell(result.stats.IN_STOCK, 'right')}${cell(pct(result.stats.IN_STOCK), 'right')}</tr>
  <tr style="background:#fff4e0">${cell('<b>FRANCHISE_OUT_OF_STOCK</b> (scarcity)')}${cell(result.stats.FRANCHISE_OUT_OF_STOCK, 'right')}${cell(pct(result.stats.FRANCHISE_OUT_OF_STOCK), 'right')}</tr>
  <tr style="background:#fde0e0">${cell('<b>NO_LISTING_INTERNAL</b> (push back to Sanmina)')}${cell(result.stats.NO_LISTING_INTERNAL, 'right')}${cell(pct(result.stats.NO_LISTING_INTERNAL), 'right')}</tr>
  <tr>${cell('<b>NO_LISTING_MILSPEC</b>')}${cell(result.stats.NO_LISTING_MILSPEC, 'right')}${cell(pct(result.stats.NO_LISTING_MILSPEC), 'right')}</tr>
  <tr style="background:#f8f8f8">${cell('<b>NO_LISTING_UNKNOWN</b>')}${cell(result.stats.NO_LISTING_UNKNOWN, 'right')}${cell(pct(result.stats.NO_LISTING_UNKNOWN), 'right')}</tr>
</table>

<h3>Price comparison — Sanmina's offered price vs best available comparable</h3>
<p style="color:#444;font-size:12px">Comparable price priority: franchise catalog (even when stock=0) → most recent broker sale → most recent customer sale → most recent RFQ target. Useful for spotting parts where Sanmina is materially cheaper than franchise / market regardless of broker resale margin.</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">MPN</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">State</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Offered</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Comparable</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">Source</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Ratio</th>
  </tr>
  ${(() => {
    // Show MPNs that have both offered + comparable, sorted by ratio (cheapest first)
    const rows = [];
    for (const [mpn, m] of result.perMpnEnrichment) {
      const sample = result.enrichedLines.find(l => l.mpn === mpn);
      if (!sample || sample.price == null || !m.bestComparable || m.bestComparable.price <= 0) continue;
      const ratio = sample.price / m.bestComparable.price;
      rows.push({ mpn, state: m.state, offered: sample.price, cmp: m.bestComparable, ratio });
    }
    rows.sort((a, b) => a.ratio - b.ratio);
    const fmt$ = n => '$' + (n || 0).toFixed(4);
    const fmtPct = n => (n * 100).toFixed(0) + '%';
    const ratioCellColor = r =>
      r < 0.30 ? 'background:#e8f5e8' :   // strong (green) — would have margin
      r < 0.60 ? 'background:#fff4e0' :   // notable (amber) — meaningful spread
      'background:#f8f8f8';                // weak (grey) — no real spread
    return rows.map(r => `
      <tr style="${ratioCellColor(r.ratio)}">
        ${cell('<code>' + r.mpn + '</code>')}
        ${cell(r.state)}
        ${cell(fmt$(r.offered), 'right')}
        ${cell(fmt$(r.cmp.price), 'right')}
        ${cell(r.cmp.source + (r.cmp.ageDays > 0 ? ' (' + r.cmp.ageDays + 'd)' : ''))}
        ${cell('<b>' + fmtPct(r.ratio) + '</b>', 'right')}
      </tr>`).join('');
  })()}
</table>
<p style="color:#666;font-size:11px">Color key: <span style="background:#e8f5e8;padding:1px 6px">&lt;30%</span> meets broker resale margin threshold &nbsp; <span style="background:#fff4e0;padding:1px 6px">30-60%</span> meaningful spread, worth investigating &nbsp; <span style="background:#f8f8f8;padding:1px 6px">≥60%</span> no real spread</p>

<h3>Recent historical activity (top 10 across the lot)</h3>
${(() => {
  // Top 10 most recent RFQs across all MPNs
  const allRfqs = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const r of m.demand.historicalRfqs) {
      allRfqs.push({ mpn, ...r });
    }
  }
  allRfqs.sort((a, b) => a.ageDays - b.ageDays);
  const top = allRfqs.slice(0, 10);
  if (top.length === 0) return '<p style="color:#888">No historical RFQ matches in the last 12 months.</p>';
  return `<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
    <tr style="background:#f0f0f0">
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">MPN</th>
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">RFQ #</th>
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">Customer</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Qty</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Target</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Days Ago</th>
    </tr>
    ${top.map(r => `<tr>
      ${cell('<code>' + r.mpn + '</code>')}
      ${cell(r.rfqSearchKey)}
      ${cell(r.customer)}
      ${cell((r.qty || 0).toLocaleString(), 'right')}
      ${cell(r.targetPrice ? '$' + Number(r.targetPrice).toFixed(4) : '—', 'right')}
      ${cell(r.ageDays + 'd', 'right')}
    </tr>`).join('')}
  </table>`;
})()}

${(() => {
  // Top 10 most recent SALES across all MPNs
  const allSales = [];
  for (const [mpn, m] of result.perMpnEnrichment) {
    for (const s of m.demand.historicalSales) {
      allSales.push({ mpn, ...s });
    }
  }
  allSales.sort((a, b) => a.ageDays - b.ageDays);
  const top = allSales.slice(0, 10);
  if (top.length === 0) return '<p style="color:#888">No historical sales matches in the last 24 months.</p>';
  return `<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
    <tr style="background:#f0f0f0">
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">MPN</th>
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">Customer</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Qty</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Sold @</th>
      <th align="right" style="padding:4px 10px;border:1px solid #ccc">Days Ago</th>
      <th align="left" style="padding:4px 10px;border:1px solid #ccc">Channel</th>
    </tr>
    ${top.map(s => `<tr>
      ${cell('<code>' + s.mpn + '</code>')}
      ${cell(s.customer)}
      ${cell((s.qty || 0).toLocaleString(), 'right')}
      ${cell('$' + Number(s.soldPrice).toFixed(4), 'right')}
      ${cell(s.ageDays + 'd', 'right')}
      ${cell(s.isBroker ? 'Broker' : 'Customer')}
    </tr>`).join('')}
  </table>`;
})()}

<h3>Demand signals (per-line)</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Signal</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Lines</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr>${cell('Active open RFQ (90d)')}${cell(result.stats.activeRfq, 'right')}${cell(pct(result.stats.activeRfq), 'right')}</tr>
  <tr>${cell('Prior SO history (12mo)')}${cell(result.stats.priorSo, 'right')}${cell(pct(result.stats.priorSo), 'right')}</tr>
  <tr>${cell('Zero demand signal')}${cell(result.stats.zeroDemand, 'right')}${cell(pct(result.stats.zeroDemand), 'right')}</tr>
</table>

<h3>What to do with this</h3>
<ul>
  <li><b>The "Per-MPN Summary" sheet</b> is the headline — 20 rows with offered vs comparable pricing, plus a sortable ratio column. Start there.</li>
  <li><b>"Historical RFQs" and "Historical Sales" sheets</b> have the actual rows the cog pulled — customer / date / qty / price for the top 10 most recent matches per MPN. Drill into these for context on parts the lot has activity for.</li>
  <li><b>Price ratio &lt;30%</b> (green rows in the comparison table) are parts where Sanmina is meaningfully cheaper than the best comparable — these are the spread opportunities.</li>
  <li><b>Sanmina gave us per-(Date Code, Lot) detail</b> for every MPN. The "Per-Line Detail" sheet has all ${total.toLocaleString()} positions if you need to drill into specific lots.</li>
  <li><b>Sanmina data quality caveat:</b> per-MPN Σ(MPN On Hand) doesn't reconcile to OnHand or Excess column for several parts. If a real opportunity surfaces, we go back to John Gorham to clarify before transacting.</li>
</ul>

<h3>Pipeline timing</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Step</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">ms</th></tr>
  <tr>${cell('Fetch from OT (psql)')}${cell(result.timing.fetchMs.toLocaleString(), 'right')}</tr>
  <tr>${cell('Bulk demand fetch')}${cell(result.timing.demandMs.toLocaleString(), 'right')}</tr>
  <tr>${cell('Franchise enrichment (' + uniqueMpns + ' unique MPNs, parallel)')}${cell(result.timing.franchiseMs.toLocaleString(), 'right')}</tr>
  <tr>${cell('Score + aggregate')}${cell(result.timing.scoreMs.toLocaleString(), 'right')}</tr>
  <tr>${cell('<b>Total</b>')}${cell('<b>' + result.timing.totalMs.toLocaleString() + '</b>', 'right')}</tr>
</table>

<p style="color:#666;font-size:11px;margin-top:20px">First analysis to use <code>shared/offer-analyzer.js</code> — same cog will run for every future market offer regardless of customer (no copy-paste between scripts). Phase 3 (AI extraction + fully automated inbox poller) is the next session's work.</p>
</body></html>`;
}

// ─── EMAIL SENDER ────────────────────────────────────────────────────────────

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
    subject: `Sanmina Q2FY26 E&O — 25 unique MPNs across ~2000 date code/lot positions`,
    html: htmlBody,
    attachments: [
      { filename: 'Sanmina_Q2FY26_EandO_Analysis.xlsx', content: xlsxBuffer },
    ],
  });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  console.error(`=== Sanmina Q2FY26 E&O Analysis (cog-based) ===`);
  console.error(`Offer ID: ${OFFER_ID}`);
  console.error('');

  const result = await analyzeOffer({
    offerId: OFFER_ID,
    intent: 'consignment',
    franchiseConcurrency: 10,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) {
        process.stderr.write(`  franchise: ${done}/${total} unique MPNs\n`);
      }
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
