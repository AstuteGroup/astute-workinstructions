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
  'RFQ MFR': { width: 18, format: 'text' },
  'RFQ Qty': { width: 12, format: 'number' },
  'RFQ Target': { width: 14, format: 'currency_precise' },
  'Customer Part Number': { width: 20, format: 'text' },
  'Type': { width: 8, format: 'text' },
  'MO Type': { width: 28, format: 'text' },
  'Supplier MPN': { width: 22, format: 'text' },
  'Supplier MFR': { width: 18, format: 'text' },
  'Supplier/Excess Partner': { width: 28, format: 'text' },
  'Qty': { width: 12, format: 'number' },
  'Supplier Price': { width: 14, format: 'currency_precise' },
  '% Under Target': { width: 14, format: 'percent' },
  'Supply': { width: 11, format: 'text' },
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
    'RFQ Number', '% Under Target', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ MFR', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN', 'Supplier MFR',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
    'Supply', 'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'All Prices': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ MFR', 'RFQ Qty',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN', 'Supplier MFR',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
    'Supply', 'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ],
  'No Prices': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ MFR', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'Type', 'MO Type', 'Supplier MPN', 'Supplier MFR',
    'Supplier/Excess Partner', 'Qty',
    'Supply', 'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand'
  ],
  'Stock': [
    'RFQ Number', 'RFQ Created', 'RFQ Customer', 'RFQ MPN', 'RFQ MFR', 'RFQ Qty', 'RFQ Target',
    'Customer Part Number', 'MO Type', 'Supplier MPN', 'Supplier MFR',
    'Supplier/Excess Partner', 'Qty', 'Supplier Price',
    'Supply', 'lead_time', 'Date Code', 'Created Date', 'Days Btw MO/VQ & RFQ', '% of Demand', 'Opp Amount'
  ]
};

// ─── MFR MATCH ──────────────────────────────────────────────────────────────
// Manufacturer equivalence comparison lives in shared/mfr-equivalence.js so
// every workflow that needs to compare a customer's MFR ask against a
// supplier's MFR label uses the same canonicalization pipeline (prenormalize
// → alias file → acquisitions chain). See that module's header for the full
// pipeline, the rules for adding new equivalences, and the supported callers.
const { computeMfrMatch } = require('../../shared/mfr-equivalence');

// ─── SUPPLY STATE ───────────────────────────────────────────────────────────
// Categorical scan-aid for the seller. Today the seller has to read (Qty,
// lead_time) together and infer what the row means. With ~50% of rows on a
// PPV RFQ showing both qty>0 AND a lead_time string, the inference is wrong
// often enough to cause confidence-affecting mistakes:
//   - STOCK+LT misread as pure stock → seller commits to a delivery they
//     can't make
//   - LEAD TIME (qty=0) dismissed as "0 = nothing" → real opportunity
//     written off
//
// Supply state collapses (qty, lead_time) into one of four categorical values
// rendered in its own column right next to lead_time:
//
//   STOCK     — qty > 0, lt blank or stock-like (ship now, no caveats)
//   STOCK+LT  — qty > 0, lt set with a non-stock value (legitimate but
//               investigate why — could be franchise restock, partial stock,
//               or broker shipping/customs window)
//   LEAD TIME — qty = 0, lt set (contract quote, future delivery only —
//               valid for PPV, NOT to be written off)
//   ?         — qty = 0, lt blank (vendor told us neither — broker noise)
//
// "Stock-like" in lt: blank, "stock", "in stock", "ready", "available",
// "asap", "ship now". Case-insensitive.
//
// Applied uniformly to MO and VQ rows, broker and franchise alike — see the
// 2026-04-09 design discussion for the trade-off (the categorization is most
// reliable on API-sourced franchise data; broker free-text rows in STOCK+LT
// state may need a manual look at lead_time, same as today).
const STOCK_LIKE_LT = /^(stock|in[\s-]*stock|ready[\s-]*stock|ready|available|asap|ship[\s-]*now)\s*$/i;

function computeSupplyState(qty, leadTime) {
  const q = Number(qty) || 0;
  const lt = (leadTime || '').trim();
  const ltIsStockLike = lt === '' || STOCK_LIKE_LT.test(lt);
  if (q > 0 && ltIsStockLike) return 'STOCK';
  if (q > 0 && !ltIsStockLike) return 'STOCK+LT';
  if (q === 0 && !ltIsStockLike) return 'LEAD TIME';
  return '?';  // qty=0 AND lt blank/stock-like — vendor gave us nothing
}

