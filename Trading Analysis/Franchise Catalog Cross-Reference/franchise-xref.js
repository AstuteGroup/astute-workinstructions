#!/usr/bin/env node
/**
 * Franchise Catalog Cross-Reference
 *
 * Cross-references an RFQ's line items against stored franchise distributor
 * catalogs (HTC Korea/TAEJIN, ATGBICS, etc.) and generates per-franchise
 * workbooks showing which customer-asked MPNs have franchise alternatives.
 *
 * Entry points:
 *   1. CLI (testing):  node franchise-xref.js <rfq_number> [--franchise htc-korea]
 *   2. Library:        const { runFranchiseXref } = require('./franchise-xref');
 *                      const result = await runFranchiseXref('1234567', { franchises: ['htc-korea'] });
 *
 * Returns:
 *   {
 *     rfqNumber,
 *     customer,
 *     results: [
 *       {
 *         franchise: 'htc-korea',
 *         displayName: 'HTC Korea (TAEJIN)',
 *         matchCount: 15,
 *         attachment: { filename: '1234567_HTC_CrossRef.xlsx', content: Buffer }
 *       },
 *       ...
 *     ]
 *   }
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

// Shared utilities
const { normalizeMPN, mpnMatch } = require('../../shared/mpn-normalization');

// Database connection
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user'
});

// Catalog directory
const CATALOG_DIR = path.resolve(process.env.HOME, 'workspace/franchise-catalogs');

// ─── CATALOG DISCOVERY ──────────────────────────────────────────────────────

/**
 * Discover all available franchise catalogs by scanning the catalog directory
 * for subdirectories containing metadata.json.
 *
 * Returns a Map of franchiseKey -> { metadata, catalogPath }
 */
function discoverFranchises() {
  const franchises = new Map();

  if (!fs.existsSync(CATALOG_DIR)) {
    return franchises;
  }

  const dirs = fs.readdirSync(CATALOG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of dirs) {
    const metaPath = path.join(CATALOG_DIR, dir, 'metadata.json');
    const catalogPath = path.join(CATALOG_DIR, dir, 'catalog.csv');

    if (fs.existsSync(metaPath) && fs.existsSync(catalogPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        franchises.set(dir, { metadata, catalogPath });
      } catch (e) {
        console.warn(`Warning: Could not parse ${metaPath}: ${e.message}`);
      }
    }
  }

  return franchises;
}

/**
 * Match a subject keyword to a franchise key.
 * Returns the franchise key if found, null otherwise.
 */
function matchKeywordToFranchise(keyword, franchises) {
  const kw = keyword.toLowerCase().trim();
  for (const [key, { metadata }] of franchises) {
    if (key === kw) return key;
    if (metadata.subjectKeywords?.some(sk => sk.toLowerCase() === kw)) return key;
    if (metadata.displayName?.toLowerCase() === kw) return key;
  }
  return null;
}

// ─── CATALOG LOADING ────────────────────────────────────────────────────────

/**
 * Parse a CSV file with proper quote handling.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQ = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function readCatalog(catalogPath) {
  const content = fs.readFileSync(catalogPath, 'utf-8').replace(/\r/g, '');
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = cells[i] != null ? cells[i] : '';
    }
    return obj;
  });
}

/**
 * Build lookup indexes for a catalog.
 * Returns { byCompetitorMpn, byDistributorMpn } where each is a Map of
 * normalizedMPN -> array of catalog entries.
 */
function buildCatalogIndex(catalogRows, columnMapping) {
  const byCompetitorMpn = new Map();
  const byDistributorMpn = new Map();

  const compCol = columnMapping.competitorMpn;
  const distCol = columnMapping.distributorMpn;

  for (const row of catalogRows) {
    // Index by competitor MPN
    const compMpn = row[compCol];
    if (compMpn) {
      const key = normalizeMPN(compMpn);
      if (!byCompetitorMpn.has(key)) byCompetitorMpn.set(key, []);
      byCompetitorMpn.get(key).push(row);
    }

    // Index by distributor MPN (for customers asking for the franchise MPN directly)
    const distMpn = row[distCol];
    if (distMpn) {
      const key = normalizeMPN(distMpn);
      if (!byDistributorMpn.has(key)) byDistributorMpn.set(key, []);
      byDistributorMpn.get(key).push(row);
    }
  }

  return { byCompetitorMpn, byDistributorMpn };
}

