/**
 * Philippines carryover offer search_key 1026050 (internal chuboe_offer_id 1026157)
 * — targeted cleanups per Jake's decisions on the 2026-04-21 Philippines audit.
 *
 * Qty fix:
 *   - IRF8910TRPBF  (line 34982000, POV0073170) — 4,000 sold of 5,340 carry → 1,340 remaining
 *
 * Retire (all stock sold):
 *   - RT0402BRE0724K9L (line 34982126, POV0070688) — 1,800 sold, matches carry exactly
 *
 * Sticks through next Monday's refresh — refresh reads `IsActive eq true` only and
 * the Qty update propagates on the next copy.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { patchBatch } = require('../../shared/record-updater');

const UPDATES = [
  { id: 34982000, mpn: 'IRF8910TRPBF',     op: 'qty-fix', payload: { Qty: 1340 },       note: '5,340 → 1,340 (4,000 sold, POV0073170)' },
  { id: 34982126, mpn: 'RT0402BRE0724K9L', op: 'retire',  payload: { IsActive: false }, note: '1,800 sold from POV0070688'               },
];

(async () => {
  console.log(`Patching ${UPDATES.length} lines on Philippines carryover offer (chuboe_offer_id 1026157, search_key 1026050)...`);
  for (const u of UPDATES) {
    console.log(`  ${String(u.id).padStart(10)}  ${u.mpn.padEnd(22)} ${u.op.padEnd(8)} ${u.note}`);
  }

  const summary = await patchBatch(
    'chuboe_offer_line',
    UPDATES.map(u => ({ id: u.id, payload: u.payload })),
    {
      source: 'philippines-carryover-cleanup-2026-04-21',
      concurrency: 3,
      auditDir: '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/Inventory File Cleanup/patch-logs',
      onProgress: (done, total, result) => {
        const tag = result.status === 'patched' ? 'OK' : result.status.toUpperCase();
        console.log(`  [${done}/${total}] ${tag} line ${result.id}${result.error ? ' — ' + result.error : ''}`);
      },
    }
  );

  console.log(`\nSummary: ${summary.patched} patched, ${summary.skipped} skipped, ${summary.errors} errors (${summary.total} total)`);
  if (summary.errors > 0) process.exit(1);
})();
