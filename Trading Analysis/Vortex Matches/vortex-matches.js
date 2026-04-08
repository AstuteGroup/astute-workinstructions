#!/usr/bin/env node
/**
 * Vortex Matches - Match RFQs against market offers and vendor quotes
 *
 * Two entry points:
 *
 * 1. CLI (testing/manual):  node vortex-matches.js <rfq_number>
 *    Runs in-memory and prints a summary. Does NOT write files or send mail.
 *    Add --email to additionally email Jake the result.
 *
 * 2. Library: const { runVortexForRFQ } = require('./vortex-matches');
 *    Returns { rfqNumber, customer, hasTargets, summary, attachments[] }
 *    where attachments[] = [{ filename, content: Buffer }, ...]
 *    Used by vortex-poller.js for inbox-driven automation.
 */

const { Pool } = require('pg');
const ExcelJS = require('exceljs');

// Database connection (uses Unix socket peer authentication).
// `user` must be set explicitly because cron-launched processes don't
// inherit $USER, and libpq falls back to "no PostgreSQL user name specified".
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
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
    'RFQ Number', '% Under Target', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
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
 * Dedupes RFQ lines with identical MPN + qty + target + customer part number
 */
async function fetchRfqDetails(rfqNumber) {
  const query = `
    SELECT DISTINCT ON (rlm.chuboe_mpn_clean, rlm.qty, rlm.priceentered, COALESCE(rlm.chuboe_cpc, ''))
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
    ORDER BY rlm.chuboe_mpn_clean, rlm.qty, rlm.priceentered, COALESCE(rlm.chuboe_cpc, ''), rlm.chuboe_rfq_line_mpn_id
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
      NULL AS mo_type,
      vql.vendor_quote_bpartner_name AS supplier_partner,
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
      // Stock file - default lead time to "STOCK" if blank, leave price blank if 0
      const stockRow = { ...row };
      if (!stockRow['lead_time'] || stockRow['lead_time'].trim() === '') {
        stockRow['lead_time'] = 'STOCK';
      }
      if (stockRow['Supplier Price'] === 0) {
        stockRow['Supplier Price'] = null;
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
 * Serialize a workbook to a Buffer (in-memory, no file I/O)
 */
async function workbookToBuffer(workbook) {
  return await workbook.xlsx.writeBuffer();
}

/**
 * Library entry point — runs all match logic in memory and returns
 * attachments as Buffers. No file I/O, no SMTP.
 *
 * Returns:
 *   {
 *     rfqNumber, customer, hasTargets,
 *     summary: { stock, goodPrices, allPrices, noPrices, totalLines, uniqueMpns },
 *     attachments: [{ filename: '1130263_Stock.xlsx', content: Buffer }, ...]
 *   }
 *
 * Throws if RFQ not found.
 */
async function runVortexForRFQ(rfqNumber, { log = () => {} } = {}) {
  log(`Vortex: processing RFQ ${rfqNumber}`);

  const rfqRows = await fetchRfqDetails(rfqNumber);
  if (rfqRows.length === 0) {
    const err = new Error(`RFQ ${rfqNumber} not found`);
    err.code = 'RFQ_NOT_FOUND';
    throw err;
  }

  const customer = rfqRows[0].customer_name || '';
  const cleanMpns = [...new Set(rfqRows.map(r => r.chuboe_mpn_clean).filter(Boolean))];
  const hasTargets = rfqRows.some(r => r.rfq_target && parseFloat(r.rfq_target) > 0);

  log(`  ${rfqRows.length} lines, ${cleanMpns.length} unique MPNs, targets=${hasTargets}`);

  const [marketOffers, vendorQuotes] = await Promise.all([
    fetchMarketOffers(cleanMpns),
    fetchVendorQuotes(cleanMpns)
  ]);
  const allOffers = [...marketOffers, ...vendorQuotes];
  log(`  ${marketOffers.length} MOs + ${vendorQuotes.length} VQs = ${allOffers.length} offers`);

  const joinedData = joinData(rfqRows, allOffers);
  const { stock, goodPrices, allPrices, noPrices } = categorizeResults(joinedData, hasTargets);

  const summary = {
    customer,
    rfqLines: rfqRows.length,
    uniqueMpns: cleanMpns.length,
    hasTargets,
    stock: stock.length,
    goodPrices: goodPrices.length,
    allPrices: allPrices.length,
    noPrices: noPrices.length,
    totalMatches: joinedData.length
  };

  const attachments = [];

  async function pushFile(rows, columnSet, label) {
    if (rows.length === 0) return;
    const wb = await createWorkbook(rows, COLUMNS[columnSet], columnSet);
    const buf = await workbookToBuffer(wb);
    attachments.push({ filename: `${rfqNumber}_${label}.xlsx`, content: buf });
  }

  await pushFile(stock, 'Stock', 'Stock');
  if (hasTargets) {
    await pushFile(goodPrices, 'Good Prices', 'Good Prices');
  } else {
    await pushFile(allPrices, 'All Prices', 'All Prices');
  }
  await pushFile(noPrices, 'No Prices', 'No Prices');

  return { rfqNumber, customer, hasTargets, summary, attachments };
}

/**
 * Build an HTML email body summarizing a vortex run.
 */
function buildSummaryHtml(result) {
  const { rfqNumber, customer, hasTargets, summary } = result;
  const priceLine = hasTargets
    ? `<tr><td>Good Prices (≤20% above target)</td><td style="text-align:right"><b>${summary.goodPrices}</b></td></tr>`
    : `<tr><td>All Prices (no customer targets)</td><td style="text-align:right"><b>${summary.allPrices}</b></td></tr>`;

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="margin:0 0 8px 0">Vortex Matches — RFQ ${rfqNumber}</h2>
<p style="margin:0 0 12px 0"><b>Customer:</b> ${escapeHtml(customer)}<br/>
<b>RFQ lines:</b> ${summary.rfqLines} &nbsp;|&nbsp; <b>Unique MPNs:</b> ${summary.uniqueMpns} &nbsp;|&nbsp; <b>Customer targets:</b> ${hasTargets ? 'Yes' : 'No'}</p>
<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #ddd;min-width:340px">
  <tr style="background:#f0f0f0;font-weight:bold"><td>Bucket</td><td style="text-align:right">Rows</td></tr>
  <tr><td>Stock (Astute inventory)</td><td style="text-align:right"><b>${summary.stock}</b></td></tr>
  ${priceLine}
  <tr><td>No Prices (supply leads)</td><td style="text-align:right"><b>${summary.noPrices}</b></td></tr>
  <tr style="background:#fafafa"><td><b>Total matches</b></td><td style="text-align:right"><b>${summary.totalMatches}</b></td></tr>
</table>
<p style="margin:14px 0 4px 0;color:#666;font-size:11px">Generated by Vortex Matches automation. Attached workbooks contain the full row-level detail.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * CLI entry point — for testing only. Prints summary; does not write files.
 */
async function cliMain() {
  const rfqNumber = process.argv[2];
  if (!rfqNumber) {
    console.error('Usage: node vortex-matches.js <rfq_number>');
    console.error('  Runs in-memory and prints a summary. No files written.');
    console.error('  For email-driven automation, use vortex-poller.js.');
    process.exit(1);
  }

  try {
    const result = await runVortexForRFQ(rfqNumber, { log: msg => console.log(msg) });
    console.log('\nSummary:');
    console.log(JSON.stringify(result.summary, null, 2));
    console.log(`\nAttachments built: ${result.attachments.length}`);
    for (const a of result.attachments) {
      console.log(`  - ${a.filename}  (${a.content.length} bytes)`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    if (err.code !== 'RFQ_NOT_FOUND') console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

module.exports = { runVortexForRFQ, buildSummaryHtml };

// Run CLI only when invoked directly
if (require.main === module) {
  cliMain();
}