// ─── RFQ QUERY ──────────────────────────────────────────────────────────────

/**
 * Fetch RFQ line items with MPN/MFR/Qty details.
 */
async function fetchRfqLines(rfqNumber) {
  const query = `
    SELECT
      r.chuboe_rfq_id AS rfq_id,
      r.value AS rfq_number,
      r.created AS rfq_created,
      bp.name AS customer_name,
      rl.chuboe_rfq_line_id AS rfq_line_id,
      rl.chuboe_cpc AS cpc,
      rl.qty AS line_qty,
      rlm.chuboe_rfq_line_mpn_id,
      rlm.chuboe_mpn AS asked_mpn,
      rlm.chuboe_mpn_clean AS asked_mpn_clean,
      COALESCE(mfr.name, rlm.chuboe_mfr_text, '') AS asked_mfr,
      rlm.qty AS asked_qty,
      rlm.priceentered AS target_price
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive = 'Y'
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive = 'Y'
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = r.c_bpartner_id
    LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = rlm.chuboe_mfr_id
    WHERE r.value = $1
      AND r.isactive = 'Y'
    ORDER BY rl.line, rlm.chuboe_rfq_line_mpn_id
  `;

  const result = await pool.query(query, [rfqNumber]);
  return result.rows;
}

// ─── MATCHING LOGIC ─────────────────────────────────────────────────────────

/**
 * Match RFQ lines against a franchise catalog.
 *
 * Returns array of hit objects with both RFQ and catalog data merged.
 */
function matchRfqToCatalog(rfqLines, catalogIndex, columnMapping) {
  const { byCompetitorMpn, byDistributorMpn } = catalogIndex;
  const hits = [];

  for (const rfqLine of rfqLines) {
    const askedMpnClean = normalizeMPN(rfqLine.asked_mpn_clean || rfqLine.asked_mpn);
    if (!askedMpnClean) continue;

    // Check competitor MPN matches (customer asked for OEM part, we have franchise replacement)
    const competitorMatches = byCompetitorMpn.get(askedMpnClean) || [];
    for (const cat of competitorMatches) {
      hits.push({
        matchType: 'competitor',
        rfqLine,
        catalogEntry: cat,
        columnMapping
      });
    }

    // Check distributor MPN matches (customer asked for franchise MPN directly)
    const distributorMatches = byDistributorMpn.get(askedMpnClean) || [];
    for (const cat of distributorMatches) {
      // Avoid duplicates if the same entry matched both ways
      const isDupe = competitorMatches.some(c =>
        c[columnMapping.distributorMpn] === cat[columnMapping.distributorMpn] &&
        c[columnMapping.competitorMpn] === cat[columnMapping.competitorMpn]
      );
      if (!isDupe) {
        hits.push({
          matchType: 'direct',
          rfqLine,
          catalogEntry: cat,
          columnMapping
        });
      }
    }
  }

  return hits;
}

// ─── WORKBOOK GENERATION ────────────────────────────────────────────────────

/**
 * Build a cross-reference workbook for a franchise.
 *
 * Tabs:
 *   - Summary: Per-line roll-up with match details
 *   - By MPN: Per asked MPN with franchise alternatives
 *   - Detail: Per-hit detail rows
 */
