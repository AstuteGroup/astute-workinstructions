const { execSync } = require('child_process');
const fs = require('fs');

// Load existing extractions
const existingCsv = fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/verified-extractions-all-enriched.csv', 'utf8');
const existingLines = existingCsv.trim().split('\n').slice(1); // Skip header

const existingRecords = existingLines.map(line => {
  const parts = line.split(',');
  return {
    emailId: parts[0],
    mpn: parts[1],
    qty: parts[2],
    price: parts[3],
    dc: parts[4],
    vendor_email: parts[5],
    vendor_name: parts[6],
    vendor_search_key: parts[7],
    rfq_number: parts[8]
  };
});

console.log(`Loaded ${existingRecords.length} existing records`);

// Load new extractions (6774-6943)
const newExtractionsJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/new-extractions-6774-6943.json', 'utf8'));

// Flatten all sections
const newRecords = [
  ...newExtractionsJson.manualExtractions,
  ...newExtractionsJson.agent1_6806_6850,
  ...newExtractionsJson.agent2_6851_6900,
  ...newExtractionsJson.agent3_6901_6943
];

console.log(`Loaded ${newRecords.length} new records (6774-6943)`);

// Load old extractions (2xxx-5xxx)
let oldRecords = [];
try {
  const oldExtractionsJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/old-extractions-2xxx-5xxx.json', 'utf8'));
  oldRecords = oldExtractionsJson.extracted_quotes || [];
  console.log(`Loaded ${oldRecords.length} old records (2xxx-5xxx)`);
} catch (e) {
  console.log('No old extractions file found, skipping');
}

// Load no-bid records
let noBidRecords = [];
try {
  const noBidJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/nobid-extractions.json', 'utf8'));
  noBidRecords = noBidJson.records || [];
  console.log(`Loaded ${noBidRecords.length} no-bid records`);
} catch (e) {
  console.log('No no-bid extractions file found, skipping');
}

// Load PDF extractions (new comprehensive file)
let pdfRecords = [];
try {
  const pdfJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/pdf-extractions-new.json', 'utf8'));
  pdfRecords = pdfJson.records || [];
  console.log(`Loaded ${pdfRecords.length} PDF records`);
} catch (e) {
  console.log('No PDF extractions file found, skipping');
}

// Load remaining extractions (quotes + no-bids + target price)
let remainingQuotes = [];
let remainingNoBids = [];
try {
  const remainingJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/remaining-extractions.json', 'utf8'));
  remainingQuotes = remainingJson.quotes || [];
  // Combine no_bids and target_price as they both have qty=0, price=0
  remainingNoBids = [...(remainingJson.no_bids || []), ...(remainingJson.target_price || [])];
  console.log(`Loaded ${remainingQuotes.length} remaining quotes, ${remainingNoBids.length} remaining no-bids/target-price`);
} catch (e) {
  console.log('No remaining extractions file found, skipping');
}

// Get all unique vendor emails
const allEmails = [...new Set([
  ...existingRecords.map(r => r.vendor_email?.toLowerCase()),
  ...newRecords.map(r => r.vendor_email?.toLowerCase()),
  ...oldRecords.map(r => r.vendor_email?.toLowerCase()),
  ...noBidRecords.map(r => r.vendor_email?.toLowerCase()),
  ...pdfRecords.map(r => r.vendor_email?.toLowerCase()),
  ...remainingQuotes.map(r => r.vendor_email?.toLowerCase()),
  ...remainingNoBids.map(r => r.vendor_email?.toLowerCase())
].filter(Boolean))];

console.log(`${allEmails.length} unique vendor emails to lookup`);

