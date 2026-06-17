/**
 * Test resale logic on Active Sourcing batches
 *
 * Usage:
 *   node test-resale-logic.js --rfq 1137344           # Analyze specific Active Sourcing batch
 *   node test-resale-logic.js                          # Find and analyze most recent batch
 *   node test-resale-logic.js MPN1 MPN2 ...           # Analyze specific MPNs
 *
 * The primary use case is analyzing delisted parts from Active Sourcing RFQs
 * that have been price-checked in the broker market.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// Franchise vendor type ID
const FRANCHISE_VENDOR_TYPE = 1000002;

/**
 * Find recent Active Sourcing RFQs
 */
async function findActiveSourcingRFQs() {
  const sql = `
    SELECT
      r.chuboe_rfq_id,
      r.value AS rfq_number,
      r.description,
      r.created,
      COUNT(DISTINCT lm.chuboe_rfq_line_mpn_id) AS line_count
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line_mpn lm ON lm.chuboe_rfq_id = r.chuboe_rfq_id
    WHERE r.isactive = 'Y'
      AND r.chuboe_rfq_type_id = 1000007
      AND r.description ILIKE '%active sourcing%'
      AND r.created > NOW() - INTERVAL '30 days'
    GROUP BY r.chuboe_rfq_id, r.value, r.description, r.created
    ORDER BY r.created DESC
    LIMIT 5;
  `;
  const result = await pool.query(sql);
  return result.rows;
}

/**
 * Analyze an Active Sourcing batch
 */
