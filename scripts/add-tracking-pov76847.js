#!/usr/bin/env node
/**
 * Add tracking number to POV0076847 lines 10-40
 * Tracking: 382268232906
 */

const { patchRecord } = require('../shared/record-updater');

const TRACKING = '382268232906';
const ORDER_LINES = [
  { id: 1027454, line: 10, mpn: 'CB3LV-3C-24M000000' },
  { id: 1027455, line: 20, mpn: 'DSP2A-DC24V' },
  { id: 1027456, line: 30, mpn: 'EEEFC1V220P' },
  { id: 1027457, line: 40, mpn: 'EEE1VA331P' },
];

async function main() {
  console.log('Adding tracking ' + TRACKING + ' to POV0076847 lines...\n');

  for (const ol of ORDER_LINES) {
    console.log('Line ' + ol.line + ' (' + ol.mpn + ')...');
    const result = await patchRecord('c_orderline', ol.id, {
      Chuboe_TrackingNumbers: TRACKING
    }, { source: 'tracking-add-pov76847' });

    if (result.status === 'patched') {
      console.log('  OK');
    } else {
      console.log('  ERROR: ' + (result.error || result.status));
    }
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
