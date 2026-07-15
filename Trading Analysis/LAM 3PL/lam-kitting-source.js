#!/usr/bin/env node
/**
 * LAM Kitting Sourcing Script
 *
 * Runs franchise screening on reorder alerts and enriches with sourcing data.
 * Uses the franchise API modules from Trading Analysis/RFQ Sourcing/franchise_check/
 *
 * Usage:
 *   node lam-kitting-source.js <reorder-alerts-csv> [output-csv]
 *
 * Example:
 *   node lam-kitting-source.js output/LAM_Reorder_Alerts_2026-03-17.csv
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Use shared franchise API module (single source of truth for all distributor APIs)
const { searchAllDistributors } = require('../../shared/franchise-api');
const { writePricingResult } = require('../../shared/api-result-writer');
const { isRestrictedMfr } = require('../../shared/restricted-mfrs');

// Use shared CSV utility
const { readCSVFile } = require('../../shared/csv-utils');

const DELAY_BETWEEN_PARTS = 500; // ms between parts to avoid rate limiting
const DELAY_BETWEEN_MPNS = 200;  // ms between MPN queries within same CPC

// MPN switch tracking file
const MPN_SWITCH_FILE = path.join(__dirname, 'lam-mpn-switches.json');

/**
 * Log an MPN switch when sourcing picks an alternate MPN over the roster MPN.
 * These are CANDIDATES for switching - user confirms which ones to actually buy.
 *
 * @param {Object} switchData - { cpc, fromMPN, toMPN, reason, qtyNeeded, supplier, price }
 */
function logMPNSwitchCandidate(switchData) {
  let data = { description: 'Tracks MPN switch candidates from sourcing. User confirms actual switches.', candidates: [], switches: [] };

  if (fs.existsSync(MPN_SWITCH_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(MPN_SWITCH_FILE, 'utf-8'));
      // Ensure both arrays exist (backwards compat)
      if (!data.candidates) data.candidates = [];
      if (!data.switches) data.switches = [];
    } catch (e) {
      console.log(`  WARNING: Could not parse ${MPN_SWITCH_FILE}: ${e.message}`);
    }
  }

  // Add to candidates (not confirmed switches yet)
  const today = new Date().toISOString().split('T')[0];
  const candidate = {
    cpc: switchData.cpc,
    fromMPN: switchData.fromMPN,
    toMPN: switchData.toMPN,
    date: today,
    reason: switchData.reason || 'Sourcing found better option',
    supplier: switchData.supplier || '',
    price: switchData.price || '',
    qtyNeeded: switchData.qtyNeeded || 0,
  };

  // Check if already a candidate (don't duplicate)
  const exists = data.candidates.some(c =>
    c.cpc === candidate.cpc && c.fromMPN === candidate.fromMPN && c.toMPN === candidate.toMPN
  );

  if (!exists) {
    data.candidates.push(candidate);
    fs.writeFileSync(MPN_SWITCH_FILE, JSON.stringify(data, null, 2) + '\n');
  }
}

// -----------------------------------------------------------------------------
// AVL Loader - Load complete AVL for multi-MPN sourcing
// -----------------------------------------------------------------------------

let _avlCache = null;

/**
 * Load the complete AVL (CPC -> [MPN, MPN, ...])
 * Returns a Map of CPC -> array of { mpn, mfr, preferred }
 */
function loadAVL() {
  if (_avlCache) return _avlCache;

  const avlPath = path.join(__dirname, 'LAM_Complete_AVL.xlsx');
  if (!fs.existsSync(avlPath)) {
    console.log('  WARNING: LAM_Complete_AVL.xlsx not found - using roster MPN only');
    _avlCache = new Map();
    return _avlCache;
  }

  const wb = XLSX.readFile(avlPath);
  const ws = wb.Sheets['Complete AVL'];
  if (!ws) {
    console.log('  WARNING: Complete AVL sheet not found');
    _avlCache = new Map();
    return _avlCache;
  }

  const data = XLSX.utils.sheet_to_json(ws);
  _avlCache = new Map();

  for (const row of data) {
    const cpc = row.CPC;
    if (!cpc) continue;

    if (!_avlCache.has(cpc)) {
      _avlCache.set(cpc, []);
    }

    _avlCache.get(cpc).push({
      mpn: row.MPN,
      mfr: row.Manufacturer,
      preferred: row.Preferred === 'Y',
      source: row.Source
    });
  }

  return _avlCache;
}

