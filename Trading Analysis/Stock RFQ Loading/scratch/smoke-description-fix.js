/*
 * Smoke test for Change 2 (description + BPName format).
 *
 * Mocks shared/api-client so no real writes happen. Runs the load_rfq handler
 * twice (matched BP + Unqualified Broker) and asserts the chuboe_rfq POST
 * payload has the right Description + BPName, and the line MPN payloads on
 * the Unqualified path are prepended with customerName.
 *
 * Run: node "Trading Analysis/Stock RFQ Loading/scratch/smoke-description-fix.js"
 */

const Module = require('module');
const path = require('path');

const captured = [];
const apiClientPath = path.resolve(__dirname, '../../../shared/api-client.js');

// Intercept require for api-client to install our stub.
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === '../api-client' || req === './api-client' || req.endsWith('shared/api-client') || req.endsWith('shared/api-client.js')) {
    return {
      apiPost: async (table, payload /* , opts */) => {
        captured.push({ table, payload });
        // Simulate server-assigned IDs
        if (table === 'chuboe_rfq') return { id: 9001, Value: '999999' };
        if (table === 'chuboe_rfq_line') return { id: payload.Chuboe_RFQ_ID * 100 + payload.Line };
        return { id: Math.floor(Math.random() * 1e6) };
      },
    };
  }
  return origLoad.call(this, req, parent, ...rest);
};

// Also stub db-helpers' psqlQuery so the description-lookup doesn't try DB.
Module._load = (function (next) {
  return function (req, parent, ...rest) {
    if (req === './db-helpers' || req.endsWith('shared/db-helpers')) {
      return {
        psqlQuery: () => null,
        cleanMpn: (s) => String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase(),
      };
    }
    return next.call(this, req, parent, ...rest);
  };
})(Module._load);

const stockrfq = require('../../../shared/workflow-actions/stockrfq.js');
const loadRfq = stockrfq.actions.load_rfq.handler;

const fakeCtx = { uid: 9999, dryRun: false, jakeEmail: 'jake@test', notifier: { sendEmail: async () => {} } };

(async () => {
  // CASE A — matched BP, customerName passed
  await loadRfq({
    bpartnerId: 1001060,
    type: 'Stock',
    customerName: 'Smith & Associates LP',
    lines: [{ mpn: 'ADS7953SDBT', qty: 100 }],
  }, fakeCtx);

  // CASE B — Unqualified Broker, customerName parsed from email
  await loadRfq({
    bpartnerId: 1006505,
    type: 'Stock',
    customerName: 'Shenzhen Yudexin',
    lines: [{ mpn: 'MT47H128M16RT-25E', qty: 2000 }],
  }, fakeCtx);

  const rfqA = captured.find(c => c.table === 'chuboe_rfq' && c.payload.C_BPartner_ID === 1001060);
  const rfqB = captured.find(c => c.table === 'chuboe_rfq' && c.payload.C_BPartner_ID === 1006505);

  console.log('CASE A (matched BP):');
  console.log('  Description:', JSON.stringify(rfqA.payload.Description));
  console.log('  BPName:     ', JSON.stringify(rfqA.payload.BPName));

  console.log('\nCASE B (Unqualified Broker):');
  console.log('  Description:', JSON.stringify(rfqB.payload.Description));
  console.log('  BPName:     ', JSON.stringify(rfqB.payload.BPName));

  const lineMpnB = captured.find(c => c.table === 'chuboe_rfq_line_mpn' && c.payload.Chuboe_RFQ_ID === 9001 && c.payload.Chuboe_MPN === 'MT47H128M16RT-25E');
  console.log('  Line MPN Description (should prepend customerName):', JSON.stringify(lineMpnB.payload.Description));

  const lineMpnA = captured.find(c => c.table === 'chuboe_rfq_line_mpn' && c.payload.Chuboe_MPN === 'ADS7953SDBT');
  console.log('\nCASE A Line MPN Description (should NOT prepend — matched BP):', JSON.stringify(lineMpnA.payload.Description));

  // Assertions
  const fail = (msg) => { console.error('  FAIL:', msg); process.exitCode = 1; };
  if (rfqA.payload.Description !== 'Smith & Associates LP — Stock RFQ') fail('CASE A Description wrong');
  if (rfqA.payload.BPName !== 'Smith & Associates LP') fail('CASE A BPName wrong');
  if (rfqB.payload.Description !== 'Shenzhen Yudexin — Stock RFQ') fail('CASE B Description wrong');
  if (rfqB.payload.BPName !== 'Shenzhen Yudexin') fail('CASE B BPName wrong');
  if (lineMpnB.payload.Description !== 'Shenzhen Yudexin') fail('CASE B line-prepend missing');
  if (lineMpnA.payload.Description) fail('CASE A line-prepend should be absent (matched BP)');

  if (process.exitCode) {
    console.error('\nSMOKE TEST FAILED');
  } else {
    console.log('\nSMOKE TEST PASSED');
  }
})().catch(e => { console.error('THREW:', e); process.exit(2); });