async function analyzeActiveSourcingBatch(rfqNumber) {
  // Get RFQ details
  const rfqSql = `
    SELECT r.chuboe_rfq_id, r.value, r.description, r.created
    FROM adempiere.chuboe_rfq r
    WHERE r.value = $1 AND r.isactive = 'Y';
  `;
  const rfqResult = await pool.query(rfqSql, [rfqNumber]);
  if (rfqResult.rows.length === 0) {
    console.log(`RFQ ${rfqNumber} not found`);
    return;
  }
  const rfq = rfqResult.rows[0];

  console.log('='.repeat(100));
  console.log(`ACTIVE SOURCING BATCH: ${rfq.description || rfq.value}`);
  console.log(`RFQ: ${rfq.value}  |  Created: ${rfq.created.toISOString().substring(0, 10)}`);
  console.log('='.repeat(100));

  // Triage: SOURCED vs NOT_SOURCED
  const triageSql = `
    WITH batch_mpns AS (
      SELECT DISTINCT lm.chuboe_mpn_clean AS mpn
      FROM adempiere.chuboe_rfq_line_mpn lm
      WHERE lm.chuboe_rfq_id = $1 AND lm.isactive = 'Y'
    ),
    vq_check AS (
      SELECT bm.mpn,
        EXISTS (
          SELECT 1 FROM adempiere.chuboe_vq_line v
          JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id
          WHERE v.chuboe_mpn_clean = bm.mpn
            AND v.isactive = 'Y' AND v.cost > 0
            AND v.created > $2
            AND bp.name NOT ILIKE '%astute%'
            AND COALESCE(bp.chuboe_vendortype_id, 0) != $3  -- Exclude franchise VQs for broker check
        ) AS has_broker_vqs
      FROM batch_mpns bm
    )
    SELECT
      COUNT(*) FILTER (WHERE has_broker_vqs) AS sourced,
      COUNT(*) FILTER (WHERE NOT has_broker_vqs) AS not_sourced,
      COUNT(*) AS total
    FROM vq_check;
  `;
  const triage = await pool.query(triageSql, [rfq.chuboe_rfq_id, rfq.created, FRANCHISE_VENDOR_TYPE]);
  const t = triage.rows[0];

  console.log('');
  console.log('TRIAGE:');
  console.log(`  Total MPNs in batch:   ${t.total}`);
  console.log(`  SOURCED (broker VQs):  ${t.sourced} (${Math.round(t.sourced / t.total * 100)}%)`);
  console.log(`  NOT SOURCED:           ${t.not_sourced} (${Math.round(t.not_sourced / t.total * 100)}%) → back to master list`);
  console.log('');

  // Get detailed analysis for SOURCED parts
  const analysisSql = `
    WITH batch_mpns AS (
      SELECT DISTINCT lm.chuboe_mpn_clean AS mpn
      FROM adempiere.chuboe_rfq_line_mpn lm
      WHERE lm.chuboe_rfq_id = $1 AND lm.isactive = 'Y'
    ),
    broker_vqs AS (
      SELECT
        bm.mpn,
        COUNT(DISTINCT v.c_bpartner_id) AS broker_count,
        MIN(v.cost) AS broker_low,
        AVG(v.cost) AS broker_mid,
        MAX(v.cost) AS broker_high
      FROM batch_mpns bm
      JOIN adempiere.chuboe_vq_line v ON v.chuboe_mpn_clean = bm.mpn
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id
      WHERE v.isactive = 'Y' AND v.cost > 0
        AND v.created > $2
        AND bp.name NOT ILIKE '%astute%'
        AND COALESCE(bp.chuboe_vendortype_id, 0) != $3
      GROUP BY bm.mpn
    ),
    franchise_vqs AS (
      SELECT
        bm.mpn,
        MIN(v.cost) AS franchise_low,
        SUM(v.qty) AS franchise_stock,
        MAX(v.chuboe_lead_time) AS lead_time
      FROM batch_mpns bm
      JOIN adempiere.chuboe_vq_line v ON v.chuboe_mpn_clean = bm.mpn
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id
      WHERE v.chuboe_rfq_id = $1
        AND v.isactive = 'Y' AND v.cost > 0
        AND bp.chuboe_vendortype_id = $3
      GROUP BY bm.mpn
    ),
    rfq_activity AS (
      SELECT
        lm.chuboe_mpn_clean AS mpn,
        COUNT(DISTINCT lm.chuboe_rfq_line_mpn_id) AS rfq_count
      FROM adempiere.chuboe_rfq_line_mpn lm
      JOIN adempiere.chuboe_rfq r ON r.chuboe_rfq_id = lm.chuboe_rfq_id
      WHERE lm.isactive = 'Y' AND r.isactive = 'Y'
        AND r.created > NOW() - INTERVAL '30 days'
      GROUP BY lm.chuboe_mpn_clean
    ),
    our_sales AS (
      SELECT
        ol.chuboe_mpn_clean AS mpn,
        AVG(ol.priceentered) AS avg_sold,
        COUNT(*) AS sale_count
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
      WHERE ol.isactive = 'Y' AND o.issotrx = 'Y'
        AND o.docstatus IN ('CO', 'CL')
        AND ol.created > NOW() - INTERVAL '60 days'
      GROUP BY ol.chuboe_mpn_clean
    ),
    our_cqs AS (
      SELECT
        cq.chuboe_mpn_clean AS mpn,
        AVG(cq.priceentered) AS avg_cq,
        COUNT(*) AS cq_count
      FROM adempiere.chuboe_cq_line cq
      WHERE cq.isactive = 'Y'
        AND cq.created > NOW() - INTERVAL '90 days'
      GROUP BY cq.chuboe_mpn_clean
    )
    SELECT
      bv.mpn,
      bv.broker_count,
      ROUND(bv.broker_low::numeric, 4) AS broker_low,
      ROUND(bv.broker_mid::numeric, 4) AS broker_mid,
      ROUND(bv.broker_high::numeric, 4) AS broker_high,
      ROUND(fv.franchise_low::numeric, 4) AS franchise_low,
      fv.franchise_stock,
      fv.lead_time,
      COALESCE(ra.rfq_count, 0) AS rfq_count,
      ROUND(os.avg_sold::numeric, 4) AS avg_sold,
      os.sale_count,
      ROUND(oc.avg_cq::numeric, 4) AS avg_cq,
      oc.cq_count
    FROM broker_vqs bv
    LEFT JOIN franchise_vqs fv ON fv.mpn = bv.mpn
    LEFT JOIN rfq_activity ra ON ra.mpn = bv.mpn
    LEFT JOIN our_sales os ON os.mpn = bv.mpn
    LEFT JOIN our_cqs oc ON oc.mpn = bv.mpn
    ORDER BY COALESCE(ra.rfq_count, 0) DESC, bv.broker_count ASC
    LIMIT 25;
  `;

  const analysis = await pool.query(analysisSql, [rfq.chuboe_rfq_id, rfq.created, FRANCHISE_VENDOR_TYPE]);

  console.log('SOURCED PARTS - RESALE ANALYSIS (top 25 by RFQ activity):');
  console.log('-'.repeat(100));

  for (const r of analysis.rows) {
    // Compute classification
    const isLongLead = r.lead_time && parseInt(r.lead_time) >= 12;
    const isScarcity = r.broker_count <= 2 && (!r.franchise_stock || r.franchise_stock < 100);
    const isCommodity = r.franchise_stock >= 500 && r.broker_count >= 4;
    const classification = isLongLead || isScarcity ? 'SCARCITY' : (isCommodity ? 'COMMODITY' : 'MIDDLE');

    // Compute flags
    let salesFlag = '';
    if (r.avg_sold && r.broker_low) {
      if (parseFloat(r.avg_sold) < parseFloat(r.broker_low) * 0.90) salesFlag = '🔴 UNDERSOLD';
      else if (parseFloat(r.avg_sold) > parseFloat(r.broker_high) * 1.10) salesFlag = '🟢 PREMIUM';
    }

    let cqFlag = '';
    if (r.avg_cq && r.broker_low && r.rfq_count >= 3) {
      if (parseFloat(r.avg_cq) < parseFloat(r.broker_low) * 0.90) cqFlag = '🔴 QUOTING_LOW';
      else if (parseFloat(r.avg_cq) > parseFloat(r.broker_high) * 1.10) cqFlag = '🟡 QUOTING_HIGH';
    }

    // Compute target resale
    let target;
    if (classification === 'SCARCITY') target = parseFloat(r.broker_high) * 1.10;
    else if (classification === 'COMMODITY') target = parseFloat(r.broker_low) * 0.95;
    else target = parseFloat(r.broker_mid);

    // Apply franchise ceiling if well-stocked
    if (r.franchise_stock >= 500 && r.franchise_low) {
      target = Math.min(target, parseFloat(r.franchise_low));
    }

    // Floor: broker_low * 1.10 (minimum margin)
    const floor = parseFloat(r.broker_low) * 1.10;
    const resale = Math.max(target, floor);
    const margin = ((resale - parseFloat(r.broker_low)) / parseFloat(r.broker_low) * 100).toFixed(0);

    console.log('');
    console.log(`MPN: ${r.mpn}`);
    console.log(`  Broker:     ${r.broker_count} sources  |  $${r.broker_low} — $${r.broker_mid} — $${r.broker_high}`);
    if (r.franchise_low) {
      console.log(`  Franchise:  $${r.franchise_low}  |  ${r.franchise_stock || 0} in stock  |  ${r.lead_time || 'stock'} lead`);
    }
    console.log(`  RFQ Activity: ${r.rfq_count} (30d)  |  Class: ${classification}`);
    console.log(`  → Resale: $${resale.toFixed(4)}  (${margin}% margin over broker low)`);

    if (r.sale_count) {
      console.log(`  Sales (60d): ${r.sale_count} @ avg $${r.avg_sold}  ${salesFlag}`);
    }
    if (r.cq_count) {
      console.log(`  CQs (90d):   ${r.cq_count} @ avg $${r.avg_cq}  ${cqFlag}`);
    }
  }

  // Show NOT_SOURCED parts
  const notSourcedSql = `
    WITH batch_mpns AS (
      SELECT DISTINCT lm.chuboe_mpn_clean AS mpn, lm.chuboe_mfr_text AS mfr
      FROM adempiere.chuboe_rfq_line_mpn lm
      WHERE lm.chuboe_rfq_id = $1 AND lm.isactive = 'Y'
    )
    SELECT bm.mpn, bm.mfr
    FROM batch_mpns bm
    WHERE NOT EXISTS (
      SELECT 1 FROM adempiere.chuboe_vq_line v
      JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = v.c_bpartner_id
      WHERE v.chuboe_mpn_clean = bm.mpn
        AND v.isactive = 'Y' AND v.cost > 0
        AND v.created > $2
        AND bp.name NOT ILIKE '%astute%'
        AND COALESCE(bp.chuboe_vendortype_id, 0) != $3
    )
    LIMIT 10;
  `;

  const notSourced = await pool.query(notSourcedSql, [rfq.chuboe_rfq_id, rfq.created, FRANCHISE_VENDOR_TYPE]);

  if (notSourced.rows.length > 0) {
    console.log('');
    console.log('-'.repeat(100));
    console.log('NOT SOURCED (sample — need re-sourcing):');
    for (const r of notSourced.rows) {
      console.log(`  ${r.mpn}  (${r.mfr || 'unknown MFR'})`);
    }
  }

  console.log('');
}

