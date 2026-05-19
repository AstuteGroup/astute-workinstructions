#!/usr/bin/env node
/**
 * CLI wrapper for mappers/heilind.js — processes one Heilind BOM-tool export
 * file and writes VQs + negative-cache entries.
 *
 * Usage:
 *   node process-heilind-export.js --export <file.xlsx> --sidecar <file.meta.json> [--dry-run]
 *
 * Auto-pair: if --sidecar omitted, looks for the most recent meta.json in
 * ~/workspace/outbox/heilind/ that pairs to the export's timestamp (the
 * outbox sidecar carries the original request context).
 *
 * Always prints a summary at the end. Exit code is 0 on success, 1 on error.
 */

const fs = require('fs');
const path = require('path');

const ROOT = '/home/analytics_user/workspace/astute-workinstructions';
const { processExport, autoPairSidecar } = require(path.join(ROOT, 'Trading Analysis/Distributor Scrape Loading/mappers/heilind'));
const { createNotifier } = require(path.join(ROOT, 'shared/notifier'));

const OPERATOR_EMAIL = process.env.HEILIND_NOTIFY_TO || 'jake.harris@astutegroup.com';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--export') args.exportPath = argv[++i];
    else if (a === '--sidecar') args.sidecarPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node ${path.basename(argv[1])} --export <file.xlsx> [--sidecar <file.meta.json>] [--dry-run]`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.exportPath) {
    console.error('Missing --export <file.xlsx>');
    process.exit(1);
  }
  if (!fs.existsSync(args.exportPath)) {
    console.error(`Export file not found: ${args.exportPath}`);
    process.exit(1);
  }
  if (!args.sidecarPath) {
    args.sidecarPath = autoPairSidecar(args.exportPath);
    if (!args.sidecarPath) {
      console.error('Could not auto-pair sidecar. Pass --sidecar explicitly.');
      process.exit(1);
    }
    console.log(`Auto-paired sidecar: ${args.sidecarPath}`);
  }

  console.log(`Mode: ${args.dryRun ? 'DRY-RUN (no writes)' : 'LIVE (writes VQs + cache)'}`);
  console.log(`Export:  ${args.exportPath}`);
  console.log(`Sidecar: ${args.sidecarPath}`);
  console.log('');

  const result = await processExport(args);

  console.log('=== Classification ===');
  console.log(`  Total rows:        ${result.rows}`);
  console.log(`  Priced:            ${result.priced}`);
  console.log(`  Matched-no-price:  ${result.matched_no_price}`);
  console.log(`  Not-carried:       ${result.not_carried}`);
  console.log(`  Orphans (no sidecar match): ${result.orphans}`);
  console.log('');
  console.log('=== VQ writes ===');
  console.log(`  RFQs affected: ${result.rfqsAffected}`);
  let totalWritten = 0, totalFlagged = 0, totalFailed = 0;
  for (const r of result.writeResults) {
    if (r.dryRun) {
      console.log(`  RFQ ${r.rfqSearchKey}: ${r.lines} envelope(s) [DRY-RUN]`);
    } else if (r.error) {
      console.log(`  RFQ ${r.rfqSearchKey}: ERROR — ${r.error}`);
    } else {
      const w = (r.written || []).length;
      const f = (r.flagged || []).length;
      const x = (r.failed  || []).length;
      totalWritten += w; totalFlagged += f; totalFailed += x;
      console.log(`  RFQ ${r.rfqSearchKey}: ${w} written, ${f} flagged, ${x} failed (from ${r.lines} envelopes)`);
    }
  }
  if (!result.dryRun) {
    console.log(`  TOTAL: ${totalWritten} written / ${totalFlagged} flagged / ${totalFailed} failed`);
  }
  console.log('');
  console.log('=== Cache writes ===');
  console.log(`  carried:           ${result.cacheResults.carried}`);
  console.log(`  matched_no_price:  ${result.cacheResults.matched_no_price}`);
  console.log(`  not_carried:       ${result.cacheResults.not_carried}`);
  console.log(`  skipped:           ${result.cacheResults.skipped}`);

  // -- Email summary --------------------------------------------------------
  // Skip in dry-run; the operator already sees the console output.
  if (args.dryRun) {
    console.log('\n[dry-run: not sending email]');
    return;
  }

  const totalWrittenForEmail = result.writeResults.reduce(
    (s, r) => s + (r.written?.length || 0), 0);
  const totalFlaggedForEmail = result.writeResults.reduce(
    (s, r) => s + (r.flagged?.length || 0), 0);
  const totalErroredForEmail = result.writeResults.filter(r => r.error).length;

  const subject = `[Heilind] ${totalWrittenForEmail} VQs loaded across ${result.rfqsAffected} RFQs (${result.priced}/${result.rows} priced)`;
  const lines = [];
  lines.push(`<h2>Heilind BOM tool results — ${new Date().toISOString().slice(0, 10)}</h2>`);
  lines.push(`<p><b>Export file:</b> ${args.exportPath}<br>`);
  lines.push(`<b>Sidecar:</b> ${args.sidecarPath}</p>`);
  lines.push(`<h3>Classification (${result.rows} rows from Heilind)</h3>`);
  lines.push(`<table border="1" cellpadding="5" style="border-collapse:collapse">`);
  lines.push(`<tr><th>Bucket</th><th>Count</th><th>Note</th></tr>`);
  lines.push(`<tr><td>Priced</td><td>${result.priced}</td><td>DAC PN + Price1 &gt; 0 → VQ written</td></tr>`);
  lines.push(`<tr><td>Matched-no-price</td><td>${result.matched_no_price}</td><td>DAC PN + Price1 = 0 → cache only</td></tr>`);
  lines.push(`<tr><td>Not-carried</td><td>${result.not_carried}</td><td>no DAC PN → cache only</td></tr>`);
  lines.push(`<tr><td>Orphans</td><td>${result.orphans}</td><td>MPN not in sidecar (data quality)</td></tr>`);
  lines.push(`</table>`);

  lines.push(`<h3>VQ writes (${totalWrittenForEmail} written / ${totalFlaggedForEmail} flagged / ${totalErroredForEmail} errored)</h3>`);
  lines.push(`<table border="1" cellpadding="5" style="border-collapse:collapse">`);
  lines.push(`<tr><th>RFQ</th><th>Written</th><th>Flagged</th><th>Status</th></tr>`);
  for (const r of result.writeResults) {
    const w = r.written?.length || 0;
    const f = r.flagged?.length || 0;
    const status = r.error ? `ERROR: ${r.error}` : (f > 0 ? 'needs review' : 'ok');
    lines.push(`<tr><td>${r.rfqSearchKey}</td><td>${w}</td><td>${f}</td><td>${status}</td></tr>`);
  }
  lines.push(`</table>`);

  lines.push(`<h3>Cache writes</h3>`);
  lines.push(`<table border="1" cellpadding="5" style="border-collapse:collapse">`);
  lines.push(`<tr><th>State</th><th>Count</th><th>TTL</th></tr>`);
  lines.push(`<tr><td>carried (positive)</td><td>${result.cacheResults.carried}</td><td>7d</td></tr>`);
  lines.push(`<tr><td>matched_no_price</td><td>${result.cacheResults.matched_no_price}</td><td>60d (fixed)</td></tr>`);
  lines.push(`<tr><td>not_carried</td><td>${result.cacheResults.not_carried}</td><td>180d</td></tr>`);
  lines.push(`</table>`);
  lines.push(`<p style="color:#666;font-size:0.9em">Cache rows feed tomorrow's producer filter — MPNs scraped at qty ±25% won't re-burn budget.</p>`);

  const notifier = createNotifier({
    fromEmail: 'stockRFQ@orangetsunami.com',
    fromName: 'Heilind Loader',
  });
  const ok = await notifier.sendEmail(OPERATOR_EMAIL, subject, lines.join('\n'), { html: true });
  console.log(`\n[email ${ok ? 'sent' : 'FAILED'} to ${OPERATOR_EMAIL}]`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
