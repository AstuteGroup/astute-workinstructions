#!/usr/bin/env node
/**
 * Vortex Matches - Match RFQs against market offers
 *
 * Usage: node vortex-matches.js <rfq_number>
 * Example: node vortex-matches.js 1130263
 *
 * Generates Excel files in output/ directory:
 * - {RFQ}_Stock.xlsx - Always (if stock matches exist)
 * - {RFQ}_Good Prices.xlsx - Only if customer targets exist
 * - {RFQ}_All Prices.xlsx - Only if NO customer targets
 * - {RFQ}_No Prices.xlsx - Always (if no-price matches exist)
 */

const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// Database connection (uses Unix socket peer authentication)
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica'
});

// Column definitions with format types
const COLUMN_DEFS = {
  'RFQ': { header: 'RFQ', width: 10, format: 'text' },
  'RFQ Date': { header: 'RFQ Date', width: 12, format: 'date' },
  'Customer': { header: 'Customer', width: 25, format: 'text' },
  'RFQ MPN': { header: 'RFQ MPN', width: 20, format: 'text' },
  'RFQ Qty': { header: 'RFQ Qty', width: 12, format: 'number' },
  'RFQ Target': { header: 'RFQ Target', width: 12, format: 'currency' },
  'Customer Part #': { header: 'Customer Part #', width: 18, format: 'text' },
  'RFQ Manufacturer': { header: 'RFQ Manufacturer', width: 18, format: 'text' },
  'Type': { header: 'Type', width: 8, format: 'text' },
  'MO Type': { header: 'MO Type', width: 25, format: 'text' },
  'Supplier MPN': { header: 'Supplier MPN', width: 20, format: 'text' },
  'Supplier/Excess Partner': { header: 'Supplier/Excess Partner', width: 25, format: 'text' },
  'Vendor Grade': { header: 'Vendor Grade', width: 12, format: 'text' },
  'Supplier Qty': { header: 'Supplier Qty', width: 12, format: 'number' },
  'Supplier Price': { header: 'Supplier Price', width: 14, format: 'currency' },
  '% Under Target': { header: '% Under Target', width: 14, format: 'percent' },
  'Lead Time': { header: 'Lead Time', width: 12, format: 'text' },
  'Date Code': { header: 'Date Code', width: 12, format: 'text' },
  'Offer Date': { header: 'Offer Date', width: 12, format: 'date' },
  'Days Btw MO/VQ & RFQ': { header: 'Days Btw MO/VQ & RFQ', width: 18, format: 'number' },
  '% of Demand': { header: '% of Demand', width: 12, format: 'percent' },
  'Opp Amount': { header: 'Opp Amount', width: 14, format: 'currency' }
};

