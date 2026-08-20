#!/usr/bin/env node
/**
 * One-time script to reclassify Hot Parts RFQs
 * - Julie White's -> Shortage (1000000)
 * - Carlos Moreno's -> Astute Franchised (1000002)
 */

const { apiPut } = require('../shared/api-client');

async function updateRfqTypes() {
  // Julie White's RFQs -> Shortage (1000000)
  const julieRfqs = [
    1150991, 1150626, 1150241, 1150166, 1150023, 1150003, 1149068, 1148913,
    1148911, 1148270, 1147406, 1146002, 1144618, 1142880, 1142762, 1141360,
    1140443, 1140234, 1139561, 1139000, 1136733
  ];

  // Carlos Moreno's RFQs -> Astute Franchised (1000002)
  const carlosRfqs = [1145777, 1145775, 1145743, 1145116, 1139805, 1139786];

  console.log('Updating Julie White RFQs to Shortage (1000000)...');
  let julieSuccess = 0, julieFail = 0;
  for (const id of julieRfqs) {
    try {
      await apiPut('chuboe_rfq', id, { Chuboe_RFQ_Type_ID: 1000000 });
      julieSuccess++;
      process.stdout.write('.');
    } catch (e) {
      julieFail++;
      console.error('\nFailed ' + id + ': ' + e.message);
    }
  }
  console.log(' Done: ' + julieSuccess + ' updated, ' + julieFail + ' failed');

  console.log('Updating Carlos Moreno RFQs to Astute Franchised (1000002)...');
  let carlosSuccess = 0, carlosFail = 0;
  for (const id of carlosRfqs) {
    try {
      await apiPut('chuboe_rfq', id, { Chuboe_RFQ_Type_ID: 1000002 });
      carlosSuccess++;
      process.stdout.write('.');
    } catch (e) {
      carlosFail++;
      console.error('\nFailed ' + id + ': ' + e.message);
    }
  }
  console.log(' Done: ' + carlosSuccess + ' updated, ' + carlosFail + ' failed');

  console.log('\nSummary:');
  console.log('  Julie White: ' + julieSuccess + '/21 -> Shortage');
  console.log('  Carlos Moreno: ' + carlosSuccess + '/6 -> Astute Franchised');
}

updateRfqTypes().catch(e => {
  console.error('Script failed:', e);
  process.exit(1);
});
