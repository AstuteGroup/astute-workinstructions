#!/usr/bin/env node

/**
 * Inspection Queue Maintenance
 *
 * Auto-fixes inspection queue LOTS with missing SO Line allocations.
 * Processes what the user sees in the MI QUEUE - lots with NULL weighted priority.
 *
 * Usage:
 *   node inspection-queue-maintenance.js [options]
 *
 * Options:
 *   --dry-run       Report only, no writes
 *   --limit N       Process max N lots (default: no limit)
 *   --verbose       Print each lot being processed
 *   --output-dir    Directory for escalation report (default: ./output)
 *
 * What it does:
 *   1. Finds LOTS in MI QUEUE with NULL weighted priority
 *   2. Skips Lam Research and Flock Safety (intentionally unallocated)
 *   3. For each lot, finds candidate SO Lines by MPN match
 *   4. Auto-fixes single exact-qty matches
 *   5. Generates escalation report for ambiguous cases
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Use writeback-proxy-client for the actual PATCH
const { linkAllocSOLine } = require('../../shared/writeback-proxy-client');
const breadcrumbs = require('../../shared/breadcrumbs');
const { createNotifier } = require('../../shared/notifier');

// ─── NOTIFICATION CONFIG ────────────────────────────────────────────────────

const NOTIFICATION_RECIPIENT = 'justin.oberhofer@astutegroup.com';
const notifier = createNotifier({
  fromEmail: 'bizops@orangetsunami.com',
  fromName: 'Inspection Queue Maintenance'
});

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');

// Classification types
const CLASSIFICATION = {
  AUTO_FIX: 'AUTO_FIX',
  ESCALATE_MULTIPLE: 'ESCALATE_MULTIPLE',
  ESCALATE_QTY_MISMATCH: 'ESCALATE_QTY_MISMATCH',
  NO_CANDIDATES: 'NO_CANDIDATES'
};

// Customers to skip (no escalation needed - they often have unallocated orders intentionally)
// BP IDs: Lam Research = 1000730, Flock Safety = 1006460
const SKIP_CUSTOMER_IDS = [1000730, 1006460];

// Vendors to skip (test houses - parts already went through inspection before send-out)
// BP IDs: White Horse Laboratories Ltd = 1002731
const SKIP_VENDOR_IDS = [1002731];

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
 * Find LOTS in MI QUEUE with NULL weighted priority.
 * This is what the user sees in the inspection queue.
 *
 * Uses warehouse_group to determine location (AUSTIN vs HONG KONG),
 * not just the shelf name (both locations have "MI QUEUE" shelf).
 */
function findProblemLots(limit) {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const sql = `
    SELECT
      q.m_attributesetinstance_id AS lot_id,
      q.chuboe_mpnlot_mpn AS mpn,
      q.chuboe_mpnlot_qty AS lot_qty,
      q.chuboe_mpnlot_lot AS lot_number,
      q.chuboe_rfq_id,
      rfq.value AS rfq_value,
      rfq.c_bpartner_id AS customer_id,
      bp.name AS customer_name,
      ws.name AS shelf_name,
      wg.chuboe_warehouse_group_id AS warehouse_group_id,
      wg.name AS warehouse_group_name,
      vq.c_bpartner_id AS vendor_id,
      vendor.name AS vendor_name
    FROM adempiere.chuboe_insp_mpnlotqueue_v q
    LEFT JOIN adempiere.chuboe_rfq rfq ON rfq.chuboe_rfq_id = q.chuboe_rfq_id
    LEFT JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = rfq.c_bpartner_id
    LEFT JOIN adempiere.chuboe_warehouse_shelf ws ON ws.chuboe_warehouse_shelf_id = q.chuboe_warehouse_shelf_id
    LEFT JOIN adempiere.chuboe_warehouse_group wg ON wg.chuboe_warehouse_group_id = q.chuboe_warehouse_group_id
    LEFT JOIN adempiere.chuboe_vq_line vq ON vq.chuboe_vq_line_id = q.chuboe_vq_line_id
    LEFT JOIN adempiere.c_bpartner vendor ON vendor.c_bpartner_id = vq.c_bpartner_id
    WHERE q.isactive = 'Y'
      AND ws.name = 'MI QUEUE'
      AND q.chuboe_po_pickeduser_id IS NULL
      AND COALESCE(q.isvalidate, 'N') = 'N'
      AND COALESCE(q.processed, 'N') = 'N'
      AND q.chuboe_weightedpriority IS NULL
    ORDER BY wg.name, q.m_attributesetinstance_id DESC
    ${limitClause}
  `;

  const rows = runQuery(sql);
  const columns = [
    'lot_id', 'mpn', 'lot_qty', 'lot_number', 'chuboe_rfq_id',
    'rfq_value', 'customer_id', 'customer_name', 'shelf_name',
    'warehouse_group_id', 'warehouse_group_name', 'vendor_id', 'vendor_name'
  ];

  return rows.map(row => parseRow(row, columns));
}

