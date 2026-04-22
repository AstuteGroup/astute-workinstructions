/**
 * Deactivate stale Eaton-related carryover offers — both still showing 36,695
 * of 5044490507 (Molex), duplicating the current static carryover + weekly
 * Infor offer. No longer needed now that the active Eaton carryover
 * (1026156 / search_key 1026049) and weekly Eaton_Consignment offer
 * (1026153 / search_key 1026046) cover everything.
 *
 * Offers to deactivate:
 *   - 1023493 (search_key 1023387) — "PENDING CONSIGNMENT STOCK - PH"
 *   - 1020708 (search_key 1020612) — "08.21.2024-Eaton"
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { deactivateOfferById } = require('../../shared/offer-writeback');

const OFFERS = [
  { id: 1023493, label: 'PENDING CONSIGNMENT STOCK - PH',  value: '1023387' },
  { id: 1020708, label: '08.21.2024-Eaton',                value: '1020612' },
];

(async () => {
  for (const o of OFFERS) {
    console.log(`Deactivating offer ${o.id} (search_key ${o.value}) — ${o.label}...`);
    try {
      await deactivateOfferById(o.id);
      console.log(`  ✓ OK`);
    } catch (err) {
      console.error(`  ✗ FAILED — ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log('Done.');
})();
