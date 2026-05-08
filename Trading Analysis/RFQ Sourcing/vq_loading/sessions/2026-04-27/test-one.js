// Smoke test: write ONE VQ to verify the synthetic-stub path works end-to-end.
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const fs = require('fs');
const path = require('path');
const { writeVQFromAPI } = require('/home/analytics_user/workspace/astute-workinstructions/shared/vq-writer');

const EXTRACTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '8370-extractions.json'), 'utf8')
);

// Pick first quote: howeher / DH82029PCH S LKM8 / 330 @ $62.21
const record = EXTRACTIONS.records[0];
console.log('Test record:', record);

const fr = {
  distributors: [{
    found: true,
    name: 'Howeher Co.，Limited',
    bpValue: '1007571',
    bpName: 'Howeher Co.，Limited',
    vqLines: [{
      vendorBP: '1007571',
      vendorName: 'Howeher Co.，Limited',
      channel: 'broker',
      mpn: record.rfqMpn,
      manufacturer: record.mfrText || '',
      qty: record.qty,
      cost: record.cost,
      moq: null,
      spq: null,
      dateCode: record.dateCode,
      leadTime: '',
      vendorNotes: record.vendorNotes || '',
      priceBreaks: null,
    }],
    vqManufacturer: record.mfrText || '',
    vqVendorNotes: record.vendorNotes || '',
    vqCooCountryId: null, // howeher quote has no COO
    vqPackagingId: null,
    vqRohs: null,
    vqHts: null,
    vqEccn: null,
  }],
};

(async () => {
  const r = await writeVQFromAPI('1132932', '', fr, {
    searchedMpn:        record.rfqMpn,
    buyerId:            1006326, // Elaine Liang
    rfqQty:             record.qty,
    _rfqLineIdOverride: 3100088, // Line 130
  });
  console.log('\nResult:', JSON.stringify(r, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
