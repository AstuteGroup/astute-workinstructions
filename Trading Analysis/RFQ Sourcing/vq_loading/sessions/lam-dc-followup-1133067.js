// Follow-up: lines on RFQ 1133067 where best broker DC is older than 23+
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });
const { createNotifier } = require('../../../../shared/notifier');

const RFQ = '1133067';

const html = `
<p>Follow-up on the APAC broker sourcing for RFQ ${RFQ} — looked specifically at lines where the best broker quote has a date code <strong>older than 23+</strong>, plus 23+ borderline cases.</p>

<h3>Two lines have best &lt; 23+</h3>

<h4>Line 10 — SN74LVC125ARGYR (best is DC 20+)</h4>
<p>All 5 quotes are 20+ to 22+. <strong>No 23+ or newer option in this batch.</strong></p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
  <tr style="background:#D9E1F2"><th>Vendor</th><th>Cost</th><th>DC</th><th>COO</th><th>Margin</th><th>Note</th></tr>
  <tr><td>Delsheng (current best)</td><td>$0.1000</td><td>20+</td><td>Malaysia</td><td>59.0%</td><td>Cheapest, oldest</td></tr>
  <tr><td>NES Group</td><td>$0.1160</td><td>20+</td><td>?</td><td>52.4%</td><td></td></tr>
  <tr style="background:#D5F4E6"><td><strong>SKYEAST ⭐</strong></td><td><strong>$0.1300</strong></td><td><strong>22+</strong></td><td>Malaysia</td><td><strong>46.6%</strong></td><td><strong>Newest in batch</strong></td></tr>
  <tr><td>Smartel</td><td>$0.1500</td><td>21+</td><td>Malaysia</td><td>38.4%</td><td></td></tr>
  <tr><td>Firsttop</td><td>$0.1600</td><td>20+</td><td>?</td><td>34.3%</td><td></td></tr>
</table>
<p><strong>Recommendation:</strong> SKYEAST 22+ is two DC years newer than Delsheng for $0.03/pc more. Still 46.6% margin. At LAM reorder qty 25, total cost diff is ~$0.75.</p>

<h4>Line 80 — LTM4632EV#PBF (best is DC 21+)</h4>
<p>All 9 quotes are 21+ or 22+. <strong>No 23+ option in this batch.</strong> But there's a strict upgrade available:</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
  <tr style="background:#D9E1F2"><th>Vendor</th><th>Cost</th><th>DC</th><th>COO</th><th>Margin</th><th>Note</th></tr>
  <tr><td>SKYEAST (current best)</td><td>$8.5000</td><td>21+</td><td>Malaysia</td><td>42.0%</td><td></td></tr>
  <tr style="background:#D5F4E6"><td><strong>Fanco ⭐</strong></td><td><strong>$8.5000</strong></td><td><strong>22+</strong></td><td>?</td><td><strong>42.0%</strong></td><td><strong>Same price, newer DC — pure upgrade</strong></td></tr>
  <tr><td>NES Group</td><td>$8.7010</td><td>22+</td><td>?</td><td>40.6%</td><td>Fallback if Fanco can't disclose COO</td></tr>
  <tr><td>Firsttop</td><td>$8.9600</td><td>21+</td><td>?</td><td>38.8%</td><td></td></tr>
  <tr><td>ECI</td><td>$9.0850</td><td>21+</td><td>?</td><td>38.0%</td><td></td></tr>
  <tr><td>DQ (Hong Kong Duan Que)</td><td>$9.2500</td><td>22+</td><td>?</td><td>36.8%</td><td>3-5 day LT</td></tr>
  <tr><td>SKYEAST</td><td>$9.3000</td><td>22+</td><td>Malaysia</td><td>36.5%</td><td></td></tr>
  <tr><td>XJH (Xin Jun Hong)</td><td>$9.4100</td><td>22+</td><td>Malaysia</td><td>35.8%</td><td></td></tr>
</table>
<p><strong>Recommendation:</strong> <strong>Fanco</strong> — same price as the current SKYEAST best, same 42.0% margin, but 22+ instead of 21+. If COO certainty matters, NES Group at $8.70 22+ is a $0.20 premium with known sourcing channel.</p>

<h3>Borderline (best is exactly 23+) — newer alternatives exist but cost more</h3>

<p><strong>Line 110 — ADS8688IDBTR</strong> (best Firsttop 23+ $3.70, margin 76.3%):</p>
<ul>
  <li><strong>Delsheng 25+ at $5.55</strong> (margin 64.5%) — pay 50% more for two DC years newer; still healthy margin.</li>
  <li>Dragon 25+ at $5.56 — suspended, can't PO.</li>
</ul>

<p><strong>Line 150 — LT1491ACS#PBF</strong> (best Chip Energy 23+ alt #TRPBF, margin 21.6%):</p>
<ul>
  <li>No newer option in this batch. 23+ is the freshest. The 22+ canonical-MPN quotes are all RED.</li>
</ul>

<h3>Lines where best is already 23+ or newer (no DC concern)</h3>
<ul>
  <li>Line 60 LTM8074EY#PBF — best DQ <strong>24+</strong> ($5.88, 39.5%)</li>
  <li>Line 70 MAX16029TG+ — best Smartel <strong>24+</strong> ($6.40, 28.3%) [alt MPN MAX16029TG+T]</li>
  <li>Line 120 LMZ14202TZ-ADJ/NOPB — best Smartel <strong>25+</strong> ($6.80, 44.4%) [alt MPN LMZ14202TZX]</li>
  <li>Line 130 AD9467BCPZ-250 — best XJH <strong>25+</strong> ($113.95, 56.8%)</li>
</ul>

<p><em>Source: VQs already loaded against RFQ ${RFQ} — see prior email for the full xlsx with both tabs.</em></p>
`;

async function main() {
  const notifier = createNotifier({
    fromEmail: 'excess@orangetsunami.com',
    fromName: 'LAM Kitting Reorder',
  });
  const ok = await notifier.sendEmail(
    'jake.harris@astutegroup.com, josh.syre@astutegroup.com',
    `LAM Kitting Reorder — RFQ ${RFQ} — Newer-DC Alternatives on Lines 10, 80 (and borderline 110, 150)`,
    html,
    { html: true }
  );
  console.log(ok ? 'Email sent' : 'Email failed');
}

main().catch(err => { console.error(err); process.exit(1); });