async function buildFranchiseWorkbook(rfqNumber, customer, hits, metadata, columnMapping) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `Franchise Cross-Ref — ${metadata.displayName}`;
  workbook.created = new Date();

  // Helper to extract catalog fields using column mapping
  const getDistMpn = (cat) => cat[columnMapping.distributorMpn] || '';
  const getCompMpn = (cat) => cat[columnMapping.competitorMpn] || '';
  const getVendor = (cat) => cat[columnMapping.vendor] || '';
  const getMatchGrade = (cat) => columnMapping.matchGrade ? (cat[columnMapping.matchGrade] || '') : '';
  const getTargetPkg = (cat) => columnMapping.targetPkg ? (cat[columnMapping.targetPkg] || '') : '';
  const getDistPkg = (cat) => columnMapping.distributorPkg ? (cat[columnMapping.distributorPkg] || '') : '';
  const getDescription = (cat) => columnMapping.description ? (cat[columnMapping.description] || '') : '';
  const getCategory = (cat) => columnMapping.category ? (cat[columnMapping.category] || '') : '';

  // ─── SUMMARY TAB ────────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'RFQ MPN', key: 'rfqMpn', width: 22 },
    { header: 'RFQ MFR', key: 'rfqMfr', width: 18 },
    { header: 'RFQ Qty', key: 'rfqQty', width: 10 },
    { header: 'Target Price', key: 'targetPrice', width: 12 },
    { header: 'CPC', key: 'cpc', width: 16 },
    { header: `${metadata.displayName} MPN`, key: 'franchiseMpn', width: 22 },
    { header: 'Vendor Replaced', key: 'vendor', width: 18 },
    { header: 'Match Grade', key: 'matchGrade', width: 18 },
    { header: 'Match Type', key: 'matchType', width: 12 },
    { header: 'Package', key: 'pkg', width: 14 },
    { header: 'Description', key: 'description', width: 30 }
  ];

  // Style header
  const summaryHeader = summarySheet.getRow(1);
  summaryHeader.font = { bold: true };
  summaryHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0FF' } };

  for (const hit of hits) {
    const cat = hit.catalogEntry;
    summarySheet.addRow({
      rfqMpn: hit.rfqLine.asked_mpn || '',
      rfqMfr: hit.rfqLine.asked_mfr || '',
      rfqQty: Number(hit.rfqLine.asked_qty) || 0,
      targetPrice: hit.rfqLine.target_price ? Number(hit.rfqLine.target_price) : null,
      cpc: hit.rfqLine.cpc || '',
      franchiseMpn: getDistMpn(cat),
      vendor: getVendor(cat),
      matchGrade: getMatchGrade(cat),
      matchType: hit.matchType === 'direct' ? 'Direct' : 'Cross-Ref',
      pkg: getTargetPkg(cat) || getDistPkg(cat),
      description: getDescription(cat) || getCategory(cat)
    });
  }

  // Format columns
  summarySheet.getColumn('rfqQty').numFmt = '#,##0';
  summarySheet.getColumn('targetPrice').numFmt = '$#,##0.0000';

  // ─── BY MPN TAB ─────────────────────────────────────────────────────────
  const byMpnSheet = workbook.addWorksheet('By MPN');
  byMpnSheet.columns = [
    { header: 'RFQ MPN', key: 'rfqMpn', width: 22 },
    { header: 'RFQ MFR', key: 'rfqMfr', width: 18 },
    { header: 'Total Qty', key: 'totalQty', width: 12 },
    { header: `${metadata.displayName} Alternatives`, key: 'alternatives', width: 40 },
    { header: 'Vendor(s)', key: 'vendors', width: 24 },
    { header: 'Match Grade(s)', key: 'matchGrades', width: 20 }
  ];

  const byMpnHeader = byMpnSheet.getRow(1);
  byMpnHeader.font = { bold: true };
  byMpnHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0FF' } };

  // Aggregate by RFQ MPN
  const byMpnMap = new Map();
  for (const hit of hits) {
    const key = normalizeMPN(hit.rfqLine.asked_mpn);
    if (!byMpnMap.has(key)) {
      byMpnMap.set(key, {
        rfqMpn: hit.rfqLine.asked_mpn,
        rfqMfr: hit.rfqLine.asked_mfr,
        totalQty: 0,
        alternatives: new Set(),
        vendors: new Set(),
        matchGrades: new Set()
      });
    }
    const entry = byMpnMap.get(key);
    entry.totalQty += Number(hit.rfqLine.asked_qty) || 0;
    entry.alternatives.add(getDistMpn(hit.catalogEntry));
    entry.vendors.add(getVendor(hit.catalogEntry));
    const grade = getMatchGrade(hit.catalogEntry);
    if (grade) entry.matchGrades.add(grade);
  }

  const byMpnRows = [...byMpnMap.values()].sort((a, b) => b.totalQty - a.totalQty);
  for (const row of byMpnRows) {
    byMpnSheet.addRow({
      rfqMpn: row.rfqMpn,
      rfqMfr: row.rfqMfr,
      totalQty: row.totalQty,
      alternatives: [...row.alternatives].join(' | '),
      vendors: [...row.vendors].join(' | '),
      matchGrades: [...row.matchGrades].join(' | ')
    });
  }

  byMpnSheet.getColumn('totalQty').numFmt = '#,##0';

  // ─── DETAIL TAB ─────────────────────────────────────────────────────────
  const detailSheet = workbook.addWorksheet('Detail');
  detailSheet.columns = [
    { header: 'RFQ MPN', key: 'rfqMpn', width: 22 },
    { header: 'RFQ MFR', key: 'rfqMfr', width: 18 },
    { header: 'RFQ Qty', key: 'rfqQty', width: 10 },
    { header: 'CPC', key: 'cpc', width: 16 },
    { header: 'Match Type', key: 'matchType', width: 12 },
    { header: `${metadata.displayName} MPN`, key: 'franchiseMpn', width: 22 },
    { header: 'Competitor MPN', key: 'competitorMpn', width: 22 },
    { header: 'Vendor Replaced', key: 'vendor', width: 18 },
    { header: 'Match Grade', key: 'matchGrade', width: 18 },
    { header: 'Target Pkg', key: 'targetPkg', width: 12 },
    { header: `${metadata.displayName} Pkg`, key: 'franchisePkg', width: 12 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Category', key: 'category', width: 16 }
  ];

  const detailHeader = detailSheet.getRow(1);
  detailHeader.font = { bold: true };
  detailHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0FF' } };

  for (const hit of hits) {
    const cat = hit.catalogEntry;
    detailSheet.addRow({
      rfqMpn: hit.rfqLine.asked_mpn || '',
      rfqMfr: hit.rfqLine.asked_mfr || '',
      rfqQty: Number(hit.rfqLine.asked_qty) || 0,
      cpc: hit.rfqLine.cpc || '',
      matchType: hit.matchType === 'direct' ? 'Direct' : 'Cross-Ref',
      franchiseMpn: getDistMpn(cat),
      competitorMpn: getCompMpn(cat),
      vendor: getVendor(cat),
      matchGrade: getMatchGrade(cat),
      targetPkg: getTargetPkg(cat),
      franchisePkg: getDistPkg(cat),
      description: getDescription(cat),
      category: getCategory(cat)
    });
  }

  detailSheet.getColumn('rfqQty').numFmt = '#,##0';

  return workbook;
}

