#!/usr/bin/env node
/**
 * Cross-Ref Review CLI — manually apply operator approvals/rejections to
 * the cross-ref staging queue.
 *
 * Three input modes:
 *
 *   # Parse a pasted email body (interactive)
 *   node crossref-review-cli.js --body "approve cross-ref: xref-...-0"
 *
 *   # Parse stdin (paste/echo a forwarded reply)
 *   pbpaste | node crossref-review-cli.js --stdin
 *
 *   # Approve specific IDs directly (no body parsing)
 *   node crossref-review-cli.js --approve xref-...-0 xref-...-1
 *   node crossref-review-cli.js --reject  xref-...-2
 *
 * Add --dry-run to preview without writing VQs or mutating the queue.
 * Add --approved-by "Jake Harris" to override the audit-trail name.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { parseReplyBody, executeDecisions, processReplyBody } = require('../../shared/workflow-actions/crossref-review');

function parseArgs(argv) {
  const args = { approve: [], reject: [], body: null, stdin: false, dryRun: false, approvedBy: 'Jake Harris (cli)' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--stdin') args.stdin = true;
    else if (a === '--body') args.body = argv[++i];
    else if (a === '--approved-by') args.approvedBy = argv[++i];
    else if (a === '--approve') {
      while (i + 1 < argv.length && argv[i + 1].startsWith('xref-')) args.approve.push(argv[++i]);
    }
    else if (a === '--reject') {
      while (i + 1 < argv.length && argv[i + 1].startsWith('xref-')) args.reject.push(argv[++i]);
    }
    else if (a === '--help' || a === '-h') {
      console.log(require('fs').readFileSync(__filename, 'utf8').slice(0, 1100));
      process.exit(0);
    }
  }
  return args;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c.toString(); });
    process.stdin.on('end', () => resolve(data));
  });
}

function fmtResult(r) {
  console.log(`\nApproved : ${r.approved.length}`);
  for (const a of r.approved) console.log(`  ${a.id}` + (a.vqId ? ` → VQ ${a.vqId}` : '') + (a.dryRun ? ' [dry-run]' : ''));
  console.log(`Rejected : ${r.rejected.length}`);
  for (const a of r.rejected) console.log(`  ${a.id}`);
  console.log(`Failed   : ${r.failed.length}`);
  for (const a of r.failed) console.log(`  ${a.id} — ${a.reason}`);
  console.log(`Not found: ${r.notFound.length}`);
  for (const a of r.notFound) console.log(`  ${a.id} — ${a.reason}`);
}

(async () => {
  const args = parseArgs(process.argv);

  let result;
  if (args.body) {
    console.log(`Parsing --body (${args.body.length} chars), dryRun=${args.dryRun}…`);
    result = await processReplyBody(args.body, { approvedBy: args.approvedBy, source: 'cli', dryRun: args.dryRun });
    console.log(`Decisions parsed: ${result.decisions.length}`);
  } else if (args.stdin) {
    const text = await readStdin();
    console.log(`Parsing stdin (${text.length} chars), dryRun=${args.dryRun}…`);
    result = await processReplyBody(text, { approvedBy: args.approvedBy, source: 'cli', dryRun: args.dryRun });
    console.log(`Decisions parsed: ${result.decisions.length}`);
  } else if (args.approve.length || args.reject.length) {
    const decisions = [
      ...args.approve.map(id => ({ action: 'approve', id })),
      ...args.reject.map(id => ({ action: 'reject', id })),
    ];
    console.log(`Executing ${decisions.length} explicit decisions, dryRun=${args.dryRun}…`);
    result = await executeDecisions(decisions, { approvedBy: args.approvedBy, source: 'cli', dryRun: args.dryRun });
  } else {
    console.error('Usage: --body <text> | --stdin | --approve <ID>... | --reject <ID>...');
    process.exit(1);
  }

  fmtResult(result);
  process.exit(0);
})().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(2);
});
