#!/usr/bin/env node
// Retire PMV450ENEAR from the Eaton Consignment static carryover.
// User confirmed 2026-05-12: physical stock is in Austin (transferred
// from Philippines a few weeks ago); the carryover loop should stop
// re-creating this line every week.
//
// Targets:
//   - chuboe_offer_line     35072335  (qty 28,034, Nexperia, on offer 1026216 = '[Carryover] Eaton Consignment — refreshed 2026-05-06')
//   - chuboe_offer_line_mpn 31172772  (child row)
//
// Next refresh's prefix-lookup finds offer 1026216, reads its IsActive=true
// lines, and copies them forward. Once these two rows are IsActive=N, the
// next refresh will not see PMV450ENEAR — permanent removal.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { patchRecord } = require('../shared/record-updater');

(async () => {
    const source = 'retire-pmv450enear-carryover (Jake 2026-05-12, physical in Austin)';

    console.log('Retiring PMV450ENEAR from Eaton carryover offer 1026216 ...');

    const lineResult = await patchRecord('chuboe_offer_line', 35072335, { IsActive: false }, { source });
    console.log('  chuboe_offer_line  35072335 →', lineResult.status, lineResult.error ? `(${lineResult.error})` : '');

    const mpnResult = await patchRecord('chuboe_offer_line_mpn', 31172772, { IsActive: false }, { source });
    console.log('  chuboe_offer_line_mpn 31172772 →', mpnResult.status, mpnResult.error ? `(${mpnResult.error})` : '');

    console.log('\nNext weekly carryover refresh will read offer 1026216 with these rows IsActive=N,');
    console.log('so PMV450ENEAR will not be copied into next week\'s carryover offer.');
})();