// Query vendor search keys from database (exact email match)
function queryVendorSearchKeys() {
  const emailList = allEmails.map(e => `'${e.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT LOWER(au.email) as vendor_email, bp.value as search_key
    FROM adempiere.ad_user au
    JOIN adempiere.c_bpartner bp ON au.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(au.email) IN (${emailList})
    AND bp.value NOT LIKE 'USE %'
    AND bp.isactive = 'Y'
  `;

  try {
    const result = execSync(`psql -t -A -c "${sql.replace(/\n/g, ' ')}"`, { encoding: 'utf8' });
    const vendorMap = {};
    result.trim().split('\n').filter(l => l).forEach(line => {
      const [email, searchKey] = line.split('|');
      if (email && searchKey) {
        vendorMap[email.toLowerCase()] = searchKey;
      }
    });
    return vendorMap;
  } catch (e) {
    console.error('Error querying vendors:', e.message);
    return {};
  }
}

// Query vendor search keys by domain (fallback for unmatched emails)
function queryVendorsByDomain() {
  // Get all unique domains from emails
  const allDomains = [...new Set(allEmails.map(e => e.split('@')[1]?.toLowerCase()).filter(Boolean))];
  const domainList = allDomains.map(d => `'${d.replace(/'/g, "''")}'`).join(',');

  const sql = `
    SELECT DISTINCT
      LOWER(SUBSTRING(au.email FROM POSITION('@' IN au.email) + 1)) as domain,
      bp.value as search_key
    FROM adempiere.ad_user au
    JOIN adempiere.c_bpartner bp ON au.c_bpartner_id = bp.c_bpartner_id
    WHERE bp.value NOT LIKE 'USE %'
    AND bp.isactive = 'Y'
    AND LOWER(SUBSTRING(au.email FROM POSITION('@' IN au.email) + 1)) IN (${domainList})
  `;

  try {
    const result = execSync(`psql -t -A -c "${sql.replace(/\n/g, ' ')}"`, { encoding: 'utf8' });
    const domainMap = {};
    result.trim().split('\n').filter(l => l).forEach(line => {
      const [domain, searchKey] = line.split('|');
      if (domain && searchKey && !domainMap[domain]) {
        // Only store first match per domain (avoid duplicates)
        domainMap[domain] = searchKey;
      }
    });
    return domainMap;
  } catch (e) {
    console.error('Error querying vendors by domain:', e.message);
    return {};
  }
}

// Helper to find vendor search key with fallback to domain
function findVendorSearchKey(email, vendorMap, domainMap) {
  if (!email) return 'NOT_FOUND';
  const lowerEmail = email.toLowerCase();

  // Try exact match first
  if (vendorMap[lowerEmail]) return vendorMap[lowerEmail];

  // Fallback to domain match
  const domain = lowerEmail.split('@')[1];
  if (domain && domainMap[domain]) return domainMap[domain];

  return 'NOT_FOUND';
}

// Query RFQ numbers by MPN
function queryRfqNumbers() {
  const allMpns = [...new Set([
    ...existingRecords.map(r => r.mpn?.toUpperCase()),
    ...newRecords.map(r => r.mpn?.toUpperCase()),
    ...oldRecords.map(r => r.mpn?.toUpperCase()),
    ...noBidRecords.map(r => r.mpn?.toUpperCase()),
    ...pdfRecords.map(r => r.mpn?.toUpperCase()),
    ...remainingQuotes.map(r => r.mpn?.toUpperCase()),
    ...remainingNoBids.map(r => r.mpn?.toUpperCase())
  ].filter(Boolean))];

  // Create patterns for fuzzy matching (remove trailing characters)
  const mpnPatterns = allMpns.flatMap(mpn => {
    const patterns = [mpn];
    // Add trimmed versions
    if (mpn.length > 6) {
      patterns.push(mpn.slice(0, -1));
      patterns.push(mpn.slice(0, -2));
    }
    return patterns;
  });

  const sql = `
    SELECT DISTINCT UPPER(vl.chuboe_mpn) as mpn, r.value as rfq_number
    FROM adempiere.chuboe_vq_line vl
    JOIN adempiere.chuboe_rfq r ON vl.chuboe_rfq_id = r.chuboe_rfq_id
    WHERE vl.chuboe_rfq_id IS NOT NULL
    AND vl.created >= CURRENT_DATE - INTERVAL '60 days'
  `;

  try {
    const result = execSync(`psql -t -A -c "${sql}"`, { encoding: 'utf8' });
    const rfqMap = {};
    result.trim().split('\n').filter(l => l).forEach(line => {
      const [mpn, rfqNum] = line.split('|');
      if (mpn && rfqNum) {
        // Clean the MPN from database too (remove commas, hyphens, etc.)
        const cleanedDbMpn = mpn.toUpperCase().replace(/[-\/\.\s_#,]/g, '');
        rfqMap[cleanedDbMpn] = rfqNum;
      }
    });
    return rfqMap;
  } catch (e) {
    console.error('Error querying RFQs:', e.message);
    return {};
  }
}

// Query RFQ from the correct table: chuboe_rfq_line_mpn
function queryRfqFromLineMpn() {
  const sql = `
    SELECT UPPER(rlm.chuboe_mpn_clean) as mpn_clean, r.value as rfq_number
    FROM adempiere.chuboe_rfq_line_mpn rlm
    JOIN adempiere.chuboe_rfq r ON rlm.chuboe_rfq_id = r.chuboe_rfq_id
    WHERE r.created >= CURRENT_DATE - INTERVAL '60 days'
    AND rlm.chuboe_mpn_clean IS NOT NULL
    AND rlm.chuboe_mpn_clean != ''
  `;

  try {
    const result = execSync(`psql -t -A -c "${sql}"`, { encoding: 'utf8' });
    const rfqMap = {};
    result.trim().split('\n').filter(l => l).forEach(line => {
      const [mpn, rfqNum] = line.split('|');
      if (mpn && rfqNum) {
        // Clean the MPN from database too (remove commas, hyphens, etc.)
        const cleanedDbMpn = mpn.toUpperCase().replace(/[-\/\.\s_#,]/g, '');
        rfqMap[cleanedDbMpn] = rfqNum;
      }
    });
    return rfqMap;
  } catch (e) {
    console.error('Error querying RFQ line MPNs:', e.message);
    return {};
  }
}

// Clean MPN to match database format (remove special chars)
function cleanMpn(mpn) {
  // Remove all common MPN separators: hyphen, slash, dot, space, underscore, hash, comma
  return mpn.toUpperCase().replace(/[-\/\.\s_#,]/g, '');
}

// Main enrichment
const vendorMap = queryVendorSearchKeys();
const domainMap = queryVendorsByDomain();
console.log(`Found ${Object.keys(vendorMap).length} vendor search keys (exact), ${Object.keys(domainMap).length} domain mappings`);

const rfqMap = queryRfqNumbers();
const rfqLineMpnMap = queryRfqFromLineMpn();
const combinedRfqMap = { ...rfqMap, ...rfqLineMpnMap };
console.log(`Found ${Object.keys(combinedRfqMap).length} RFQ mappings (${Object.keys(rfqLineMpnMap).length} from rfq_line_mpn)`);

// Helper to find RFQ with fuzzy matching
function findRfq(mpn) {
  const upperMpn = mpn.toUpperCase();
  const cleanedMpn = cleanMpn(mpn);

  // Try cleaned MPN first (matches database format)
  if (combinedRfqMap[cleanedMpn]) return combinedRfqMap[cleanedMpn];

  // Exact match with original format
  if (combinedRfqMap[upperMpn]) return combinedRfqMap[upperMpn];

  // Try variations of cleaned MPN
  const variations = [
    cleanedMpn.replace(/E3$/, ''),
    cleanedMpn.replace(/NOPB$/, ''),
    cleanedMpn.replace(/T1E3$/, 'E3'),
    cleanedMpn.replace(/TR$/, ''),
    cleanedMpn.replace(/LF$/, ''),
    cleanedMpn.slice(0, -1),
    cleanedMpn.slice(0, -2),
    cleanedMpn.slice(0, -3)
  ];

  for (const v of variations) {
    if (combinedRfqMap[v]) return combinedRfqMap[v];
  }

  return 'NOT_FOUND';
}

// Enrich new records
const enrichedNew = newRecords.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: r.qty,
  price: r.price,
  dc: r.dc || '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn)
}));

// Enrich old records
const enrichedOld = oldRecords.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: r.qty,
  price: r.price,
  dc: r.dc || '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn)
}));

// Enrich no-bid records
const enrichedNoBid = noBidRecords.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: 0,
  price: 0,
  dc: '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn),
  notes: r.notes || 'No-bid'
}));

