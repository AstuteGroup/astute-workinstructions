#!/usr/bin/env node
/**
 * CLI wrapper for shared/load-bulk-summary.js
 *
 * Loads a batch of broker/APAC quotes (Type 2 bulk-summary email) into OT
 * via the iDempiere REST API. Caller (you, in a Claude session) extracts the
 * quotes from the email body into a JSON file, then this script writes them.
 *
 * USAGE:
 *   node load-bulk-summary-cli.js <quotes.json> --rfq <searchKey> --buyer <userId> --dry-run
 *   node load-bulk-summary-cli.js <quotes.json> --rfq <searchKey> --buyer <userId> --commit
 *
 *   Either --dry-run OR --commit is required. There is no default.
 *
 * QUOTES JSON FORMAT (array of objects):
 *   [
 *     {
 *       "vendorName": "Howeher Co.，Limited",  // OR vendorSearchKey
 *       "mpn": "DH82029PCH S LKM8",            // must match an accepted RFQ MPN (incl. AVL alts)
 *       "mfr": "Intel",
 *       "qty": 330,
 *       "cost": 62.21,
 *       "leadTime": "3-4 days",                 // optional; 'stock' if blank
 *       "dateCode": "18+",                       // optional
 *       "coo": "Malaysia",                       // optional; PENDING if unknown
 *       "packaging": "REEL",                     // optional
 *       "rohs": null,                            // 'Y' / 'N' / null
 *       "vendorNotes": "reconfirm COO after PO", // free text → Chuboe_Note_User
 *       "vendorQuotedMpn": null                  // populates "Quoted MPN: X" if differs from mpn
 *     }
 *   ]
 *
 * OUTPUT:
 *   - Console summary: written / skipped / failed counts + per-line coverage + gaps
 *   - On --commit: tracker JSON saved to sessions/YYYY-MM-DDTHH-MM-SS-bulk-load.json
 *   - Exit 0 on clean success; exit 1 if any quotes failed
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { loadBulkSummary } = require('/home/analytics_user/workspace/astute-workinstructions/shared/load-bulk-summary');

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--commit') args.commit = true;
    else if (a === '--rfq') args.rfq = argv[++i];
    else if (a === '--buyer') args.buyer = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else args.positional.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  load-bulk-summary-cli.js <quotes.json> --rfq <searchKey> --buyer <userId> (--dry-run | --commit)

Options:
  --rfq <searchKey>    RFQ search key (e.g. 1132932)
  --buyer <userId>     AD_User_ID of the sourcing person (e.g. Elaine Liang = 1006326)
  --dry-run            Resolve, match, and report — but DO NOT write VQs
  --commit             Write VQs via the iDempiere REST API (live)

See header comment for quotes JSON format.
`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.positional.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const jsonPath = args.positional[0];
  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }
  if (!args.rfq) {
    console.error('--rfq required');
    process.exit(1);
  }
  if (!args.buyer || Number.isNaN(args.buyer)) {
    console.error('--buyer required (numeric AD_User_ID)');
    process.exit(1);
  }
  if (!args.dryRun && !args.commit) {
    console.error('Either --dry-run or --commit is required (no default)');
    process.exit(1);
  }
  if (args.dryRun && args.commit) {
    console.error('--dry-run and --commit are mutually exclusive');
    process.exit(1);
  }

  let quotes;
  try {
    quotes = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(quotes)) {
    console.error('Quotes JSON must be an array');
    process.exit(1);
  }

  console.log(`\n=== Bulk Summary Load ===`);
  console.log(`RFQ:     ${args.rfq}`);
  console.log(`Buyer:   ${args.buyer}`);
  console.log(`Quotes:  ${quotes.length}`);
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN' : 'COMMIT (live API write)'}`);
  console.log('');

  const result = await loadBulkSummary({
    rfqSearchKey: args.rfq,
    buyerId: args.buyer,
    quotes,
    dryRun: !!args.dryRun,
  });

  // ─── Report ────────────────────────────────────────────────────────────
  console.log(`\n=== Result ===`);
  console.log(`Written:  ${result.written.length}${args.dryRun ? ' (simulated)' : ''}`);
  console.log(`Skipped:  ${result.skipped.length}`);
  console.log(`Failed:   ${result.failed.length}`);

  if (result.written.length > 0) {
    console.log(`\nWritten:`);
    for (const w of result.written) {
      const flag = w.fuzzyMatch ? ' [fuzzy]' : '';
      const id = w.vqLineId ? `vq ${w.vqLineId}` : '(sim)';
      console.log(`  line ${String(w.line).padStart(3)} | ${w.mpn.padEnd(28)} | ${w.vendor.substring(0, 30).padEnd(30)} | $${String(w.cost).padStart(10)} × ${String(w.qty).padStart(8)}  ${id}${flag}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`\nSkipped:`);
    for (const s of result.skipped) {
      console.log(`  ${s.reason.padEnd(20)} ${(s.mpn || '').substring(0, 28).padEnd(28)} ${(s.vendorName || '').substring(0, 30).padEnd(30)}  ${s.detail || ''}`);
    }
  }

  if (result.failed.length > 0) {
    console.log(`\nFailed:`);
    for (const f of result.failed) {
      console.log(`  ${f.reason}: ${f.mpn} (${f.vendorName}) — ${f.detail || f.error}`);
    }
  }

  console.log(`\nLine coverage (this batch):`);
  for (const c of result.coverage) {
    const marker = c.vqsThisBatch > 0 ? '✓' : ' ';
    console.log(`  ${marker} line ${String(c.lineNo).padStart(3)} | qty ${String(c.rfqQty).padStart(7)} | ${c.vqsThisBatch} VQs | accepts: ${c.mpns.join(', ')}`);
  }

  console.log(`\nGaps (no VQ this batch): ${result.gaps.length === 0 ? 'none' : result.gaps.join(', ')}`);

  // ─── Tracker (commit only) ─────────────────────────────────────────────
  if (args.commit && result.written.length > 0) {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
    const trackerPath = path.join(sessionsDir, `${ts}-bulk-load-${args.rfq}.json`);
    fs.writeFileSync(trackerPath, JSON.stringify({
      rfqSearchKey: args.rfq,
      buyerId: args.buyer,
      runAt: new Date().toISOString(),
      sourceQuotes: jsonPath,
      result,
    }, null, 2));
    console.log(`\nTracker: ${trackerPath}`);
  }

  process.exit(result.failed.length > 0 ? 1 : 0);
})().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(2);
});