// ─── MAIN ENTRY POINT ───────────────────────────────────────────────────────

/**
 * Run franchise cross-reference for an RFQ.
 *
 * @param {string} rfqNumber - 7-digit RFQ number
 * @param {object} options
 * @param {string[]} options.franchises - Filter to specific franchises, or empty/['all'] for all
 * @param {function} options.log - Logger function
 * @returns {Promise<object>} Result with per-franchise attachments
 */
async function runFranchiseXref(rfqNumber, options = {}) {
  const { franchises: franchiseFilter = [], log = () => {} } = options;

  log(`Franchise Cross-Ref: processing RFQ ${rfqNumber}`);

  // Discover available franchises
  const allFranchises = discoverFranchises();
  if (allFranchises.size === 0) {
    throw new Error(`No franchise catalogs found in ${CATALOG_DIR}`);
  }
  log(`  Found ${allFranchises.size} franchise catalog(s): ${[...allFranchises.keys()].join(', ')}`);

  // Filter franchises if specified
  let targetFranchises;
  if (franchiseFilter.length === 0 || franchiseFilter.includes('all')) {
    targetFranchises = allFranchises;
  } else {
    targetFranchises = new Map();
    for (const kw of franchiseFilter) {
      const key = matchKeywordToFranchise(kw, allFranchises);
      if (key && allFranchises.has(key)) {
        targetFranchises.set(key, allFranchises.get(key));
      } else {
        log(`  Warning: Unknown franchise keyword '${kw}', skipping`);
      }
    }
  }

  if (targetFranchises.size === 0) {
    throw new Error(`No matching franchises found for filter: ${franchiseFilter.join(', ')}`);
  }
  log(`  Processing: ${[...targetFranchises.keys()].join(', ')}`);

  // Fetch RFQ lines
  const rfqLines = await fetchRfqLines(rfqNumber);
  if (rfqLines.length === 0) {
    const err = new Error(`RFQ ${rfqNumber} not found or has no line items`);
    err.code = 'RFQ_NOT_FOUND';
    throw err;
  }

  const customer = rfqLines[0].customer_name || '';
  log(`  Customer: ${customer}`);
  log(`  RFQ lines: ${rfqLines.length}, unique MPNs: ${new Set(rfqLines.map(l => normalizeMPN(l.asked_mpn))).size}`);

  // Process each franchise - track ALL checked franchises for the summary
  const results = [];        // Franchises with matches (have attachments)
  const checkedFranchises = []; // ALL franchises checked (for summary display)

  for (const [franchiseKey, { metadata, catalogPath }] of targetFranchises) {
    log(`  Processing ${metadata.displayName}...`);

    // Load and index catalog
    const catalogRows = readCatalog(catalogPath);
    log(`    Catalog: ${catalogRows.length} entries`);

    const catalogIndex = buildCatalogIndex(catalogRows, metadata.columnMapping);

    // Match RFQ lines
    const hits = matchRfqToCatalog(rfqLines, catalogIndex, metadata.columnMapping);
    log(`    Matches: ${hits.length}`);

    // Track this franchise as checked (even if 0 matches)
    const franchiseInfo = {
      franchise: franchiseKey,
      displayName: metadata.displayName,
      vendorsCovered: metadata.vendorsCovered || [],
      productCategory: metadata.productCategory || '',
      catalogSize: catalogRows.length,
      matchCount: hits.length,
      uniqueMpns: hits.length > 0 ? new Set(hits.map(h => normalizeMPN(h.rfqLine.asked_mpn))).size : 0
    };
    checkedFranchises.push(franchiseInfo);

    if (hits.length === 0) {
      // No matches for this franchise, no attachment
      continue;
    }

    // Build workbook
    const workbook = await buildFranchiseWorkbook(
      rfqNumber,
      customer,
      hits,
      metadata,
      metadata.columnMapping
    );
    const buffer = await workbook.xlsx.writeBuffer();

    const filename = `${rfqNumber}_${metadata.displayName.replace(/[^a-zA-Z0-9]/g, '')}_CrossRef.xlsx`;
    results.push({
      ...franchiseInfo,
      attachment: { filename, content: buffer }
    });
  }

  return {
    rfqNumber,
    customer,
    results,
    checkedFranchises  // All franchises that were checked
  };
}

