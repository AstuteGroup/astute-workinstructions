// Confirmation email after tick + R_Request post for RFQ 1133067 (24+ DC batch).
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('../../../../shared/notifier');

const RFQ = '1133067';

const RESULTS = [
  { line: 60,  mpn: 'LTM8074EY#PBF',  vendor: 'Hong Kong Duan Que Electronics Co., Limited', vendorShort: 'DQ',
    cost: 5.88,    qty: 80,  dc: '24+', leadTime: 'STOCK - 1 WEEK',
    vqId: 2140913, rRequest: '1158559 (id 1160657)',
    margin: 0.395, gp: 307.18, lamResale: 9.7198, packaging: 'F-REEL' },
  { line: 70,  mpn: 'MAX16029TG+',    vendor: 'SMARTEL ELECTRONICS (ASIA) CO LTD',           vendorShort: 'Smartel',
    cost: 6.40,    qty: 75,  dc: '24+', leadTime: 'STOCK',
    vqId: 2140922, rRequest: '1158560 (id 1160658)',
    margin: 0.283, gp: 189.39, lamResale: 8.9252, packaging: 'F-REEL',
    altMpn: 'MAX16029TG+T (T&R variant of canonical — same product, reel)' },
  { line: 130, mpn: 'AD9467BCPZ-250', vendor: 'Xin Jun Hong (HK) Industry Co., Ltd',         vendorShort: 'XJH',
    cost: 113.95, qty: 100, dc: '25+', leadTime: 'STOCK',
    vqId: 2140932, rRequest: '1158561 (id 1160659)',
    margin: 0.568, gp: 15003.91, lamResale: 263.99, packaging: 'OTHER (per historical LAM tick)' },
];

const fmtUSD = (n, dp = 2) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPct = (n) => (n * 100).toFixed(1) + '%';
const fmtQty = (n) => Number(n).toLocaleString();

const totalCost = RESULTS.reduce((s, r) => s + r.cost * r.qty, 0);
const totalGp = RESULTS.reduce((s, r) => s + r.gp, 0);

const rows = RESULTS.map(r => `
  <tr>
    <td>${r.line}</td>
    <td><b>${r.mpn}</b>${r.altMpn ? `<br/><span style="font-size:11px;color:#a06000;">alt: ${r.altMpn}</span>` : ''}</td>
    <td>${r.vendor}<br/><span style="font-size:11px;color:#666;">${r.vendorShort}</span></td>
    <td style="text-align:right;">${fmtUSD(r.cost, 4)}</td>
    <td style="text-align:right;">${fmtQty(r.qty)}</td>
    <td style="text-align:center;">${r.dc}</td>
    <td>${r.leadTime}</td>
    <td>${r.packaging}</td>
    <td style="text-align:right;">${fmtUSD(r.cost * r.qty)}</td>
    <td style="text-align:right;background:#90ee90;font-weight:bold;">${fmtPct(r.margin)}</td>
    <td style="text-align:right;">${fmtUSD(r.gp)}</td>
    <td style="text-align:center;">${r.vqId}</td>
    <td style="text-align:center;"><b>${r.rRequest}</b></td>
  </tr>
`).join('');

const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222;">

<h2 style="margin:0 0 8px 0;">RFQ ${RFQ} — Set Up for Purchasing (3 R_Requests posted)</h2>

<p>VQs ticked (IsPurchased='Y') and approve-order R_Requests posted to your queue. All routed to <b>Jake Harris (1000004)</b> with Status = <b>Submitted</b>, ship-to <b>BROWNSVILLE (W111 LAM Kitting)</b>, shipper FedEx Ground, EXW, DatePromised <b>2026-05-09</b> (10 days out per modal LAM Kitting STOCK pattern).</p>

<table cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:12px;">
  <thead style="background:#d9e1f2;">
    <tr>
      <th>Line</th><th>MPN</th><th>Vendor</th>
      <th>Cost</th><th>Qty</th><th>DC</th><th>Lead Time</th><th>Packaging</th>
      <th>Buy $</th><th>Margin</th><th>GP</th>
      <th>VQ ID</th><th>R_Request</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot style="background:#f0f0f0;font-weight:bold;">
    <tr>
      <td colspan="8" style="text-align:right;">Total:</td>
      <td style="text-align:right;">${fmtUSD(totalCost)}</td>
      <td></td>
      <td style="text-align:right;">${fmtUSD(totalGp)}</td>
      <td colspan="2"></td>
    </tr>
  </tfoot>
</table>