/**
 * Get all approved MPNs for a CPC
 * Returns array sorted by: LAM-AVL source first, then preferred, then alphabetically
 */
function getApprovedMPNs(cpc, rosterMpn) {
  const avl = loadAVL();
  const entries = avl.get(cpc);

  if (!entries || entries.length === 0) {
    // No AVL data - use roster MPN as sole option
    return [{ mpn: rosterMpn, mfr: '', preferred: true, source: 'Roster-Fallback' }];
  }

  // Source priority: LAM-AVL > Kitting > NewParts > others
  const sourcePriority = {
    'LAM-AVL': 1,
    'Kitting-AVL': 2,
    'Kitting-HVM': 2,
    'NewParts-AVL': 3,
    'EPG-Alternates': 4,
    'Roster-Only': 5
  };

  // Sort: LAM-AVL first, then preferred, then alphabetically
  return entries.sort((a, b) => {
    const aPri = sourcePriority[a.source] || 10;
    const bPri = sourcePriority[b.source] || 10;
    if (aPri !== bPri) return aPri - bPri;
    if (a.preferred && !b.preferred) return -1;
    if (!a.preferred && b.preferred) return 1;
    return (a.mpn || '').localeCompare(b.mpn || '');
  });
}

// -----------------------------------------------------------------------------
// Shared state for partial-write support
// -----------------------------------------------------------------------------

let _outputState = null; // { results, totalItems, headers, outputFile }

/**
 * Write whatever results we have so far (sourced + unsourced stubs).
 * Called on normal completion AND on SIGTERM/SIGINT so partial runs
 * still produce a usable output file with unsourced lines flagged.
 */
async function flushOutput() {
  if (!_outputState) return;
  const { results, totalItems, headers, outputFile } = _outputState;

  // "Processed" = anything other than the SKIPPED error state (SOURCED + NO COVERAGE both count)
  const processedCount = results.filter(r => r.sourcingStatus !== 'SKIPPED - TIMEOUT/ERROR').length;
  const isPartial = processedCount < totalItems;

  if (isPartial) {
    console.log('');
    console.log(`⚠️  PARTIAL SOURCING: ${processedCount}/${totalItems} items processed`);
  }

  console.log('');
  console.log('Writing output...');
  await writeEnrichedOutput(results, headers, outputFile);
  console.log(`  CSV written to: ${outputFile}`);

  // Save raw franchise data for downstream VQ writing
  const franchiseDataFile = outputFile.replace('.csv', '_franchise_data.json');
  const franchiseExport = {};
  for (const r of results) {
    const mpn = r.originalRow[headers.indexOf('MPN')];
    if (r.rawFranchise && r.sourcingStatus === 'SOURCED') {
      franchiseExport[mpn] = r.rawFranchise;
    }
  }
  fs.writeFileSync(franchiseDataFile, JSON.stringify(franchiseExport, null, 2));
  console.log(`  Franchise data written to: ${franchiseDataFile}`);

  // Summary
  console.log('');
  console.log('=== Summary ===');
  const sourced = results.filter(r => r.sourcingStatus === 'SOURCED');
  const inStock = sourced.filter(r => r.franchise.inStockSupplier).length;
  const leadTimeOnly = sourced.filter(r => !r.franchise.inStockSupplier && r.franchise.leadTimeSupplier).length;
  const noCoverage = results.filter(r => r.sourcingStatus === 'NO COVERAGE').length;
  const notSourced = results.filter(r => r.sourcingStatus === 'SKIPPED - TIMEOUT/ERROR').length;
  const onOrder = results.filter(r => r.sourcingStatus.startsWith('SKIPPED - PENDING')).length;
  const usedAlternate = results.filter(r => r.selectedMpn).length;
  const multiMpnCpcs = results.filter(r => r.avlCount > 1).length;

  console.log(`  In Stock: ${inStock}`);
  console.log(`  Lead Time Only: ${leadTimeOnly}`);
  console.log(`  NO COVERAGE (APIs returned no match): ${noCoverage}`);
  if (onOrder > 0) {
    console.log(`  Skipped (on order): ${onOrder}`);
  }
  if (notSourced > 0) {
    console.log(`  SKIPPED - TIMEOUT/ERROR (interrupted): ${notSourced}`);
  }

  // AVL stats
  if (multiMpnCpcs > 0) {
    console.log('');
    console.log('=== AVL Multi-MPN Stats ===');
    console.log(`  CPCs with multiple approved MPNs: ${multiMpnCpcs}`);
    console.log(`  Used alternate MPN (better option): ${usedAlternate}`);
  }

  // Log MPN switch candidates (when sourcing found a better alternate)
  const cpcIdx = headers.indexOf('Lam P/N') !== -1 ? headers.indexOf('Lam P/N') : headers.indexOf('CPC');
  const mpnIdx = headers.indexOf('MPN');
  const moqIdx = headers.indexOf('LAM MOQ');

  const switchCandidates = results.filter(r => r.selectedMpn && r.sourcingStatus === 'SOURCED');
  if (switchCandidates.length > 0) {
    console.log('');
    console.log('=== MPN Switch Candidates ===');
    console.log(`  ${switchCandidates.length} items where alternate MPN had better sourcing:`);

    for (const r of switchCandidates) {
      const cpc = r.originalRow[cpcIdx] || '';
      const rosterMpn = r.originalRow[mpnIdx] || '';
      const altMpn = r.selectedMpn;
      const qtyNeeded = parseInt(r.originalRow[moqIdx]) || 0;
      const supplier = r.franchise.inStockSupplier || r.franchise.leadTimeSupplier || '';
      const price = r.franchise.inStockPrice || r.franchise.leadTimePrice || '';

      console.log(`    ${cpc}: ${rosterMpn} → ${altMpn} (${supplier} @ $${price})`);

      // Log to switch tracking file
      logMPNSwitchCandidate({
        cpc,
        fromMPN: rosterMpn,
        toMPN: altMpn,
        reason: 'Sourcing found better franchise option',
        qtyNeeded,
        supplier,
        price,
      });
    }

    console.log('');
    console.log('  Switch candidates logged to lam-mpn-switches.json');
    console.log('  Review and confirm which switches to make permanent.');
  }
}