async function main() {
  const args = process.argv.slice(2);

  // Check for --rfq flag
  const rfqIndex = args.indexOf('--rfq');
  if (rfqIndex !== -1 && args[rfqIndex + 1]) {
    await analyzeActiveSourcingBatch(args[rfqIndex + 1]);
  } else if (args.length === 0 || args[0] === '--rfq') {
    // Find most recent Active Sourcing batch
    console.log('Finding recent Active Sourcing batches...\n');
    const batches = await findActiveSourcingRFQs();

    if (batches.length === 0) {
      console.log('No Active Sourcing batches found in last 30 days.');
    } else {
      console.log('Recent Active Sourcing batches:');
      console.log('-'.repeat(70));
      for (const b of batches) {
        console.log(`  ${b.rfq_number.padEnd(10)} ${String(b.line_count).padStart(4)} MPNs  ${b.created.toISOString().substring(0, 10)}  ${b.description || ''}`);
      }
      console.log('');
      console.log(`Analyzing most recent: ${batches[0].rfq_number}\n`);
      await analyzeActiveSourcingBatch(batches[0].rfq_number);
    }
  } else {
    // Analyze specific MPNs (legacy mode)
    console.log('Analyzing specific MPNs...\n');
    for (const mpn of args) {
      if (mpn.startsWith('--')) continue;
      console.log(`TODO: Single MPN analysis for ${mpn}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  pool.end();
  process.exit(1);
});
