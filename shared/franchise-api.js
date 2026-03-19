/**
 * Centralized Franchise Distributor API Module
 *
 * Calls ALL active franchise distributor APIs and returns standardized results.
 * Each API hit with stock produces VQ-ready data for ERP import.
 *
 * USAGE:
 *   const { searchAllDistributors, searchPart } = require('../shared/franchise-api');
 *
 *   // Search all distributors for a part
 *   const results = await searchAllDistributors('ADS1115IDGST', 700);
 *   console.log(results.summary);       // { totalStock, lowestPrice, distributorCount }
 *   console.log(results.distributors);   // Array of per-distributor results
 *   console.log(results.vqLines);        // VQ-ready rows for ERP import
 *
 *   // Search a single distributor
 *   const dk = await searchPart('digikey', 'ADS1115IDGST', 700);
 *
 * CONSUMERS:
 *   - Franchise Screening: stock vs demand → skip/proceed decision
 *   - Suggested Resale: price levels + availability as scarcity signal
 *   - VQ Loading: generate VQ template rows from API data
 *   - Quick Quote: franchise price as ceiling reference
 *
 * IMPORTANT:
 *   - API data = confirmed pricing → captured as VQ lines
 *   - FindChips scraped data is NOT handled here (availability-only, see main.js)
 */

const path = require('path');

// All active distributor API modules
const API_DIR = path.resolve(__dirname, '../Trading Analysis/RFQ Sourcing/franchise_check');

const DISTRIBUTORS = {
  digikey: {
    name: 'DigiKey',
    script: path.join(API_DIR, 'digikey.js'),
    bpValue: '1002331',
    bpName: 'Digi-Key Electronics',
    bpId: 1000327,
    active: true,
  },
  arrow: {
    name: 'Arrow',
    script: path.join(API_DIR, 'arrow.js'),
    bpValue: '1002390',
    bpName: 'Arrow Electronics',
    bpId: 1000386,
    active: true,
  },
  rutronik: {
    name: 'Rutronik',
    script: path.join(API_DIR, 'rutronik.js'),
    bpValue: '1004668',
    bpName: 'Rutronik Inc.',
    bpId: 1002668,
    active: true,
  },
  future: {
    name: 'Future',
    script: path.join(API_DIR, 'future.js'),
    bpValue: '1002332',
    bpName: 'Future Electronics Corporation',
    bpId: 1000328,
    active: true,
  },
  newark: {
    name: 'Newark/Farnell',
    script: path.join(API_DIR, 'newark.js'),
    bpValue: '1002394',
    bpName: 'Newark in One (Element 14)',
    bpId: 1000390,
    active: true,
  },
  tti: {
    name: 'TTI',
    script: path.join(API_DIR, 'tti.js'),
    bpValue: '1002330',
    bpName: 'TTI Inc',
    bpId: 1000326,
    active: true,
  },
  master: {
    name: 'Master',
    script: path.join(API_DIR, 'master.js'),
    bpValue: '1002409',
    bpName: 'Master Electronics',
    bpId: 1000405,
    active: true,
  },
};

/**
 * Call a single distributor API
 * Each script exports searchPart(mpn, qty) → result object
 */
async function searchPart(distributor, mpn, qty) {
  const config = DISTRIBUTORS[distributor];
  if (!config || !config.active) {
    return { distributor, name: config?.name || distributor, found: false, error: 'Not configured or inactive' };
  }

  try {
    const mod = require(config.script);
    const result = await mod.searchPart(mpn, qty);

    return {
      distributor,
      name: config.name,
      bpValue: config.bpValue,
      bpName: config.bpName,
      bpId: config.bpId,
      found: result.found || false,
      franchiseQty: result.franchiseQty || 0,
      franchisePrice: result.franchisePrice || null,       // unit price (qty=1)
      franchiseBulkPrice: result.franchiseBulkPrice || null, // lowest price break
      franchiseRfqPrice: result.franchiseRfqPrice || null,   // price at RFQ qty
      // VQ-ready fields
      vqPrice: result.vqPrice || result.franchiseRfqPrice || null,
      vqMpn: result.vqMpn || mpn,
      vqManufacturer: result.vqManufacturer || '',
      vqDescription: result.vqDescription || '',
      vqVendorNotes: result.vqVendorNotes || '',
      vqDateCode: result.vqDateCode || '',
      vqLeadTime: result.vqLeadTime || '',
      // Raw result for workflow-specific needs
      raw: result,
    };
  } catch (err) {
    return {
      distributor,
      name: config.name,
      found: false,
      error: err.message,
      franchiseQty: 0,
    };
  }
}

