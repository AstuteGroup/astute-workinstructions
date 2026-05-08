// Email Jake the "request to purchase" summary for RFQ 1133067 lines whose
// best non-suspended quote has DC >= 24+. Source: 2026-04-29 Tracy Xie APAC
// bulk summary (62 VQs already loaded against the RFQ).
//
// This is a buyer-facing summary, NOT an automated R_Request post. Per
// memory rules: buyer ticks VQ + provides OT Copy Text, then we post the
// R_Request. This email is the precursor — Jake reviews, decides on the
// AVL caveat (Line 120) and the Line 130 historical-PPP gap, then either
// proceeds in OT directly or sends back the OT Copy Text for us to post.
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('../../../../shared/notifier');

const RFQ = '1133067';

const fmtUSD = (n, dp = 2) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPct = (n, dp = 1) => (n * 100).toFixed(dp) + '%';
const fmtQty = (n) => Number(n).toLocaleString();

// Lines whose BEST non-suspended quote has DC >= 24+
const buys = [
  {
    line: 60, lamPn: '660-345770-001', mpn: 'LTM8074EY#PBF', mfr: 'Analog Devices',
    priority: 'CRITICAL', shortfall: 25, qoh: 0,
    vendor: 'Hong Kong Duan Que Electronics Co., Limited',
    vendorShort: 'DQ', vendorSearchKey: '1003874',
    cost: 5.88, dc: '24+', coo: '—', leadTime: '3-5 days',
    altMpn: null,
    lamMoq: 80, resale: 9.71975487804878, basePrice: 7.970199, histPpp: 10.241,
    otPrevSupplier: 'Hong Kong Duan Que Electronics Co., Limited',
    notes: 'Best green. Same vendor as LAM previous supplier.',
  },
  {
    line: 70, lamPn: '630-345769-001', mpn: 'MAX16029TG+', mfr: 'Maxim Integrated',
    priority: 'CRITICAL', shortfall: 25, qoh: 0,
    vendor: 'Smartel', vendorShort: 'Smartel', vendorSearchKey: null,
    cost: 6.40, dc: '24+', coo: '—', leadTime: 'stock',
    altMpn: 'MAX16029TG+T',
    lamMoq: 75, resale: 8.925226829268293, basePrice: 7.318686, histPpp: 7.876,
    otPrevSupplier: 'Hong Kong Duan Que Electronics Co., Limited',
    notes: 'Quoted as MAX16029TG+T (T&R variant of canonical part — same product, taped & reel packaging). Confirm LAM accepts T&R.',
  },
  {
    line: 120, lamPn: '630-144359-001', mpn: 'LMZ14202TZ-ADJ/NOPB', mfr: 'Texas Instruments',
    priority: 'HIGH', shortfall: 12, qoh: 3,
    vendor: 'Smartel', vendorShort: 'Smartel', vendorSearchKey: null,
    cost: 6.80, dc: '25+', coo: 'Malaysia', leadTime: 'stock',
    altMpn: 'LMZ14202TZX-ADJ/NOPB',
    lamMoq: 250, resale: 12.225109756097561, basePrice: 10.02459, histPpp: 8.766,
    otPrevSupplier: 'Texas Instruments (franchise)',
    notes: '⚠ AVL ALT — TZX is a different module variant. Need LAM AVL approval before substituting. If AVL declines, fallback is Keming @ $10.32 / DC 23+ on canonical TZ-ADJ/NOPB (NOT 24+).',
  },
  {
    line: 130, lamPn: '630-337825-001', mpn: 'AD9467BCPZ-250', mfr: 'Analog Devices',
    priority: 'MEDIUM', shortfall: 14, qoh: 11,
    vendor: 'Xin Jun Hong (HK) Industry Co., Ltd', vendorShort: 'XJH', vendorSearchKey: '1003910',
    cost: 113.95, dc: '25+', coo: 'Philippines', leadTime: 'stock',
    altMpn: null,
    lamMoq: 100, resale: 263.99063414634145, basePrice: 216.47232, histPpp: 78.50,
    otPrevSupplier: 'LITUOXIN GROUP (HK) CO.,',
    notes: '⚠ Historical PPP was $78.50 (POV0066904, 2024-06-21). Today\'s best at $113.95 is +45% over historical, but resale is $264 so margin still strong (56.8%). Decide if you want to push XJH for closer to the historical bench, or accept the market drift.',
  },
];