// Register signal handlers — flush partial results before exit
let _flushing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (_flushing) return; // prevent double-flush
    _flushing = true;
    console.log(`\n[${sig}] Interrupted — writing partial results...`);
    try {
      await flushOutput();
    } catch (err) {
      console.error(`  Failed to write partial results: ${err.message}`);
    }
    process.exit(0); // exit clean so runner can pick up the files
  });
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node lam-kitting-source.js <reorder-alerts-csv> [output-csv]');
    process.exit(1);
  }

  const inputFile = args[0];
  let outputFile = args[1] || inputFile.replace('.csv', '_sourced.csv');

  // Normalize output path - must be .csv (xlsx is auto-generated)
  if (outputFile.endsWith('.xlsx')) {
    console.warn('WARNING: Output must be .csv path (xlsx is auto-generated). Converting...');
    outputFile = outputFile.replace(/\.xlsx$/, '.csv');
  }
  if (!outputFile.endsWith('.csv')) {
    outputFile = outputFile + '.csv';
  }

  console.log('LAM Kitting Sourcing');
  console.log('====================');
  console.log(`Input: ${inputFile}`);
  console.log(`Output: ${outputFile}`);
  console.log('');

  // Load AVL for multi-MPN sourcing
  console.log('Loading AVL...');
  const avl = loadAVL();
  console.log(`  ${avl.size} CPCs in AVL`);

  // Load reorder alerts
  console.log('');
  console.log('Loading reorder alerts...');
  const csv = readCSVFile(inputFile);
  const headers = csv.headers;
  const mpnIdx = headers.indexOf('MPN');
  const cpcIdx = headers.indexOf('Lam P/N') !== -1 ? headers.indexOf('Lam P/N') : headers.indexOf('CPC');
  const moqIdx = headers.indexOf('LAM MOQ');
  const shortfallIdx = headers.indexOf('Shortfall');
  const mfrIdx = headers.indexOf('Manufacturer');
  const priorityIdx = headers.indexOf('Priority');

  if (mpnIdx === -1) {
    console.error('ERROR: MPN column not found');
    process.exit(1);
  }

  if (moqIdx === -1) {
    console.error('ERROR: MOQ column not found');
    process.exit(1);
  }

  // Skip PENDING RECEIPT and PENDING ORDER PLACEMENT items — already on order, no need to source
  const SKIP_PRIORITIES = ['PENDING RECEIPT', 'PENDING ORDER PLACEMENT'];
  const toSkip = priorityIdx >= 0
    ? csv.rows.filter(r => SKIP_PRIORITIES.includes(r[priorityIdx])).length
    : 0;
  const toSource = csv.rows.length - toSkip;

  console.log(`  ${csv.rows.length} total items`);
  if (toSkip > 0) {
    console.log(`  ${toSkip} items skipped (PENDING RECEIPT/ORDER PLACEMENT — already on order)`);
  }
  console.log(`  ${toSource} items to source`);
  console.log(`  Querying at MAX(MOQ, Shortfall) for accurate pricing`);
  console.log('');

  // J5 pause — LAM 3PL Reorder is a foreground workflow; claim the pause
  // for small batches so the background enricher yields. Large batches run
  // alongside (cache hits dedupe; deferring would break the Monday SLA).
  const apiPause = require('../../shared/api-pause');
  const lineCount = csv.rows.length;
  let pauseClaimed = false;
  let pauseRefreshTimer = null;
  if (apiPause.shouldPause(lineCount)) {
    apiPause.claimPause('lam-kitting-source', lineCount);
    pauseClaimed = true;
    pauseRefreshTimer = setInterval(() => apiPause.refreshPause(), 5 * 60 * 1000);
    console.log(`  [pause] claimed (${lineCount} MPNs < 100, TTL 10m) — enricher will yield`);
    console.log('');
  } else {
    console.log(`  [pause] skipped (${lineCount} MPNs ≥ 100) — running alongside enricher`);
    console.log('');
  }

  // Pre-build all result entries as SKIPPED - TIMEOUT/ERROR — ensures every line appears
  // in output even if the process is interrupted partway through
  const results = csv.rows.map(row => ({
    originalRow: row,
    sourcingStatus: 'SKIPPED - TIMEOUT/ERROR',
    franchise: {
      inStockSupplier: '', inStockPrice: '', inStockQty: '',
      leadTimeSupplier: '', leadTimePrice: '', leadTimeWeeks: '',
    },
    selectedMpn: '',      // MPN that was selected (if different from roster)
    avlCount: 1,          // Number of approved MPNs for this CPC
    mpnsQueried: 0,       // Number of MPNs actually queried
  }));

  // Register shared state so signal handlers can flush
  _outputState = { results, totalItems: csv.rows.length, headers, outputFile };

  // Process each item
  console.log('Running franchise screening (with AVL multi-MPN lookup)...');
  console.log('');

  let sourcedCount = 0;
  for (let i = 0; i < csv.rows.length; i++) {
    const row = csv.rows[i];
    const rosterMpn = row[mpnIdx];
    const cpc = cpcIdx >= 0 ? row[cpcIdx] : '';
    const priority = priorityIdx >= 0 ? row[priorityIdx] : '';

    // Skip items already on order — no need to source
    if (SKIP_PRIORITIES.includes(priority)) {
      results[i].sourcingStatus = `SKIPPED - ${priority}`;
      console.log(`[${i + 1}/${csv.rows.length}] ${rosterMpn} — skipped (${priority})`);
      continue;
    }

    sourcedCount++;
    const moq = parseInt(row[moqIdx]) || 100;
    const shortfall = shortfallIdx >= 0 ? (parseInt(row[shortfallIdx]) || 0) : 0;
    const queryQty = Math.max(moq, shortfall);

    // Get all approved MPNs for this CPC
    const approvedMpns = getApprovedMPNs(cpc, rosterMpn);
    results[i].avlCount = approvedMpns.length;

    if (approvedMpns.length > 1) {
      console.log(`[${sourcedCount}/${toSource}] ${cpc} (${approvedMpns.length} approved MPNs, qty: ${queryQty})`);
    } else {
      console.log(`[${sourcedCount}/${toSource}] ${rosterMpn} (qty: ${queryQty})`);
    }

    try {
      // Query ALL approved MPNs and find the best option across all
      let bestInStock = null;
      let bestLeadTime = null;
      let bestInStockMpn = '';
      let bestLeadTimeMpn = '';
      let allRawResults = {};
      let mpnsQueried = 0;
      let anyRestricted = false;
      let restrictedCanonical = null;

      for (const avlEntry of approvedMpns) {
        const mpn = avlEntry.mpn;
        if (!mpn) continue;

        // Check if this MPN's manufacturer is restricted
        const mfrText = avlEntry.mfr || (mfrIdx >= 0 ? row[mfrIdx] : '');
        const restricted = isRestrictedMfr({ mfrName: mfrText });
        if (restricted) {
          anyRestricted = true;
          restrictedCanonical = restricted;
          // Still query for market intel, but won't use for sourcing
        }

        const { trimmed, raw } = await queryFranchiseAPIs(mpn, queryQty);
        mpnsQueried++;
        allRawResults[mpn] = raw;

        if (restricted) {
          // Skip using this MPN for actual sourcing (restricted)
          if (approvedMpns.length > 1) {
            console.log(`    [${mpn}] ⊘ RESTRICTED (${restricted})`);
          }
        } else {
          // Find best options for this MPN
          const inStockOption = findBestInStock(trimmed, queryQty);
          const leadTimeOption = findBestLeadTime(trimmed);

          // Compare to current best
          if (inStockOption) {
            if (!bestInStock || inStockOption.price < bestInStock.price) {
              bestInStock = inStockOption;
              bestInStockMpn = mpn;
            }
            if (approvedMpns.length > 1) {
              console.log(`    [${mpn}] ✓ In Stock: ${inStockOption.supplier} - $${inStockOption.price} x ${inStockOption.qty}`);
            }
          }

          if (leadTimeOption) {
            if (!bestLeadTime || leadTimeOption.price < bestLeadTime.price) {
              bestLeadTime = leadTimeOption;
              bestLeadTimeMpn = mpn;
            }
            if (approvedMpns.length > 1 && !inStockOption) {
              console.log(`    [${mpn}] ~ Lead Time: ${leadTimeOption.supplier} - $${leadTimeOption.price}`);
            }
          }

          if (!inStockOption && !leadTimeOption && approvedMpns.length > 1) {
            console.log(`    [${mpn}] ✗ No coverage`);
          }
        }

        // Delay between MPN queries
        if (mpnsQueried < approvedMpns.length) {
          await sleep(DELAY_BETWEEN_MPNS);
        }
      }

      results[i].mpnsQueried = mpnsQueried;

      // Determine final status and selected MPN
      const foundAny = !!(bestInStock || bestLeadTime);

      // If ALL MPNs are restricted, mark as restricted
      if (anyRestricted && !foundAny && approvedMpns.length === 1) {
        results[i].sourcingStatus = `RESTRICTED - ${restrictedCanonical}`;
        results[i].franchise = {
          inStockSupplier: '', inStockPrice: '', inStockQty: '',
          leadTimeSupplier: '', leadTimePrice: '', leadTimeWeeks: '',
        };
      } else {
        results[i].sourcingStatus = foundAny ? 'SOURCED' : 'NO COVERAGE';
        results[i].franchise = {
          inStockSupplier: bestInStock?.supplier || '',
          inStockPrice: bestInStock?.price || '',
          inStockQty: bestInStock?.qty || '',
          leadTimeSupplier: bestLeadTime?.supplier || '',
          leadTimePrice: bestLeadTime?.price || '',
          leadTimeWeeks: bestLeadTime?.leadTime || '',
        };

        // Track selected MPN if different from roster
        const selectedMpn = bestInStockMpn || bestLeadTimeMpn || '';
        if (selectedMpn && selectedMpn !== rosterMpn) {
          results[i].selectedMpn = selectedMpn;
        }
      }

      // Save raw franchise results for all queried MPNs
      results[i].rawFranchise = allRawResults;

      // Summary for this CPC
      if (approvedMpns.length === 1) {
        // Single MPN - show standard output
        if (results[i].sourcingStatus.startsWith('RESTRICTED')) {
          console.log(`    ⊘ RESTRICTED (${restrictedCanonical}) — franchise pricing hidden`);
        } else if (bestInStock) {
          console.log(`    ✓ In Stock: ${bestInStock.supplier} - $${bestInStock.price} x ${bestInStock.qty}`);
        } else if (bestLeadTime) {
          console.log(`    ~ Lead Time: ${bestLeadTime.supplier} - $${bestLeadTime.price} (${bestLeadTime.leadTime})`);
        } else {
          console.log(`    ✗ No franchise coverage`);
        }
      } else {
        // Multi-MPN - show winner summary
        if (bestInStock) {
          const altNote = bestInStockMpn !== rosterMpn ? ` ★ ALT: ${bestInStockMpn}` : '';
          console.log(`    → BEST: ${bestInStock.supplier} - $${bestInStock.price} x ${bestInStock.qty}${altNote}`);
        } else if (bestLeadTime) {
          const altNote = bestLeadTimeMpn !== rosterMpn ? ` ★ ALT: ${bestLeadTimeMpn}` : '';
          console.log(`    → BEST: ${bestLeadTime.supplier} - $${bestLeadTime.price} (${bestLeadTime.leadTime})${altNote}`);
        } else {
          console.log(`    → No coverage across ${mpnsQueried} MPNs`);
        }
      }
    } catch (err) {
      console.log(`    ✗ ERROR: ${err.message}`);
      // Leave as SKIPPED - TIMEOUT/ERROR, continue to next item
    }

    // Delay between parts
    if (i < csv.rows.length - 1) {
      await sleep(DELAY_BETWEEN_PARTS);
    }
  }

  // Write final output
  await flushOutput();

  // Release pause claim if we made one
  if (pauseClaimed) {
    try {
      clearInterval(pauseRefreshTimer);
      apiPause.releasePause('lam-kitting-source');
      console.log('  [pause] released');
    } catch (e) { /* ignore */ }
  }
}

