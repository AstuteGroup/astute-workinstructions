#!/usr/bin/env node
/**
 * Fix MFR on tariff VQs and tick them
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPut } = require('./shared/api-client');
const { tickVQForPurchase } = require('./shared/vq-patcher');

// Use a generic client-level MFR for tariffs (doesn't matter which one)
// Using Molex LLC (1021009) since it's a client-level record we created
const TARIFF_MFR_ID = 1021009;

const tariffVQs = [
  { vqId: 2228067, invoice: '89497435', amount: 99.65 },
  { vqId: 2228068, invoice: '89519101', amount: 94.41 },
  { vqId: 2228069, invoice: '89568193', amount: 778.90 },
  { vqId: 2228070, invoice: '89765460', amount: 7.28 },
  { vqId: 2228071, invoice: '90441161', amount: 0.31 },
];

async function main() {
  console.log('Fixing MFR and ticking tariff VQs...\n');

  // First, set MFR on all tariff VQs
  console.log('Setting MFR ID on tariff VQs...');
  for (const tariff of tariffVQs) {
    await apiPut('chuboe_vq_line', tariff.vqId, { Chuboe_MFR_ID: TARIFF_MFR_ID });
    console.log(`  ✓ VQ ${tariff.vqId}: MFR set`);
  }

  console.log('\nTicking tariff VQs for purchase...\n');
  const ticked = [];

  for (const tariff of tariffVQs) {
    try {
      await tickVQForPurchase(tariff.vqId, {
        program: 'LAM_KITTING',
        extra: {
          DatePromised: '2026-03-30',
          DueDate: '2026-03-30',
        },
        allowCompetingTicked: true,
      });
      console.log(`✓ Ticked VQ ${tariff.vqId}: Invoice ${tariff.invoice} - $${tariff.amount.toFixed(2)}`);
      ticked.push(tariff);
    } catch (err) {
      console.log(`✗ VQ ${tariff.vqId}: ${err.message}`);
      if (err.violations) {
        for (const v of err.violations) {
          console.log(`    - ${v}`);
        }
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Ticked: ${ticked.length}/${tariffVQs.length}`);
  console.log(`Total tariff: $${ticked.reduce((sum, t) => sum + t.amount, 0).toFixed(2)}`);
  console.log(`\nVQ IDs: ${ticked.map(t => t.vqId).join(', ')}`);
}

main().catch(console.error);
