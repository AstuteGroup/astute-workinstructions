/**
 * Offline test for the failure-rate-gate fan-out fix. Replays the UID 8655
 * per-RFQ numbers (from the breadcrumb high-failure-rate-detected rows).
 */
'use strict';
const { evaluateFailureRate } = require('../shared/failure-rate-gate');

const mk = (written, noMpnMatch, failed, vendorNotFound = 0) => ({
  written: Array(written).fill({}),
  failed: Array(failed).fill({}),
  skipped: [
    ...Array(noMpnMatch).fill({ reason: 'NO_MPN_MATCH' }),
    ...Array(vendorNotFound).fill({ reason: 'VENDOR_NOT_FOUND' }),
  ],
});

let pass = true;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) pass = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: severity=${got} (want ${want})`);
};

// ── Original UID 8655 numbers, as the gate saw them last night (no fanOut) ──
console.log('\n[1] Original behavior (fanOut=false) — reproduces the 4 alerts:');
check('1135455 written13/fail7',  evaluateFailureRate({ result: mk(13, 0, 7) }).severity, 'high');
check('1135458 written9/noMpn11', evaluateFailureRate({ result: mk(9, 11, 0) }).severity, 'medium');
check('1133971 written9/noMpn11', evaluateFailureRate({ result: mk(9, 11, 0) }).severity, 'medium');
check('1133119 written0/noMpn13/fail7', evaluateFailureRate({ result: mk(0, 13, 7) }).severity, 'high');

// ── Same numbers WITH fanOut: the two skip-rate false positives must clear ──
console.log('\n[2] fanOut=true on the same numbers — skip-rate false positives gone:');
check('1135458 fan-out', evaluateFailureRate({ result: mk(9, 11, 0), fanOut: true }).severity, 'none');
check('1133971 fan-out', evaluateFailureRate({ result: mk(9, 11, 0), fanOut: true }).severity, 'none');
// The two REAL-failure RFQs still fire pre-no-bid-fix (gate can't know they're no-bids):
check('1135455 fan-out (real fails)', evaluateFailureRate({ result: mk(13, 0, 7), fanOut: true }).severity, 'high');

// ── With the no-bid fix too: the 7 ADUM failures become `written`, so all clear ──
console.log('\n[3] fanOut + no-bid fix (failures reclassified as written) — all clear:');
check('1135455 post-fix', evaluateFailureRate({ result: mk(20, 0, 0), fanOut: true }).severity, 'none');
check('1133119 post-fix', evaluateFailureRate({ result: mk(7, 13, 0), fanOut: true }).severity, 'none');

// ── Signal preservation: single-RFQ load with a wall of NO_MPN_MATCH still fires ──
console.log('\n[4] Single-RFQ (fanOut=false) NO_MPN_MATCH wall still alerts:');
check('single-rfq 5 written / 15 noMpn', evaluateFailureRate({ result: mk(5, 15, 0) }).severity, 'medium');
// Real vendor-not-found gap fires even in fan-out (it matched a line here):
check('fan-out real VENDOR_NOT_FOUND',   evaluateFailureRate({ result: mk(3, 4, 0, 12), fanOut: true }).severity, 'medium');

console.log(pass ? '\nPASS — all gate cases as expected.' : '\nFAIL — see above.');
process.exit(pass ? 0 : 1);