/**
 * Build an HTML email body summarizing a franchise xref run.
 * Shows ALL checked franchises with their vendor coverage, highlighting which had matches.
 */
function buildSummaryHtml(result) {
  const { rfqNumber, customer, results, checkedFranchises = [] } = result;

  // Build the "Catalogs Checked" section showing all franchises with vendor coverage
  const catalogRows = (checkedFranchises.length > 0 ? checkedFranchises : results).map(f => {
    const hasMatches = f.matchCount > 0;
    const vendorList = (f.vendorsCovered || []).join(', ') || '—';
    const category = f.productCategory || '';
    const matchCell = hasMatches
      ? `<b style="color:#080">${f.matchCount}</b>`
      : `<span style="color:#999">0</span>`;
    const rowStyle = hasMatches ? '' : 'color:#666;';

    return `
    <tr style="${rowStyle}">
      <td style="padding:5px 8px;border:1px solid #ddd">${escapeHtml(f.displayName)}</td>
      <td style="padding:5px 8px;border:1px solid #ddd">${escapeHtml(category)}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-size:11px">${escapeHtml(vendorList)}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;text-align:right">${matchCell}</td>
    </tr>`;
  }).join('');

  const totalMatches = (checkedFranchises.length > 0 ? checkedFranchises : results)
    .reduce((sum, r) => sum + r.matchCount, 0);

  // Build attachments list (only franchises with matches)
  const attachmentList = results.length > 0
    ? results.map(r => `<li><code>${escapeHtml(r.attachment.filename)}</code> — ${r.matchCount} matches (${r.uniqueMpns} unique MPNs)</li>`).join('')
    : '<li style="color:#666">None (no matches found)</li>';

  return `<html><body style="font-family:Arial,sans-serif;font-size:13px;color:#222">
<h2 style="margin:0 0 8px 0">Franchise Cross-Reference — RFQ ${rfqNumber}</h2>
<p style="margin:0 0 14px 0"><b>Customer:</b> ${escapeHtml(customer)}</p>

<h3 style="margin:0 0 6px 0;font-size:14px;color:#444">Catalogs Checked</h3>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #ddd;margin-bottom:14px">
  <tr style="background:#f0f0f0;font-weight:bold;font-size:12px">
    <td style="padding:5px 8px;border:1px solid #ddd">Franchise</td>
    <td style="padding:5px 8px;border:1px solid #ddd">Category</td>
    <td style="padding:5px 8px;border:1px solid #ddd">Vendors Covered</td>
    <td style="padding:5px 8px;border:1px solid #ddd;text-align:right">Matches</td>
  </tr>
  ${catalogRows}
  <tr style="background:#fafafa;font-weight:bold">
    <td colspan="3" style="padding:5px 8px;border:1px solid #ddd">Total</td>
    <td style="padding:5px 8px;border:1px solid #ddd;text-align:right">${totalMatches}</td>
  </tr>
</table>

<h3 style="margin:0 0 6px 0;font-size:14px;color:#444">Attachments</h3>
<ul style="margin:0 0 14px 0;padding-left:20px">
  ${attachmentList}
</ul>

<p style="margin:14px 0 4px 0;color:#666;font-size:11px">Generated by Franchise Cross-Reference automation.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ─── CLI ENTRY POINT ────────────────────────────────────────────────────────

async function cliMain() {
  const args = process.argv.slice(2);
  const rfqNumber = args.find(a => /^\d{7}$/.test(a));

  if (!rfqNumber) {
    console.error('Usage: node franchise-xref.js <rfq_number> [--franchise htc-korea|atgbics|all]');
    console.error('  Runs in-memory and prints summary. No files written.');
    console.error('  For email-driven automation, use vortex-poller.js.');
    process.exit(1);
  }

  // Parse --franchise flag
  const franchiseIdx = args.indexOf('--franchise');
  const franchiseArg = franchiseIdx !== -1 && args[franchiseIdx + 1]
    ? args[franchiseIdx + 1].split(',')
    : [];

  try {
    const result = await runFranchiseXref(rfqNumber, {
      franchises: franchiseArg,
      log: msg => console.log(msg)
    });

    console.log('\nResults:');
    if (result.results.length === 0) {
      console.log('  No franchise matches found.');
    } else {
      for (const r of result.results) {
        console.log(`  ${r.displayName}: ${r.matchCount} matches (${r.uniqueMpns} unique MPNs)`);
        console.log(`    → ${r.attachment.filename} (${r.attachment.content.length} bytes)`);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    if (err.code !== 'RFQ_NOT_FOUND') console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

module.exports = {
  runFranchiseXref,
  buildSummaryHtml,
  discoverFranchises,
  matchKeywordToFranchise
};

if (require.main === module) {
  cliMain();
}