<h3 style="margin-top:24px;">What I changed on each VQ before ticking</h3>
<ul style="font-size:13px;">
  <li><b>Qty</b> → LAM MOQ (was already correct from the VQ load)</li>
  <li><b>Chuboe_Warehouse_ID</b> → 1000015 (W111 LAM KITTING)</li>
  <li><b>Chuboe_Warehouse_Group_ID</b> → 1000008 (BROWNSVILLE)</li>
  <li><b>M_Shipper_ID</b> → 1000003 (FedEx Ground)</li>
  <li><b>Chuboe_Inco_Term_ID</b> → 1000000 (EXW)</li>
  <li><b>Chuboe_Lead_Time</b> → STOCK (DQ: STOCK - 1 WEEK, since DQ quoted "3-5 days")</li>
  <li><b>DatePromised</b> → 2026-05-09 (today + 10 days)</li>
  <li><b>Chuboe_Packaging_ID</b> → F-REEL (LTM8074, MAX16029) / OTHER (AD9467BCPZ-250) — per historical LAM Kitting tick on each MPN</li>
  <li><b>IsChuboeDomesticShipping</b> → 'N' (HK suppliers, US ship-to = international)</li>
</ul>

<p style="font-size:13px;">Validator passed clean on all three before ticking. No competing VQs were ticked previously, so nothing was unticked.</p>

<h3 style="margin-top:24px;">Approval text format</h3>
<p style="font-size:13px;">Used the short-line shorthand fallback per <code>shared/r-requests.md</code> — same pattern as the LAM Kitting franchise auto-purchase flow (since you didn't paste OT Copy Text and this is a broker-batch tick, the shorthand is the established alternative).</p>

<pre style="background:#f8f8f8;padding:12px;font-size:11px;border-left:3px solid #d9e1f2;">Line 60  LTM8074EY#PBF  80pcs @ $5.8800  DC 24+  Analog Devices
Vendor: Hong Kong Duan Que Electronics Co., Limited
Ship-To: BROWNSVILLE (W111 LAM Kitting) · Shipper: FedEx Ground · Inco Term: EXW · Packaging: F-REEL · Lead Time: STOCK - 1 WEEK · Promise: 2026-05-09</pre>

<p style="font-size:13px;">If you want the full OT Copy Text block instead (manager pattern-match), paste the OT Copy Text in chat and I'll close these and re-post with the full block. <code>Chuboe_Approval_Text</code> is non-updateable post-POST, so it's a recreate, not a patch.</p>

<h3 style="margin-top:24px;">Watchouts (carried over from earlier email)</h3>
<ul style="font-size:13px;">
  <li><b>Line 70 Smartel quoted MAX16029TG+T</b> — T&R reel variant of canonical MAX16029TG+. Same product, reel packaging. Confirmed in the approval text + Result.</li>
  <li><b>Line 130 AD9467BCPZ-250</b> — historical PPP $78.50 (Lituoxin, 2024-06-21). XJH today is +45% over historical but margin still 56.8%. Not blocking — proceeding with the buy as-is.</li>
  <li><b>Line 120 LMZ14202TZ-ADJ/NOPB excluded</b> — only DC 24+ option was the LMZ14202TZX alt (different module variant, not just packaging). Canonical TZ has no DC 24+ in the batch (Keming/Delsheng/Guiyu/NES all DC 23+, margins 11-16% YELLOW). Held for AVL review or DC tradeoff decision.</li>
</ul>

<h3 style="margin-top:24px;">Files</h3>
<ul style="font-size:12px;">
  <li><code>sessions/lam-tick-and-approve-1133067.js</code> — the executor</li>
  <li><code>sessions/2026-04-29-tick-approve-1133067.json</code> — tracker (VQ → R_Request map)</li>
</ul>

<p style="font-size:11px;color:#888;margin-top:30px;">RFQ ${RFQ} (Lam Research) · 3 lines · ${fmtUSD(totalCost)} buy · ${fmtUSD(totalGp)} GP at LAM MOQ resale</p>

</body></html>`;

(async () => {
  const notifier = createNotifier({ fromEmail: 'excess@orangetsunami.com', fromName: 'LAM Kitting Reorder' });
  const ok = await notifier.sendEmail(
    'jake.harris@astutegroup.com',
    `LAM Kitting RFQ ${RFQ} — 3 R_Requests posted (DQ + Smartel + XJH, ${fmtUSD(totalCost)} buy, ${fmtUSD(totalGp)} GP)`,
    html,
    { html: true }
  );
  console.log(ok ? 'Confirmation email sent.' : 'Email failed.');
})();
