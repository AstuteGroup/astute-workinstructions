// Confirmation email after direct API write of all 75 VQs.
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('/home/analytics_user/workspace/astute-workinstructions/shared/notifier');

const html = `
<p>Correction on the prior email — VQs are now written <strong>directly into OT via API</strong>, no CSV upload step needed.</p>

<h3>RFQ 1132932 — Mercury Systems</h3>
<ul>
  <li><strong>73 VQ rows</strong> live in OT, attached to 15 RFQ lines (Tier 1, IsPurchased=N — for you to tick the winner via the gate)</li>
  <li>Buyer field set to Elaine Liang</li>
  <li>3 quotes skipped — vendors are tagged Suspended (vtype 1000004) in OT:
    <ul>
      <li>Wafer Electronic Technology (Line 130 DH82029PCH SLKM8 @ $66, Malaysia)</li>
      <li>Onway HK Technology (Line 90 W25Q32JVSSIQ @ $0.52, Taiwan, 2k/reel)</li>
      <li>Saviliter Technology (Line 210 XCF02SVOG20C @ $14.80, China)</li>
    </ul>
  </li>
  <li>3 source-side duplicates were deduped by natural-key (rfq_line + MPN + vendor + cost) — fixchip and the smoke-test row</li>
  <li>0 flagged, 0 failed</li>
</ul>

<h3>Per-line VQ counts in OT</h3>
<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:12px">
  <tr style="background:#f0f0f0"><th>Line</th><th>Canonical MPN</th><th>Quotes</th></tr>
  <tr><td>10</td><td>S29GL032N90BFI030 (incl. -032/-033 variants)</td><td>4</td></tr>
  <tr><td>40</td><td>85411AMILF</td><td>7</td></tr>
  <tr><td>50</td><td>PI6C49X0201WIE (83021AMILFT/F)</td><td>5</td></tr>
  <tr><td>70</td><td>2304NZGI-1LF / -1LFT</td><td>5</td></tr>
  <tr><td>80</td><td>841N254BKILF</td><td>3</td></tr>
  <tr><td>90</td><td>W25Q32FVSSIG / J / B</td><td>11</td></tr>
  <tr><td>100</td><td>MT41K256M8DA-125 AIT:K</td><td>4</td></tr>
  <tr><td>130</td><td>DH82029PCH S LKM8</td><td>5</td></tr>
  <tr><td>140</td><td>MT40A2G8NRE-083E:B</td><td>7</td></tr>
  <tr><td>150</td><td>PC28F00AP30EFA</td><td>3</td></tr>
  <tr><td>180</td><td>N25Q032A13EF640F / E</td><td>6</td></tr>
  <tr><td>190</td><td>N25Q032A11EF440F</td><td>5</td></tr>
  <tr><td>210</td><td>XCF02SVOG20C</td><td>3</td></tr>
  <tr><td>220</td><td>XC3S50A-4FT256I</td><td>2</td></tr>
  <tr><td>240</td><td>XC2C512-7FT256I</td><td>3</td></tr>
</table>

<p><em>9 RFQ lines (20, 30, 60, 110, 120, 160, 170, 200, 230, 250) have no APAC quotes from this email — Elaine sourced 15 of 25 lines.</em></p>

<h3>Things flagged for your eye</h3>
<ul>
  <li><strong>Line 90</strong> — valley quoted W25Q32JVSSIQ at $0.683 inside the W25Q32FVSSIG group (Elaine source-side mislabel). Both rows written.</li>
  <li><strong>Line 10</strong> — corerine S29GL032N90BFI033 at $23 is ~5× the -BFI032 quotes ($3.82–$5.48). Verifier confirmed extraction; could be variant pricing or broker typo.</li>
  <li><strong>Line 140</strong> — pgc only quoted 400 of 30,000 needed (twice, $37.50 and $66.17). Partial coverage — full 30k available from howeher/corerine at multi-tier pricing.</li>
</ul>

<p>— Claude</p>
`;

const notifier = createNotifier({
  fromEmail: 'stockRFQ@orangetsunami.com',
  fromName: 'Stock RFQ',
});

(async () => {
  await notifier.sendEmail(
    'jake.harris@astutegroup.com',
    'VQ Loading: RFQ 1132932 (Mercury) — 73 VQs LIVE in OT (direct API write, no CSV)',
    html,
    { html: true }
  );
  console.log('Confirmation sent.');
})().catch((e) => { console.error(e); process.exit(1); });
