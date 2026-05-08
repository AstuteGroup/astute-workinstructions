/**
 * Update SIPOC for RNCF0805TKT61K2 + RNCF0805TKT10K0 after combined approval
 * posted via R_Request 1157278:
 *   - POV0075767 (added to existing PO809833, Master)
 *   - PO Sent date → 2026-04-21
 *   - Processed in OT → Y
 *   - OT Order Number → PO809833
 *   - Notes → refresh with dock date 07/21/26 + R_Request reference
 *
 * Also PATCHes the VQ datepromised to 2026-07-21 (13 wks from 04/21 tick).
 *
 * Not on the escalations list (lam-epg-escalation-table.md) — confirmed clean
 * Master sourcing, no customer escalation needed.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { patchRecord } = require('/home/analytics_user/workspace/astute-workinstructions/shared/record-updater');

const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const BACKUP = path.join(__dirname, `Lam_EPG_SIPOC.backup-2026-04-21-rncf.xlsx`);

const UPDATES = [
  {
    cpc: '615-122309-612',
    mpn: 'RNCF0805TKT61K2',
    vqId: 2059150,
    note: 'Request 1157278 — Added to POV0075767 / PO809833 (Master, existing IP). Dock 07/21/26 (13 wks from 04/21). F-REEL. MOQ 500 / LAM need 350 / 150 excess.',
  },
  {
    cpc: '615-122309-100',
    mpn: 'RNCF0805TKT10K0',
    vqId: 2059841,
    note: 'Request 1157278 — Added to POV0075767 / PO809833 (Master, existing IP). Dock 07/21/26 (13 wks from 04/21). F-REEL. MOQ 500 / LAM need 310 / 190 excess.',
  },
];

const POV = 'POV0075767';
const PO_SENT_DATE = '2026-04-21';
const OT_PO = 'PO809833';

function updateSipoc() {
  fs.copyFileSync(SIPOC, BACKUP);
  console.log(`[backup] ${path.basename(BACKUP)}`);

  const wb = XLSX.readFile(SIPOC);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const cpcToRow = new Map();
  for (let i = 2; i < aoa.length; i++) {
    const cpc = String(aoa[i][0] || '').trim();
    if (cpc) cpcToRow.set(cpc, i);
  }

  function setCell(rowIdx, colIdx, value, format) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
    let cell = ws[addr];
    if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
    cell.v = value;
    cell.t = (typeof value === 'number') ? 'n' : 's';
    if (format) cell.z = format;
    delete cell.w;
  }

  for (const u of UPDATES) {
    const rowIdx = cpcToRow.get(u.cpc);
    if (rowIdx == null) {
      console.log(`  ✗ CPC ${u.cpc} NOT FOUND`);
      continue;
    }
    setCell(rowIdx, 26, POV);              // POV
    setCell(rowIdx, 28, PO_SENT_DATE);     // PO Sent (date)
    setCell(rowIdx, 30, 'Y');              // Processed in OT
    setCell(rowIdx, 31, OT_PO);            // OT Order Number
    setCell(rowIdx, 33, u.note);           // Notes
    console.log(`  ✓ row ${rowIdx + 1} CPC ${u.cpc} ${u.mpn} → POV ${POV} / ${OT_PO}`);
  }

  XLSX.writeFile(wb, SIPOC);
  console.log(`[saved] ${path.basename(SIPOC)}`);
}

async function patchVqPromise() {
  console.log(`\n[VQ promise date → 2026-07-21]`);
  for (const u of UPDATES) {
    const res = await patchRecord('chuboe_vq_line', u.vqId, {
      DatePromised: '2026-07-21',
    }, { source: 'rncf-dock-date' });
    console.log(`  VQ ${u.vqId} (${u.mpn}): ${res.status}`);
  }
}

async function refreshRequestMessage() {
  // R_Request 1159373 — update Result (Message to User) to reflect dock date.
  console.log(`\n[R_Request 1159373 Result → dock 07/21/26]`);
  const newMessage = [
    `ADD BOTH LINES TO ${POV} / ${OT_PO} (Master Electronics, existing IP order).`,
    '',
    'Lines:',
    '  RFQ Line 1080 — RNCF0805TKT61K2 (CPC 615-122309-612, VQ 2059150)',
    '  RFQ Line 1770 — RNCF0805TKT10K0 (CPC 615-122309-100, VQ 2059841)',
    '',
    `Both VQs already IsPurchased='Y'. F-REEL. Dock date 07/21/26 (13 wks from today's cut).`,
    '',
    `MOQ overage: both MPNs are MOQ 500; LAM contract qtys are 350 + 310 (total 340 pcs excess). Stackpole RNCF0805TKT family prices flat at this break — unit cost $0.688 is 15-16% under LAM base on both.`,
    '',
    `Supersedes R_Requests 1157265 + 1157266 (closed). Promise dates updated on VQs to 2026-07-21.`,
  ].join('\n');

  const res = await patchRecord('r_request', 1159373, {
    Result: newMessage,
  }, { source: 'rncf-dock-date' });
  console.log(`  R_Request 1159373: ${res.status}`);
}

(async () => {
  updateSipoc();
  await patchVqPromise();
  await refreshRequestMessage();
  console.log('\n=== DONE ===');
  process.exit(0);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
