/**
 * Eaton carryover offer search_key 1026049 (internal chuboe_offer_id 1026156)
 * — targeted cleanups per Jake's decisions on the 2026-04-21 audit.
 *
 * Retires (all stock sold — fully allocated or shipped):
 *   - ADR5041ARTZ-REEL7  (line 34981725, carry 37,480) — 37,480 shipped to Shenzhen A.S.W
 *   - LIS3DHTR           (line 34981728, carry 47,894) — 47,894 allocated to Shenzhen A.S.W
 *   - SX1509BIULTRT      (line 34981774, carry  4,130) — 4,130 net shipped (2 Eaton POs, JZChips voided)
 *
 * Qty fix (stale carryover, propagating since Oct 2025):
 *   - PBO-3C-5           (line 34981815, carry  6,792 → 480) — match current Infor W117
 *     Original 980 − 500 sold (SO505679 Sourceability) = 480.
 *
 * Sticks through next Monday's refresh because refreshStaticCarryoverOffers
 * reads lines with `IsActive eq true` only — retired rows never carry forward,
 * and the Qty update propagates on the next copy.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { patchBatch } = require('../../shared/record-updater');

const UPDATES = [
  { id: 34981725, mpn: 'ADR5041ARTZ-REEL7', op: 'retire',  payload: { IsActive: false }, note: 'carry 37,480' },
  { id: 34981728, mpn: 'LIS3DHTR',          op: 'retire',  payload: { IsActive: false }, note: 'carry 47,894' },
  { id: 34981774, mpn: 'SX1509BIULTRT',     op: 'retire',  payload: { IsActive: false }, note: 'carry 4,130'  },
  { id: 34981815, mpn: 'PBO-3C-5',          op: 'qty-fix', payload: { Qty: 480 },        note: '6,792 → 480'  },
];

(async () => {
  console.log(`Patching ${UPDATES.length} lines on Eaton carryover offer (chuboe_offer_id 1026156, search_key 1026049)...`);
  for (const u of UPDATES) {
    console.log(`  ${String(u.id).padStart(10)}  ${u.mpn.padEnd(22)} ${u.op.padEnd(8)} ${u.note}`);
  }

  const summary = await patchBatch(
    'chuboe_offer_line',
    UPDATES.map(u => ({ id: u.id, payload: u.payload })),
    {
      source: 'eaton-carryover-cleanup-2026-04-21',
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
