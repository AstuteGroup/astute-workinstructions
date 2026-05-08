// Patch the 2 bugs found in revalidation:
//   1. Packaging IDs off-by-one across the map (REEL→1000005=TRAY etc.)
//   2. Smoke-test row + stock-leadTime row had null Chuboe_Lead_Time
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { patchRecord } = require('/home/analytics_user/workspace/astute-workinstructions/shared/record-updater');

// Correct IDs from chuboe_packaging table (verified 2026-04-27):
//   F-REEL=1000001 F-TRAY=1000002 F-TUBE=1000003 REEL=1000004 TRAY=1000005
//   CUT TAPE=1000006 BOX=1000007 BULK=1000008 AMMO=1000009 OTHER=1000010

const PACKAGING_FIXES = [
  // Source had REEL → loader wrote 1000005 (TRAY) → fix to 1000004 (REEL)
  { vqId: 2136383, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip 85411AMILF' },
  { vqId: 2136378, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'cmarch 83021AMILFT (3K/REEL)' },
  { vqId: 2136337, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip W25Q32JVSSIQ' },
  { vqId: 2136345, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip W25Q32FVSSIG' },
  { vqId: 2136338, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'ruifan W25Q32JVSSIQ (2000/reel)' },
  { vqId: 2136333, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip DH82029PCH 20+' },
  { vqId: 2136334, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip DH82029PCH 22+' },
  { vqId: 2136391, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'archermind N25Q032A13EF640F (4000/REEL)' },
  { vqId: 2136392, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip N25Q032A13EF640F' },
  { vqId: 2136356, want: 1000004, from: 'TRAY',     to: 'REEL',   note: 'fixchip N25Q032A11EF440F' },

  // Source had TRAY → loader wrote 1000006 (CUT TAPE) → fix to 1000005 (TRAY)
  { vqId: 2136367, want: 1000005, from: 'CUT TAPE', to: 'TRAY',   note: 'cmarch 841N254BKILF 21+ (490/TRAY)' },
  { vqId: 2136368, want: 1000005, from: 'CUT TAPE', to: 'TRAY',   note: 'cmarch 841N254BKILF 23+ (490/TRAY)' },
  { vqId: 2136364, want: 1000005, from: 'CUT TAPE', to: 'TRAY',   note: 'fixchip MT41K256M8DA' },
  { vqId: 2136361, want: 1000005, from: 'CUT TAPE', to: 'TRAY',   note: 'fixchip PC28F00AP30EFA' },

  // Source had F-TUBE → loader wrote 1000008 (BULK) → fix to 1000003 (F-TUBE)
  { vqId: 2136373, want: 1000003, from: 'BULK',     to: 'F-TUBE', note: 'cmarch 2304NZGI-1LF (96/TUBE)' },
  { vqId: 2136353, want: 1000003, from: 'BULK',     to: 'F-TUBE', note: 'fixchip XCF02SVOG20C (tube)' },
  { vqId: 2136351, want: 1000003, from: 'BULK',     to: 'F-TUBE', note: 'topray XCF02SVOG20C (74/tube)' },
];

const LEAD_TIME_FIXES = [
  { vqId: 2136330, leadTime: '3-4 days', note: 'howeher DH82029PCH 18+ (smoke-test row hardcoded blank)' },
  { vqId: 2136383, leadTime: 'Stock',    note: 'fixchip 85411AMILF (extraction said stock; loader dropped to null)' },
];

(async () => {
  let okPkg = 0, failPkg = 0;
  for (const fix of PACKAGING_FIXES) {
    try {
      await patchRecord('Chuboe_VQ_Line', fix.vqId, { Chuboe_Packaging_ID: fix.want });
      console.log(`  ✓ ${fix.vqId}  ${fix.from} → ${fix.to}  ${fix.note}`);
      okPkg++;
    } catch (e) {
      console.log(`  ✗ ${fix.vqId}  ${fix.note}: ${e.message}`);
      failPkg++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('\nLead time fixes:');
  let okLt = 0, failLt = 0;
  for (const fix of LEAD_TIME_FIXES) {
    try {
      await patchRecord('Chuboe_VQ_Line', fix.vqId, { Chuboe_Lead_Time: fix.leadTime });
      console.log(`  ✓ ${fix.vqId}  → "${fix.leadTime}"  ${fix.note}`);
      okLt++;
    } catch (e) {
      console.log(`  ✗ ${fix.vqId}  ${fix.note}: ${e.message}`);
      failLt++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\nDone: packaging ${okPkg}/${PACKAGING_FIXES.length}, lead time ${okLt}/${LEAD_TIME_FIXES.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
