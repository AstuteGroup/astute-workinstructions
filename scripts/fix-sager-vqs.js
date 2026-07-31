#!/usr/bin/env node
/**
 * Fix Sager VQs for LAM RFQ 1132774
 *
 * 1. VQ 2133933 (5-104363-2): Change qty from 11,929 to 52, keep ticked
 * 2. VQ 2134017 (503398-1892): Untick (set IsPurchased = 'N')
 */

const { patchRecord } = require('../shared/record-updater');

async function main() {
  console.log('Fixing Sager VQs for LAM RFQ 1132774...\n');

  // 1. Fix qty on VQ 2133933
  console.log('1. VQ 2133933 (5-104363-2): Setting qty to 52...');
  const result1 = await patchRecord('chuboe_vq_line', 2133933, {
    Qty: 52
  }, { source: 'sager-vq-fix' });

  if (result1.status === 'patched') {
    console.log('   OK - Qty updated to 52');
  } else {
    console.log('   ERROR:', result1.error || result1.status);
  }

  // 2. Untick VQ 2134017
  console.log('\n2. VQ 2134017 (503398-1892): Unticking IsPurchased...');
  const result2 = await patchRecord('chuboe_vq_line', 2134017, {
    IsPurchased: 'N'
  }, { source: 'sager-vq-fix' });

  if (result2.status === 'patched') {
    console.log('   OK - IsPurchased set to N');
  } else {
    console.log('   ERROR:', result2.error || result2.status);
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