// Optional flag: Line 110 ADS8688IDBTR has 24+ alt available if you want to upgrade DC
const optionalUpgrade = {
  line: 110, mpn: 'ADS8688IDBTR',
  current: { vendor: 'Firsttop', cost: 3.70, dc: '23+', margin: (15.617652439024392 - 3.70)/15.617652439024392 },
  upgrade: { vendor: 'Delsheng', cost: 5.55, dc: '25+', coo: 'Malaysia', margin: (15.617652439024392 - 5.55)/15.617652439024392 },
  lamMoq: 60,
};

function buildHtml() {
  const totalCost = buys.reduce((s, b) => s + b.cost * b.lamMoq, 0);
  const totalGp = buys.reduce((s, b) => s + (b.resale - b.cost) * b.lamMoq, 0);

  const rows = buys.map(b => {
    const margin = (b.resale - b.cost) / b.resale;
    const gp = (b.resale - b.cost) * b.lamMoq;
    const cost = b.cost * b.lamMoq;
    const altMpnTag = b.altMpn ? `<br/><span style="color:#a06000;font-size:11px;">alt MPN: <b>${b.altMpn}</b></span>` : '';
    const priorityColor = b.priority === 'CRITICAL' ? '#ff9999' : b.priority === 'HIGH' ? '#fff2cc' : '#e0e0e0';
    return `
      <tr>
        <td>${b.line}</td>
        <td><b>${b.mpn}</b>${altMpnTag}<br/><span style="font-size:11px;color:#666;">${b.lamPn} · ${b.mfr}</span></td>
        <td style="background:${priorityColor};font-weight:bold;">${b.priority}</td>
        <td>${b.vendor}${b.vendorSearchKey ? `<br/><span style="font-size:11px;color:#666;">sk ${b.vendorSearchKey}</span>` : ''}</td>
        <td style="text-align:right;">${fmtUSD(b.cost, 4)}</td>
        <td style="text-align:center;">${b.dc}</td>
        <td style="text-align:center;">${b.coo}</td>
        <td style="text-align:right;">${fmtQty(b.lamMoq)}</td>
        <td style="text-align:right;">${fmtUSD(cost)}</td>
        <td style="text-align:right;">${fmtUSD(b.resale, 4)}</td>
        <td style="text-align:right;background:#90ee90;font-weight:bold;">${fmtPct(margin)}</td>
        <td style="text-align:right;">${fmtUSD(gp)}</td>
      </tr>
      <tr><td colspan="12" style="font-size:11px;color:#444;background:#fafafa;padding:6px 12px;">${b.notes}</td></tr>
    `;
  }).join('');

  const upgradeBox = `
    <h3 style="margin-top:24px;">Optional: Line 110 DC upgrade (not currently 24+, but 24+ alt available)</h3>
    <p style="font-size:13px;">
      <b>${optionalUpgrade.mpn}</b> — current best is <b>${optionalUpgrade.current.vendor}</b> @ ${fmtUSD(optionalUpgrade.current.cost, 4)} / DC ${optionalUpgrade.current.dc} (margin ${fmtPct(optionalUpgrade.current.margin)}).
      24+ alt available: <b>${optionalUpgrade.upgrade.vendor}</b> @ ${fmtUSD(optionalUpgrade.upgrade.cost, 4)} / DC ${optionalUpgrade.upgrade.dc} / ${optionalUpgrade.upgrade.coo} (margin ${fmtPct(optionalUpgrade.upgrade.margin)}).
      Premium: +${fmtUSD(optionalUpgrade.upgrade.cost - optionalUpgrade.current.cost, 4)}/pc · +${fmtUSD((optionalUpgrade.upgrade.cost - optionalUpgrade.current.cost) * optionalUpgrade.lamMoq)} on a ${optionalUpgrade.lamMoq}-pc buy.
      <b>Skipped from main list since 23+ is generally acceptable;</b> say the word if you want to swap.
    </p>
  `;

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222;">
<h2 style="margin:0 0 8px 0;">Request to Purchase — RFQ ${RFQ} (24+ DC parts)</h2>
<p>Best non-suspended broker quote per line on RFQ ${RFQ} where date code is <b>2024 or newer</b>. Source: Tracy Xie APAC bulk summary, 62 VQs loaded 2026-04-29. Lines 10, 80, 110, 150 had no 24+ DC at viable margin and are excluded (older session emails covered the DC trade-offs there).</p>

<table cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:12px;">
  <thead style="background:#d9e1f2;">
    <tr>
      <th>Line</th><th>MPN</th><th>Priority</th><th>Vendor</th>
      <th>Cost</th><th>DC</th><th>COO</th><th>LAM MOQ</th><th>Buy $</th>
      <th>Resale</th><th>Margin</th><th>GP @ MOQ</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
  <tfoot style="background:#f0f0f0;font-weight:bold;">
    <tr>
      <td colspan="8" style="text-align:right;">Total @ LAM MOQ:</td>
      <td style="text-align:right;">${fmtUSD(totalCost)}</td>
      <td></td><td></td>
      <td style="text-align:right;">${fmtUSD(totalGp)}</td>
    </tr>
  </tfoot>
</table>

${upgradeBox}

<h3 style="margin-top:24px;">Watchouts before posting R_Requests</h3>
<ul>
  <li><b>Line 70 MAX16029TG+T</b> — T&R variant of canonical (cut tape vs reel). Confirm LAM accepts the reel packaging.</li>
  <li><b>Line 120 LMZ14202TZX-ADJ/NOPB</b> — different module variant from LMZ14202TZ-ADJ/NOPB. <b>Needs LAM AVL approval</b> before substituting. Fallback if declined: Keming @ $10.32 / DC 23+ on canonical (NOT 24+, so excluded from this list).</li>
  <li><b>Line 130 AD9467BCPZ-250</b> — historical PPP $78.50 (Lituoxin, 2024-06-21). XJH today at $113.95 is +45% over historical, but margin still 56.8% at LAM resale. Decide whether to push for a closer-to-historical re-quote first.</li>
  <li><b>Line 60 LTM8074EY#PBF</b> — same vendor (DQ) as LAM previous supplier. Cleanest of the four.</li>
</ul>

<h3 style="margin-top:24px;">Next steps</h3>
<p>If you want me to post the R_Requests via API: tick the chosen VQ in OT (or tell me which VQ_Line_IDs to tick), then paste the OT Copy Text per line and I'll post the approve-order requests through <code>shared/r-request-writer.js::postApproveOrder</code>. Otherwise, proceed manually in OT — VQs are already loaded.</p>

<p style="font-size:11px;color:#888;margin-top:30px;">RFQ: ${RFQ} (Lam Research) · Source session: <code>2026-04-29-LAM-reorders-1133067.json</code></p>
</body></html>`;
}

(async () => {
  const html = buildHtml();
  const notifier = createNotifier({ fromEmail: 'excess@orangetsunami.com', fromName: 'LAM Kitting Reorder' });
  const ok = await notifier.sendEmail(
    'jake.harris@astutegroup.com',
    `LAM Kitting RFQ ${RFQ} — Request to Purchase (24+ DC parts, 4 lines, ~${'$' + Math.round(buys.reduce((s,b)=>s+b.cost*b.lamMoq,0)).toLocaleString()} buy / ~${'$' + Math.round(buys.reduce((s,b)=>s+(b.resale-b.cost)*b.lamMoq,0)).toLocaleString()} GP)`,
    html,
    { html: true }
  );
  console.log(ok ? 'Email sent.' : 'Email failed.');
})();
