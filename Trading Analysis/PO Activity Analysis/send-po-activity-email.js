// Send the January 2026 PO analysis to Jake.
const path = require('path');
const { createNotifier } = require(path.resolve('/home/analytics_user/workspace/astute-workinstructions/shared/notifier'));

const TO = 'jake.harris@Astutegroup.com';
const ATTACH = '/home/analytics_user/workspace/January_2026_POs_Analysis.xlsx';

const notifier = createNotifier({
  fromEmail: 'stockRFQ@orangetsunami.com',
  fromName: 'Astute Analytics',
});

const subject = 'January 2026 PO Activity — Comprehensive Analysis (updated cycle benchmarks)';

const html = `
<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222">
<p>Hi Jake,</p>

<p>Attached is the comprehensive analysis of January 2026 PO activity (POVs generated Jan&nbsp;1 – Jan&nbsp;31), parts only — service / testing / fee / freight lines (30 of them) are excluded so the metrics aren't muddied by non-goods POs.</p>

<h3 style="margin-bottom:4px">Headline numbers</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;border:1px solid #ccc;font-size:10.5pt">
  <tr style="background:#f4f4f4"><th align="left">Metric</th><th align="right">Value</th></tr>
  <tr><td>Distinct POVs</td><td align="right">413</td></tr>
  <tr><td>PO lines (parts only)</td><td align="right">541</td></tr>
  <tr><td>Distinct buyers / suppliers / customers</td><td align="right">28 / 189 / 83</td></tr>
  <tr><td>Total PO spend (cost)</td><td align="right">$7,140,209</td></tr>
  <tr><td>Total attributed SO revenue</td><td align="right">$18,725,067</td></tr>
  <tr><td>Booked GP</td><td align="right">$11,584,858</td></tr>
  <tr><td>Booked margin</td><td align="right">61.9%</td></tr>
  <tr><td>Open PO exposure (NOT_RECEIVED)</td><td align="right">$333,049</td></tr>
  <tr><td>Open SO revenue at risk</td><td align="right">$1,281,460</td></tr>
</table>

<h3 style="margin-bottom:4px">OTIN lifecycle</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;border:1px solid #ccc;font-size:10.5pt">
  <tr style="background:#f4f4f4"><th align="left">Status</th><th align="right">Lines</th><th align="right">%</th></tr>
  <tr><td>VALIDATED (inspection complete)</td><td align="right">395</td><td align="right">73.0%</td></tr>
  <tr><td>NOT_RECEIVED (vendor delay)</td><td align="right">132</td><td align="right">24.4%</td></tr>
  <tr><td>RECEIVED_NO_LOT (awaiting OTIN lot)</td><td align="right">8</td><td align="right">1.5%</td></tr>
  <tr><td>LOT_OPEN (in inspection queue)</td><td align="right">6</td><td align="right">1.1%</td></tr>
</table>
<p style="margin-top:4px"><em>Of the 146 lines not yet validated, 132 (90%) are stuck on the vendor side — only 14 are internal-inspection backlog.</em></p>

<h3 style="margin-bottom:4px">Delivery performance</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;border:1px solid #ccc;font-size:10.5pt">
  <tr style="background:#f4f4f4"><th align="left">Status</th><th align="right">Lines</th></tr>
  <tr><td>Received</td><td align="right">409</td></tr>
  <tr><td><strong>Past-due (open + promise &lt; today)</strong></td><td align="right"><strong>123</strong></td></tr>
  <tr><td>Due within 7 days</td><td align="right">1</td></tr>
  <tr><td>Future-promise</td><td align="right">8</td></tr>
  <tr><td>Worst days late / Median days late</td><td align="right">131 / 117</td></tr>
</table>

<h3 style="margin-bottom:4px">Cycle benchmarks (validated parts lines only, n=395)</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;border:1px solid #ccc;font-size:10.5pt">
  <tr style="background:#f4f4f4"><th align="left">Stage</th><th align="right">Median</th><th align="right">P75</th><th align="right">P90</th><th align="right">Max</th></tr>
  <tr><td>1. PO placed → first receipt <em>(vendor + transit)</em></td><td align="right">11&nbsp;d</td><td align="right">35&nbsp;d</td><td align="right">59&nbsp;d</td><td align="right">114&nbsp;d</td></tr>
  <tr><td>2. Receipt → inspection opened <em>(warehouse staging)</em></td><td align="right">0&nbsp;d</td><td align="right">0&nbsp;d</td><td align="right">0&nbsp;d</td><td align="right">85&nbsp;d</td></tr>
  <tr><td>3. Inspection opened → validated <em>(inspection work + queue)</em></td><td align="right">5&nbsp;d</td><td align="right">17&nbsp;d</td><td align="right">38&nbsp;d</td><td align="right">102&nbsp;d</td></tr>
  <tr style="background:#f9f9f9"><td><strong>Total: PO placed → validated</strong></td><td align="right"><strong>32&nbsp;d</strong></td><td align="right"><strong>53&nbsp;d</strong></td><td align="right"><strong>81&nbsp;d</strong></td><td align="right"><strong>124&nbsp;d</strong></td></tr>
</table>
<p style="margin-top:4px"><em>Stage 1 (vendor) is the long pole — P90 of 59 days is where most variance lives.<br>
Stage 2 (warehouse staging) is essentially instant — receipts route to the inspection bench same-day for 90%+ of lots.<br>
Stage 3 (inspection) has a 5-day median but a long P90 tail (38 days) — queue contention or hard-to-validate parts.</em></p>

<h3 style="margin-bottom:4px">Workbook tabs</h3>
<ol style="margin-top:0">
  <li><b>Summary</b> — the above metrics</li>
  <li><b>Open Past-Due</b> — 132 NOT_RECEIVED lines sorted by days-late (ready for buyer follow-up)</li>
  <li><b>Buyer Status Matrix</b> — OTIN status counts per buyer</li>
  <li><b>By Buyer</b> — 28 buyers w/ spend, validation %, past-due %, avg days late</li>
  <li><b>By Supplier</b> — 189 suppliers, on-time and validation rates</li>
  <li><b>By Customer</b> — 83 customers w/ GP$, open exposure, revenue at risk</li>
  <li><b>Cycle Times</b> — per-line PO→Recv and Recv→Valid days</li>
  <li><b>All Lines</b> — full dataset (541 rows × 37 columns)</li>
</ol>

<h3 style="margin-bottom:4px">Caveats worth knowing</h3>
<ul style="margin-top:0">
  <li><b>SO revenue is attributed as</b> <code>po_qty &times; weighted-avg SO unit price</code> on the same RFQ line. Replaces a buggy first pass that gave each Jan PO full credit when multiple POs fed the same customer order (was inflating to $89M). Still slightly over-attributes when a customer order is fulfilled by non-January POs — exact attribution would require shipment-level matching from m_inout to specific sales orderlines.</li>
  <li><b>62% booked margin</b> reflects parts/RFQ-type mix; happy to split GP by Stock / Shortage / PPV if useful.</li>
  <li><b>0-qty PO lines</b> exist (a handful of buyer data-hygiene issues where qty was left blank at PO time).</li>
  <li><b>~11 lines</b> have insp_validated='Y' but no m_inout receipt linked — minor data anomaly, doesn't shift counts.</li>
  <li><b>Tracking</b> is populated on 48% of lines in <code>c_orderline.chuboe_trackingnumbers</code>; field is free-text, so a few entries are notes rather than real tracking numbers.</li>
</ul>

<p>Reply with anything you'd want pivoted, sliced, or extended (e.g., GP by rfq_type, supplier scorecard, past-due ageing buckets).</p>

<p>— Astute Analytics</p>
</body></html>
`.trim();

(async () => {
  const ok = await notifier.sendWithAttachment(
    TO,
    subject,
    html,
    [{ filename: 'January_2026_POs_Analysis.xlsx', path: ATTACH }],
    { html: true, replyTo: 'jake.harris@Astutegroup.com' }
  );
  console.log(ok ? 'SENT' : 'FAILED');
  process.exit(ok ? 0 : 1);
})();