// Enrich PDF records
const enrichedPdf = pdfRecords.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: r.qty,
  price: r.price,
  dc: r.dc || '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn),
  notes: r.notes || ''
}));

// Enrich remaining quotes
const enrichedRemainingQuotes = remainingQuotes.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: r.qty,
  price: r.price,
  dc: r.dc || '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn),
  notes: r.notes || ''
}));

// Enrich remaining no-bids (qty=0, price=0)
const enrichedRemainingNoBids = remainingNoBids.map(r => ({
  emailId: r.emailId,
  mpn: r.mpn,
  qty: 0,
  price: 0,
  dc: '',
  vendor_email: r.vendor_email,
  vendor_name: r.vendor_name,
  vendor_search_key: findVendorSearchKey(r.vendor_email, vendorMap, domainMap),
  rfq_number: findRfq(r.mpn),
  notes: r.notes || 'No-bid'
}));

// Update existing records that had NOT_FOUND for vendor_search_key
const updatedExisting = existingRecords.map(r => ({
  ...r,
  vendor_search_key: r.vendor_search_key === 'NOT_FOUND'
    ? (findVendorSearchKey(r.vendor_email, vendorMap, domainMap))
    : r.vendor_search_key,
  rfq_number: r.rfq_number === 'NOT_FOUND'
    ? findRfq(r.mpn)
    : r.rfq_number
}));

