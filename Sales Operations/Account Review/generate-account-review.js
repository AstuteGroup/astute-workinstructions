#!/usr/bin/env node
/**
 * Account Review Report Generator
 *
 * Generates quarterly account review reports for sales reps by:
 * 1. Querying OT for pre-sales metrics (Activities, RFQs, CQs, conversions)
 * 2. Parsing Infor CSVs for Booked/Invoiced GP
 * 3. Fuzzy matching customer names between OT and Infor
 * 4. Generating formatted Excel report
 *
 * Usage:
 *   node generate-account-review.js --seller "Aaron Mendoza" --quarter Q2 --year 2026
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const { parse: parseCSVSync } = require('csv-parse/sync');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Quarter date ranges
  quarters: {
    Q1: { start: '-01-01', end: '-03-31' },
    Q2: { start: '-04-01', end: '-06-30' },
    Q3: { start: '-07-01', end: '-09-30' },
    Q4: { start: '-10-01', end: '-12-31' }
  },

  // OT username → Infor username mapping (for cases where they differ)
  inforUsernameOverrides: {
    'amendoza': 'aaromend',  // Aaron Mendoza
    // Add more as needed
  }
};

// ============================================================================
// SELLER LOOKUP (Database Query)
// ============================================================================

function lookupSeller(sellerName) {
  // Try exact match first
  let query = `
    SELECT DISTINCT
      u.ad_user_id,
      u.name,
      u.value AS username
    FROM ad_user u
    INNER JOIN c_bpartner_location bpl
      ON u.ad_user_id = bpl.chuboe_ise_steward_id
    WHERE u.isactive = 'Y'
      AND bpl.isactive = 'Y'
      AND LOWER(u.name) = LOWER('${sellerName}')
    ORDER BY u.name
    LIMIT 1;
  `;

  let result = execSync(`psql -c "${query.replace(/"/g, '\\"')}" -t -A -F ","`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  let lines = result.trim().split('\n').filter(l => l.trim());

  // If no exact match, try partial match
  if (lines.length === 0) {
    query = `
      SELECT DISTINCT
        u.ad_user_id,
        u.name,
        u.value AS username
      FROM ad_user u
      INNER JOIN c_bpartner_location bpl
        ON u.ad_user_id = bpl.chuboe_ise_steward_id
      WHERE u.isactive = 'Y'
        AND bpl.isactive = 'Y'
        AND LOWER(u.name) LIKE LOWER('%${sellerName}%')
      ORDER BY u.name
      LIMIT 5;
    `;

    result = execSync(`psql -c "${query.replace(/"/g, '\\"')}" -t -A -F ","`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    lines = result.trim().split('\n').filter(l => l.trim());
  }

  if (lines.length === 0) {
    return null;
  }

  const sellers = lines.map(line => {
    const parts = line.split(',');
    return {
      userId: parts[0],
      name: parts[1],
      username: parts[2]
    };
  });

  return sellers;
}

function listAllSellers() {
  // Find all sellers who have ISE Steward assignments
  const query = `
    SELECT DISTINCT
      u.ad_user_id,
      u.name,
      u.value AS username
    FROM ad_user u
    INNER JOIN c_bpartner_location bpl
      ON u.ad_user_id = bpl.chuboe_ise_steward_id
    WHERE u.isactive = 'Y'
      AND bpl.isactive = 'Y'
    ORDER BY u.name;
  `;

  const result = execSync(`psql --csv -c "${query.replace(/"/g, '\\"')}" -t`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  const lines = result.trim().split('\n').filter(l => l.trim());

  return lines.map(line => {
    const parts = line.split(',');
    return {
      userId: parts[0],
      name: parts[1],
      username: parts[2]
    };
  });
}

// ============================================================================
// CSV PARSING (using csv-parse for proper multiline field support)
// ============================================================================

function readCSVFileProper(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Parse with csv-parse (handles multiline fields correctly)
  const records = parseCSVSync(content, {
    columns: true,  // First row is headers, return objects
    skip_empty_lines: true,
    relax_column_count: true,  // Allow rows with different column counts
    trim: true
  });

  return records;
}

// ============================================================================
// FUZZY CUSTOMER NAME MATCHING
// ============================================================================

function normalizeCompanyName(name) {
  if (!name) return '';

  return name
    .toUpperCase()
    // Remove leading/trailing quotes
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    // Remove parenthetical info
    .replace(/\([^)]*\)/g, '')
    // Remove punctuation FIRST (so "Corp." becomes "Corp")
    .replace(/[.,\-&]/g, ' ')
    // Now remove legal entities as whole words
    .replace(/\bINCORPORATED\b/g, '')
    .replace(/\bCORPORATION\b/g, '')
    .replace(/\bCORP\b/g, '')
    .replace(/\bINC\b/g, '')
    .replace(/\bLLC\b/g, '')
    .replace(/\bLIMITED\b/g, '')
    .replace(/\bLTD\b/g, '')
    .replace(/\bCOMPANY\b/g, '')
    .replace(/\bCO\b/g, '')
    .replace(/\bPTE\b/g, '')
    .replace(/\bULC\b/g, '')
    .replace(/\bTHE\b/g, '')
    .replace(/\bDBA\b/g, '')
    // Collapse spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(normalizedName) {
  // Extract significant words (3+ chars) for matching
  return normalizedName.split(' ').filter(w => w.length >= 3);
}

function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

function fuzzyMatchCustomer(otName, inforNames) {
  const normalizedOT = normalizeCompanyName(otName);
  const otKeywords = extractKeywords(normalizedOT);

  let bestMatch = null;
  let bestScore = Infinity;
  let bestConfidence = 'no-match';

  for (const inforName of inforNames) {
    const normalizedInfor = normalizeCompanyName(inforName);

    // Exact match after normalization
    if (normalizedOT === normalizedInfor) {
      return { match: inforName, score: 0, confidence: 'exact' };
    }

    // Check if one contains the other (full substring match)
    if (normalizedInfor.includes(normalizedOT)) {
      return { match: inforName, score: 0, confidence: 'contains' };
    }

    if (normalizedOT.includes(normalizedInfor)) {
      if (bestScore > 0) {
        bestScore = 0;
        bestMatch = inforName;
        bestConfidence = 'contains';
      }
      continue;
    }

    // Keyword matching (e.g., "GE Healthcare" matches "GE Precision Healthcare LLC")
    const inforKeywords = extractKeywords(normalizedInfor);
    const commonKeywords = otKeywords.filter(k => inforKeywords.includes(k));

    if (commonKeywords.length > 0 && otKeywords.length > 0) {
      // Check for distinctive keywords (5+ chars) - these are high-signal matches
      const distinctiveMatches = commonKeywords.filter(k => k.length >= 5);

      if (distinctiveMatches.length > 0) {
        // Score based on keyword coverage
        const matchPct = commonKeywords.length / otKeywords.length;
        const score = 1 - matchPct;

        // Accept if 50%+ of OT keywords match and we have a distinctive keyword
        if (matchPct >= 0.5) {
          if (score < bestScore) {
            bestScore = score;
            bestMatch = inforName;
            bestConfidence = 'keyword';
          }
        }
      }

      // Regular keyword matching (requires min 2 keywords)
      const minKeywords = Math.min(2, otKeywords.length);

      if (commonKeywords.length >= minKeywords) {
        const matchPct = commonKeywords.length / otKeywords.length;

        if (matchPct >= 0.75) {
          // 75%+ match - accept immediately
          return { match: inforName, score: 1 - matchPct, confidence: 'keyword' };
        } else if (matchPct >= 0.5) {
          // 50-75% match - keep as candidate
          const score = 1 - matchPct;
          if (score < bestScore) {
            bestScore = score;
            bestMatch = inforName;
            bestConfidence = 'keyword';
          }
        }
      }
    }

    // Levenshtein distance (fallback for similar spellings)
    const distance = levenshteinDistance(normalizedOT, normalizedInfor);
    const maxLen = Math.max(normalizedOT.length, normalizedInfor.length);
    const similarity = 1 - (distance / maxLen);

    if (similarity >= 0.85 && (bestConfidence === 'no-match' || distance < bestScore)) {
      bestScore = distance;
      bestMatch = inforName;
      bestConfidence = 'fuzzy';
    }
  }

  if (bestMatch) {
    return { match: bestMatch, score: bestScore, confidence: bestConfidence };
  }

  return { match: null, score: Infinity, confidence: 'no-match' };
}

// ============================================================================
// SCHEDULED GP CALCULATION (From Infor Booked Sales CSV)
// ============================================================================

function parseScheduledGP(filePath, username, nextQuarterStart, nextQuarterEnd) {
  console.log(`\n📊 Parsing Scheduled GP for ${username} (CO Promise Date: ${nextQuarterStart} to ${nextQuarterEnd}, CO Ship Date: blank)...`);

  const rows = readCSVFileProper(filePath);

  const filtered = rows.filter(row => {
    const salesperson = row['CO Internal Salesperson'];
    const promiseDateStr = row['CO Promise Date'];
    const shipDateStr = row['CO Ship Date'];

    // Must match seller
    if (salesperson !== username) return false;

    // Ship date must be blank (not shipped yet)
    if (shipDateStr && shipDateStr.trim() !== '') return false;

    // Promise date must be in next quarter
    if (!promiseDateStr) return false;

    const promiseDate = new Date(promiseDateStr.split(' ')[0]);
    const start = new Date(nextQuarterStart);
    const end = new Date(nextQuarterEnd);

    return promiseDate >= start && promiseDate <= end;
  });

  console.log(`  Found ${filtered.length} scheduled booked sales lines`);

  // Aggregate by customer
  const byCustomer = {};

  for (const row of filtered) {
    const customer = row['Customer Name'];
    const gpStr = (row['Booked GP'] || '').replace(/[$,]/g, '');
    const gp = parseFloat(gpStr) || 0;

    if (!byCustomer[customer]) {
      byCustomer[customer] = 0;
    }
    byCustomer[customer] += gp;
  }

  const totalGP = Object.values(byCustomer).reduce((sum, gp) => sum + gp, 0);
  console.log(`  Found scheduled GP for ${Object.keys(byCustomer).length} customers ($${totalGP.toFixed(2)} total)`);

  return byCustomer;
}

// ============================================================================
// GP GOALS PARSING
// ============================================================================

/**
 * Parse GP Goals from Excel file
 * @param {string} filePath - Path to "Sales Goals 25-26 - INC - SharePoint.xlsx"
 * @param {string} username - OT username (e.g., "aaromend")
 * @param {string} quarter - Quarter (Q1, Q2, Q3, Q4)
 * @param {number} year - Year (2025, 2026, etc.)
 * @returns {number} Quarterly GP Goal (sum of monthly goals)
 */