// -----------------------------------------------------------------------------
// Franchise API Queries
// -----------------------------------------------------------------------------

async function queryFranchiseAPIs(mpn, qty) {
  const aggregated = await searchAllDistributors(mpn, qty);

  // Capture full API pricing data (all price breaks) for market intelligence
  writePricingResult({ searchResult: aggregated, mpn, qty, source: 'lam-kitting' })
    .catch(err => console.error(`  API result capture failed: ${err.message}`));

  const trimmed = {};

  for (const r of aggregated.distributors) {
    if (r.found && (r.franchiseQty > 0 || r.franchiseRfqPrice || r.franchiseBulkPrice)) {
      trimmed[r.name] = {
        qty: r.franchiseQty || 0,
        price: r.franchiseRfqPrice || r.franchiseBulkPrice || null,
        leadTime: r.vqLeadTime || '',
        supplier: r.bpName || r.name,
      };
    }
  }

  return { trimmed, raw: aggregated };
}

// -----------------------------------------------------------------------------
// Find Best Options
// -----------------------------------------------------------------------------

/**
 * Find best in-stock option (has enough qty to cover needed quantity)
 * Returns supplier with lowest price among those with sufficient stock
 */
function findBestInStock(franchiseResults, neededQty) {
  let best = null;
  let bestPartial = null;

  for (const [name, data] of Object.entries(franchiseResults)) {
    if (!data || data.qty <= 0) continue;

    if (data.qty >= neededQty) {
      // Full coverage — pick lowest price
      if (!best || (data.price && data.price < best.price)) {
        best = { ...data, supplier: name };
      }
    } else {
      // Partial stock — track as fallback
      if (!bestPartial || (data.price && data.price < bestPartial.price)) {
        bestPartial = { ...data, supplier: name };
      }
    }
  }

  // Return full coverage winner; if none, return partial with note
  if (best) return best;
  if (bestPartial) {
    bestPartial.partialStock = true;
    return bestPartial;
  }
  return null;
}