/**
 * Find allocations for a lot that need SO Line linking.
 */
function findAllocationsForLot(lotId) {
  const sql = `
    SELECT chuboe_alloc_order_lot_id, qty
    FROM adempiere.chuboe_alloc_order_lot
    WHERE chuboe_insp_lot_id = ${lotId}
      AND c_orderline_id IS NULL
      AND isactive = 'Y'
  `;

  const rows = runQuery(sql);
  return rows.map(row => {
    const [allocId, qty] = row.split('|');
    return { allocId: parseInt(allocId, 10), qty: parseInt(qty, 10) };
  });
}

/**
 * Find candidate SO Lines by MPN match.
 */
function findCandidateSOLines(mpn) {
  if (!mpn) return [];

  const mpnStr = String(mpn).trim();
  const escapedMpn = mpnStr.replace(/'/g, "''");

  const sql = `
    SELECT sol.c_orderline_id,
           so.documentno AS so_documentno,
           sol.qtyentered,
           sol.line AS so_line_no,
           bp.name AS customer_name
    FROM adempiere.c_orderline sol
    JOIN adempiere.c_order so
      ON so.c_order_id = sol.c_order_id
      AND so.issotrx = 'Y'
    JOIN adempiere.c_bpartner bp
      ON bp.c_bpartner_id = so.c_bpartner_id
    WHERE UPPER(TRIM(sol.chuboe_mpn)) = UPPER('${escapedMpn}')
      AND sol.isactive = 'Y'
      AND so.isactive = 'Y'
    ORDER BY sol.qtyentered DESC
  `;

  const rows = runQuery(sql);
  const columns = ['c_orderline_id', 'so_documentno', 'qtyentered', 'so_line_no', 'customer_name'];

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
 * Classify a lot based on candidate SO Lines.
 */
function classifyLot(lot, candidates) {
  if (candidates.length === 0) {
    return {
      classification: CLASSIFICATION.NO_CANDIDATES,
      candidates: [],
      recommendation: null,
      reason: 'No Sales Order Line found matching this MPN'
    };
  }

  // Check each candidate for available qty
  const candidatesWithAvailable = candidates.map(c => {
    const allocated = getAllocatedQty(c.c_orderline_id);
    const available = c.qtyentered - allocated;
    return { ...c, allocated, available };
  });

  // Filter to candidates with sufficient qty
  const sufficient = candidatesWithAvailable.filter(c => c.available >= lot.lot_qty);

  // Exact match (qty equals exactly)
  const exactMatch = sufficient.filter(c => c.available === lot.lot_qty);

  // Single exact match = AUTO_FIX
  if (exactMatch.length === 1) {
    return {
      classification: CLASSIFICATION.AUTO_FIX,
      candidates: exactMatch,
      recommendation: exactMatch[0],
      reason: `Single exact qty match: ${exactMatch[0].so_documentno} Line ${exactMatch[0].so_line_no}`
    };
  }

  // Single candidate with sufficient qty = AUTO_FIX
  if (sufficient.length === 1) {
    return {
      classification: CLASSIFICATION.AUTO_FIX,
      candidates: sufficient,
      recommendation: sufficient[0],
      reason: `Single candidate with sufficient qty: ${sufficient[0].so_documentno} Line ${sufficient[0].so_line_no}`
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
  const best = candidatesWithAvailable[0];
  return {
    classification: CLASSIFICATION.ESCALATE_QTY_MISMATCH,
    candidates: candidatesWithAvailable,
    recommendation: best,
    reason: best
      ? `No candidate has sufficient qty. Best: ${best.so_documentno} Line ${best.so_line_no} (available: ${best.available}, need: ${lot.lot_qty})`
      : 'No candidates available'
  };
}

// ─── MAIN PROCESSING ─────────────────────────────────────────────────────────

async function processLots(opts) {
  const { dryRun, limit, verbose, outputDir } = opts;

  console.log('=== Inspection Queue Maintenance ===\n');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}`);
  if (limit) console.log(`Limit: ${limit} lots`);
  console.log('');

  // Find problem lots
  const lots = findProblemLots(limit);
  console.log(`Found ${lots.length} lots with missing weighted priority\n`);

  if (lots.length === 0) {
    console.log('Nothing to process.');
    return { autoFixed: 0, escalations: 0, skipped: 0 };
  }

  const results = {
    autoFixed: [],
    escalations: [],
    skipped: []
  };

  for (const lot of lots) {
    const location = lot.warehouse_group_name || 'Unknown';
    if (verbose) {
      console.log(`Processing Lot ${lot.lot_id} [${location}]: MPN=${lot.mpn}, Qty=${lot.lot_qty}, Customer=${lot.customer_name || 'N/A'}`);
    }

    // Skip customers that often have unallocated orders intentionally
    if (lot.customer_id && SKIP_CUSTOMER_IDS.includes(lot.customer_id)) {
      if (verbose) console.log(`  → SKIP: ${lot.customer_name} (intentionally unallocated)`);
      results.skipped.push({ ...lot, reason: `${lot.customer_name} - intentionally unallocated` });
      continue;
    }

    // Skip test house vendors (parts already went through inspection before send-out)
    if (lot.vendor_id && SKIP_VENDOR_IDS.includes(lot.vendor_id)) {
      if (verbose) console.log(`  → SKIP: ${lot.vendor_name} (test house return)`);
      results.skipped.push({ ...lot, reason: `${lot.vendor_name} - test house return` });
      continue;
    }

    // Skip if no MPN
    if (!lot.mpn) {
      if (verbose) console.log(`  → SKIP: No MPN on lot`);
      results.skipped.push({ ...lot, reason: 'No MPN on lot' });
      continue;
    }

    // Find candidate SO Lines
    const candidates = findCandidateSOLines(lot.mpn);
    const { classification, recommendation, reason } = classifyLot(lot, candidates);

    if (classification === CLASSIFICATION.AUTO_FIX && recommendation) {
      // Get allocations for this lot
      const allocations = findAllocationsForLot(lot.lot_id);

      if (allocations.length === 0) {
        if (verbose) console.log(`  → SKIP: No unlinked allocations for this lot`);
        results.skipped.push({ ...lot, reason: 'No unlinked allocations' });
        continue;
      }

      // Link all allocations to the recommended SO Line
      if (dryRun) {
        console.log(`AUTO-FIX (dry-run): Lot ${lot.lot_id} (${lot.mpn}) → ${recommendation.so_documentno} Line ${recommendation.so_line_no} (${allocations.length} allocation(s))`);
      } else {
        try {
          for (const alloc of allocations) {
            await linkAllocSOLine(alloc.allocId, recommendation.c_orderline_id, {
              skipQtyCheck: false,
              dryRun: false
            });
          }
          console.log(`AUTO-FIX: Lot ${lot.lot_id} (${lot.mpn}) → ${recommendation.so_documentno} Line ${recommendation.so_line_no} (${allocations.length} allocation(s))`);
        } catch (err) {
          console.error(`ERROR: Lot ${lot.lot_id} → ${err.message}`);
          results.escalations.push({ ...lot, classification: 'ERROR', reason: err.message });
          continue;
        }
      }
      results.autoFixed.push({ ...lot, recommendation, reason });

    } else if (classification === CLASSIFICATION.NO_CANDIDATES) {
      if (verbose) console.log(`  → SKIP: ${reason}`);
      results.skipped.push({ ...lot, reason });

    } else {
      // Escalate
      console.log(`ESCALATE: Lot ${lot.lot_id} (${lot.mpn}) → ${reason}`);
      results.escalations.push({ ...lot, classification, reason, candidates });
    }
  }

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Auto-fixed: ${results.autoFixed.length}`);
  console.log(`Escalations: ${results.escalations.length}`);
  console.log(`Skipped: ${results.skipped.length}`);

  // Write escalation report if any
  if (results.escalations.length > 0) {
    writeEscalationReport(results.escalations, outputDir, dryRun);
  }

  // Send notification if there are auto-fixes or escalations
  if (!dryRun && (results.autoFixed.length > 0 || results.escalations.length > 0)) {
    await sendNotification(results);
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

function writeEscalationReport(escalations, outputDir, dryRun) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const filename = `escalations-${timestamp}${dryRun ? '-dryrun' : ''}.csv`;
  const filepath = path.join(outputDir, filename);

  const header = 'LotID,MPN,LotQty,Customer,Classification,Reason';
  const rows = escalations.map(e => {
    return [
      e.lot_id,
      `"${(e.mpn || '').replace(/"/g, '""')}"`,
      e.lot_qty,
      `"${(e.customer_name || '').replace(/"/g, '""')}"`,
      e.classification,
      `"${(e.reason || '').replace(/"/g, '""')}"`
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');
  fs.writeFileSync(filepath, csv);

  console.log(`\nEscalation report written to: ${filepath}`);
}

// ─── NOTIFICATION ─────────────────────────────────────────────────────────────

/**
 * Send email notification for auto-fixes and escalations.
 */
async function sendNotification(results) {
  const { autoFixed, escalations } = results;

  const subject = `Inspection Queue Maintenance: ${autoFixed.length} fixed, ${escalations.length} escalations`;

  let body = '=== Inspection Queue Maintenance Report ===\n\n';

  // Auto-fixes section
  if (autoFixed.length > 0) {
    body += `✅ AUTO-FIXED (${autoFixed.length}):\n`;
    body += '─'.repeat(50) + '\n';
    for (const lot of autoFixed) {
      body += `  • Lot ${lot.lot_id}: ${lot.mpn} (${lot.lot_qty} pcs)\n`;
      body += `    Customer: ${lot.customer_name || 'N/A'}\n`;
      body += `    Linked to: ${lot.recommendation.so_documentno} Line ${lot.recommendation.so_line_no}\n\n`;
    }
  }

  // Escalations section
  if (escalations.length > 0) {
    body += `\n⚠️ ESCALATIONS (${escalations.length}) - Manual action required:\n`;
    body += '─'.repeat(50) + '\n';
    for (const lot of escalations) {
      body += `  • Lot ${lot.lot_id}: ${lot.mpn} (${lot.lot_qty} pcs)\n`;
      body += `    Customer: ${lot.customer_name || 'N/A'}\n`;
      body += `    Reason: ${lot.reason}\n\n`;
    }
    body += '\nSee inspection-queue-maintenance-task.md for fix workflow.\n';
  }

  body += '\n---\nGenerated by inspection-queue-maintenance.js';

  try {
    await notifier.sendEmail(NOTIFICATION_RECIPIENT, subject, body);
    console.log(`\nNotification sent to ${NOTIFICATION_RECIPIENT}`);
  } catch (err) {
    console.error(`Failed to send notification: ${err.message}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  try {
    await processLots(opts);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
