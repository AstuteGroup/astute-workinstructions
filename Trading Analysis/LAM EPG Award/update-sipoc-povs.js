/**
 * Update SIPOC with POV numbers for the 4 broker POs:
 *   POV0075525 / PO809585 — SMARTEL
 *   POV0075529 / PO809591 — CHIP ENERGY
 *   POV0075532 / PO809592 — Dragon Core
 *   POV0075533 / PO809593 — HK Firsttop
 *
 * Also retrieves PO copy PDFs from iDempiere Document Explorer (attachments API).
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');
const { apiGet, getToken, login } = require('../../shared/api-client');

const SIPOC = path.join(__dirname, 'Lam_EPG_SIPOC.xlsx');
const BACKUP = path.join(__dirname, `Lam_EPG_SIPOC.backup-${new Date().toISOString().slice(0,10)}-povs.xlsx`);

// POV → vendor source name mapping (matches SIPOC Source column values)
const PO_MAP = [
  { pov: 'POV0075525', po: 'PO809585', vendor: 'SMARTEL ELECTRONICS (ASIA)',   orderId: 1016338, orderUU: '4b61277d-c912-4048-9604-62d5d330c98c' },
  { pov: 'POV0075529', po: 'PO809591', vendor: 'CHIP ENERGY INTERNATIONAL',    orderId: null,    orderUU: null },
  { pov: 'POV0075532', po: 'PO809592', vendor: 'Dragon Core Electronics HK',   orderId: null,    orderUU: null },
  { pov: 'POV0075533', po: 'PO809593', vendor: 'HK Firsttop Technology',       orderId: null,    orderUU: null },
];

// SIPOC column indices (from header)
const COL = {
  CPC: 0,
  SOURCE: 15,
  POV: 26,         // AA
  PURCHASED_BY: 27,// AB
  PO_SENT: 28,     // AC
  OT_ORDER: 31,    // AF
  NOTES: 33,       // AH
};

function setSipocCell(ws, rowIdx, colIdx, value, format) {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  let cell = ws[addr];
  if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell; }
  cell.v = value;
  cell.t = (typeof value === 'number') ? 'n' : 's';
  if (format) cell.z = format;
  delete cell.w;
}

(async () => {
  // ── 1. Backup SIPOC ────────────────────────────────────────────────────────
  fs.copyFileSync(SIPOC, BACKUP);
  console.log(`✓ Backup: ${path.basename(BACKUP)}`);

  // ── 2. Read SIPOC and find matching rows ────────────────────────────────────
  const wb = XLSX.readFile(SIPOC);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let updated = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 2; i < aoa.length; i++) {
    const r = aoa[i];
    const cpc = String(r[COL.CPC] || '').trim();
    if (!cpc) continue;

    const source = String(r[COL.SOURCE] || '').trim();
    const existingPov = String(r[COL.POV] || '').trim();

    // Skip if POV already filled
    if (existingPov) continue;

    // Match source to one of our 4 vendors
    const match = PO_MAP.find(p => source.toUpperCase().includes(p.vendor.split(' ')[0].toUpperCase()));
    if (!match) continue;

    // Update POV column
    setSipocCell(ws, i, COL.POV, match.pov);
    // Update PO Sent date (today)
    setSipocCell(ws, i, COL.PO_SENT, today);
    // Update Purchased By
    setSipocCell(ws, i, COL.PURCHASED_BY, 'Jake Harris');
    // Update OT Order Number
    setSipocCell(ws, i, COL.OT_ORDER, match.po);

    console.log(`  Row ${i}: CPC=${cpc} Source=${source} → POV=${match.pov} PO=${match.po}`);
    updated++;
  }

  // Ensure sheet range covers the new columns
  const range = XLSX.utils.decode_range(ws['!ref']);
  if (range.e.c < 38) { range.e.c = 38; ws['!ref'] = XLSX.utils.encode_range(range); }

  XLSX.writeFile(wb, SIPOC);
  console.log(`\n✓ SIPOC updated: ${updated} rows with POV/PO/PurchasedBy/POSent`);

  // ── 3. Retrieve PO copies from iDempiere attachments ────────────────────────
  console.log('\n--- Retrieving PO copies from iDempiere ---');

  // We need to find the c_order_id for each PO via the API (they're too new for the replica)
  for (const po of PO_MAP) {
    try {
      // Try by document number first
      let orders;
      if (po.orderId) {
        // We have the ID directly
        orders = { records: [{ id: po.orderId, DocumentNo: po.po }] };
      } else {
        // Search by DocumentNo
        orders = await apiGet('C_Order', { filter: `DocumentNo eq '${po.po}'`, top: 1 });
      }

      if (!orders.records || orders.records.length === 0) {
        console.log(`  ✗ ${po.po}: not found in iDempiere`);
        continue;
      }

      const orderId = orders.records[0].id || po.orderId;
      console.log(`  ${po.po}: C_Order_ID=${orderId}`);

      // Try to get attachments via the attachments endpoint
      // iDempiere REST: GET /models/{table}/{id}/attachments
      const token = await getToken();
      const BASE_URL = process.env.IDEMPIERE_BASE_URL;

      const attUrl = `${BASE_URL}/models/C_Order/${orderId}/attachments`;
      const attRes = await fetch(attUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!attRes.ok) {
        console.log(`  ✗ ${po.po}: attachments endpoint returned ${attRes.status}`);
        // Try the print endpoint instead
        const printUrl = `${BASE_URL}/models/C_Order/${orderId}/print`;
        const printRes = await fetch(printUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (printRes.ok) {
          const contentType = printRes.headers.get('content-type') || '';
          const ext = contentType.includes('pdf') ? 'pdf' : 'html';
          const buf = Buffer.from(await printRes.arrayBuffer());
          const outFile = path.join(__dirname, `${po.po}_copy.${ext}`);
          fs.writeFileSync(outFile, buf);
          console.log(`  ✓ ${po.po}: print output saved → ${path.basename(outFile)} (${buf.length} bytes)`);
        } else {
          console.log(`  ✗ ${po.po}: print endpoint returned ${printRes.status}`);
        }
        continue;
      }

      const attData = await attRes.json();
      console.log(`  ${po.po}: attachment response:`, JSON.stringify(attData).slice(0, 300));

      // If there are attachment entries, download them
      if (attData && Array.isArray(attData.attachments || attData.records || attData)) {
        const items = attData.attachments || attData.records || attData;
        for (const att of items) {
          const name = att.name || att.fileName || `${po.po}_attachment`;
          const downloadUrl = att.link || att.href || att.url || `${attUrl}/${att.id || att.name}`;

          const dlRes = await fetch(downloadUrl.startsWith('http') ? downloadUrl : `${BASE_URL}${downloadUrl}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (dlRes.ok) {
            const buf = Buffer.from(await dlRes.arrayBuffer());
            const outFile = path.join(__dirname, `${po.po}_${name}`);
            fs.writeFileSync(outFile, buf);
            console.log(`  ✓ ${po.po}: attachment saved → ${path.basename(outFile)} (${buf.length} bytes)`);
          }
        }
      }
    } catch (e) {
      console.error(`  ✗ ${po.po}: ${e.message}`);
    }
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