/**
 * Find best lead time option (for items without immediate stock)
 * Returns supplier with pricing but no/insufficient stock (lowest price)
 */
function findBestLeadTime(franchiseResults) {
  let best = null;

  for (const [name, data] of Object.entries(franchiseResults)) {
    if (!data || !data.price) continue;

    // Only consider items without stock (lead time orders)
    if (data.qty > 0) continue;

    if (!best) {
      best = { ...data, supplier: name };
      continue;
    }

    // Pick lowest price
    if (data.price < best.price) {
      best = { ...data, supplier: name };
    }
  }

  return best;
}

// -----------------------------------------------------------------------------
// Write Output
// -----------------------------------------------------------------------------

async function writeEnrichedOutput(results, originalHeaders, outputPath) {
  const ExcelJS = require('exceljs');

  // Get resale price index for margin calculations
  const resaleIdx = originalHeaders.indexOf('Resale Price');

  // Simplified columns: In Stock option + Lead Time option + Margins + Status + AVL info
  const newHeaders = [
    'In Stock Supplier',
    'In Stock Price',
    'In Stock Qty',
    'In Stock Margin %',
    'Lead Time Supplier',
    'Lead Time Price',
    'Lead Time (Weeks)',
    'Lead Time Margin %',
    'Sourcing Status',
    'Selected MPN',    // MPN used (if different from roster - alternate was better)
    'AVL Count',       // Number of approved MPNs for this CPC
  ];

  const allHeaders = [...originalHeaders, ...newHeaders];
  const rows = [];

  // Track margin column indices (1-based for ExcelJS)
  const inStockMarginCol = allHeaders.indexOf('In Stock Margin %') + 1;
  const leadTimeMarginCol = allHeaders.indexOf('Lead Time Margin %') + 1;

  for (const result of results) {
    // Keep original values - pass numbers as numbers for Excel formatting
    const originalValues = result.originalRow.map((v, idx) => {
      const header = originalHeaders[idx];
      if (['Base Unit Price', 'Resale Price', 'Historical Purchase Price'].includes(header)) {
        const num = parseFloat(v);
        if (!isNaN(num)) return num;
      }
      if (['Reorder Threshold', 'LAM MOQ', 'QTY ON HAND', 'Shortfall', 'On Order Qty', 'Available Qty (Other WH)'].includes(header)) {
        const num = parseFloat(v);
        if (!isNaN(num)) return num;
      }
      return v;
    });

    // Get resale price for margin calculations
    const resalePrice = parseFloat(result.originalRow[resaleIdx]) || 0;

    // Calculate margins
    const inStockPrice = parseFloat(result.franchise.inStockPrice) || 0;
    const leadTimePrice = parseFloat(result.franchise.leadTimePrice) || 0;

    const inStockMarginNum = (resalePrice > 0 && inStockPrice > 0)
      ? (resalePrice - inStockPrice) / resalePrice * 100
      : null;

    const leadTimeMarginNum = (resalePrice > 0 && leadTimePrice > 0)
      ? (resalePrice - leadTimePrice) / resalePrice * 100
      : null;

    const franchiseValues = [
      result.franchise.inStockSupplier || '',
      result.franchise.inStockPrice ? parseFloat(result.franchise.inStockPrice) : '',
      result.franchise.inStockQty ? parseInt(result.franchise.inStockQty) : '',
      inStockMarginNum,  // Store as number for coloring
      result.franchise.leadTimeSupplier || '',
      result.franchise.leadTimePrice ? parseFloat(result.franchise.leadTimePrice) : '',
      result.franchise.leadTimeWeeks || '',
      leadTimeMarginNum,  // Store as number for coloring
      result.sourcingStatus || 'SOURCED',
      result.selectedMpn || '',           // MPN used if alternate was better
      result.avlCount || 1,               // Number of approved MPNs
    ];

    rows.push([...originalValues, ...franchiseValues]);
  }

  // Create workbook with ExcelJS
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sourced Reorder Alerts');

  // Add header row with styling
  worksheet.addRow(allHeaders);
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' }
  };

  // Add data rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const excelRow = worksheet.addRow(row);

    // Apply margin cell coloring
    const inStockMargin = row[inStockMarginCol - 1];
    const leadTimeMargin = row[leadTimeMarginCol - 1];

    // In Stock Margin cell
    if (inStockMargin !== null && inStockMargin !== undefined) {
      const cell = excelRow.getCell(inStockMarginCol);
      cell.value = inStockMargin / 100;  // Store as decimal for % format
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: getMarginColor(inStockMargin) }
      };
    }

    // Lead Time Margin cell
    if (leadTimeMargin !== null && leadTimeMargin !== undefined) {
      const cell = excelRow.getCell(leadTimeMarginCol);
      cell.value = leadTimeMargin / 100;  // Store as decimal for % format
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: getMarginColor(leadTimeMargin) }
      };
    }

    // Sourcing Status cell — color-code the four states
    //   SKIPPED - TIMEOUT/ERROR → red (needs re-run)
    //   RESTRICTED - <MFR>      → gray (franchise-only program can't buy this — manual)
    //   NO COVERAGE             → orange (APIs clean but zero match — manual sourcing/broker)
    //   SOURCED                 → no fill (default, nothing actionable)
    const statusCol = allHeaders.indexOf('Sourcing Status') + 1;
    const statusVal = row[statusCol - 1];
    if (statusVal === 'SKIPPED - TIMEOUT/ERROR') {
      const cell = excelRow.getCell(statusCol);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF9999' } };
      cell.font = { bold: true };
    } else if (typeof statusVal === 'string' && statusVal.startsWith('RESTRICTED')) {
      const cell = excelRow.getCell(statusCol);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.font = { bold: true };
    } else if (statusVal === 'NO COVERAGE') {
      const cell = excelRow.getCell(statusCol);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD580' } };
      cell.font = { bold: true };
    }

    // W115 Stale Inventory cell — amber highlight when YES
    const staleCol = allHeaders.indexOf('W115 Stale Inventory') + 1;
    if (staleCol > 0) {
      const staleVal = row[staleCol - 1];
      if (staleVal === 'YES') {
        const cell = excelRow.getCell(staleCol);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD580' } };
      }
    }

    // Selected MPN cell — light blue highlight when alternate was used
    const selectedMpnCol = allHeaders.indexOf('Selected MPN') + 1;
    if (selectedMpnCol > 0) {
      const selectedMpnVal = row[selectedMpnCol - 1];
      if (selectedMpnVal) {
        const cell = excelRow.getCell(selectedMpnCol);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF87CEEB' } };  // Light blue
        cell.font = { bold: true };
      }
    }
  }

  // Apply number formats to currency and quantity columns
  const currencyCols = ['Base Unit Price', 'Resale Price', 'Historical Purchase Price', 'In Stock Price', 'Lead Time Price'];
  const intCols = ['Reorder Threshold', 'LAM MOQ', 'QTY ON HAND', 'Shortfall', 'In Stock Qty', 'On Order Qty', 'Available Qty (Other WH)'];
  const pctCols = ['In Stock Margin %', 'Lead Time Margin %'];

  allHeaders.forEach((header, idx) => {
    const colNum = idx + 1;
    if (currencyCols.includes(header)) {
      worksheet.getColumn(colNum).numFmt = '$#,##0.0000';
    } else if (intCols.includes(header)) {
      worksheet.getColumn(colNum).numFmt = '#,##0';
    } else if (pctCols.includes(header)) {
      worksheet.getColumn(colNum).numFmt = '0.0%';
    }
  });

  // Set column widths
  worksheet.columns.forEach((col, idx) => {
    const header = allHeaders[idx];
    if (header === 'Item Description') col.width = 45;
    else if (header === 'Manufacturer' || header.includes('Supplier')) col.width = 25;
    else if (header === 'MPN' || header === 'Lam P/N') col.width = 25;
    else if (header.includes('Margin')) col.width = 15;
    else col.width = 18;
  });

  // Freeze header row
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Write Excel file
  const xlsxPath = outputPath.replace(/\.csv$/, '.xlsx');
  await workbook.xlsx.writeFile(xlsxPath);
  console.log(`  Excel written to: ${xlsxPath}`);

  // Also write CSV for compatibility
  const csvRows = [allHeaders, ...rows.map(row => row.map((v, idx) => {
    // Format margin columns for CSV
    if (idx === inStockMarginCol - 1 || idx === leadTimeMarginCol - 1) {
      return v !== null && v !== undefined ? v.toFixed(1) + '%' : '';
    }
    return v;
  }))];
  const csvLines = csvRows.map(row => row.map(v => formatCSVValue(v)).join(','));
  fs.writeFileSync(outputPath, csvLines.join('\n'));
}

/**
 * Get fill color based on margin threshold
 * >18% = green, 0-18% = yellow, <0% = red
 */
function getMarginColor(margin) {
  if (margin > 18) return 'FF90EE90';  // Light green
  if (margin >= 0) return 'FFFFFF99';   // Light yellow
  return 'FFFF9999';                     // Light red
}

/**
 * Format number as dollar amount
 */
function formatDollar(val) {
  const num = parseFloat(val);
  if (isNaN(num)) return '';
  // Use appropriate decimal places based on value
  if (num >= 1) {
    return '$' + num.toFixed(2);
  } else if (num >= 0.01) {
    return '$' + num.toFixed(4);
  } else {
    return '$' + num.toFixed(6);
  }
}

function formatCSVValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