function parseGPGoal(filePath, username, quarter, year) {
  console.log(`\n📊 Parsing GP Goal for ${username} ${quarter} ${year}...`);

  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️  Goals file not found: ${filePath}`);
    return null;
  }

  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // Filter for this seller, quarter, and year
    const goals = data.filter(row =>
      row['ISE Name'] === username &&
      row['Goal Quarter'] === quarter &&
      row['Goal Year'] === year
    );

    if (goals.length === 0) {
      console.log(`  ⚠️  No goal found for ${username} ${quarter} ${year}`);
      return null;
    }

    // Sum monthly goals for the quarter
    const quarterlyGoal = goals.reduce((sum, row) => sum + (row['Invoice GP Goal'] || 0), 0);
    console.log(`  Found ${goals.length} monthly goals totaling $${quarterlyGoal.toFixed(2)}`);

    return quarterlyGoal;
  } catch (error) {
    console.log(`  ⚠️  Error parsing Goals file: ${error.message}`);
    return null;
  }
}

// ============================================================================
// INFOR DATA PARSING
// ============================================================================

function parseInforBookedSales(filePath, username, startDate, endDate) {
  console.log(`\n📊 Parsing Booked Sales for ${username} (${startDate} to ${endDate})...`);

  const rows = readCSVFileProper(filePath);

  const filtered = rows.filter(row => {
    const salesperson = row['CO Internal Salesperson'];
    const dateStr = row['Date'];

    if (salesperson !== username) return false;

    // Parse date (format: "2026-04-01 00:00:00")
    const date = new Date(dateStr.split(' ')[0]);
    const start = new Date(startDate);
    const end = new Date(endDate);

    return date >= start && date <= end;
  });

  console.log(`  Found ${filtered.length} booked sales lines`);

  // Aggregate by customer
  const byCustomer = {};

  for (const row of filtered) {
    const customer = row['Customer Name'];
    const gpStr = (row['Booked GP'] || '').replace(/[$,]/g, '');
    const gp = parseFloat(gpStr) || 0;

    if (!byCustomer[customer]) {
      byCustomer[customer] = 0;
    }
    byCustomer[customer] += gp;
  }

  return byCustomer;
}

function parseInforInvoicedSales(filePath, username, startDate, endDate) {
  console.log(`\n📊 Parsing Invoiced Sales for ${username} (${startDate} to ${endDate})...`);

  const rows = readCSVFileProper(filePath);

  const filtered = rows.filter(row => {
    const salesperson = row['Internal Salesperson'];
    const dateStr = row['Invoice Date'];

    if (salesperson !== username) return false;

    // Parse date (format: "2026-04-01 00:00:00")
    const date = new Date(dateStr.split(' ')[0]);
    const start = new Date(startDate);
    const end = new Date(endDate);

    return date >= start && date <= end;
  });

  console.log(`  Found ${filtered.length} invoiced sales lines`);

  // Aggregate by customer
  const byCustomer = {};

  for (const row of filtered) {
    const customer = row['Customer Name'];
    const gpStr = (row['Invoice GP'] || '').replace(/[$,]/g, '');
    const gp = parseFloat(gpStr) || 0;

    if (!byCustomer[customer]) {
      byCustomer[customer] = 0;
    }
    byCustomer[customer] += gp;
  }

  return byCustomer;
}

// ============================================================================
// OT QUERY
// ============================================================================

function queryOT(sellerId, startDate, endDate) {
  console.log(`\n🔍 Querying OT for seller ${sellerId} (${startDate} to ${endDate})...`);

  const query = `
WITH assigned_accounts AS (
  SELECT DISTINCT
    bp.c_bpartner_id,
    bp.name AS account_name,
    COUNT(DISTINCT bpl.c_bpartner_location_id) AS location_count
  FROM c_bpartner bp
  INNER JOIN c_bpartner_location bpl
    ON bp.c_bpartner_id = bpl.c_bpartner_id
    AND bpl.isactive = 'Y'
  WHERE bpl.chuboe_ise_steward_id = ${sellerId}
    AND bp.isactive = 'Y'
  GROUP BY bp.c_bpartner_id, bp.name
),

assignment_dates AS (
  -- Get first interaction date with this seller as a proxy for assignment date
  -- Uses earliest of: activity, RFQ, or order
  SELECT
    bp.c_bpartner_id,
    LEAST(
      COALESCE(MIN(ca.startdate), '9999-12-31'::date),
      COALESCE(MIN(rfq.created), '9999-12-31'::date),
      COALESCE(MIN(o.dateordered), '9999-12-31'::date)
    ) AS first_assigned_date,
    (EXTRACT(YEAR FROM AGE(
      CURRENT_DATE,
      LEAST(
        COALESCE(MIN(ca.startdate), '9999-12-31'::date),
        COALESCE(MIN(rfq.created), '9999-12-31'::date),
        COALESCE(MIN(o.dateordered), '9999-12-31'::date)
      )
    )) * 12 + EXTRACT(MONTH FROM AGE(
      CURRENT_DATE,
      LEAST(
        COALESCE(MIN(ca.startdate), '9999-12-31'::date),
        COALESCE(MIN(rfq.created), '9999-12-31'::date),
        COALESCE(MIN(o.dateordered), '9999-12-31'::date)
      )
    )))::integer AS months_assigned
  FROM c_bpartner bp
  LEFT JOIN c_contactactivity ca ON bp.c_bpartner_id = (
    SELECT u.c_bpartner_id
    FROM ad_user u
    WHERE u.ad_user_id = ca.ad_user_id
  ) AND ca.salesrep_id = ${sellerId} AND ca.isactive = 'Y'
  LEFT JOIN chuboe_rfq rfq ON bp.c_bpartner_id = rfq.c_bpartner_id
    AND rfq.salesrep_id = ${sellerId} AND rfq.isactive = 'Y'
  LEFT JOIN c_order o ON bp.c_bpartner_id = o.c_bpartner_id
    AND o.salesrep_id = ${sellerId} AND o.isactive = 'Y'
  WHERE bp.c_bpartner_id IN (
    SELECT DISTINCT bpl.c_bpartner_id
    FROM c_bpartner_location bpl
    WHERE bpl.chuboe_ise_steward_id = ${sellerId} AND bpl.isactive = 'Y'
  )
  GROUP BY bp.c_bpartner_id
),

last_sales AS (
  -- Get most recent sale date by this seller (either invoice or order creation)
  SELECT
    bp.c_bpartner_id,
    GREATEST(
      COALESCE(MAX(i.dateinvoiced), '1900-01-01'::date),
      COALESCE(MAX(o.created::date), '1900-01-01'::date)
    ) AS last_sale_date
  FROM c_bpartner bp
  LEFT JOIN c_invoice i ON bp.c_bpartner_id = i.c_bpartner_id
    AND i.salesrep_id = ${sellerId}
    AND i.isactive = 'Y' AND i.docstatus IN ('CO', 'CL')
  LEFT JOIN c_order o ON bp.c_bpartner_id = o.c_bpartner_id
    AND o.salesrep_id = ${sellerId}
    AND o.isactive = 'Y' AND o.docstatus != 'VO'
  GROUP BY bp.c_bpartner_id
  HAVING GREATEST(
    COALESCE(MAX(i.dateinvoiced), '1900-01-01'::date),
    COALESCE(MAX(o.created::date), '1900-01-01'::date)
  ) > '1900-01-01'::date
),

activities AS (
  SELECT
    u.c_bpartner_id,
    COUNT(*) AS activity_count
  FROM c_contactactivity ca
  INNER JOIN ad_user u
    ON ca.ad_user_id = u.ad_user_id
  WHERE ca.salesrep_id = ${sellerId}
    AND ca.startdate >= '${startDate}'
    AND ca.startdate <= '${endDate}'
    AND ca.isactive = 'Y'
  GROUP BY u.c_bpartner_id
),

rfq_lines AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(*) AS rfq_line_count
  FROM chuboe_rfq rfq
  INNER JOIN chuboe_rfq_line rfql
    ON rfq.chuboe_rfq_id = rfql.chuboe_rfq_id
    AND rfql.isactive = 'Y'
  INNER JOIN chuboe_rfq_line_mpn rfqm
    ON rfql.chuboe_rfq_line_id = rfqm.chuboe_rfq_line_id
    AND rfqm.isactive = 'Y'
  WHERE rfq.salesrep_id = ${sellerId}
    AND rfq.created >= '${startDate}'
    AND rfq.created <= '${endDate} 23:59:59'
    AND rfq.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
),

