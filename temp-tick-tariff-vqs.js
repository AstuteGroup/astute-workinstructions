#!/usr/bin/env node
/**
 * Tick tariff VQs for purchase
 */
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { tickVQForPurchase } = require('./shared/vq-patcher');

const tariffVQs = [
  { vqId: 2228067, invoice: '89497435', amount: 99.65 },
  { vqId: 2228068, invoice: '89519101', amount: 94.41 },
  { vqId: 2228069, invoice: '89568193', amount: 778.90 },
  { vqId: 2228070, invoice: '89765460', amount: 7.28 },
  { vqId: 2228071, invoice: '90441161', amount: 0.31 },
];

async function main() {
  console.log('Ticking tariff VQs for purchase...\n');

  const ticked = [];

  for (const tariff of tariffVQs) {
    try {
      await tickVQForPurchase(tariff.vqId, {
        program: 'LAM_KITTING',
        extra: {
          DatePromised: '2026-03-30',  // Use latest ship date
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

  console.log(`\nTicked: ${ticked.length}/${tariffVQs.length}`);
  console.log(`Total tariff ticked: $${ticked.reduce((sum, t) => sum + t.amount, 0).toFixed(2)}`);
}

main().catch(console.error);
