const { execSync } = require('child_process');
const fs = require('fs');

// Load existing extractions
const existingCsv = fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/verified-extractions-all-enriched.csv', 'utf8');
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
const newExtractionsJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/new-extractions-6774-6943.json', 'utf8'));

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
  const oldExtractionsJson = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/old-extractions-2xxx-5xxx.json', 'utf8'));
  oldRecords = oldExtractionsJson.extracted_quotes || [];
  console.log(`Loaded ${oldRecords.length} old records (2xxx-5xxx)`);
} catch (e) {
  console.log('No old extractions file found, skipping');
}

// Get all unique vendor emails
const allEmails = [...new Set([
  ...existingRecords.map(r => r.vendor_email?.toLowerCase()),
  ...newRecords.map(r => r.vendor_email?.toLowerCase()),
  ...oldRecords.map(r => r.vendor_email?.toLowerCase())
].filter(Boolean))];

console.log(`${allEmails.length} unique vendor emails to lookup`);

// Query vendor search keys from database
function queryVendorSearchKeys() {
  const emailList = allEmails.map(e => `'${e.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT LOWER(au.email) as vendor_email, bp.value as search_key
    FROM adempiere.ad_user au
    JOIN adempiere.c_bpartner bp ON au.c_bpartner_id = bp.c_bpartner_id
    WHERE LOWER(au.email) IN (${emailList})
    AND bp.value NOT LIKE 'USE %'
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

// Query RFQ numbers by MPN
function queryRfqNumbers() {
  const allMpns = [...new Set([
    ...existingRecords.map(r => r.mpn?.toUpperCase()),
    ...newRecords.map(r => r.mpn?.toUpperCase()),
    ...oldRecords.map(r => r.mpn?.toUpperCase())
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
        rfqMap[mpn.toUpperCase()] = rfqNum;
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
        // Store the cleaned MPN format
        rfqMap[mpn.toUpperCase()] = rfqNum;
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
  return mpn.toUpperCase().replace(/[-\/\.\s_#]/g, '');
}

// Main enrichment
const vendorMap = queryVendorSearchKeys();
console.log(`Found ${Object.keys(vendorMap).length} vendor search keys`);

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
  vendor_search_key: vendorMap[r.vendor_email?.toLowerCase()] || 'NOT_FOUND',
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
  vendor_search_key: vendorMap[r.vendor_email?.toLowerCase()] || 'NOT_FOUND',
  rfq_number: findRfq(r.mpn)
}));

// Update existing records that had NOT_FOUND for vendor_search_key
const updatedExisting = existingRecords.map(r => ({
  ...r,
  vendor_search_key: r.vendor_search_key === 'NOT_FOUND'
    ? (vendorMap[r.vendor_email?.toLowerCase()] || 'NOT_FOUND')
    : r.vendor_search_key,
  rfq_number: r.rfq_number === 'NOT_FOUND'
    ? findRfq(r.mpn)
    : r.rfq_number
}));

// Combine all records, sort by emailId
const allRecords = [...updatedExisting, ...enrichedNew, ...enrichedOld]
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

// Write CSV
const csvHeader = 'emailId,mpn,qty,price,dc,vendor_email,vendor_name,vendor_search_key,rfq_number';
const csvLines = deduped.map(r =>
  `${r.emailId},${r.mpn},${r.qty},${r.price},${r.dc || ''},${r.vendor_email},${r.vendor_name},${r.vendor_search_key},${r.rfq_number}`
);

const csvOutput = [csvHeader, ...csvLines].join('\n');
fs.writeFileSync('/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/verified-extractions-all-enriched.csv', csvOutput);

// Write JSON
const jsonOutput = {
  extractedAt: new Date().toISOString().split('T')[0],
  totalRecords: deduped.length,
  vendorFoundCount: vendorFound,
  rfqFoundCount: rfqFound,
  records: deduped
};
fs.writeFileSync('/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/verified-extractions-all.json', JSON.stringify(jsonOutput, null, 2));

console.log('\nFiles written:');
console.log('  - verified-extractions-all-enriched.csv');
console.log('  - verified-extractions-all.json');