/**
 * Search ALL active distributors for a part
 * Returns aggregated results + VQ-ready lines
 */
async function searchAllDistributors(mpn, qty, options = {}) {
  const { parallel = true, exclude = [], onResult = null } = options;

  const activeDistributors = Object.keys(DISTRIBUTORS)
    .filter(d => DISTRIBUTORS[d].active && !exclude.includes(d));

  let results;
  if (parallel) {
    // Run all APIs concurrently
    results = await Promise.all(
      activeDistributors.map(async (d) => {
        const result = await searchPart(d, mpn, qty);
        if (onResult) onResult(result); // callback for progress reporting
        return result;
      })
    );
  } else {
    // Sequential (for rate-limit-sensitive scenarios)
    results = [];
    for (const d of activeDistributors) {
      const result = await searchPart(d, mpn, qty);
      if (onResult) onResult(result);
      results.push(result);
    }
  }

  // Aggregate
  const found = results.filter(r => r.found && r.franchiseQty > 0);
  const allPrices = found.map(r => r.franchiseBulkPrice).filter(p => p != null && p > 0);
  const totalStock = found.reduce((sum, r) => sum + (r.franchiseQty || 0), 0);

  const summary = {
    mpn,
    qty,
    totalStock,
    distributorsWithStock: found.length,
    distributorsChecked: results.length,
    lowestPrice: allPrices.length > 0 ? Math.min(...allPrices) : null,
    highestPrice: allPrices.length > 0 ? Math.max(...allPrices) : null,
    medianPrice: allPrices.length > 0 ? allPrices.sort((a, b) => a - b)[Math.floor(allPrices.length / 2)] : null,
    // Availability assessment
    coverage: totalStock >= qty ? 'FULL' : totalStock > 0 ? 'PARTIAL' : 'NONE',
    coveragePct: qty > 0 ? Math.round(totalStock / qty * 100) : 0,
  };

  // Generate VQ lines for each distributor with stock+pricing (API data = confirmed → log as VQ)
  const vqLines = found
    .filter(r => r.vqPrice != null && r.vqPrice > 0)
    .map(r => ({
      vendorBP: r.bpValue,
      vendorName: r.bpName,
      mpn: r.vqMpn,
      manufacturer: r.vqManufacturer,
      cost: r.vqPrice,
      qty: r.franchiseQty,
      description: r.vqDescription,
      vendorNotes: r.vqVendorNotes,
      dateCode: r.vqDateCode,
      leadTime: r.vqLeadTime,
    }));

  return {
    summary,
    distributors: results,
    found,
    vqLines,
  };
}

/**
 * Get list of active distributors
 */
function getActiveDistributors() {
  return Object.entries(DISTRIBUTORS)
    .filter(([, v]) => v.active)
    .map(([key, v]) => ({ key, ...v }));
}

/**
 * Write VQ capture file from search results
 */
function writeVQCapture(filePath, vqLines) {
  const fs = require('fs');
  if (vqLines.length === 0) return null;

  const header = 'Vendor BP,Vendor Name,MPN,Manufacturer,Cost,Qty Available,Description,Vendor Notes,Date Code,Lead Time';
  const rows = vqLines.map(v => [
    v.vendorBP,
    `"${v.vendorName}"`,
    `"${v.mpn}"`,
    `"${v.manufacturer}"`,
    v.cost,
    v.qty,
    `"${v.description}"`,
    `"${v.vendorNotes}"`,
    `"${v.dateCode || ''}"`,
    `"${v.leadTime || ''}"`,
  ].join(','));

  fs.writeFileSync(filePath, [header, ...rows].join('\n') + '\n');
  return filePath;
}

module.exports = {
  searchPart,
  searchAllDistributors,
  getActiveDistributors,
  writeVQCapture,
  DISTRIBUTORS,
};
