/**
 * Blue Origin Offer 1024645 — Surgical Cleanup
 *
 * Fixes 4 dirty MPN lines on chuboe_offer_id 1024752 per the AVL/multi-MPN
 * loading rule. Two cases:
 *
 *   Case B (variant strip): lines 100, 110 — "LS1046AMN3T1A (EM)"
 *     PATCH: MPN → "LS1046AMN3T1A" on parent + sub-mpn
 *     PATCH: Description → original + "| EM (Engineering Sample)" on parent
 *     The (EM) annotation moves from the MPN field into Description so the
 *     join key (chuboe_mpn_clean) matches against the bare industry part.
 *
 *   Case A (split mil-spec cross-ref): lines 160, 170 —
 *     "RT4G150-1LG1657B (5962-1620804QZC)" / "RT4G150-1LG1657E (5962-1620808QZC)"
 *     PATCH parent: MPN → bare primary, CPC → bare primary
 *     PATCH sub-mpn: MPN → bare primary
 *     POST new line (165, 175): full row with the 5962-* cross-ref MPN, same
 *       qty/dc/mfr, CPC = primary, description notes the cross-ref relationship
 *     POST new sub-mpn: child of the new line
 *
 * After this runs, offer 1024645 should have 20 active lines (was 18; +2 from
 * the splits) and 0 lines with parenthetical content in the MPN.
 *
 * One-shot script — not idempotent. DO NOT re-run.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { apiPost } = require('/home/analytics_user/workspace/astute-workinstructions/shared/api-client');
const { patchRecord } = require('/home/analytics_user/workspace/astute-workinstructions/shared/record-updater');
const { cleanMpn } = require('/home/analytics_user/workspace/astute-workinstructions/shared/db-helpers');

const OFFER_ID = 1024752;
const SOURCE = 'fix-blue-origin-1024645';

// Case B: strip variant annotation
const VARIANT_FIXES = [
  {
    line: 100, lineId: 34233579, lineMpnId: 30240594,
    oldMpn: 'LS1046AMN3T1A (EM)', newMpn: 'LS1046AMN3T1A',
    annotation: 'EM (Engineering Sample)',
    oldDesc: 'LS1046A 780-BGA 1800MHz',
  },
  {
    line: 110, lineId: 34233580, lineMpnId: 30240595,
    oldMpn: 'LS1046AMN3T1A (EM)', newMpn: 'LS1046AMN3T1A',
    annotation: 'EM (Engineering Sample)',
    oldDesc: 'LS1046A 780-BGA 1800MHz',
  },
];

// Case A: split into primary + mil-spec cross-ref
const SPLIT_FIXES = [
  {
    line: 160, lineId: 34233585, lineMpnId: 30240600,
    newSplitLine: 165, qty: 3, dc: '2034', mfrText: 'Microsemi',
    oldMpn:     'RT4G150-1LG1657B (5962-1620804QZC)',
    primaryMpn: 'RT4G150-1LG1657B',
    altMpn:     '5962-1620804QZC',
    oldDesc: 'RT4G150-1 1657-LGA',
  },
  {
    line: 170, lineId: 34233586, lineMpnId: 30240601,
    newSplitLine: 175, qty: 10, dc: '2234', mfrText: 'Microsemi',
    oldMpn:     'RT4G150-1LG1657E (5962-1620808QZC)',
    primaryMpn: 'RT4G150-1LG1657E',
    altMpn:     '5962-1620808QZC',
    oldDesc: 'RT4G150-1 1657-LGA',
  },
];

(async () => {
  console.log('=== Blue Origin Offer 1024645 — Surgical Fix ===');
  console.log(`chuboe_offer_id: ${OFFER_ID}`);
  console.log('');

  // ── Case B: Strip variant annotations ─────────────────────────────────────
  console.log('--- Case B: strip (EM) variant annotations ---');
  for (const fix of VARIANT_FIXES) {
    console.log(`\n[Line ${fix.line}] ${fix.oldMpn} → ${fix.newMpn}`);

    const newDesc = `${fix.oldDesc} | ${fix.annotation}`;
    const parentResult = await patchRecord('chuboe_offer_line', fix.lineId, {
      Chuboe_MPN: fix.newMpn,
      Chuboe_MPN_Clean: cleanMpn(fix.newMpn),
      Description: newDesc,
    }, { source: SOURCE });
    console.log(`  parent line ${fix.lineId}: ${parentResult.status}`);
    if (parentResult.status === 'error') console.log(`    ERROR: ${parentResult.error}`);

    const subResult = await patchRecord('chuboe_offer_line_mpn', fix.lineMpnId, {
      Chuboe_MPN: fix.newMpn,
      Chuboe_MPN_Clean: cleanMpn(fix.newMpn),
    }, { source: SOURCE });
    console.log(`  sub mpn ${fix.lineMpnId}: ${subResult.status}`);
    if (subResult.status === 'error') console.log(`    ERROR: ${subResult.error}`);
  }

  // ── Case A: Split mil-spec cross-refs ─────────────────────────────────────
  console.log('\n--- Case A: split mil-spec cross-refs ---');
  for (const fix of SPLIT_FIXES) {
    console.log(`\n[Line ${fix.line}] ${fix.oldMpn}`);
    console.log(`  → primary: ${fix.primaryMpn} (existing line ${fix.lineId})`);
    console.log(`  → alt:     ${fix.altMpn} (new line ${fix.newSplitLine})`);

    // 1. Clean the existing parent line to bare primary MPN + set CPC
    const parentResult = await patchRecord('chuboe_offer_line', fix.lineId, {
      Chuboe_MPN: fix.primaryMpn,
      Chuboe_MPN_Clean: cleanMpn(fix.primaryMpn),
      Chuboe_CPC: fix.primaryMpn,
      Chuboe_CPC_Clean: cleanMpn(fix.primaryMpn),
    }, { source: SOURCE });
    console.log(`  patched parent line ${fix.lineId}: ${parentResult.status}`);
    if (parentResult.status === 'error') console.log(`    ERROR: ${parentResult.error}`);

    // 2. Clean the existing sub-mpn
    const subResult = await patchRecord('chuboe_offer_line_mpn', fix.lineMpnId, {
      Chuboe_MPN: fix.primaryMpn,
      Chuboe_MPN_Clean: cleanMpn(fix.primaryMpn),
    }, { source: SOURCE });
    console.log(`  patched sub mpn ${fix.lineMpnId}: ${subResult.status}`);
    if (subResult.status === 'error') console.log(`    ERROR: ${subResult.error}`);

    // 3. POST a new offer line for the cross-ref
    const newLinePayload = {
      Chuboe_Offer_ID: OFFER_ID,
      Line: fix.newSplitLine,
      Chuboe_MPN: fix.altMpn,
      Chuboe_MPN_Clean: cleanMpn(fix.altMpn),
      Chuboe_MFR_Text: fix.mfrText,
      Qty: fix.qty,
      Chuboe_Date_Code: fix.dc,
      Description: `${fix.oldDesc} | Mil-spec cross-ref of ${fix.primaryMpn}`,
      Chuboe_CPC: fix.primaryMpn,
      Chuboe_CPC_Clean: cleanMpn(fix.primaryMpn),
    };
    let newLine;
    try {
      newLine = await apiPost('chuboe_offer_line', newLinePayload);
      console.log(`  POST new line: id=${newLine.id}`);
    } catch (e) {
      console.log(`  POST new line ERROR: ${e.message}`);
      continue;
    }

    // 4. POST child sub-mpn record for the new line
    try {
      const newSub = await apiPost('chuboe_offer_line_mpn', {
        Chuboe_Offer_Line_ID: newLine.id,
        Chuboe_MPN: fix.altMpn,
        Chuboe_MPN_Clean: cleanMpn(fix.altMpn),
      });
      console.log(`  POST new sub mpn: id=${newSub.id}`);
    } catch (e) {
      console.log(`  POST new sub mpn ERROR: ${e.message}`);
    }
  }

  console.log('\n=== Surgical fix complete ===');
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
