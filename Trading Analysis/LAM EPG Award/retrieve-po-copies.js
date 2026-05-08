/**
 * Retrieve PO copy PDFs from iDempiere via the print endpoint.
 *
 * Discovery (2026-04-10): GET /models/C_Order/{id}/print returns JSON with:
 *   { exportFile: "<base64-encoded PDF>" }
 *
 * POs:
 *   PO809585 (C_Order_ID=1016338) — SMARTEL
 *   PO809591 — CHIP ENERGY
 *   PO809592 — Dragon Core
 *   PO809593 — HK Firsttop
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getToken, login } = require('../../shared/api-client');

const BASE_URL = process.env.IDEMPIERE_BASE_URL;

const POS = [
  { po: 'PO809585', orderId: 1016338, vendor: 'SMARTEL' },
  { po: 'PO809591', orderId: null,    vendor: 'CHIP ENERGY' },
  { po: 'PO809592', orderId: null,    vendor: 'Dragon Core' },
  { po: 'PO809593', orderId: null,    vendor: 'HK Firsttop' },
];

const OUT_DIR = __dirname;

async function fetchJson(token, urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${urlPath}`);
  return res.json();
}

(async () => {
  const token = await getToken();

  // Resolve order IDs for POs we don't have yet
  for (const po of POS) {
    if (!po.orderId) {
      const data = await fetchJson(token, `/models/C_Order?$filter=DocumentNo eq '${po.po}'&$top=1`);
      if (data.records && data.records.length > 0) {
        po.orderId = data.records[0].id;
        console.log(`  ${po.po}: resolved C_Order_ID=${po.orderId}`);
      } else {
        console.log(`  ✗ ${po.po}: not found in iDempiere`);
      }
    }
  }

  // Download print PDF for each
  const results = [];
  for (const po of POS) {
    if (!po.orderId) continue;
    try {
      console.log(`\n[${po.po}] Printing C_Order/${po.orderId}...`);
      const data = await fetchJson(token, `/models/C_Order/${po.orderId}/print`);

      if (data.exportFile) {
        const buf = Buffer.from(data.exportFile, 'base64');
        const outFile = path.join(OUT_DIR, `${po.po}_${po.vendor.replace(/\s+/g, '_')}.pdf`);
        fs.writeFileSync(outFile, buf);
        console.log(`  ✓ ${path.basename(outFile)} — ${buf.length} bytes (${(buf.length/1024).toFixed(0)} KB)`);
        results.push({ po: po.po, vendor: po.vendor, file: outFile, size: buf.length });
      } else {
        console.log(`  ✗ No exportFile in response`);
        console.log(`  Response keys: ${Object.keys(data).join(', ')}`);
      }
    } catch (e) {
      console.error(`  ✗ ${po.po}: ${e.message}`);
    }
  }

  console.log(`\n=== ${results.length} PO copies retrieved ===`);
  for (const r of results) {
    console.log(`  ${r.po} (${r.vendor}): ${path.basename(r.file)} — ${(r.size/1024).toFixed(0)} KB`);
  }
})().catch(e => { console.error(e); process.exit(1); });