cq_lines AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(*) AS cq_line_count
  FROM chuboe_cq_line cql
  INNER JOIN chuboe_rfq_line rfql
    ON cql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
  INNER JOIN chuboe_rfq rfq
    ON rfql.chuboe_rfq_id = rfq.chuboe_rfq_id
  WHERE rfq.salesrep_id = ${sellerId}
    AND cql.created >= '${startDate}'
    AND cql.created <= '${endDate} 23:59:59'
    AND cql.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
),

cq_won AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(DISTINCT ol.c_orderline_id) AS cq_won_count
  FROM c_orderline ol
  INNER JOIN chuboe_cq_line cql
    ON ol.chuboe_cq_line_id = cql.chuboe_cq_line_id
  INNER JOIN chuboe_rfq_line rfql
    ON cql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
  INNER JOIN chuboe_rfq rfq
    ON rfql.chuboe_rfq_id = rfq.chuboe_rfq_id
  INNER JOIN c_order o
    ON ol.c_order_id = o.c_order_id
    AND o.isactive = 'Y'
  WHERE o.salesrep_id = ${sellerId}
    AND ol.created >= '${startDate}'
    AND ol.created <= '${endDate} 23:59:59'
    AND ol.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
)

SELECT
  aa.c_bpartner_id,
  aa.account_name,
  aa.location_count,
  ad.months_assigned,
  TO_CHAR(ad.first_assigned_date, 'YYYY-MM-DD') AS first_assigned_date,
  TO_CHAR(ls.last_sale_date, 'YYYY-MM-DD') AS last_sale_date,
  COALESCE(a.activity_count, 0) AS activities,
  COALESCE(rfq.rfq_line_count, 0) AS rfq_lines,
  COALESCE(cq.cq_line_count, 0) AS cq_lines,
  COALESCE(w.cq_won_count, 0) AS cq_won,
  CASE
    WHEN COALESCE(cq.cq_line_count, 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(w.cq_won_count, 0)::numeric / cq.cq_line_count::numeric, 4)
  END AS conversion_rate
FROM assigned_accounts aa
LEFT JOIN assignment_dates ad ON aa.c_bpartner_id = ad.c_bpartner_id
LEFT JOIN last_sales ls ON aa.c_bpartner_id = ls.c_bpartner_id
LEFT JOIN activities a ON aa.c_bpartner_id = a.c_bpartner_id
LEFT JOIN rfq_lines rfq ON aa.c_bpartner_id = rfq.c_bpartner_id
LEFT JOIN cq_lines cq ON aa.c_bpartner_id = cq.c_bpartner_id
LEFT JOIN cq_won w ON aa.c_bpartner_id = w.c_bpartner_id
ORDER BY aa.account_name;
`;

  const result = execSync(`psql --csv -c "${query.replace(/"/g, '\\"')}" -t`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  const lines = result.trim().split('\n').filter(l => l.trim());
  const accounts = [];

  for (const line of lines) {
    // Use proper CSV parsing to handle commas in company names
    const parsed = parseCSVSync(line, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true
    });

    if (parsed.length === 0 || parsed[0].length < 11) continue;
    const parts = parsed[0];

    accounts.push({
      bpartnerId: parts[0],
      accountName: parts[1],
      locations: parseInt(parts[2]) || 0,
      monthsAssigned: parts[3] === '' ? null : parseInt(parts[3]),
      firstAssignedDate: parts[4] === '' ? null : parts[4],
      lastSaleDate: parts[5] === '' ? null : parts[5],
      activities: parseInt(parts[6]) || 0,
      rfqLines: parseInt(parts[7]) || 0,
      cqLines: parseInt(parts[8]) || 0,
      cqWon: parseInt(parts[9]) || 0,
      conversionRate: parts[10] === '' ? null : parseFloat(parts[10])
    });
  }

  console.log(`  Found ${accounts.length} assigned accounts`);
  return accounts;
}

