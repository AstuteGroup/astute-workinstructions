#!/usr/bin/env node

/**
 * Inspection Queue Maintenance
 *
 * Auto-fixes inspection queue records with missing SO Line allocations.
 * Auto-fixes straightforward cases (exact qty match, single candidate),
 * reports escalations for ambiguous cases.
 *
 * Usage:
 *   node inspection-queue-maintenance.js [options]
 *
 * Options:
 *   --dry-run       Report only, no writes
 *   --limit N       Process max N records (default: no limit)
 *   --verbose       Print each allocation being processed
 *   --output-dir    Directory for escalation report (default: ./output)
 *
 * What it does:
 *   1. Finds allocations (chuboe_alloc_order_lot) with NULL c_orderline_id
 *   2. For each allocation, finds candidate SO Lines via CQ chain
 *   3. Classifies: AUTO_FIX / ESCALATE_MULTIPLE / ESCALATE_QTY_MISMATCH / NO_CANDIDATES
 *   4. Auto-fixes single exact-qty matches
 *   5. Generates escalation report for ambiguous cases
 *
 * See: Business Ops/cron-inspection queue maintenance/inspection-queue-maintenance-task.md
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Use writeback-proxy-client for the actual PATCH
const { linkAllocSOLine } = require('../../shared/writeback-proxy-client');
const breadcrumbs = require('../../shared/breadcrumbs');

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');

// Classification types
const CLASSIFICATION = {
  AUTO_FIX: 'AUTO_FIX',
  ESCALATE_MULTIPLE: 'ESCALATE_MULTIPLE',
  ESCALATE_QTY_MISMATCH: 'ESCALATE_QTY_MISMATCH',
  NO_CANDIDATES: 'NO_CANDIDATES'
};

// ─── CLI ARGS ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    limit: null,
    verbose: false,
    outputDir: DEFAULT_OUTPUT_DIR
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--limit' && args[i + 1]) {
      opts.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--verbose') {
      opts.verbose = true;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      opts.outputDir = args[i + 1];
      i++;
    }
  }

  return opts;
}

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────

/**
 * Run a SQL query and return raw result string.
 */
