/**
 * Weekly RFQ Container for Market Intelligence
 *
 * Single weekly RFQ used by both Market Profiling and Active Sourcing.
 * All market intelligence VQs (profiling $0 availability + sourcing real quotes)
 * go to the same container.
 *
 * Naming: "Market Intelligence 2026-W23"
 */

const path = require('path');
const { execFileSync } = require('child_process');

// Shared utilities
const sharedPath = path.join(__dirname, '../../shared');
const { apiPost } = require(path.join(sharedPath, 'api-client'));

/**
 * Get ISO week number for a date
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get the weekly RFQ identifier (e.g., "2026-W23")
 */
function getWeeklyRFQIdentifier(date = new Date()) {
  const weekNum = getWeekNumber(date);
  return `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get or create the weekly Market Intelligence RFQ
 *
 * @returns {Promise<{searchKey: string, id: number, description: string, created: boolean}>}
 */
async function getOrCreateWeeklyRFQ() {
  const weekStr = getWeeklyRFQIdentifier();
  const description = `Market Intelligence ${weekStr}`;

  // Check if exists
  const existingSql = `
    SELECT value, chuboe_rfq_id
    FROM adempiere.chuboe_rfq
    WHERE description = '${description}'
      AND isactive = 'Y'
    ORDER BY created DESC
    LIMIT 1
  `;

  let existing = null;
  try {
    const out = execFileSync('psql', ['-At', '-F', '|', '-c', existingSql], { encoding: 'utf8' }).trim();
    if (out) {
      const [value, id] = out.split('|');
      existing = { searchKey: value, id: parseInt(id, 10) };
    }
  } catch (e) {
    // Query failed, will create new
  }

  if (existing) {
    return {
      searchKey: existing.searchKey,
      id: existing.id,
      description,
      created: false
    };
  }

  // Create new weekly RFQ
  const payload = {
    C_BPartner_ID: 1000000,       // Astute Electronics Inc
    Chuboe_RFQ_Type_ID: 1000007,  // Stock
    SalesRep_ID: 1000004,         // Jake Harris
    R_Status_ID: 1000022,         // New
    Description: description
  };

  const result = await apiPost('chuboe_rfq', payload);
  const searchKey = result.Value || result.value;

  console.log(`Created weekly RFQ: ${searchKey} — ${description}`);

  return {
    searchKey,
    id: result.id,
    description,
    created: true
  };
}

/**
 * Add lines to the weekly RFQ (for profiling or sourcing)
 *
 * @param {number} rfqId - RFQ ID
 * @param {Array<{mpn: string, qty: number}>} mpns - MPNs to add
 * @param {string} source - 'profiling' or 'sourcing' (for logging)
 * @returns {Promise<number>} - Number of lines added
 */
async function addLinesToWeeklyRFQ(rfqId, mpns, source = 'unknown') {
  let added = 0;

  // Get current max line number
  const maxLineSql = `
    SELECT COALESCE(MAX(line), 0)::int
    FROM adempiere.chuboe_rfq_line
    WHERE chuboe_rfq_id = ${rfqId}
  `;
  let lineNum = 0;
  try {
    const out = execFileSync('psql', ['-At', '-c', maxLineSql], { encoding: 'utf8' }).trim();
    lineNum = parseInt(out, 10) || 0;
  } catch (e) {
    // Start at 0
  }

  for (const item of mpns) {
    lineNum += 10;

    try {
      // Create line
      const lineResult = await apiPost('chuboe_rfq_line', {
        Chuboe_RFQ_ID: rfqId,
        Line: lineNum,
        Qty: item.qty || 1
      });

      // Create line MPN
      await apiPost('chuboe_rfq_line_mpn', {
        Chuboe_RFQ_Line_ID: lineResult.id,
        Chuboe_RFQ_ID: rfqId,
        Chuboe_MPN: item.mpn,
        Chuboe_MPN_Clean: item.mpn.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        Qty: item.qty || 1
      });

      added++;
    } catch (e) {
      console.warn(`  [${source}] Failed to add line for ${item.mpn}: ${e.message}`);
    }
  }

  return added;
}

module.exports = {
  getOrCreateWeeklyRFQ,
  addLinesToWeeklyRFQ,
  getWeeklyRFQIdentifier
};
