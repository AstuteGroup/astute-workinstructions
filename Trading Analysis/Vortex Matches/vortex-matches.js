#!/usr/bin/env node
/**
 * Vortex Matches - Match RFQs against market offers and vendor quotes
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
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// Database connection (uses Unix socket peer authentication)
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica'
});

// Column definitions with format types
const COLUMN_DEFS = {
  'RFQ Number': { width: 12, format: 'text' },
  'RFQ Created': { width: 14, format: 'date' },
  'RFQ Customer': { width: 28, format: 'text' },
  'RFQ MPN': { width: 22, format: 'text' },
  'RFQ Qty': { width: 12, format: 'number' },
  'RFQ Target': { width: 14, format: 'currency_precise' },
  'Customer Part Number': { width: 20, format: 'text' },
  'Type': { width: 8, format: 'text' },
  'MO Type': { width: 28, format: 'text' },
  'Supplier MPN': { width: 22, format: 'text' },
  'Supplier/Excess Partner': { width: 28, format: 'text' },
  'Qty': { width: 12, format: 'number' },
  'Supplier Price': { width: 14, format: 'currency_precise' },
  '% Under Target': { width: 14, format: 'percent' },
  'lead_time': { width: 14, format: 'text' },
  'Date Code': { width: 14, format: 'text' },
  'Created Date': { width: 14, format: 'date' },
  'Days Btw MO/VQ & RFQ': { width: 20, format: 'number' },
  '% of Demand': { width: 14, format: 'percent' },
  'Opp Amount': { width: 14, format: 'currency' }
};

// Column sets for each file type
const COLUMNS = {
  'Good Prices': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price', '% Under Target',
    'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'All Prices': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ Qty',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
    'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'No Prices': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN',
    'Supplier/Excess Partner', 'Qty',
    'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand'
  ],
  'Stock': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'MO Type', 'Supplier MPN',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
    'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
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
      rlm.chuboe_cpc AS customer_part_number
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON r.chuboe_rfq_id = rlm.chuboe_rfq_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    WHERE r.value = $1
    ORDER BY rlm.chuboe_rfq_line_mpn_id
  `;

  const result = await pool.query(query, [rfqNumber]);
  return result.rows;
}

/**
 * Fetch market offers matching the cleaned MPNs
 * - Stock (offer_type LIKE 'Stock -%'): No time filter (our inventory, always current)
 * - Other offers: 90-day window
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
      mol.market_offer_created AS created_date,
      'MO' AS record_type
    FROM adempiere.bi_market_offer_line_v mol
    WHERE mol.market_offer_line_mpn_clean = ANY($1)
      AND mol.market_offer_active = 'Y'
      AND (
        mol.offer_type_name LIKE 'Stock -%'  -- Astute stock: no time filter
        OR mol.market_offer_created >= CURRENT_DATE - INTERVAL '90 days'  -- Others: 90-day window
      )
    ORDER BY mol.market_offer_created DESC
  `;

  const result = await pool.query(query, [cleanMpns]);
  return result.rows;
}

/**
 * Fetch vendor quotes matching the cleaned MPNs (90-day window)
 */
async function fetchVendorQuotes(cleanMpns) {
  if (cleanMpns.length === 0) return [];

  const query = `
    SELECT
      vql.vendor_quote_mpn AS supplier_mpn,
      vql.vendor_quote_mpn_clean AS market_offer_line_mpn_clean,
      vql.vendor_type_name AS mo_type,
      vql.vendor_quote_bpartner_name AS supplier_partner,
      vql.vendor_quote_bpartner_group_name AS vendor_grade,
      vql.vendor_quote_quantity AS qty,
      vql.vendor_quote_cost AS supplier_price,
      vql.vendor_quote_lead_time AS lead_time,
      vql.vendor_quote_date_code AS date_code,
      vql.vendor_quote_created AS created_date,
      'VQ' AS record_type
    FROM adempiere.bi_vendor_quote_line_v vql
    WHERE vql.vendor_quote_mpn_clean = ANY($1)
      AND vql.vendor_quote_created >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY vql.vendor_quote_created DESC
  `;

  const result = await pool.query(query, [cleanMpns]);
  return result.rows;
}

/**
 * Join RFQ data with market offers and vendor quotes
 */