// Combine all records, sort by emailId
const allRecords = [...updatedExisting, ...enrichedNew, ...enrichedOld, ...enrichedNoBid, ...enrichedPdf, ...enrichedRemainingQuotes, ...enrichedRemainingNoBids]
  .sort((a, b) => parseInt(a.emailId) - parseInt(b.emailId));

// Remove exact duplicates (same emailId, mpn, qty, price, vendor_email)
const seen = new Set();
const deduped = allRecords.filter(r => {
  const key = `${r.emailId}|${r.mpn}|${r.qty}|${r.price}|${r.vendor_email}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(`\nFinal count: ${deduped.length} records (${allRecords.length - deduped.length} duplicates removed)`);

// Stats
const vendorFound = deduped.filter(r => r.vendor_search_key !== 'NOT_FOUND').length;
const rfqFound = deduped.filter(r => r.rfq_number !== 'NOT_FOUND').length;
console.log(`Vendor search_key found: ${vendorFound}/${deduped.length}`);
console.log(`RFQ number found: ${rfqFound}/${deduped.length}`);

// ============================================================================
// OUTPUT: VQ Mass Upload Template format (friendly column names)
// ============================================================================
// Template: RFQ Search Key,Buyer,Business Partner Search Key,Contact,MPN,
//           MFR Text,Quoted Quantity,Cost,Currency,Date Code,MOQ,SPQ,
//           Packaging,Lead Time,COO,RoHS,Vendor Notes

const VQ_HEADER = 'RFQ Search Key,Buyer,Business Partner Search Key,Contact,MPN,MFR Text,Quoted Quantity,Cost,Currency,Date Code,MOQ,SPQ,Packaging,Lead Time,COO,RoHS,Vendor Notes';

// Escape CSV field (quote if contains comma, quote, or newline)
function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Format record to VQ Mass Upload Template format
function formatVqLine(r) {
  // Build vendor notes
  // - Alternate MPN goes here as "Quoted MPN: xxx"
  // - Other notes from extraction
  let vendorNotes = r.notes || '';

  // Currency: blank if USD, only specify for EUR/GBP/other
  const currency = (r.currency && r.currency !== 'USD') ? r.currency : '';

  // No-bid check: qty=0 and price=0
  const isNoBid = parseFloat(r.qty) === 0 && parseFloat(r.price) === 0;

  // Lead Time: default to "stock" unless it's a no-bid
  const leadTime = isNoBid ? '' : (r.lead_time || 'stock');

  return [
    r.rfq_number === 'NOT_FOUND' ? 'NEEDS_RFQ' : r.rfq_number,  // RFQ Search Key
    'Jake Harris',                                               // Buyer (all emails forwarded by Jake)
    escapeCsvField(r.vendor_search_key),                         // Business Partner Search Key
    '',                                                          // Contact (not captured)
    escapeCsvField(r.mpn),                                       // MPN (escape commas)
    escapeCsvField(r.mfr || ''),                                 // MFR Text
    r.qty,                                                       // Quoted Quantity
    r.price,                                                     // Cost
    currency,                                                    // Currency (blank = USD)
    escapeCsvField(r.dc || ''),                                  // Date Code (may contain commas)
    r.moq || '',                                                 // MOQ
    r.spq || '',                                                 // SPQ
    escapeCsvField(r.packaging || ''),                           // Packaging
    escapeCsvField(leadTime),                                    // Lead Time
    r.coo || '',                                                 // COO
    r.rohs || '',                                                // RoHS
    escapeCsvField(vendorNotes)                                  // Vendor Notes
  ].join(',');
}

// Tracking header for internal use (includes source info for debugging)
const TRACKING_HEADER = 'emailId,mpn,qty,price,dc,vendor_email,vendor_name,vendor_search_key,rfq_number,notes,mfr,currency,moq,spq,packaging,lead_time,coo,rohs';

function formatTrackingLine(r) {
  return [
    r.emailId,
    escapeCsvField(r.mpn),
    r.qty,
    r.price,
    escapeCsvField(r.dc || ''),
    escapeCsvField(r.vendor_email),
    escapeCsvField(r.vendor_name),
    r.vendor_search_key,
    r.rfq_number,
    escapeCsvField(r.notes || ''),
    escapeCsvField(r.mfr || ''),
    r.currency || 'USD',
    r.moq || '',
    r.spq || '',
    escapeCsvField(r.packaging || ''),
    escapeCsvField(r.lead_time || ''),
    r.coo || '',
    r.rohs || ''
  ].join(',');
}

// Split records: upload-ready vs needs-vendor
// Upload-ready: has vendor_search_key AND has RFQ (or explicitly NEEDS_RFQ)
const uploadReady = deduped.filter(r => r.vendor_search_key !== 'NOT_FOUND');

// Write VQ Mass Upload format (ready for iDempiere import)
fs.writeFileSync(
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/vq-upload-ready.csv',
  [VQ_HEADER, ...uploadReady.map(formatVqLine)].join('\n')
);

// Write tracking format (for reference/debugging)
fs.writeFileSync(
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/vq-upload-ready-tracking.csv',
  [TRACKING_HEADER, ...uploadReady.map(formatTrackingLine)].join('\n')
);

// Needs-vendor: complete quotes (qty>0, price>0) missing vendor
const needsVendor = deduped.filter(r =>
  r.vendor_search_key === 'NOT_FOUND' &&
  parseFloat(r.qty) > 0 &&
  parseFloat(r.price) > 0
);
fs.writeFileSync(
  '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Sourcing/vq_loading/needs-vendor.csv',
  [TRACKING_HEADER, ...needsVendor.map(formatTrackingLine)].join('\n')
);

console.log('\nFinal outputs:');
console.log(`  - vq-upload-ready.csv (${uploadReady.length} records) - VQ Mass Upload Template format`);
console.log(`  - vq-upload-ready-tracking.csv - Source tracking info`);
console.log(`  - needs-vendor.csv (${needsVendor.length} records, ${[...new Set(needsVendor.map(r => r.vendor_email))].length} vendors to add)`);

// Warn about missing data
console.log('\n⚠️  MISSING DATA (not captured during extraction):');
console.log('  - chuboe_mfr_text (manufacturer)');
console.log('  - c_currency_id (defaults to USD - EUR/GBP vendors need manual fix)');
console.log('  - c_country_id (COO)');
console.log('  - chuboe_rohs');
console.log('  - chuboe_lead_time');