function queryOTNotAssigned(sellerId, startDate, endDate) {
  console.log(`\n🔍 Querying OT for NOT ASSIGNED accounts (seller ${sellerId}, ${startDate} to ${endDate})...`);

  const query = `
WITH seller_activity_accounts AS (
  -- Accounts where seller had activities
  SELECT DISTINCT u.c_bpartner_id
  FROM c_contactactivity ca
  INNER JOIN ad_user u ON ca.ad_user_id = u.ad_user_id
  WHERE ca.salesrep_id = ${sellerId}
    AND ca.startdate >= '${startDate}'
    AND ca.startdate <= '${endDate}'
    AND ca.isactive = 'Y'

  UNION

  -- Accounts where seller had RFQs
  SELECT DISTINCT c_bpartner_id
  FROM chuboe_rfq
  WHERE salesrep_id = ${sellerId}
    AND created >= '${startDate}'
    AND created <= '${endDate} 23:59:59'
    AND isactive = 'Y'

  UNION

  -- Accounts where seller had CQs
  SELECT DISTINCT rfq.c_bpartner_id
  FROM chuboe_cq_line cql
  INNER JOIN chuboe_rfq_line rfql ON cql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
  INNER JOIN chuboe_rfq rfq ON rfql.chuboe_rfq_id = rfq.chuboe_rfq_id
  WHERE rfq.salesrep_id = ${sellerId}
    AND cql.created >= '${startDate}'
    AND cql.created <= '${endDate} 23:59:59'
    AND cql.isactive = 'Y'

  UNION

  -- Accounts where seller had Sales Orders
  SELECT DISTINCT o.c_bpartner_id
  FROM c_order o
  WHERE o.salesrep_id = ${sellerId}
    AND o.created >= '${startDate}'
    AND o.created <= '${endDate} 23:59:59'
    AND o.isactive = 'Y'
),

assigned_accounts AS (
  -- Accounts where seller IS the current ISE Steward
  SELECT DISTINCT bp.c_bpartner_id
  FROM c_bpartner bp
  INNER JOIN c_bpartner_location bpl
    ON bp.c_bpartner_id = bpl.c_bpartner_id
    AND bpl.isactive = 'Y'
  WHERE bpl.chuboe_ise_steward_id = ${sellerId}
    AND bp.isactive = 'Y'
),

not_assigned AS (
  -- Activity accounts that are NOT assigned
  SELECT DISTINCT
    bp.c_bpartner_id,
    bp.name AS account_name,
    COUNT(DISTINCT bpl.c_bpartner_location_id) AS location_count
  FROM seller_activity_accounts saa
  INNER JOIN c_bpartner bp ON saa.c_bpartner_id = bp.c_bpartner_id AND bp.isactive = 'Y'
  LEFT JOIN c_bpartner_location bpl ON bp.c_bpartner_id = bpl.c_bpartner_id AND bpl.isactive = 'Y'
  WHERE saa.c_bpartner_id NOT IN (SELECT c_bpartner_id FROM assigned_accounts)
  GROUP BY bp.c_bpartner_id, bp.name
),

activities AS (
  SELECT
    u.c_bpartner_id,
    COUNT(*) AS activity_count
  FROM c_contactactivity ca
  INNER JOIN ad_user u ON ca.ad_user_id = u.ad_user_id
  WHERE ca.salesrep_id = ${sellerId}
    AND ca.startdate >= '${startDate}'
    AND ca.startdate <= '${endDate}'
    AND ca.isactive = 'Y'
  GROUP BY u.c_bpartner_id
),

rfq_lines AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(*) AS rfq_line_count
  FROM chuboe_rfq rfq
  INNER JOIN chuboe_rfq_line rfql
    ON rfq.chuboe_rfq_id = rfql.chuboe_rfq_id
    AND rfql.isactive = 'Y'
  INNER JOIN chuboe_rfq_line_mpn rfqm
    ON rfql.chuboe_rfq_line_id = rfqm.chuboe_rfq_line_id
    AND rfqm.isactive = 'Y'
  WHERE rfq.salesrep_id = ${sellerId}
    AND rfq.created >= '${startDate}'
    AND rfq.created <= '${endDate} 23:59:59'
    AND rfq.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
),

cq_lines AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(*) AS cq_line_count
  FROM chuboe_cq_line cql
  INNER JOIN chuboe_rfq_line rfql
    ON cql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
  INNER JOIN chuboe_rfq rfq
    ON rfql.chuboe_rfq_id = rfq.chuboe_rfq_id
  WHERE rfq.salesrep_id = ${sellerId}
    AND cql.created >= '${startDate}'
    AND cql.created <= '${endDate} 23:59:59'
    AND cql.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
),

cq_won AS (
  SELECT
    rfq.c_bpartner_id,
    COUNT(DISTINCT ol.c_orderline_id) AS cq_won_count
  FROM c_orderline ol
  INNER JOIN chuboe_cq_line cql
    ON ol.chuboe_cq_line_id = cql.chuboe_cq_line_id
  INNER JOIN chuboe_rfq_line rfql
    ON cql.chuboe_rfq_line_id = rfql.chuboe_rfq_line_id
  INNER JOIN chuboe_rfq rfq
    ON rfql.chuboe_rfq_id = rfq.chuboe_rfq_id
  INNER JOIN c_order o
    ON ol.c_order_id = o.c_order_id
    AND o.isactive = 'Y'
  WHERE o.salesrep_id = ${sellerId}
    AND ol.created >= '${startDate}'
    AND ol.created <= '${endDate} 23:59:59'
    AND ol.isactive = 'Y'
  GROUP BY rfq.c_bpartner_id
)

SELECT
  na.c_bpartner_id,
  na.account_name,
  na.location_count,
  COALESCE(a.activity_count, 0) AS activities,
  COALESCE(rfq.rfq_line_count, 0) AS rfq_lines,
  COALESCE(cq.cq_line_count, 0) AS cq_lines,
  COALESCE(w.cq_won_count, 0) AS cq_won,
  CASE
    WHEN COALESCE(cq.cq_line_count, 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(w.cq_won_count, 0)::numeric / cq.cq_line_count::numeric, 4)
  END AS conversion_rate
FROM not_assigned na
LEFT JOIN activities a ON na.c_bpartner_id = a.c_bpartner_id
LEFT JOIN rfq_lines rfq ON na.c_bpartner_id = rfq.c_bpartner_id
LEFT JOIN cq_lines cq ON na.c_bpartner_id = cq.c_bpartner_id
LEFT JOIN cq_won w ON na.c_bpartner_id = w.c_bpartner_id
ORDER BY na.account_name;
`;

  const result = execSync(`psql --csv -c "${query.replace(/"/g, '\\"')}" -t`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  const lines = result.trim().split('\n').filter(l => l.trim());
  const accounts = [];

  for (const line of lines) {
    // Use proper CSV parsing to handle commas in company names
    const parsed = parseCSVSync(line, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true
    });

    if (parsed.length === 0 || parsed[0].length < 8) continue;
    const parts = parsed[0];

    accounts.push({
      bpartnerId: parts[0],
      accountName: parts[1],
      locations: parseInt(parts[2]) || 0,
      activities: parseInt(parts[3]) || 0,
      rfqLines: parseInt(parts[4]) || 0,
      cqLines: parseInt(parts[5]) || 0,
      cqWon: parseInt(parts[6]) || 0,
      conversionRate: parts[7] === '' ? null : parseFloat(parts[7])
    });
  }

  console.log(`  Found ${accounts.length} not-assigned accounts`);
  return accounts;
}

// ============================================================================
// CUSTOMER MATCHING
// ============================================================================

function matchAccountsWithInfor(otAccounts, bookedGP, invoicedGP, sectionName) {
  const allInforCustomers = Array.from(new Set([
    ...Object.keys(bookedGP),
    ...Object.keys(invoicedGP)
  ]));

  const matchedAccounts = [];
  const unmatchedOT = [];
  const matchedInforCustomers = new Set();

  // Track which Infor customers have already contributed GP in this section
  const gpAlreadyCounted = new Set();

  for (const account of otAccounts) {
    // Find ALL Infor customers that match this OT account
    const matches = [];

    for (const inforName of allInforCustomers) {
      const match = fuzzyMatchCustomer(account.accountName, [inforName]);

      if (match.match) {
        // Only count GP if this Infor customer hasn't been counted yet in this section
        const bookedGPValue = gpAlreadyCounted.has(match.match) ? 0 : (bookedGP[match.match] || 0);
        const invoicedGPValue = gpAlreadyCounted.has(match.match) ? 0 : (invoicedGP[match.match] || 0);

        matches.push({
          inforName: match.match,
          confidence: match.confidence,
          bookedGP: bookedGPValue,
          invoicedGP: invoicedGPValue
        });
        matchedInforCustomers.add(match.match);
        gpAlreadyCounted.add(match.match); // Mark as counted
      }
    }

    if (matches.length > 0) {
      // Aggregate GP from all matches
      const totalBookedGP = matches.reduce((sum, m) => sum + m.bookedGP, 0);
      const totalInvoicedGP = matches.reduce((sum, m) => sum + m.invoicedGP, 0);

      const inforNames = matches.map(m => m.inforName).join('|');
      const confidences = matches.map(m => m.confidence).join(', ');

      console.log(`  ✓ ${account.accountName} → ${inforNames} (${confidences})`);

      matchedAccounts.push({
        ...account,
        inforName: inforNames,
        bookedGP: totalBookedGP,
        invoicedGP: totalInvoicedGP,
        matchConfidence: confidences,
        matchCount: matches.length
      });
    } else {
      console.log(`  ✗ ${account.accountName} (no match)`);
      unmatchedOT.push(account);

      matchedAccounts.push({
        ...account,
        inforName: null,
        bookedGP: 0,
        invoicedGP: 0,
        matchConfidence: 'no-match',
        matchCount: 0
      });
    }
  }

  return { matchedAccounts, unmatchedOT, matchedInforCustomers };
}

// ============================================================================
// EXCEL GENERATION
// ============================================================================