function joinData(rfqRows, offers) {
  const results = [];

  // Create a map of cleaned MPN to RFQ row(s)
  const mpnToRfq = new Map();
  for (const rfq of rfqRows) {
    const cleanMpn = rfq.chuboe_mpn_clean;
    if (!cleanMpn) continue;
    if (!mpnToRfq.has(cleanMpn)) {
      mpnToRfq.set(cleanMpn, []);
    }
    mpnToRfq.get(cleanMpn).push(rfq);
  }

  // Join offers to RFQ rows
  for (const offer of offers) {
    const cleanMpn = offer.market_offer_line_mpn_clean;
    const rfqMatches = mpnToRfq.get(cleanMpn) || [];

    for (const rfq of rfqMatches) {
      const rfqDate = new Date(rfq.rfq_created);
      const offerDate = new Date(offer.created_date);
      const daysBetween = Math.abs(Math.round((offerDate - rfqDate) / (1000 * 60 * 60 * 24)));

      const supplierQty = parseFloat(offer.qty) || 0;
      const rfqQty = parseFloat(rfq.rfq_qty) || 0;
      // Preserve original decimal precision for prices
      const supplierPrice = offer.supplier_price != null ? Number(offer.supplier_price) : 0;
      const rfqTarget = rfq.rfq_target != null ? Number(rfq.rfq_target) : 0;

      // Calculate % under target (stored as decimal 0-1)
      let percentUnderTarget = null;
      if (rfqTarget > 0 && supplierPrice > 0) {
        percentUnderTarget = (rfqTarget - supplierPrice) / rfqTarget;
      }

      // Calculate % of demand (as decimal, e.g., 1.5 = 150%)
      let percentOfDemand = null;
      if (rfqQty > 0) {
        percentOfDemand = supplierQty / rfqQty;
      }

      // Calculate opportunity amount (target price * RFQ qty)
      let oppAmount = null;
      if (rfqTarget > 0 && rfqQty > 0) {
        oppAmount = rfqTarget * rfqQty;
      }

      results.push({
        'RFQ Number': rfq.rfq_number,
        'RFQ Created': rfqDate,
        'RFQ Customer': rfq.customer_name || '',
        'RFQ MPN': rfq.rfq_mpn || '',
        'RFQ Qty': rfqQty,
        'RFQ Target': rfqTarget,
        'Customer Part Number': rfq.customer_part_number || '',
        'Type': offer.record_type,
        'MO Type': offer.mo_type || '',
        'Supplier MPN': offer.supplier_mpn || '',
        'Supplier/Excess Partner': offer.supplier_partner || '',
        'Qty': supplierQty,
        'Supplier Price': supplierPrice,
        '% Under Target': percentUnderTarget,
        'lead_time': offer.lead_time || '',
        'Date Code': offer.date_code || '',
        'Created Date': offerDate,
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
      if (!stockRow['lead_time'] || stockRow['lead_time'].trim() === '') {
        stockRow['lead_time'] = 'STOCK';
      }
      stock.push(stockRow);
    } else if (supplierPrice > 0) {
      // Has pricing
      if (hasTargets) {
        // Check if within 20% above target (price <= target * 1.20)
        const threshold = rfqTarget * 1.20;
        if (rfqTarget > 0 && supplierPrice <= threshold) {
          goodPrices.push(row);
        }
        // Else: dropped (>20% above target or no target for this line)
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
 * Create formatted Excel workbook using ExcelJS
 */
async function createWorkbook(data, columns, fileType) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vortex Matches';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Matches');

  // Define columns with headers and widths
  worksheet.columns = columns.map(col => ({
    header: col,
    key: col,
    width: COLUMN_DEFS[col]?.width || 15
  }));

  // Style header row
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data rows
  for (const row of data) {
    const rowData = {};
    for (const col of columns) {
      rowData[col] = row[col];
    }
    worksheet.addRow(rowData);
  }

  // Apply formatting to columns
  columns.forEach((col, colIndex) => {
    const colDef = COLUMN_DEFS[col];
    if (!colDef) return;

    const column = worksheet.getColumn(colIndex + 1);

    // Apply number format based on column type
    switch (colDef.format) {
      case 'currency':
        column.numFmt = '"$"#,##0.00';
        break;
      case 'currency_precise':
        // Preserve source decimals (up to 6 decimal places)
        column.numFmt = '"$"#,##0.00####';
        break;
      case 'percent':
        column.numFmt = '0.00%';
        break;
      case 'number':
        column.numFmt = '#,##0';
        break;
      case 'date':
        column.numFmt = 'yyyy-mm-dd';
        break;
    }
  });

  return workbook;
}

/**
 * Write workbook to file
 */
async function writeWorkbook(workbook, outputPath) {
  await workbook.xlsx.writeFile(outputPath);
  const worksheet = workbook.getWorksheet('Matches');
  console.log(`  Created: ${path.basename(outputPath)} (${worksheet.rowCount - 1} rows)`);
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
    console.log(`   Found ${marketOffers.length} market offers`);

    // Fetch vendor quotes
    console.log('\n3. Searching vendor quotes (90-day window)...');
    const vendorQuotes = await fetchVendorQuotes(cleanMpns);
    console.log(`   Found ${vendorQuotes.length} vendor quotes`);

    // Combine offers
    const allOffers = [...marketOffers, ...vendorQuotes];
    console.log(`   Total: ${allOffers.length} offers`);

    if (allOffers.length === 0) {
      console.log('\nNo matching offers found for this RFQ.');
      await pool.end();
      return;
    }

    // Join data
    console.log('\n4. Joining RFQ and offer data...');
    const joinedData = joinData(rfqRows, allOffers);
    console.log(`   ${joinedData.length} matched records`);

    // Categorize results
    console.log('\n5. Categorizing results...');
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
    console.log('\n6. Generating Excel files...');

    if (stock.length > 0) {
      const wb = await createWorkbook(stock, COLUMNS['Stock'], 'Stock');
      await writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_Stock.xlsx`));
    }

    if (hasTargets && goodPrices.length > 0) {
      const wb = await createWorkbook(goodPrices, COLUMNS['Good Prices'], 'Good Prices');
      await writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_Good Prices.xlsx`));
    }

    if (!hasTargets && allPrices.length > 0) {
      const wb = await createWorkbook(allPrices, COLUMNS['All Prices'], 'All Prices');
      await writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_All Prices.xlsx`));
    }

    if (noPrices.length > 0) {
      const wb = await createWorkbook(noPrices, COLUMNS['No Prices'], 'No Prices');
      await writeWorkbook(wb, path.join(outputDir, `${rfqNumber}_No Prices.xlsx`));
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