/**
 * Fetch RFQ details from database
 *
 * Dedupes RFQ lines on (mpn_clean, mfr_id, qty, target, cpc). MFR is included
 * in the key so legitimate cross-MFR AVL alternates (e.g., DG441DY from both
 * Renesas and Vishay on the same customer line) are NOT collapsed — buyers
 * need to see both manufacturers as separate sourcing options. Without MFR
 * in the key, Vortex was silently hiding ~1% of alternate-manufacturer rows
 * on every RFQ run.
 */
async function fetchRfqDetails(rfqNumber) {
  const query = `
    SELECT DISTINCT ON (rlm.chuboe_mpn_clean, COALESCE(rlm.chuboe_mfr_id, 0), rlm.qty, rlm.priceentered, COALESCE(rlm.chuboe_cpc, ''))
      r.value AS rfq_number,
      r.created AS rfq_created,
      bp.name AS customer_name,
      rlm.chuboe_mpn AS rfq_mpn,
      rlm.chuboe_mpn_clean,
      rlm.chuboe_mfr_id AS rfq_mfr_id,
      COALESCE(mfr.name, rlm.chuboe_mfr_text, '') AS rfq_mfr,
      rlm.qty AS rfq_qty,
      rlm.priceentered AS rfq_target,
      rlm.chuboe_cpc AS customer_part_number
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON r.chuboe_rfq_id = rlm.chuboe_rfq_id
    LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = rlm.chuboe_mfr_id
    WHERE r.value = $1
    ORDER BY rlm.chuboe_mpn_clean, COALESCE(rlm.chuboe_mfr_id, 0), rlm.qty, rlm.priceentered, COALESCE(rlm.chuboe_cpc, ''), rlm.chuboe_rfq_line_mpn_id
  `;

  const result = await pool.query(query, [rfqNumber]);
  return result.rows;
}

/**
 * Fetch market offers matching the cleaned MPNs
 * - Stock (offer_type LIKE 'Stock -%'): No time filter (our inventory, always current)
 * - Other offers: 90-day window
 *
 * DEDUP: chuboe_offer_line frequently contains exact-duplicate rows for the
 * same content within a single offer (loader/wizard amplification — verified
 * 804 dup groups in last 30 days, with one MPN/vendor combo at 148× dups).
 * Without dedup, Vortex emits one output row per dup, which is the visible
 * redundancy operators see. We dedup at read on
 * (offer_id, mpn_clean, qty, price, lead_time, date_code) — same offer,
 * identical line content = dup; different offer = legitimately separate
 * opportunity (we keep those). Backfill of the upstream dups is intentionally
 * out of scope; the read-side dedup is sufficient for output quality.
 */
