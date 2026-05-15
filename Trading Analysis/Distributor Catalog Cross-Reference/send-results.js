#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(process.env.HOME, 'workspace/.env') });
const fs = require('fs');
const path = require('path');
const { createNotifier } = require(path.resolve(process.env.HOME, 'workspace/astute-workinstructions/shared/notifier'));

const ROOT = path.resolve(process.env.HOME, 'workspace/htc-korea-xref');
const TO = 'jake.harris@astutegroup.com';

(async () => {
  const notifier = createNotifier({
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Stock RFQ',
    smtpUser: 'stockRFQ@orangetsunami.com',
    smtpPass: process.env.WORKMAIL_PASS,
  });

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px;max-width:780px">
<h2>HTC Korea — Drop-In Replacement Cross-Reference (12mo RFQ history)</h2>

<p>Source: <i>FW: New Tier 3 Franchise: Introduction to HTC Korea</i> — blocked from market-offer loading (moved to <code>NotOffer</code>).</p>

<p>HTC's catalogs across 8 mainstream MFRs were normalized into 3,403 replacement entries (2,652 distinct mainstream MPNs), then matched against the last 12 months of RFQ activity.</p>

<h3>Headline opportunity by replaced brand</h3>
<table style="border-collapse:collapse;font-size:12px">
  <tr style="background:#f0f0f0"><th style="padding:4px 10px;text-align:left">Brand HTC replaces</th><th style="padding:4px 10px;text-align:right">Hit lines</th><th style="padding:4px 10px;text-align:right">RFQs</th><th style="padding:4px 10px;text-align:right">Customers</th><th style="padding:4px 10px;text-align:right">Distinct MPNs</th></tr>
  <tr><td style="padding:3px 10px">Texas Instruments</td><td style="padding:3px 10px;text-align:right">2,178</td><td style="padding:3px 10px;text-align:right">255</td><td style="padding:3px 10px;text-align:right">68</td><td style="padding:3px 10px;text-align:right">386</td></tr>
  <tr><td style="padding:3px 10px">ON Semiconductor</td><td style="padding:3px 10px;text-align:right">1,728</td><td style="padding:3px 10px;text-align:right">119</td><td style="padding:3px 10px;text-align:right">49</td><td style="padding:3px 10px;text-align:right">175</td></tr>
  <tr><td style="padding:3px 10px">STMicroelectronics</td><td style="padding:3px 10px;text-align:right">659</td><td style="padding:3px 10px;text-align:right">119</td><td style="padding:3px 10px;text-align:right">43</td><td style="padding:3px 10px;text-align:right">138</td></tr>
  <tr><td style="padding:3px 10px">Microchip</td><td style="padding:3px 10px;text-align:right">91</td><td style="padding:3px 10px;text-align:right">30</td><td style="padding:3px 10px;text-align:right">15</td><td style="padding:3px 10px;text-align:right">41</td></tr>
  <tr><td style="padding:3px 10px">Analog Devices</td><td style="padding:3px 10px;text-align:right">75</td><td style="padding:3px 10px;text-align:right">23</td><td style="padding:3px 10px;text-align:right">13</td><td style="padding:3px 10px;text-align:right">24</td></tr>
  <tr><td style="padding:3px 10px">Nexperia</td><td style="padding:3px 10px;text-align:right">63</td><td style="padding:3px 10px;text-align:right">31</td><td style="padding:3px 10px;text-align:right">19</td><td style="padding:3px 10px;text-align:right">11</td></tr>
  <tr><td style="padding:3px 10px">NXP</td><td style="padding:3px 10px;text-align:right">52</td><td style="padding:3px 10px;text-align:right">20</td><td style="padding:3px 10px;text-align:right">14</td><td style="padding:3px 10px;text-align:right">9</td></tr>
</table>

<h3>Johnson Controls subset</h3>
<p><b>508 line-hits across 103 distinct MPNs from just 4 RFQs</b> — all Justin Goodwin (3× 3PL/VMI in Apr, 1× PPV in Apr). Concentrated on commodity analog/logic: LM317T (75 hits), LM339N (39), ULN2003AD (25), LM324N (24), MC34063ADR (12). HTC's catalog has near-complete coverage of JCI's jellybean shelf.</p>

<h3>Attachments</h3>
<ul>
  <li><b>HTC_RFQ_Cross_Reference_12mo.xlsx</b> — full deck (Summary / By Competitor Brand / By HTC Brand / By MPN / Customer × Seller × Type / Detail; 4,846 detail rows)</li>
  <li><b>HTC_RFQ_Cross_Reference_12mo_JCI.xlsx</b> — Johnson Controls only (same shape, 508 detail rows)</li>
</ul>

<p style="color:#666;font-size:11px">Same structure as ATGBICS_RFQ_Cross_Reference_12mo.xlsx shipped 5/13. Source files + catalog CSV remain in <code>~/workspace/htc-korea-xref/</code>.</p>
</body></html>`;

  const attachments = [
    {
      filename: 'HTC_RFQ_Cross_Reference_12mo.xlsx',
      path: path.join(ROOT, 'HTC_RFQ_Cross_Reference_12mo.xlsx'),
    },
    {
      filename: 'HTC_RFQ_Cross_Reference_12mo_JCI.xlsx',
      path: path.join(ROOT, 'HTC_RFQ_Cross_Reference_12mo_JCI.xlsx'),
    },
  ];

  const ok = await notifier.sendWithAttachment(
    TO,
    'HTC Korea drop-in replacement xref — 12mo RFQ history (with JCI split)',
    html,
    attachments,
    { html: true },
  );

  console.log(ok ? `Sent to ${TO}` : 'FAILED to send');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
