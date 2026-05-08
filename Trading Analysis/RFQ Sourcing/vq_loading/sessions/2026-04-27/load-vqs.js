// Direct VQ load — RFQ 1132932 / Mercury — APAC broker quotes from Elaine Liang.
// Pattern: synthetic distributor stub per quote, route through writeVQFromAPI.
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

const fs = require('fs');
const path = require('path');
const { writeVQFromAPI } = require('/home/analytics_user/workspace/astute-workinstructions/shared/vq-writer');

const SESSION = __dirname;
const EXTRACTIONS = JSON.parse(fs.readFileSync(path.join(SESSION, '8370-extractions.json'), 'utf8'));

const RFQ_SEARCH_KEY = '1132932';
const BUYER_ID = 1006326; // Elaine Liang (elaine.liang@astutegroup.com)

// Vendor info — search_key + vendor type (verified 2026-04-27)
const VENDORS = {
  howeher:           { sk: '1007571', name: 'Howeher Co.，Limited',                    suspended: false },
  pgc:               { sk: '1003648', name: 'PGC-IC Ltd',                              suspended: false },
  fixchip:           { sk: '1002391', name: 'Fixchips Global Limited',                 suspended: false },
  corerine:          { sk: '1006037', name: 'CORERINE TECHNOLOGY CO., LIMITED',        suspended: false },
  mto:               { sk: '1005363', name: 'MTO Technology Co., Ltd- V011284',        suspended: false },
  cmarch:            { sk: '1008484', name: 'CMARCH ELECTRONICS (HK) CO.,LIMITED',     suspended: false },
  valley:            { sk: '1011368', name: 'Valley Electronics(HK) Limited',          suspended: false },
  macroquest:        { sk: '1002407', name: 'Macroquest',                              suspended: false },
  topray:            { sk: '1004485', name: 'Topray Technology (HK) Ltd',              suspended: false },
  archermind:        { sk: '1002301', name: 'Archermind Technology (HK) Ltd',          suspended: false },
  ruifan:            { sk: '1003803', name: 'Hong Kong Ruifan Microelectronics',       suspended: false },
  ssf:               { sk: '1007351', name: 'SSF GROUP (ASIA) LIMITED',                suspended: false },
  'hanglung waiyip': { sk: '1003610', name: 'HANG LUNG TENDA TECHNOLOGY CO., LIMITED', suspended: false },
  // Suspended (vendor type 1000004) — skip for VQ writes
  onway:             { sk: '1003643', name: 'Onway (HK) Technology Ltd',               suspended: true },
  saviliter:         { sk: '1002629', name: 'Saviliter Technology Co., Ltd',           suspended: true },
  wafer:             { sk: '1003688', name: 'Wafer Electronic Technology Co., Ltd',    suspended: true },
};

// COO name → C_Country_ID
const COO_MAP = {
  China:       153,
  Malaysia:    238,
  Philippines: 278,
  Taiwan:      316,
  Thailand:    319,
};

// RFQ line internal IDs for RFQ 1132932 — from psql 2026-04-27
const RFQ_LINE_IDS = {
   10: 3100076,  40: 3100079,  50: 3100080,  70: 3100082,  80: 3100083,
   90: 3100084, 100: 3100085, 130: 3100088, 140: 3100089, 150: 3100090,
  180: 3100093, 190: 3100094, 210: 3100096, 220: 3100097, 240: 3100099,
};

// Map our extraction packaging → packaging ID (from data-model.md)
// 1000005 REEL, 1000006 TRAY, 1000008 F-TUBE, 1000010 OTHER
const PACKAGING_MAP = {
  REEL:     1000005,
  TRAY:     1000006,
  'F-TUBE': 1000008,
};