async function generateExcel(data, outputPath) {
  console.log(`\n📄 Generating Excel report: ${outputPath}`);

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(`${data.seller} - ${data.nextQuarter} ${data.nextQuarterYear}`);

  // Set column widths
  worksheet.columns = [
    { width: 25 }, // Account (OT)
    { width: 25 }, // Account INFOR
    { width: 12 }, // Locations
    { width: 15 }, // Months Assigned (NEW)
    { width: 15 }, // First Assigned (NEW)
    { width: 15 }, // Last Sale Date (NEW)
    { width: 12 }, // Activities
    { width: 12 }, // RFQ Lines
    { width: 12 }, // CQ Lines
    { width: 12 }, // CQ Lines Won
    { width: 15 }, // Conversion Rate
    { width: 15 }, // Booked GP
    { width: 15 }, // Invoiced GP
    { width: 12 }, // B to I
    { width: 12 }, // % of Inv Total
    { width: 15 }, // Scheduled GP
    { width: 15 }, // GP Target
    { width: 30 }, // Quarter Strategies
  ];

  // Report Generated Date at top
  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Chicago'
  });
  const reportDateRow = worksheet.addRow([
    `Report Generated: ${reportDate}`,
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  reportDateRow.font = { italic: true, size: 10 };

  // Blank row
  worksheet.addRow([]);

  // Report Title (merged and centered)
  const titleRow = worksheet.addRow([
    `${data.seller} - Account Review - ${data.nextQuarter} ${data.nextQuarterYear}`,
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  titleRow.font = { bold: true, size: 14 };
  titleRow.alignment = { horizontal: 'center' };

  // Merge cells A3:R3 for title
  worksheet.mergeCells(`A${titleRow.number}:R${titleRow.number}`);

  // Blank row
  worksheet.addRow([]);

  // Header
  const headerRow = worksheet.addRow([
    'Account (OT)',
    'Account INFOR',
    'Locations',
    'Months Assigned',
    'First Assigned',
    'Last Sale Date',
    `Activities ${data.quarter}`,
    `RFQ Lines ${data.quarter}`,
    `CQ Lines ${data.quarter}`,
    `CQ Lines Won ${data.quarter}`,
    `Conversion Rate ${data.quarter}`,
    `Booked GP ${data.quarter}`,
    `Invoiced GP ${data.quarter}`,
    `B to I ${data.quarter}`,
    `% of Inv Total ${data.quarter}`,
    `Scheduled GP ${data.nextQuarter} ${data.nextQuarterYear}`,
    'GP Target',
    `${data.nextQuarter} ${data.nextQuarterYear} Strategies`
  ]);

  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', wrapText: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' }
  };

  // Light yellow background for Q3 columns (Scheduled GP, GP Target, Strategies)
  headerRow.getCell(16).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' } // Light yellow
  };
  headerRow.getCell(17).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' } // Light yellow
  };
  headerRow.getCell(18).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' } // Light yellow
  };

  // Hide Column B (Account INFOR)
  worksheet.getColumn(2).hidden = true;

  // Freeze header and everything above it (rows 1-5)
  worksheet.views = [
    { state: 'frozen', ySplit: 5 }
  ];

  // Calculate totals for ASSIGNED section
  let assignedTotals = {
    locations: 0,
    activities: 0,
    rfqLines: 0,
    cqLines: 0,
    cqWon: 0,
    bookedGP: 0,
    invoicedGP: 0,
    scheduledGP: 0
  };

  for (const account of data.assignedAccounts) {
    assignedTotals.locations += account.locations || 0;
    assignedTotals.activities += account.activities || 0;
    assignedTotals.rfqLines += account.rfqLines || 0;
    assignedTotals.cqLines += account.cqLines || 0;
    assignedTotals.cqWon += account.cqWon || 0;
    assignedTotals.bookedGP += account.bookedGP || 0;
    assignedTotals.invoicedGP += account.invoicedGP || 0;
    assignedTotals.scheduledGP += account.scheduledGP || 0;
  }

  assignedTotals.conversionRate = assignedTotals.cqLines > 0
    ? assignedTotals.cqWon / assignedTotals.cqLines
    : null;
  assignedTotals.bToI = assignedTotals.invoicedGP > 0
    ? assignedTotals.bookedGP / assignedTotals.invoicedGP
    : null;

  // ASSIGNED ACCOUNTS section
  for (const account of data.assignedAccounts) {
    const row = worksheet.addRow([
      account.accountName,
      account.inforName || '',
      account.locations,
      account.monthsAssigned,
      account.firstAssignedDate || '',
      account.lastSaleDate || '',
      account.activities,
      account.rfqLines,
      account.cqLines,
      account.cqWon,
      account.conversionRate,
      account.bookedGP,
      account.invoicedGP,
      account.bToI,
      account.pctInvTotal,
      account.scheduledGP,
      '', // GP Target column (manual entry)
      '' // Quarter Strategies column (manual entry)
    ]);

    // Format conversion rate
    if (account.conversionRate !== null) {
      const cell = row.getCell(11);
      cell.numFmt = '0.00%';
      cell.value = account.conversionRate;

      // Red highlight if < 10%
      if (account.conversionRate < 0.10) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFF0000' }
        };
        cell.font = { color: { argb: 'FFFFFFFF' } };
      }
    }

    // Format currency (Booked GP, Invoiced GP, Scheduled GP, GP Target)
    row.getCell(12).numFmt = '$#,##0.00';  // Booked GP
    row.getCell(13).numFmt = '$#,##0.00';  // Invoiced GP
    row.getCell(16).numFmt = '$#,##0.00';  // Scheduled GP
    row.getCell(17).numFmt = '$#,##0.00';  // GP Target

    // Format B to I ratio
    if (account.bToI !== null) {
      row.getCell(14).numFmt = '0.00';
    }

    // Format percentage
    if (account.pctInvTotal !== null) {
      row.getCell(15).numFmt = '0.0%';
    }

    // Center alignment for specific columns (C, D, G, H, I, J, N)
    row.getCell(3).alignment = { horizontal: 'center' };  // Locations
    row.getCell(4).alignment = { horizontal: 'center' };  // Months Assigned
    row.getCell(7).alignment = { horizontal: 'center' };  // Activities
    row.getCell(8).alignment = { horizontal: 'center' };  // RFQ Lines
    row.getCell(9).alignment = { horizontal: 'center' };  // CQ Lines
    row.getCell(10).alignment = { horizontal: 'center' }; // CQ Lines Won
    row.getCell(14).alignment = { horizontal: 'center' }; // B to I

    // Red font for zero activity indicators (RFQ Lines, CQ Lines, CQ Lines Won)
    // Column 8: RFQ Lines
    if (account.rfqLines === 0) {
      row.getCell(8).font = { color: { argb: 'FFFF0000' }, bold: true };
    }
    // Column 9: CQ Lines
    if (account.cqLines === 0) {
      row.getCell(9).font = { color: { argb: 'FFFF0000' }, bold: true };
    }
    // Column 10: CQ Lines Won
    if (account.cqWon === 0) {
      row.getCell(10).font = { color: { argb: 'FFFF0000' }, bold: true };
    }
  }

  // ASSIGNED SUBTOTAL row
  const assignedSubtotalRow = worksheet.addRow([
    'ASSIGNED TOTAL',
    '',
    assignedTotals.locations,
    '', // Months Assigned (not applicable for totals)
    '', // First Assigned (not applicable for totals)
    '', // Last Sale Date (not applicable for totals)
    assignedTotals.activities,
    assignedTotals.rfqLines,
    assignedTotals.cqLines,
    assignedTotals.cqWon,
    assignedTotals.conversionRate,
    assignedTotals.bookedGP,
    assignedTotals.invoicedGP,
    assignedTotals.bToI,
    1.0, // % of Inv Total (100% within assigned section)
    assignedTotals.scheduledGP,
    '', // GP Target
    ''  // Strategies
  ]);

  assignedSubtotalRow.font = { bold: true };
  assignedSubtotalRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' }
  };

  // Format subtotal row
  assignedSubtotalRow.getCell(11).numFmt = '0.00%';      // Conversion Rate
  assignedSubtotalRow.getCell(12).numFmt = '$#,##0.00';  // Booked GP
  assignedSubtotalRow.getCell(13).numFmt = '$#,##0.00';  // Invoiced GP
  assignedSubtotalRow.getCell(14).numFmt = '0.00';       // B to I
  assignedSubtotalRow.getCell(15).numFmt = '0.0%';       // % of Inv Total
  assignedSubtotalRow.getCell(16).numFmt = '$#,##0.00';  // Scheduled GP

  // Center alignment for specific columns (C, D, G, H, I, J, N)
  assignedSubtotalRow.getCell(3).alignment = { horizontal: 'center' };  // Locations
  assignedSubtotalRow.getCell(7).alignment = { horizontal: 'center' };  // Activities
  assignedSubtotalRow.getCell(8).alignment = { horizontal: 'center' };  // RFQ Lines
  assignedSubtotalRow.getCell(9).alignment = { horizontal: 'center' };  // CQ Lines
  assignedSubtotalRow.getCell(10).alignment = { horizontal: 'center' }; // CQ Lines Won
  assignedSubtotalRow.getCell(14).alignment = { horizontal: 'center' }; // B to I

  // NOT ASSIGNED section (if any)
  let notAssignedTotals = {
    locations: 0,
    activities: 0,
    rfqLines: 0,
    cqLines: 0,
    cqWon: 0,
    bookedGP: 0,
    invoicedGP: 0,
    scheduledGP: 0
  };

  if (data.notAssignedAccounts && data.notAssignedAccounts.length > 0) {
    // Calculate totals for NOT ASSIGNED section
    for (const account of data.notAssignedAccounts) {
      notAssignedTotals.locations += account.locations || 0;
      notAssignedTotals.activities += account.activities || 0;
      notAssignedTotals.rfqLines += account.rfqLines || 0;
      notAssignedTotals.cqLines += account.cqLines || 0;
      notAssignedTotals.cqWon += account.cqWon || 0;
      notAssignedTotals.bookedGP += account.bookedGP || 0;
      notAssignedTotals.invoicedGP += account.invoicedGP || 0;
      notAssignedTotals.scheduledGP += account.scheduledGP || 0;
    }

    notAssignedTotals.conversionRate = notAssignedTotals.cqLines > 0
      ? notAssignedTotals.cqWon / notAssignedTotals.cqLines
      : null;
    notAssignedTotals.bToI = notAssignedTotals.invoicedGP > 0
      ? notAssignedTotals.bookedGP / notAssignedTotals.invoicedGP
      : null;

    // Add blank row
    worksheet.addRow([]);

    // Add "Not Assigned" header
    const notAssignedHeader = worksheet.addRow([
      'NOT ASSIGNED (Activity but no ISE Steward assignment + Infor-only sales)',
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
    ]);
    notAssignedHeader.font = { bold: true, color: { argb: 'FFFF0000' } };
    notAssignedHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' }
    };

    // Add data rows for not-assigned accounts
    for (const account of data.notAssignedAccounts) {
      const row = worksheet.addRow([
        account.accountName,
        account.inforName || '',
        account.locations,
        '', // Months Assigned (not applicable)
        '', // First Assigned (not applicable)
        '', // Last Sale Date (not applicable)
        account.activities,
        account.rfqLines,
        account.cqLines,
        account.cqWon,
        account.conversionRate,
        account.bookedGP,
        account.invoicedGP,
        account.bToI,
        account.pctInvTotal,
        account.scheduledGP,
        '', // GP Target column (manual entry)
        '' // Quarter Strategies column (manual entry)
      ]);

      // Format conversion rate
      if (account.conversionRate !== null) {
        const cell = row.getCell(11);
        cell.numFmt = '0.00%';
        cell.value = account.conversionRate;

        // Red highlight if < 10%
        if (account.conversionRate < 0.10) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFF0000' }
          };
          cell.font = { color: { argb: 'FFFFFFFF' } };
        }
      }

      // Format currency (Booked GP, Invoiced GP, Scheduled GP, GP Target)
      row.getCell(12).numFmt = '$#,##0.00';  // Booked GP
      row.getCell(13).numFmt = '$#,##0.00';  // Invoiced GP
      row.getCell(16).numFmt = '$#,##0.00';  // Scheduled GP
      row.getCell(17).numFmt = '$#,##0.00';  // GP Target

      // Format B to I ratio
      if (account.bToI !== null) {
        row.getCell(14).numFmt = '0.00';
      }

      // Format percentage
      if (account.pctInvTotal !== null) {
        row.getCell(15).numFmt = '0.0%';
      }

      // Center alignment for specific columns (C, D, G, H, I, J, N)
      row.getCell(3).alignment = { horizontal: 'center' };  // Locations
      row.getCell(4).alignment = { horizontal: 'center' };  // Months Assigned
      row.getCell(7).alignment = { horizontal: 'center' };  // Activities
      row.getCell(8).alignment = { horizontal: 'center' };  // RFQ Lines
      row.getCell(9).alignment = { horizontal: 'center' };  // CQ Lines
      row.getCell(10).alignment = { horizontal: 'center' }; // CQ Lines Won
      row.getCell(14).alignment = { horizontal: 'center' }; // B to I
    }

    // NOT ASSIGNED SUBTOTAL row
    const notAssignedSubtotalRow = worksheet.addRow([
      'NOT ASSIGNED TOTAL',
      '',
      notAssignedTotals.locations,
      '', // Months Assigned (not applicable)
      '', // First Assigned (not applicable)
      '', // Last Sale Date (not applicable)
      notAssignedTotals.activities,
      notAssignedTotals.rfqLines,
      notAssignedTotals.cqLines,
      notAssignedTotals.cqWon,
      notAssignedTotals.conversionRate,
      notAssignedTotals.bookedGP,
      notAssignedTotals.invoicedGP,
      notAssignedTotals.bToI,
      1.0, // % of Inv Total (100% within not-assigned section)
      notAssignedTotals.scheduledGP,
      '', // GP Target
      ''  // Strategies
    ]);

    notAssignedSubtotalRow.font = { bold: true };
    notAssignedSubtotalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' }
    };

    // Format subtotal row
    notAssignedSubtotalRow.getCell(11).numFmt = '0.00%';      // Conversion Rate
    notAssignedSubtotalRow.getCell(12).numFmt = '$#,##0.00';  // Booked GP
    notAssignedSubtotalRow.getCell(13).numFmt = '$#,##0.00';  // Invoiced GP
    notAssignedSubtotalRow.getCell(14).numFmt = '0.00';       // B to I
    notAssignedSubtotalRow.getCell(15).numFmt = '0.0%';       // % of Inv Total
    notAssignedSubtotalRow.getCell(16).numFmt = '$#,##0.00';  // Scheduled GP

    // Center alignment for specific columns (C, D, G, H, I, J, N)
    notAssignedSubtotalRow.getCell(3).alignment = { horizontal: 'center' };  // Locations
    notAssignedSubtotalRow.getCell(7).alignment = { horizontal: 'center' };  // Activities
    notAssignedSubtotalRow.getCell(8).alignment = { horizontal: 'center' };  // RFQ Lines
    notAssignedSubtotalRow.getCell(9).alignment = { horizontal: 'center' };  // CQ Lines
    notAssignedSubtotalRow.getCell(10).alignment = { horizontal: 'center' }; // CQ Lines Won
    notAssignedSubtotalRow.getCell(14).alignment = { horizontal: 'center' }; // B to I
  }

  // GRAND TOTAL row (combines both sections)
  const grandTotals = {
    locations: assignedTotals.locations + notAssignedTotals.locations,
    activities: assignedTotals.activities + notAssignedTotals.activities,
    rfqLines: assignedTotals.rfqLines + notAssignedTotals.rfqLines,
    cqLines: assignedTotals.cqLines + notAssignedTotals.cqLines,
    cqWon: assignedTotals.cqWon + notAssignedTotals.cqWon,
    bookedGP: assignedTotals.bookedGP + notAssignedTotals.bookedGP,
    invoicedGP: assignedTotals.invoicedGP + notAssignedTotals.invoicedGP,
    scheduledGP: assignedTotals.scheduledGP + notAssignedTotals.scheduledGP
  };

  grandTotals.conversionRate = grandTotals.cqLines > 0
    ? grandTotals.cqWon / grandTotals.cqLines
    : null;
  grandTotals.bToI = grandTotals.invoicedGP > 0
    ? grandTotals.bookedGP / grandTotals.invoicedGP
    : null;

  // Add blank row
  worksheet.addRow([]);

  // Add GRAND TOTAL row
  const grandTotalRow = worksheet.addRow([
    'GRAND TOTAL (Assigned + Not Assigned)',
    '',
    grandTotals.locations,
    '', // Months Assigned (not applicable)
    '', // First Assigned (not applicable)
    '', // Last Sale Date (not applicable)
    grandTotals.activities,
    grandTotals.rfqLines,
    grandTotals.cqLines,
    grandTotals.cqWon,
    grandTotals.conversionRate,
    grandTotals.bookedGP,
    grandTotals.invoicedGP,
    grandTotals.bToI,
    '', // % of Inv Total not applicable for grand total
    grandTotals.scheduledGP,
    '', // GP Target (will be SUM formula)
    ''  // Quarter Strategies
  ]);

  grandTotalRow.font = { bold: true, size: 12 };
  grandTotalRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };
  grandTotalRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  // Format grand total row
  grandTotalRow.getCell(11).numFmt = '0.00%';      // Conversion Rate
  grandTotalRow.getCell(12).numFmt = '$#,##0.00';  // Booked GP
  grandTotalRow.getCell(13).numFmt = '$#,##0.00';  // Invoiced GP
  grandTotalRow.getCell(14).numFmt = '0.00';       // B to I
  grandTotalRow.getCell(16).numFmt = '$#,##0.00';  // Scheduled GP

  // Add SUM formula for GP Target column (column 17)
  const grandTotalRowNum = grandTotalRow.number;
  const firstDataRow = 6; // Row after header (header is row 5)
  const lastDataRow = grandTotalRowNum - 1;
  grandTotalRow.getCell(17).value = { formula: `SUM(Q${firstDataRow}:Q${lastDataRow})` };
  grandTotalRow.getCell(17).numFmt = '$#,##0.00';

  // Center alignment for specific columns (C, D, G, H, I, J, N)
  grandTotalRow.getCell(3).alignment = { horizontal: 'center' };  // Locations
  grandTotalRow.getCell(7).alignment = { horizontal: 'center' };  // Activities
  grandTotalRow.getCell(8).alignment = { horizontal: 'center' };  // RFQ Lines
  grandTotalRow.getCell(9).alignment = { horizontal: 'center' };  // CQ Lines
  grandTotalRow.getCell(10).alignment = { horizontal: 'center' }; // CQ Lines Won
  grandTotalRow.getCell(14).alignment = { horizontal: 'center' }; // B to I

  // Add GP Goal row (if goal was found)
  if (data.gpGoal !== null) {
    const gpGoalRow = worksheet.addRow([
      `${data.nextQuarter} ${data.nextQuarterYear} GP Goal`,
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      data.gpGoal,
      ''
    ]);
    gpGoalRow.font = { bold: true };
    gpGoalRow.getCell(17).numFmt = '$#,##0.00';
    gpGoalRow.getCell(17).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2EFDA' } // Light green background
    };

    // Add Delta row (GP Target Sum - GP Goal)
    const deltaRow = worksheet.addRow([
      'Delta to Goal',
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      { formula: `Q${grandTotalRowNum}-Q${gpGoalRow.number}` },
      ''
    ]);
    deltaRow.font = { bold: true };
    deltaRow.getCell(17).numFmt = '$#,##0.00';

    // Conditional formatting for Delta: RED if negative, GREEN if >= 0
    const deltaCell = deltaRow.getCell(17);
    worksheet.addConditionalFormatting({
      ref: deltaCell.address,
      rules: [
        {
          type: 'cellIs',
          operator: 'lessThan',
          formulae: [0],
          style: {
            fill: {
              type: 'pattern',
              pattern: 'solid',
              bgColor: { argb: 'FFFF0000' } // Red
            },
            font: {
              color: { argb: 'FFFFFFFF' }, // White text
              bold: true
            }
          }
        },
        {
          type: 'cellIs',
          operator: 'greaterThanOrEqual',
          formulae: [0],
          style: {
            fill: {
              type: 'pattern',
              pattern: 'solid',
              bgColor: { argb: 'FF00B050' } // Green
            },
            font: {
              color: { argb: 'FFFFFFFF' }, // White text
              bold: true
            }
          }
        }
      ]
    });
  }

  // Add blank row
  worksheet.addRow([]);

  // How to Use section
  const howToUseRow = worksheet.addRow([
    'HOW TO USE:',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  howToUseRow.font = { bold: true, size: 10 };
  howToUseRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' } // Light yellow
  };

  const instructionRow1 = worksheet.addRow([
    '1. Review account portfolio for inactive accounts (RED zeros).',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  instructionRow1.font = { size: 11 };
  instructionRow1.alignment = { horizontal: 'left', vertical: 'top' };
  worksheet.mergeCells(`A${instructionRow1.number}:F${instructionRow1.number}`);

  const instructionRow2 = worksheet.addRow([
    '2. Set GP targets for strategic accounts to meet/exceed quarter goal.',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  instructionRow2.font = { size: 11 };
  instructionRow2.alignment = { horizontal: 'left', vertical: 'top' };
  worksheet.mergeCells(`A${instructionRow2.number}:F${instructionRow2.number}`);

  const instructionRow3 = worksheet.addRow([
    '3. Review unassigned accounts for potential assignments with supporting business case.',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  instructionRow3.font = { size: 11 };
  instructionRow3.alignment = { horizontal: 'left', vertical: 'top' };
  worksheet.mergeCells(`A${instructionRow3.number}:F${instructionRow3.number}`);

  // Save
  await workbook.xlsx.writeFile(outputPath);
  console.log(`✅ Excel report generated successfully`);
}

// ============================================================================
// MAIN
// ============================================================================

function showHelp() {
  console.log(`
Account Review Report Generator
Generate quarterly account review reports for sales reps

Usage:
  node generate-account-review.js [options]

Options:
  --seller <name>    Seller name (partial match OK, e.g., "Aaron" or "Mendoza")
  --quarter <Q1-Q4>  Quarter (Q1, Q2, Q3, or Q4)
  --year <YYYY>      Year (e.g., 2026)
  --list-sellers     List all available sellers
  --help             Show this help message

Examples:
  node generate-account-review.js --seller "Aaron Mendoza" --quarter Q2 --year 2026
  node generate-account-review.js --seller Aaron --quarter Q3 --year 2026
  node generate-account-review.js --list-sellers

Defaults:
  Seller:  Aaron Mendoza
  Quarter: Q2
  Year:    2026
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Check for help or list flags
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--list-sellers')) {
    console.log('\n📋 Available Sellers:\n');
    const sellers = listAllSellers();
    for (const seller of sellers) {
      console.log(`  ${seller.name.padEnd(30)} (ID: ${seller.userId}, Username: ${seller.username})`);
    }
    console.log(`\nTotal: ${sellers.length} sellers\n`);
    process.exit(0);
  }

  // Parse arguments
  let sellerInput = 'Aaron Mendoza';
  let quarter = 'Q2';
  let year = 2026;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seller' && args[i + 1]) {
      sellerInput = args[i + 1];
      i++;
    } else if (args[i] === '--quarter' && args[i + 1]) {
      quarter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--year' && args[i + 1]) {
      year = parseInt(args[i + 1]);
      i++;
    }
  }

  // Validate quarter
  const quarterDates = CONFIG.quarters[quarter];
  if (!quarterDates) {
    console.error(`\n❌ Error: Invalid quarter "${quarter}"`);
    console.error(`   Valid quarters: Q1, Q2, Q3, Q4\n`);
    process.exit(1);
  }

  // Lookup seller in database
  const sellerMatches = lookupSeller(sellerInput);

  if (!sellerMatches || sellerMatches.length === 0) {
    console.error(`\n❌ Error: No seller found matching "${sellerInput}"`);
    console.error(`\nTry running: node generate-account-review.js --list-sellers\n`);
    process.exit(1);
  }

  if (sellerMatches.length > 1) {
    console.error(`\n⚠️  Multiple sellers found matching "${sellerInput}":\n`);
    for (const s of sellerMatches) {
      console.error(`  - ${s.name} (ID: ${s.userId})`);
    }
    console.error(`\nPlease be more specific.\n`);
    process.exit(1);
  }

  const seller = sellerMatches[0];
  const userId = seller.userId;
  const otUsername = seller.username;
  const sellerName = seller.name;

  // Apply Infor username override if exists (OT and Infor may use different usernames)
  const username = CONFIG.inforUsernameOverrides[otUsername] || otUsername;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`ACCOUNT REVIEW REPORT GENERATOR`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Seller: ${sellerName}`);
  console.log(`Quarter: ${quarter} ${year}`);
  console.log(`${'='.repeat(60)}`);

  const startDate = `${year}${quarterDates.start}`;
  const endDate = `${year}${quarterDates.end}`;

  // Calculate next quarter dates for Scheduled GP
  const nextQuarterMap = { Q1: 'Q2', Q2: 'Q3', Q3: 'Q4', Q4: 'Q1' };
  const nextQuarter = nextQuarterMap[quarter];
  const nextQuarterYear = quarter === 'Q4' ? year + 1 : year;
  const nextQuarterDates = CONFIG.quarters[nextQuarter];
  const nextQuarterStart = `${nextQuarterYear}${nextQuarterDates.start}`;
  const nextQuarterEnd = `${nextQuarterYear}${nextQuarterDates.end}`;

  console.log(`Date range: ${startDate} to ${endDate}`);
  console.log(`Next quarter (Scheduled GP): ${nextQuarter} ${nextQuarterYear} (${nextQuarterStart} to ${nextQuarterEnd})`);
  console.log(`OT user ID: ${userId}`);
  console.log(`OT username: ${otUsername}`);
  console.log(`Infor username: ${username}${username !== otUsername ? ' (override)' : ''}`);

  // File paths
  const projectDir = __dirname;
  const bookedSalesPath = path.join(projectDir, 'Booked Sales - Account Review AI.csv');
  const invoicedSalesPath = path.join(projectDir, 'Invoiced Sales - Account Review AI.csv');

  // Step 1: Query OT for assigned and not-assigned accounts
  const otAccountsAssigned = queryOT(userId, startDate, endDate);
  const otAccountsNotAssigned = queryOTNotAssigned(userId, startDate, endDate);

  // Step 2: Parse Infor CSVs
  const bookedGP = parseInforBookedSales(bookedSalesPath, username, startDate, endDate);
  const invoicedGP = parseInforInvoicedSales(invoicedSalesPath, username, startDate, endDate);
  const scheduledGP = parseScheduledGP(bookedSalesPath, username, nextQuarterStart, nextQuarterEnd);

  // Step 3: Parse GP Goal for next quarter (same quarter as scheduled GP)
  const goalsFilePath = path.join(projectDir, 'Sales Goals 25-26 - INC - SharePoint.xlsx');
  const gpGoal = parseGPGoal(goalsFilePath, username, nextQuarter, nextQuarterYear);

  console.log(`\n📊 Summary:`);
  console.log(`  OT Accounts (Assigned): ${otAccountsAssigned.length}`);
  console.log(`  OT Accounts (Not Assigned): ${otAccountsNotAssigned.length}`);
  console.log(`  Infor Booked Customers: ${Object.keys(bookedGP).length}`);
  console.log(`  Infor Invoiced Customers: ${Object.keys(invoicedGP).length}`);
  console.log(`  Scheduled GP Customers: ${Object.keys(scheduledGP).length}`);

  // Step 3: Match ASSIGNED accounts
  console.log(`\n🔗 Matching customer names for ASSIGNED accounts...`);
  const assignedResults = matchAccountsWithInfor(otAccountsAssigned, bookedGP, invoicedGP, 'Assigned');

  // Step 4: Match NOT ASSIGNED accounts (exclude Infor customers already matched in Assigned section)
  console.log(`\n🔗 Matching customer names for NOT ASSIGNED accounts...`);

  // Create filtered GP objects that exclude already-matched Infor customers
  const unmatchedBookedGP = {};
  const unmatchedInvoicedGP = {};
  const unmatchedScheduledGP = {};

  for (const customer in bookedGP) {
    if (!assignedResults.matchedInforCustomers.has(customer)) {
      unmatchedBookedGP[customer] = bookedGP[customer];
    }
  }

  for (const customer in invoicedGP) {
    if (!assignedResults.matchedInforCustomers.has(customer)) {
      unmatchedInvoicedGP[customer] = invoicedGP[customer];
    }
  }

  for (const customer in scheduledGP) {
    if (!assignedResults.matchedInforCustomers.has(customer)) {
      unmatchedScheduledGP[customer] = scheduledGP[customer];
    }
  }


  console.log(`  (Excluding ${assignedResults.matchedInforCustomers.size} customers already matched in Assigned section)`);

  const notAssignedResults = matchAccountsWithInfor(otAccountsNotAssigned, unmatchedBookedGP, unmatchedInvoicedGP, 'Not Assigned');

  // Combine matched Infor customers from both sections
  const allMatchedInforCustomers = new Set([
    ...assignedResults.matchedInforCustomers,
    ...notAssignedResults.matchedInforCustomers
  ]);

  const allInforCustomers = Array.from(new Set([
    ...Object.keys(bookedGP),
    ...Object.keys(invoicedGP),
    ...Object.keys(scheduledGP)
  ]));

  const unmatchedInfor = allInforCustomers.filter(c => !allMatchedInforCustomers.has(c));

  // Step 5: Add unmatched Infor customers to Not Assigned section
  if (unmatchedInfor.length > 0) {
    console.log(`\n📌 Adding ${unmatchedInfor.length} Infor-only customers to NOT ASSIGNED section...`);
    for (const customer of unmatchedInfor) {
      const bookedGPValue = bookedGP[customer] || 0;
      const invoicedGPValue = invoicedGP[customer] || 0;
      const scheduledGPValue = unmatchedScheduledGP[customer] || 0;

      console.log(`  + ${customer} (Booked: $${bookedGPValue.toFixed(2)}, Invoiced: $${invoicedGPValue.toFixed(2)}, Scheduled: $${scheduledGPValue.toFixed(2)})`);

      // Add as a row with no OT account data
      notAssignedResults.matchedAccounts.push({
        bpartnerId: null,
        accountName: null,
        locations: 0,
        activities: 0,
        rfqLines: 0,
        cqLines: 0,
        cqWon: 0,
        conversionRate: null,
        inforName: customer,
        bookedGP: bookedGPValue,
        invoicedGP: invoicedGPValue,
        scheduledGP: scheduledGPValue,
        matchConfidence: 'infor-only',
        matchCount: 1
      });

      // Mark as matched so it's counted in totals
      allMatchedInforCustomers.add(customer);
      notAssignedResults.matchedInforCustomers.add(customer);
    }
  }

  // Step 6: Add Scheduled GP to accounts (match by Infor customer names)
  console.log(`\n📌 Adding Scheduled GP to accounts...`);
  for (const account of assignedResults.matchedAccounts) {
    let totalScheduledGP = 0;

    // account.inforName may contain multiple pipe-separated Infor customer names
    if (account.inforName) {
      const inforNames = account.inforName.split('|').map(n => n.trim());
      for (const inforName of inforNames) {
        totalScheduledGP += scheduledGP[inforName] || 0;
      }
    }

    account.scheduledGP = totalScheduledGP;
  }

  // Track which Infor customers we've already counted to avoid double-counting
  const scheduledGPCounted = new Set();

  for (const account of notAssignedResults.matchedAccounts) {
    let totalScheduledGP = 0;

    // account.inforName may contain multiple pipe-separated Infor customer names
    if (account.inforName) {
      const inforNames = account.inforName.split('|').map(n => n.trim());
      for (const inforName of inforNames) {
        const gpValue = unmatchedScheduledGP[inforName] || 0;
        if (gpValue > 0 && !scheduledGPCounted.has(inforName)) {
          scheduledGPCounted.add(inforName);
          totalScheduledGP += gpValue;
        }
      }
    }

    account.scheduledGP = totalScheduledGP;
  }

  // Calculate totals and derived fields for ASSIGNED accounts
  let totalInvoicedGPAssigned = 0;
  for (const account of assignedResults.matchedAccounts) {
    totalInvoicedGPAssigned += account.invoicedGP;
  }

  for (const account of assignedResults.matchedAccounts) {
    // B to I ratio
    if (account.invoicedGP > 0) {
      account.bToI = account.bookedGP / account.invoicedGP;
    } else {
      account.bToI = null;
    }

    // % of Inv Total (within assigned section)
    if (totalInvoicedGPAssigned > 0) {
      account.pctInvTotal = account.invoicedGP / totalInvoicedGPAssigned;
    } else {
      account.pctInvTotal = null;
    }
  }

  // Calculate derived fields for NOT ASSIGNED accounts
  let totalInvoicedGPNotAssigned = 0;
  for (const account of notAssignedResults.matchedAccounts) {
    totalInvoicedGPNotAssigned += account.invoicedGP;
  }

  for (const account of notAssignedResults.matchedAccounts) {
    // B to I ratio
    if (account.invoicedGP > 0) {
      account.bToI = account.bookedGP / account.invoicedGP;
    } else {
      account.bToI = null;
    }

    // % of Inv Total (within not-assigned section)
    if (totalInvoicedGPNotAssigned > 0) {
      account.pctInvTotal = account.invoicedGP / totalInvoicedGPNotAssigned;
    } else {
      account.pctInvTotal = null;
    }
  }

  console.log(`\n📊 Matching Results:`);
  console.log(`  ASSIGNED - Accounts with matches: ${assignedResults.matchedAccounts.filter(a => a.matchCount > 0).length}/${otAccountsAssigned.length}`);
  console.log(`  NOT ASSIGNED - Accounts with matches: ${notAssignedResults.matchedAccounts.filter(a => a.matchCount > 0).length}/${otAccountsNotAssigned.length} (includes ${unmatchedInfor.length} Infor-only)`);
  console.log(`  Total Infor customers matched: ${allMatchedInforCustomers.size}/${allInforCustomers.length}`);

  // Calculate total Booked GP and Scheduled GP for display
  let totalBookedGPAssigned = assignedResults.matchedAccounts.reduce((sum, a) => sum + (a.bookedGP || 0), 0);
  let totalBookedGPNotAssigned = notAssignedResults.matchedAccounts.reduce((sum, a) => sum + (a.bookedGP || 0), 0);
  let totalScheduledGPAssigned = assignedResults.matchedAccounts.reduce((sum, a) => sum + (a.scheduledGP || 0), 0);
  let totalScheduledGPNotAssigned = notAssignedResults.matchedAccounts.reduce((sum, a) => sum + (a.scheduledGP || 0), 0);

  console.log(`\n💰 GP Totals Check:`);
  console.log(`  ASSIGNED - Booked: $${totalBookedGPAssigned.toFixed(2)}, Invoiced: $${totalInvoicedGPAssigned.toFixed(2)}, Scheduled: $${totalScheduledGPAssigned.toFixed(2)}`);
  console.log(`  NOT ASSIGNED - Booked: $${totalBookedGPNotAssigned.toFixed(2)}, Invoiced: $${totalInvoicedGPNotAssigned.toFixed(2)}, Scheduled: $${totalScheduledGPNotAssigned.toFixed(2)}`);
  console.log(`  GRAND TOTAL - Booked: $${(totalBookedGPAssigned + totalBookedGPNotAssigned).toFixed(2)}, Invoiced: $${(totalInvoicedGPAssigned + totalInvoicedGPNotAssigned).toFixed(2)}, Scheduled: $${(totalScheduledGPAssigned + totalScheduledGPNotAssigned).toFixed(2)}`);

  // Note: Infor-only customers are already added to NOT ASSIGNED section above
  if (false && unmatchedInfor.length > 0) {
    console.log(`\n⚠️  Infor customers without OT match:`);
    for (const customer of unmatchedInfor) {
      const booked = bookedGP[customer] || 0;
      const invoiced = invoicedGP[customer] || 0;
      console.log(`  - ${customer} (Booked: $${booked.toFixed(2)}, Invoiced: $${invoiced.toFixed(2)})`);
    }
  }

  // Step 4: Generate Excel
  const prevQuarter = quarter === 'Q1' ? 'Q4' :
                      quarter === 'Q2' ? 'Q1' :
                      quarter === 'Q3' ? 'Q2' : 'Q3';

  const outputPath = path.join(projectDir, `Account Review - ${sellerName.replace(/ /g, '_')} - ${nextQuarter}_${nextQuarterYear}.xlsx`);

  await generateExcel({
    seller: sellerName,
    quarter,
    prevQuarter,
    year,
    nextQuarter,
    nextQuarterYear,
    gpGoal,
    assignedAccounts: assignedResults.matchedAccounts,
    notAssignedAccounts: notAssignedResults.matchedAccounts
  }, outputPath);

  console.log(`\n✅ Complete!`);
  console.log(`Output: ${outputPath}`);
}

// Run
main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