async function fetchMarketOffers(cleanMpns) {
  if (cleanMpns.length === 0) return [];

  const query = `
    SELECT * FROM (
      SELECT DISTINCT ON (
        mol.market_offer_id,
        mol.market_offer_line_mpn_clean,
        mol.market_offer_line_quantity,
        mol.market_offer_line_price,
        COALESCE(mol.market_offer_line_lead_time, ''),
        COALESCE(mol.market_offer_line_date_code, '')
      )
        mol.market_offer_line_mpn AS supplier_mpn,
        mol.market_offer_line_mpn_clean,
        COALESCE(mol.manufacturer_name, '') AS supplier_mfr,
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
      ORDER BY
        mol.market_offer_id,
        mol.market_offer_line_mpn_clean,
        mol.market_offer_line_quantity,
        mol.market_offer_line_price,
        COALESCE(mol.market_offer_line_lead_time, ''),
        COALESCE(mol.market_offer_line_date_code, ''),
        mol.market_offer_line_id  -- tiebreak: keep lowest line_id (oldest insert)
    ) deduped
    ORDER BY created_date DESC
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
      COALESCE(vql.vendor_quote_manufacturer_name, '') AS supplier_mfr,
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

      const leadTimeText = offer.lead_time || '';
      const supplyState = computeSupplyState(supplierQty, leadTimeText);

      results.push({
        'RFQ Number': rfq.rfq_number,
        'RFQ Created': rfqDate,
        'RFQ Customer': rfq.customer_name || '',
        'RFQ MPN': rfq.rfq_mpn || '',
        'RFQ MFR': rfq.rfq_mfr || '',
        'RFQ Qty': rfqQty,
        'RFQ Target': rfqTarget,
        'Customer Part Number': rfq.customer_part_number || '',
        'Type': offer.record_type,
        'MO Type': offer.mo_type || '',
        'Supplier MPN': offer.supplier_mpn || '',
        'Supplier MFR': offer.supplier_mfr || '',
        'Supplier/Excess Partner': offer.supplier_partner || '',
        'Qty': supplierQty,
        'Supplier Price': supplierPrice,
        '% Under Target': percentUnderTarget,
        'Supply': supplyState,
        'lead_time': leadTimeText,
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
 * Sort rows so the seller's top-down scan surfaces the most actionable rows
 * first per part. Three keys:
 *   1. (RFQ MPN, RFQ MFR) — group all rows for the same part together
 *   2. Supply state — STOCK first, then STOCK+LT, then LEAD TIME, then ?
 *      so ship-now rows lead each part's group, but lead-time-only rows
 *      stay visible immediately below (NOT buried at the end of an
 *      unsorted list — important for PPV where LT is acceptable)
 *   3. Supplier Price ascending — within a supply state, cheapest wins
 *
 * Sorts in place; returns the same array for chaining.
 */
const SUPPLY_ORDINAL = { 'STOCK': 1, 'STOCK+LT': 2, 'LEAD TIME': 3, '?': 4 };

function sortByPartAndSupply(rows) {
  return rows.sort((a, b) => {
    const mpnCmp = String(a['RFQ MPN'] || '').localeCompare(String(b['RFQ MPN'] || ''));
    if (mpnCmp !== 0) return mpnCmp;
    const mfrCmp = String(a['RFQ MFR'] || '').localeCompare(String(b['RFQ MFR'] || ''));
    if (mfrCmp !== 0) return mfrCmp;
    const supplyCmp = (SUPPLY_ORDINAL[a.Supply] || 9) - (SUPPLY_ORDINAL[b.Supply] || 9);
    if (supplyCmp !== 0) return supplyCmp;
    const priceA = a['Supplier Price'];
    const priceB = b['Supplier Price'];
    if (priceA == null && priceB == null) return 0;
    if (priceA == null) return 1;   // null/missing prices to the end
    if (priceB == null) return -1;
    return priceA - priceB;
  });
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

  // Per-cell red flag on the Supplier MFR cell when the supplier's MFR is a
  // genuinely DIFFERENT manufacturer than what the customer asked for.
  // 'Genuinely different' is determined via computeMfrMatch which uses an
  // equivalence table to recognize known nomenclature variations and
  // acquisitions (TE/Tyco, Vishay/Intertechnology, etc.) — those are NOT
  // flagged. Only true cross-MFR cases get the red treatment.
  // Cell-only (not row-level) so the rest of the data stays readable.
  const supplierMfrColIndex = columns.indexOf('Supplier MFR');
  if (supplierMfrColIndex >= 0) {
    const colNum = supplierMfrColIndex + 1;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const flag = computeMfrMatch(row['RFQ MFR'], row['Supplier MFR']);
      if (flag === 'MISMATCH') {
        // Worksheet row index = i + 2 (header is row 1, data starts at row 2)
        const cell = worksheet.getCell(i + 2, colNum);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCC0000' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      }
    }
  }

  // % of Demand: for LEAD TIME rows the seller's qty=0 produces 0% which
  // visually equates the row with "no opportunity" and risks the seller
  // writing it off. Override the cell with the literal text "LT" so the
  // row is unambiguously a lead-time quote — same protection the Supply
  // column gives, but in the demand-coverage column where the 0% confusion
  // would otherwise live.
  const demandColIndex = columns.indexOf('% of Demand');
  if (demandColIndex >= 0) {
    const colNum = demandColIndex + 1;
    for (let i = 0; i < data.length; i++) {
      if (data[i].Supply === 'LEAD TIME') {
        const cell = worksheet.getCell(i + 2, colNum);
        cell.value = 'LT';
        cell.numFmt = '@';  // text format — overrides the column-level percent format
        cell.alignment = { horizontal: 'center' };
      }
    }
  }

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

  // Sort each tab by (part, supply state, price) so STOCK rows lead each
  // part's group and lead-time-only rows stay visible right below them
  // ranked by price — see sortByPartAndSupply for the rationale.
  sortByPartAndSupply(stock);
  sortByPartAndSupply(goodPrices);
  sortByPartAndSupply(allPrices);
  sortByPartAndSupply(noPrices);

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