function buildDistributorStub(record, vendorInfo) {
  const cooId = COO_MAP[record.coo] || null;
  const packagingId = PACKAGING_MAP[record.packaging] || null;
  const isStock = !record.leadTime || /^stock$/i.test(record.leadTime);

  return {
    found:           true,
    name:            vendorInfo.name,
    bpValue:         vendorInfo.sk,
    bpName:          vendorInfo.name,
    // Pre-built vqLines — extractStockAndLtRows returns these as-is
    vqLines: [{
      vendorBP:     vendorInfo.sk,
      vendorName:   vendorInfo.name,
      channel:      'broker',
      mpn:          record.rfqMpn,             // canonical (RFQ MPN)
      manufacturer: record.mfrText || '',
      qty:          record.qty,
      cost:         record.cost,
      moq:          record.moq,
      spq:          record.spq,
      dateCode:     record.dateCode || null,
      leadTime:     isStock ? '' : record.leadTime,
      vendorNotes:  record.vendorNotes || '',
      priceBreaks:  null,
    }],
    // Top-level fields read by writeVQFromAPI
    vqManufacturer: record.mfrText || '',
    vqVendorNotes:  record.vendorNotes || '',
    vqCooCountryId: cooId,
    vqPackagingId:  packagingId,
    vqRohs:         null, // default Y from writer
    vqHts:          null,
    vqEccn:         null,
  };
}

(async () => {
  const skipped = [];
  const written = [];
  const flagged = [];
  const failed = [];

  for (const record of EXTRACTIONS.records) {
    const vendorInfo = VENDORS[record.vendorShortname.toLowerCase()];
    if (!vendorInfo) {
      flagged.push({ ...record, reason: 'UNKNOWN_VENDOR' });
      continue;
    }
    if (vendorInfo.suspended) {
      skipped.push({ ...record, reason: 'VENDOR_SUSPENDED', vendor: vendorInfo.name });
      continue;
    }

    const rfqLineId = RFQ_LINE_IDS[record.rfqLine];
    if (!rfqLineId) {
      flagged.push({ ...record, reason: 'NO_RFQ_LINE_ID' });
      continue;
    }

    const fr = { distributors: [buildDistributorStub(record, vendorInfo)] };

    try {
      const r = await writeVQFromAPI(RFQ_SEARCH_KEY, '', fr, {
        searchedMpn:          record.rfqMpn,
        buyerId:              BUYER_ID,
        rfqQty:               record.qty,
        _rfqLineIdOverride:   rfqLineId,
      });

      if (r.written.length > 0) {
        for (const w of r.written) {
          written.push({ ...record, vqLineId: w.vqLineId, dup: !!w._skippedAsDuplicate });
        }
      }
      if (r.flagged.length > 0) flagged.push(...r.flagged.map((f) => ({ ...record, ...f })));
      if (r.failed.length > 0) failed.push(...r.failed.map((f) => ({ ...record, ...f })));
    } catch (e) {
      failed.push({ ...record, reason: 'EXCEPTION', detail: e.message });
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  const summary = {
    total: EXTRACTIONS.records.length,
    written: written.length,
    skipped: skipped.length,
    flagged: flagged.length,
    failed: failed.length,
    duplicates: written.filter((w) => w.dup).length,
  };

  console.log('\n=== VQ LOAD SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (skipped.length) {
    console.log('\nSkipped (suspended vendor):');
    for (const s of skipped) console.log(`  Line ${s.rfqLine} ${s.rfqMpn} from ${s.vendor} — ${s.reason}`);
  }
  if (flagged.length) {
    console.log('\nFlagged:');
    for (const f of flagged) console.log(`  Line ${f.rfqLine} ${f.rfqMpn} ${f.vendorShortname || f.vendor} — ${f.reason}: ${f.detail || ''}`);
  }
  if (failed.length) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  Line ${f.rfqLine} ${f.rfqMpn} ${f.vendorShortname} — ${f.reason}: ${f.detail || ''}`);
  }

  fs.writeFileSync(
    path.join(SESSION, '8370-load-result.json'),
    JSON.stringify({ summary, written, skipped, flagged, failed }, null, 2)
  );
})().catch((e) => { console.error(e); process.exit(1); });