// Column sets for each file type
const COLUMNS = {
  'Good Prices': [
    'RFQ', 'RFQ Date', 'Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target', 'Customer Part #', 'RFQ Manufacturer',
    'Type', 'MO Type', 'Supplier MPN', 'Supplier/Excess Partner', 'Vendor Grade', 'Supplier Qty', 'Supplier Price',
    '% Under Target', 'Lead Time', 'Date Code', 'Offer Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'All Prices': [
    'RFQ', 'RFQ Date', 'Customer', 'RFQ MPN', 'RFQ Qty', 'Customer Part #', 'RFQ Manufacturer',
    'Type', 'MO Type', 'Supplier MPN', 'Supplier/Excess Partner', 'Vendor Grade', 'Supplier Qty', 'Supplier Price',
    'Lead Time', 'Date Code', 'Offer Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'No Prices': [
    'RFQ', 'RFQ Date', 'Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target', 'Customer Part #', 'RFQ Manufacturer',
    'Type', 'MO Type', 'Supplier MPN', 'Supplier/Excess Partner', 'Vendor Grade', 'Supplier Qty', 'Supplier Price',
    'Lead Time', 'Date Code', 'Offer Date', 'Days Btw MO/VQ & RFQ', '% of Demand'
  ],
  'Stock': [
    'RFQ', 'RFQ Date', 'Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target', 'Customer Part #', 'RFQ Manufacturer',
    'MO Type', 'Supplier MPN', 'Supplier/Excess Partner', 'Supplier Qty', 'Supplier Price',
    'Lead Time', 'Date Code', 'Offer Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ]
};

/**
 * Fetch RFQ details from database
 */
async function fetchRfqDetails(rfqNumber) {
  const query = `
    SELECT
      r.value AS rfq_number,
      r.created AS rfq_created,
      bp.name AS customer_name,
      rlm.chuboe_mpn AS rfq_mpn,
      rlm.chuboe_mpn_clean,
      rlm.qty AS rfq_qty,
      rlm.priceentered AS rfq_target,
      rlm.chuboe_cpc AS customer_part_number,
      mfr.name AS rfq_manufacturer
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON r.chuboe_rfq_id = rlm.chuboe_rfq_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.c_bpartner mfr ON rlm.chuboe_mfr_id = mfr.c_bpartner_id
    WHERE r.value = $1
    ORDER BY rlm.chuboe_rfq_line_mpn_id
  `;

  const result = await pool.query(query, [rfqNumber]);
  return result.rows;
}

/**
 * Fetch market offers matching the cleaned MPNs
 */
async function fetchMarketOffers(cleanMpns) {
  if (cleanMpns.length === 0) return [];

  const query = `
    SELECT
      mol.market_offer_line_mpn AS supplier_mpn,
      mol.market_offer_line_mpn_clean,
      mol.offer_type_name AS mo_type,
      mol.market_offer_bpartner_name AS supplier_partner,
      mol.market_offer_bpartner_ehs_grade AS vendor_grade,
      mol.market_offer_line_quantity AS qty,
      mol.market_offer_line_price AS supplier_price,
      mol.market_offer_line_lead_time AS lead_time,
      mol.market_offer_line_date_code AS date_code,
      mol.market_offer_created AS created_date
    FROM adempiere.bi_market_offer_line_v mol
    WHERE mol.market_offer_line_mpn_clean = ANY($1)
      AND mol.market_offer_created >= CURRENT_DATE - INTERVAL '90 days'
      AND mol.market_offer_active = 'Y'
    ORDER BY mol.market_offer_created DESC
  `;

  const result = await pool.query(query, [cleanMpns]);
  return result.rows;
}

/**
 * Join RFQ data with market offers
 */
function joinData(rfqRows, marketOffers) {
  const results = [];

  // Create a map of cleaned MPN to RFQ row(s)
  const mpnToRfq = new Map();
  for (const rfq of rfqRows) {
    const cleanMpn = rfq.chuboe_mpn_clean;
    if (!mpnToRfq.has(cleanMpn)) {
      mpnToRfq.set(cleanMpn, []);
    }
    mpnToRfq.get(cleanMpn).push(rfq);
  }

  // Join market offers to RFQ rows
  for (const offer of marketOffers) {
    const cleanMpn = offer.market_offer_line_mpn_clean;
    const rfqMatches = mpnToRfq.get(cleanMpn) || [];

    for (const rfq of rfqMatches) {
      const rfqDate = new Date(rfq.rfq_created);
      const offerDate = new Date(offer.created_date);
      const daysBetween = Math.abs(Math.round((offerDate - rfqDate) / (1000 * 60 * 60 * 24)));

      const supplierQty = parseFloat(offer.qty) || 0;
      const rfqQty = parseFloat(rfq.rfq_qty) || 0;
      const supplierPrice = parseFloat(offer.supplier_price) || 0;
      const rfqTarget = parseFloat(rfq.rfq_target) || 0;

      // Calculate % under target
      let percentUnderTarget = null;
      if (rfqTarget > 0 && supplierPrice > 0) {
        percentUnderTarget = ((rfqTarget - supplierPrice) / rfqTarget) * 100;
      }

      // Calculate % of demand
      let percentOfDemand = null;
      if (rfqQty > 0 && supplierQty > 0) {
        percentOfDemand = (supplierQty / rfqQty) * 100;
      }

      // Calculate opportunity amount
      let oppAmount = null;
      if (supplierQty > 0 && supplierPrice > 0) {
        oppAmount = supplierQty * supplierPrice;
      }

      results.push({
        'RFQ': rfq.rfq_number,
        'RFQ Date': rfqDate,
        'Customer': rfq.customer_name || '',
        'RFQ MPN': rfq.rfq_mpn || '',
        'RFQ Qty': rfqQty,
        'RFQ Target': rfqTarget,
        'Customer Part #': rfq.customer_part_number || '',
        'RFQ Manufacturer': rfq.rfq_manufacturer || '',
        'Type': 'MO',
        'MO Type': offer.mo_type || '',
        'Supplier MPN': offer.supplier_mpn || '',
        'Supplier/Excess Partner': offer.supplier_partner || '',
        'Vendor Grade': offer.vendor_grade || '',
        'Supplier Qty': supplierQty,
        'Supplier Price': supplierPrice,
        '% Under Target': percentUnderTarget,
        'Lead Time': offer.lead_time || '',
        'Date Code': offer.date_code || '',
        'Offer Date': offerDate,
        'Days Btw MO/VQ & RFQ': daysBetween,
        '% of Demand': percentOfDemand,
        'Opp Amount': oppAmount
      });
    }
  }

  return results;
}

/**
 * Categorize results into Stock, Good Prices, All Prices, No Prices
 */
function categorizeResults(joinedData, hasTargets) {
  const stock = [];
  const goodPrices = [];
  const allPrices = [];
  const noPrices = [];

  for (const row of joinedData) {
    const moType = (row['MO Type'] || '').toLowerCase();
    const isStock = moType.startsWith('stock -');
    const supplierPrice = row['Supplier Price'] || 0;
    const rfqTarget = row['RFQ Target'] || 0;

    if (isStock) {
      // Stock file - default lead time to "STOCK" if blank
      const stockRow = { ...row };
      if (!stockRow['Lead Time'] || stockRow['Lead Time'].trim() === '') {
        stockRow['Lead Time'] = 'STOCK';
      }
      stock.push(stockRow);
    } else if (supplierPrice > 0) {
      // Has pricing
      if (hasTargets) {
        // Check if within 20% above target
        const threshold = rfqTarget * 1.20;
        if (supplierPrice <= threshold) {
          goodPrices.push(row);
        }
        // Else: dropped (>20% above target)
      } else {
        // No targets - all priced offers go to All Prices
        allPrices.push(row);
      }
    } else {
      // No pricing
      noPrices.push(row);
    }
  }

  return { stock, goodPrices, allPrices, noPrices };
}

/**
 * Create formatted Excel workbook
 */
function createWorkbook(data, columns, fileType) {
  // Filter data to only include specified columns
  const filteredData = data.map(row => {
    const newRow = {};
    for (const col of columns) {
      newRow[col] = row[col];
    }
    return newRow;
  });

  // Create worksheet from data
  const ws = XLSX.utils.json_to_sheet(filteredData, { header: columns });

  // Set column widths
  const colWidths = columns.map(col => ({ wch: COLUMN_DEFS[col]?.width || 15 }));
  ws['!cols'] = colWidths;

  // Apply formatting to cells
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  for (let C = range.s.c; C <= range.e.c; C++) {
    const colName = columns[C];
    const colDef = COLUMN_DEFS[colName];
    if (!colDef) continue;

    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[cellAddress];
      if (!cell) continue;

      // Apply number format based on column type
      switch (colDef.format) {
        case 'currency':
          if (typeof cell.v === 'number') {
            cell.z = '"$"#,##0.00';
          }
          break;
        case 'percent':
          if (typeof cell.v === 'number') {
            // Store as decimal, display as percentage
            cell.z = '0.00%';
            cell.v = cell.v / 100;
          }
          break;
        case 'number':
          if (typeof cell.v === 'number') {
            cell.z = '#,##0';
          }
          break;
        case 'date':
          if (cell.v instanceof Date) {
            cell.t = 'd';
            cell.z = 'yyyy-mm-dd';
          }
          break;
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Matches');

  return wb;
}

/**
 * Write workbook to file
 */
function writeWorkbook(wb, outputPath) {
  XLSX.writeFile(wb, outputPath);
  console.log(`  Created: ${path.basename(outputPath)} (${wb.Sheets['Matches']['!ref'] ? XLSX.utils.decode_range(wb.Sheets['Matches']['!ref']).e.r : 0} rows)`);
}

/**
 * Main function
 */
async function main() {
  const rfqNumber = process.argv[2];

  if (!rfqNumber) {
    console.error('Usage: node vortex-matches.js <rfq_number>');
    console.error('Example: node vortex-matches.js 1130263');
    process.exit(1);
  }

  console.log(`\nVortex Matches - Processing RFQ ${rfqNumber}`);
  console.log('='.repeat(50));

  try {
    // Fetch RFQ details
    console.log('\n1. Fetching RFQ details...');
    const rfqRows = await fetchRfqDetails(rfqNumber);

    if (rfqRows.length === 0) {
      console.error(`Error: RFQ ${rfqNumber} not found`);
      process.exit(1);
    }

    console.log(`   Found ${rfqRows.length} line items`);

    // Get unique cleaned MPNs
    const cleanMpns = [...new Set(rfqRows.map(r => r.chuboe_mpn_clean).filter(Boolean))];
    console.log(`   ${cleanMpns.length} unique MPNs to search`);

    // Check if customer provided targets
    const hasTargets = rfqRows.some(r => r.rfq_target && parseFloat(r.rfq_target) > 0);
    console.log(`   Customer targets: ${hasTargets ? 'Yes' : 'No'}`);

    // Fetch market offers
    console.log('\n2. Searching market offers (90-day window)...');
    const marketOffers = await fetchMarketOffers(cleanMpns);
    console.log(`   Found ${marketOffers.length} matching offers`);

    if (marketOffers.length === 0) {
      console.log('\nNo market offers found for this RFQ.');
      await pool.end();
      return;
    }

    // Join data
    console.log('\n3. Joining RFQ and market offer data...');
    const joinedData = joinData(rfqRows, marketOffers);
    console.log(`   ${joinedData.length} matched records`);

    // Categorize results
    console.log('\n4. Categorizing results...');
    const { stock, goodPrices, allPrices, noPrices } = categorizeResults(joinedData, hasTargets);
    console.log(`   Stock: ${stock.length}`);
    if (hasTargets) {
      console.log(`   Good Prices (<=20% above target): ${goodPrices.length}`);
    } else {
      console.log(`   All Prices: ${allPrices.length}`);
    }
    console.log(`   No Prices: ${noPrices.length}`);

    // Ensure output directory exists
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate output files
    console.log('\n5. Generating Excel files...');

    if (stock.length > 0) {
      const wb = createWorkbook(stock, COLUMNS['Stock'], 'Stock');
      writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_Stock.xlsx`));
    }

    if (hasTargets && goodPrices.length > 0) {
      const wb = createWorkbook(goodPrices, COLUMNS['Good Prices'], 'Good Prices');
      writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_Good Prices.xlsx`));
    }

    if (!hasTargets && allPrices.length > 0) {
      const wb = createWorkbook(allPrices, COLUMNS['All Prices'], 'All Prices');
      writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_All Prices.xlsx`));
    }

    if (noPrices.length > 0) {
      const wb = createWorkbook(noPrices, COLUMNS['No Prices'], 'No Prices');
      writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_No Prices.xlsx`));
    }

    console.log('\nDone!');
    console.log(`Output files in: ${outputDir}`);

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