function runQueryRaw(sql) {
  try {
    const result = execSync(`psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });
    return result.trim();
  } catch (err) {
    console.error('SQL Error:', err.message);
    return '';
  }
}

/**
 * Run a SQL query and return parsed rows.
 */
function runQuery(sql) {
  const raw = runQueryRaw(sql);
  if (!raw || raw === '(0 rows)') return [];
  return raw.split('\n').filter(line => line && line !== '(0 rows)');
}

/**
 * Parse a pipe-delimited row into an object.
 */
function parseRow(row, columns) {
  const values = row.split('|');
  const obj = {};
  columns.forEach((col, i) => {
    let val = values[i];
    if (val === '' || val === undefined) val = null;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
    obj[col] = val;
  });
  return obj;
}

// ─── CORE QUERIES ────────────────────────────────────────────────────────────

/**
 * Find allocations with NULL c_orderline_id (missing SO Line link).
 */
function findMissingAllocations(limit) {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const sql = `
    SELECT aol.chuboe_alloc_order_lot_id,
           aol.chuboe_insp_lot_id,
           aol.qty,
           lv.chuboe_mpnlot_mpn AS mpn,
           lv.chuboe_rfq_id,
           lv.chuboe_vq_line_id,
           rfq.value AS rfq_value
    FROM adempiere.chuboe_alloc_order_lot aol
    JOIN adempiere.chuboe_insp_mpnlot_v lv
      ON lv.chuboe_insp_lot_id = aol.chuboe_insp_lot_id
    LEFT JOIN adempiere.chuboe_rfq rfq
      ON rfq.chuboe_rfq_id = lv.chuboe_rfq_id
    WHERE aol.isactive = 'Y'
      AND aol.c_orderline_id IS NULL
    ORDER BY aol.chuboe_alloc_order_lot_id DESC
    ${limitClause}
  `;

  const rows = runQuery(sql);
  const columns = [
    'chuboe_alloc_order_lot_id', 'chuboe_insp_lot_id', 'qty',
    'mpn', 'chuboe_rfq_id', 'chuboe_vq_line_id', 'rfq_value'
  ];

  return rows.map(row => parseRow(row, columns));
}

/**
 * Find candidate SO Lines for an allocation.
 *
 * Strategy: RFQ → CQ Lines (IsSold='Y') → c_orderline (via chuboe_cq_line_id)
 *
 * A CQ Line that is marked IsSold='Y' should be linked to a c_orderline record
 * via the chuboe_cq_line_id foreign key on the SO Line.
 */
function findCandidateSOLines(rfqId, mpn) {
  if (!rfqId || !mpn) return [];

  // Ensure mpn is a string
  const mpnStr = String(mpn);
  const escapedMpn = mpnStr.replace(/'/g, "''");

  const sql = `
    SELECT sol.c_orderline_id,
           so.documentno AS so_documentno,
           sol.qtyentered,
           sol.line AS so_line_no,
           bp.name AS customer_name,
           cq.chuboe_cq_line_id,
           cq.qty AS cq_qty
    FROM adempiere.chuboe_cq_line cq
    JOIN adempiere.c_orderline sol
      ON sol.chuboe_cq_line_id = cq.chuboe_cq_line_id
    JOIN adempiere.c_order so
      ON so.c_order_id = sol.c_order_id
    JOIN adempiere.c_bpartner bp
      ON bp.c_bpartner_id = so.c_bpartner_id
    WHERE cq.chuboe_rfq_id = ${rfqId}
      AND UPPER(REPLACE(REPLACE(cq.chuboe_mpn, '-', ''), ' ', ''))
        = UPPER(REPLACE(REPLACE('${escapedMpn}', '-', ''), ' ', ''))
      AND cq.issold = 'Y'
      AND cq.isactive = 'Y'
      AND sol.isactive = 'Y'
      AND so.isactive = 'Y'
    ORDER BY sol.qtyentered DESC
  `;

  const rows = runQuery(sql);
  const columns = [
    'c_orderline_id', 'so_documentno', 'qtyentered', 'so_line_no',
    'customer_name', 'chuboe_cq_line_id', 'cq_qty'
  ];

  return rows.map(row => parseRow(row, columns));
}

/**
 * Get already-allocated qty for a given SO Line.
 */
function getAllocatedQty(soLineId) {
  const sql = `
    SELECT COALESCE(SUM(qty), 0)
    FROM adempiere.chuboe_alloc_order_lot
    WHERE c_orderline_id = ${soLineId}
      AND isactive = 'Y'
  `;
  const rows = runQuery(sql);
  if (rows.length === 0) return 0;
  return parseFloat(rows[0]) || 0;
}

// ─── CLASSIFICATION ──────────────────────────────────────────────────────────

/**
 * Classify an allocation based on candidate SO Lines.
 *
 * Returns: { classification, candidates, recommendation, reason }
 */
function classifyAllocation(alloc, candidates) {
  // No candidates = spec buy or no CQ sold
  if (candidates.length === 0) {
    return {
      classification: CLASSIFICATION.NO_CANDIDATES,
      candidates: [],
      recommendation: null,
      reason: 'No CQ Line marked IsSold=Y found for this RFQ/MPN'
    };
  }

  // Check each candidate for available qty
  const candidatesWithAvailable = candidates.map(c => {
    const allocated = getAllocatedQty(c.c_orderline_id);
    const available = c.qtyentered - allocated;
    return { ...c, allocated, available };
  });

  // Filter to candidates with sufficient qty
  const sufficient = candidatesWithAvailable.filter(c => c.available >= alloc.qty);

  // Exact match (qty equals exactly)
  const exactMatch = sufficient.filter(c => c.available === alloc.qty);

  // Single exact match = AUTO_FIX
  if (exactMatch.length === 1) {
    return {
      classification: CLASSIFICATION.AUTO_FIX,
      candidates: exactMatch,
      recommendation: exactMatch[0],
      reason: `Single exact qty match: ${exactMatch[0].so_documentno} Line ${exactMatch[0].so_line_no}`
    };
  }

  // Single candidate with sufficient qty (not exact) = AUTO_FIX
  if (sufficient.length === 1) {
    return {
      classification: CLASSIFICATION.AUTO_FIX,
      candidates: sufficient,
      recommendation: sufficient[0],
      reason: `Single candidate with sufficient qty: ${sufficient[0].so_documentno} Line ${sufficient[0].so_line_no} (available: ${sufficient[0].available}, need: ${alloc.qty})`
    };
  }

  // Multiple exact matches = ESCALATE
  if (exactMatch.length > 1) {
    return {
      classification: CLASSIFICATION.ESCALATE_MULTIPLE,
      candidates: exactMatch,
      recommendation: null,
      reason: `Multiple candidates with exact qty match (${exactMatch.length} options)`
    };
  }

  // Multiple candidates with sufficient qty = ESCALATE
  if (sufficient.length > 1) {
    return {
      classification: CLASSIFICATION.ESCALATE_MULTIPLE,
      candidates: sufficient,
      recommendation: null,
      reason: `Multiple candidates with sufficient qty (${sufficient.length} options)`
    };
  }

  // No candidate has sufficient qty = ESCALATE
  return {
    classification: CLASSIFICATION.ESCALATE_QTY_MISMATCH,
    candidates: candidatesWithAvailable,
    recommendation: candidatesWithAvailable[0] || null,  // Best attempt
    reason: `No candidate has sufficient qty. Best: ${
      candidatesWithAvailable[0]
        ? `${candidatesWithAvailable[0].so_documentno} Line ${candidatesWithAvailable[0].so_line_no} (available: ${candidatesWithAvailable[0].available}, need: ${alloc.qty})`
        : 'none'
    }`
  };
}

// ─── MAIN PROCESSING ─────────────────────────────────────────────────────────

/**
 * Process all allocations.
 */
async function processAllocations(opts) {
  const { dryRun, limit, verbose, outputDir } = opts;

  console.log('=== Inspection Queue Maintenance ===\n');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}`);
  if (limit) console.log(`Limit: ${limit} records`);
  console.log('');

  // Find missing allocations
  const allocations = findMissingAllocations(limit);
  console.log(`Found ${allocations.length} allocations with missing SO Line\n`);

  if (allocations.length === 0) {
    console.log('Nothing to process.');
    return { autoFixed: 0, escalations: 0, skipped: 0 };
  }

  // Process each allocation
  const results = {
    autoFixed: [],
    escalations: [],
    skipped: []
  };

  for (const alloc of allocations) {
    const rfqDisplay = alloc.rfq_value || `ID:${alloc.chuboe_rfq_id}` || 'N/A';

    if (verbose) {
      console.log(`Processing Alloc ${alloc.chuboe_alloc_order_lot_id}: MPN=${alloc.mpn}, RFQ=${rfqDisplay}, Qty=${alloc.qty}`);
    }

    // Skip if no RFQ (spec buy)
    if (!alloc.chuboe_rfq_id) {
      if (verbose) console.log(`  → SKIP: No RFQ (spec buy)`);
      results.skipped.push({
        ...alloc,
        reason: 'No RFQ (spec buy)',
        classification: CLASSIFICATION.NO_CANDIDATES
      });
      continue;
    }

    // Skip if no MPN (data issue)
    if (!alloc.mpn) {
      if (verbose) console.log(`  → SKIP: No MPN on lot`);
      results.skipped.push({
        ...alloc,
        reason: 'No MPN on lot',
        classification: CLASSIFICATION.NO_CANDIDATES
      });
      continue;
    }

    // Find candidates
    const candidates = findCandidateSOLines(alloc.chuboe_rfq_id, alloc.mpn);

    // Classify
    const { classification, candidates: classifiedCandidates, recommendation, reason } = classifyAllocation(alloc, candidates);

    if (classification === CLASSIFICATION.AUTO_FIX && recommendation) {
      // Auto-fix
      if (dryRun) {
        console.log(`AUTO-FIX (dry-run): Alloc ${alloc.chuboe_alloc_order_lot_id} → SO Line ${recommendation.c_orderline_id} (qty: ${alloc.qty})`);
      } else {
        try {
          await linkAllocSOLine(alloc.chuboe_alloc_order_lot_id, recommendation.c_orderline_id, {
            skipQtyCheck: false,
            dryRun: false
          });
          console.log(`AUTO-FIX: Alloc ${alloc.chuboe_alloc_order_lot_id} → SO Line ${recommendation.c_orderline_id} (qty: ${alloc.qty})`);
        } catch (err) {
          console.error(`ERROR: Alloc ${alloc.chuboe_alloc_order_lot_id} → ${err.message}`);
          results.escalations.push({
            ...alloc,
            classification: 'ERROR',
            reason: err.message,
            candidates: classifiedCandidates
          });
          continue;
        }
      }
      results.autoFixed.push({
        ...alloc,
        classification,
        recommendation,
        reason
      });
    } else if (classification === CLASSIFICATION.NO_CANDIDATES) {
      if (verbose) console.log(`  → SKIP: ${reason}`);
      results.skipped.push({
        ...alloc,
        classification,
        reason
      });
    } else {
      // Escalate
      console.log(`ESCALATE: Alloc ${alloc.chuboe_alloc_order_lot_id} → ${reason}`);
      results.escalations.push({
        ...alloc,
        classification,
        reason,
        candidates: classifiedCandidates
      });
    }
  }

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Auto-fixed: ${results.autoFixed.length}`);
  console.log(`Escalations: ${results.escalations.length}`);
  console.log(`Skipped (spec buys): ${results.skipped.length}`);

  // Write escalation report if any
  if (results.escalations.length > 0) {
    writeEscalationReport(results.escalations, outputDir, dryRun);
  }

  // Write breadcrumb
  breadcrumbs.write({
    cog: 'inspection-queue-maintenance',
    event: 'run-complete',
    dryRun,
    autoFixed: results.autoFixed.length,
    escalations: results.escalations.length,
    skipped: results.skipped.length
  });

  return {
    autoFixed: results.autoFixed.length,
    escalations: results.escalations.length,
    skipped: results.skipped.length
  };
}

// ─── ESCALATION REPORT ───────────────────────────────────────────────────────

/**
 * Write escalation CSV report.
 */
function writeEscalationReport(escalations, outputDir, dryRun) {
  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const filename = `escalations-${timestamp}${dryRun ? '-dryrun' : ''}.csv`;
  const filepath = path.join(outputDir, filename);

  // CSV header
  const header = 'AllocID,LotID,MPN,LotQty,RFQ,Type,CandidateCount,Recommendation';
  const rows = escalations.map(e => {
    const candidateCount = e.candidates ? e.candidates.length : 0;
    const rec = e.candidates && e.candidates[0]
      ? `${e.candidates[0].so_documentno} Line ${e.candidates[0].so_line_no} (avail: ${e.candidates[0].available})`
      : 'N/A';

    return [
      e.chuboe_alloc_order_lot_id,
      e.chuboe_insp_lot_id,
      `"${(e.mpn || '').replace(/"/g, '""')}"`,
      e.qty,
      e.rfq_value || e.chuboe_rfq_id || 'N/A',
      e.classification,
      candidateCount,
      `"${rec.replace(/"/g, '""')}"`
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');
  fs.writeFileSync(filepath, csv);

  console.log(`\nEscalation report written to: ${filepath}`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  try {
    await processAllocations(opts);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
