/**
 * GE Aerospace Rev-Share Batch 1 — Manual Analysis Pass
 *
 * One-off analysis script for the offer just loaded as search key 1025923
 * (chuboe_offer_id 1026030). Does the full 5-step Analysis pipeline manually
 * since the proper Analysis cogs (intent classifier, scoring engine, output
 * renderers) aren't built yet.
 *
 * Pipeline:
 *   1. Fetch the offer back from OT (verify round-trip integrity)
 *   2. Infer intent — hardcoded as 'consignment' (rev share, 538 lines, no prices)
 *   3. Enrich every line:
 *      - Supply: franchise APIs (cache-first via extractPriceAtQty, fall back to live API)
 *      - Demand: market-data.getAllMarketData (RFQ/CQ/SO history)
 *   4. Score every line (Supply 0-40, Price 0-35 N/A, Demand 0-25; max 65)
 *   5. Output: lot summary xlsx + per-line xlsx + GE source-quality sidecar csv
 *
 * Runtime: ~10-15 minutes for 538 lines (franchise API calls dominate).
 *
 * Notes:
 *   - Batch 1 has no offered prices, so Price Advantage is N/A → flagged
 *     NO_OFFER_PRICE, contributes 0 points. Max achievable score = 65.
 *   - GE-internal MPNs (REV markers, parens, etc.) won't resolve in franchise
 *     APIs. The low resolution rate IS the leverage to push back on GE.
 */

require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const { execSync } = require('child_process');
const { searchAllDistributors } = require(path.join(REPO, 'shared/franchise-api'));
const { extractPriceAtQty, writePricingResult } = require(path.join(REPO, 'shared/api-result-writer'));
const { getAllMarketData, cleanMpn } = require(path.join(REPO, 'shared/market-data'));
const { classifyMpnNonFranchise } = require(path.join(REPO, 'shared/mpn-classifier'));

const OFFER_ID = 1026030;
const OFFER_SEARCH_KEY = '1025923';
const PARTNER_NAME = 'GE Aerospace (Formerly GE Aviation)';
const SOURCE_FILE = '/home/analytics_user/workspace/excess-downloads/Astute rev share parts.xlsx';
const SOURCE_SHEET = 'Legacy Obsolete '; // trailing space intentional

const FROM_EMAIL = 'excess@orangetsunami.com';
const TO_EMAIL = 'jake.harris@astutegroup.com';

// NOTE v2: outputs are built as in-memory buffers and sent directly to
// nodemailer. No more OUTPUT_DIR / disk writes per the
// feedback_outputs_emailed_not_persisted memory.

// ─── STEP 1: FETCH OFFER FROM OT ─────────────────────────────────────────────

function fetchOffer() {
  console.log('=== STEP 1: Fetch offer from OT (via psql) ===');
  console.log(`Offer ID ${OFFER_ID} (search key ${OFFER_SEARCH_KEY})`);

  // Direct SQL fetch from the read-only adempiere replica.
  // Per market-offer-analysis.md, SQL is preferred for batch reads to avoid
  // REST API pagination caps.
  const sql = "SELECT ol.chuboe_offer_line_id, ol.line, ol.chuboe_mpn, ol.chuboe_mpn_clean, " +
              "ol.qty, ol.priceentered, ol.description, ol.chuboe_cpc " +
              "FROM adempiere.chuboe_offer_line ol " +
              `WHERE ol.chuboe_offer_id = ${OFFER_ID} AND ol.isactive = 'Y' ` +
              "ORDER BY ol.line";

  const raw = execSync(`psql -t -A -F '|' -c "${sql}"`, { encoding: 'utf-8' });
  const lines = raw.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('rbash') && !l.includes('/dev/null') && !l.includes('/tmp/claude'))
    .map(line => {
      const [lineId, lineNum, mpn, mpnClean, qty, price, description, cpc] = line.split('|');
      return {
        lineId: parseInt(lineId, 10),
        lineNum: parseInt(lineNum, 10),
        mpn: mpn || '',
        mpnClean: mpnClean || '',
        qty: qty ? parseInt(qty, 10) : null,
        price: price ? parseFloat(price) : null,
        description: description || '',
        cpc: cpc || '',
      };
    })
    .filter(l => !isNaN(l.lineId));

  console.log(`Fetched ${lines.length} active lines`);
  if (lines.length !== 538) {
    console.warn(`⚠ Expected 538 lines, got ${lines.length} — round-trip mismatch`);
  }
  return lines;
}

// ─── STEP 3: ENRICHMENT ──────────────────────────────────────────────────────

// Direct franchise API call. Skips extractPriceAtQty cache lookup entirely:
// the JSONB column on chuboe_pricing_api_result is virtual / read-only via
// REST (see api-integration-roadmap.md § Pricing Envelope OT-Native Storage),
// and the file cache is empty for these GE-internal MPNs. Fail-cost of the
// lookup (~2.3s/MPN) dwarfs the benefit.
//
// We DO capture the result to cache + thin-pointer DB row via writePricingResult
// (fire-and-forget) so the OT side can audit "we pulled this MPN on this date
// for market offer analysis" and downstream consumers can read the cache later.
async function enrichSupply(line) {
  try {
    const result = await searchAllDistributors(line.mpn, line.qty || 1);

    // Fire-and-forget capture — never blocks enrichment, never throws.
    writePricingResult({
      searchResult: result,
      mpn: line.mpn,
      qty: line.qty || 1,
      source: 'market-offer-analysis',
    }).catch(err => console.error(`writePricingResult failed for ${line.mpn}: ${err.message}`));

    return { summary: result.summary, source: 'api' };
  } catch (err) {
    return {
      summary: { totalStock: 0, distributorsWithStock: 0, lowestPrice: null, coverage: 'NONE', coveragePct: 0 },
      source: 'error',
      error: err.message,
    };
  }
}

// Bulk demand-side enrichment: ONE psql query for all MPNs at once.
// Replaces 538 sequential getAllMarketData calls (63s each = ~9 hours).
// Returns a Map keyed by mpn_clean → { activeRfqCount, soCount, vqCount }.
function fetchDemandBulk(mpnCleans) {
  console.error(`Bulk demand fetch for ${mpnCleans.length} unique MPNs...`);
  const t = Date.now();

  // Build a VALUES list of MPN cleans for an INNER JOIN
  // Escape single quotes
  const valuesList = mpnCleans
    .filter(m => m && m.length > 0)
    .map(m => `('${m.replace(/'/g, "''")}')`)
    .join(',');

  if (!valuesList) {
    console.error('No MPNs to query');
    return new Map();
  }

  // Single CTE-style query that gets RFQ + SO + VQ counts per MPN.
  // Joins on the cleaned MPN value because that's the canonical identifier
  // across the schema.
  const sql = `
    WITH mpns(mpn) AS (VALUES ${valuesList})
    SELECT
      m.mpn,
      COALESCE(rfq.cnt, 0) AS active_rfq_count,
      COALESCE(so.cnt, 0)  AS so_count,
      COALESCE(vq.cnt, 0)  AS vq_count
    FROM mpns m
    LEFT JOIN (
      SELECT rlm.chuboe_mpn_clean AS mpn, COUNT(DISTINCT r.chuboe_rfq_id) AS cnt
      FROM adempiere.chuboe_rfq r
      JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id
      JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id
      WHERE rlm.chuboe_mpn_clean IN (SELECT mpn FROM mpns)
        AND r.created >= CURRENT_DATE - INTERVAL '90 days'
        AND r.isactive = 'Y' AND rl.isactive = 'Y' AND rlm.isactive = 'Y'
      GROUP BY rlm.chuboe_mpn_clean
    ) rfq ON rfq.mpn = m.mpn
    LEFT JOIN (
      SELECT vl.chuboe_mpn_clean AS mpn, COUNT(*) AS cnt
      FROM adempiere.chuboe_vq_line vl
      WHERE vl.chuboe_mpn_clean IN (SELECT mpn FROM mpns)
        AND vl.created >= CURRENT_DATE - INTERVAL '12 months'
        AND vl.isactive = 'Y'
      GROUP BY vl.chuboe_mpn_clean
    ) vq ON vq.mpn = m.mpn
    LEFT JOIN (
      SELECT REGEXP_REPLACE(UPPER(p.value), '[^A-Z0-9]', '', 'g') AS mpn, COUNT(*) AS cnt
      FROM adempiere.c_orderline ol
      JOIN adempiere.c_order o ON o.c_order_id = ol.c_order_id
      JOIN adempiere.m_product p ON p.m_product_id = ol.m_product_id
      WHERE REGEXP_REPLACE(UPPER(p.value), '[^A-Z0-9]', '', 'g') IN (SELECT mpn FROM mpns)
        AND o.issotrx = 'Y' AND o.docstatus IN ('CO','CL')
        AND o.dateordered >= CURRENT_DATE - INTERVAL '12 months'
        AND o.isactive = 'Y' AND ol.isactive = 'Y'
      GROUP BY REGEXP_REPLACE(UPPER(p.value), '[^A-Z0-9]', '', 'g')
    ) so ON so.mpn = m.mpn;
  `;

  // Write SQL to a temp file to avoid shell escaping nightmares
  const fs = require('fs');
  const tmpFile = '/tmp/demand-bulk-' + Date.now() + '.sql';
  fs.writeFileSync(tmpFile, sql);

  let raw;
  try {
    raw = execSync(`psql -t -A -F '|' -f ${tmpFile}`, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
  } catch (e) {
    console.error('Bulk demand query failed:', e.message);
    return new Map();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  const map = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('rbash') || t.includes('/dev/null') || t.includes('/tmp/claude')) continue;
    const parts = t.split('|');
    if (parts.length < 4) continue;
    const [mpn, rfqCnt, soCnt, vqCnt] = parts;
    map.set(mpn, {
      activeRfqCount: parseInt(rfqCnt, 10) || 0,
      soCount: parseInt(soCnt, 10) || 0,
      vqCount: parseInt(vqCnt, 10) || 0,
    });
  }

  console.error(`Bulk demand fetch done in ${((Date.now() - t) / 1000).toFixed(1)}s — ${map.size} MPNs returned`);
  return map;
}

// ─── STEP 4: SCORING (three-state coverage model) ───────────────────────────

/**
 * Three-state franchise classification.
 * Returns one of:
 *   IN_STOCK | FRANCHISE_OUT_OF_STOCK | NO_LISTING_INTERNAL | NO_LISTING_MILSPEC | NO_LISTING_UNKNOWN
 *
 * IN_STOCK              = at least one distributor has stock > 0
 * FRANCHISE_OUT_OF_STOCK = ≥1 distributor lists the part but ALL have zero stock — REAL scarcity
 * NO_LISTING_*          = no distributor has any catalog entry; sub-classified by MPN pattern
 */
function franchiseStateOf(line, summary) {
  if (!summary) return 'NO_LISTING_UNKNOWN';
  if (summary.distributorsWithStock > 0) return 'IN_STOCK';
  if ((summary.distributorsCarrying || 0) > 0) return 'FRANCHISE_OUT_OF_STOCK';
  // Not in any catalog — sub-classify
  return classifyMpnNonFranchise(line.mpn, null, line.cpc);
}

/**
 * Supply scarcity score (0-40). Returns null when there's no usable franchise
 * data — that's different from "0 score" because it means the model can't say
 * anything, not that supply is abundant. Used as the parallel of NO_OFFER_PRICE
 * for the Price Advantage axis.
 */
function scoreSupply(state, summary, offeredQty) {
  // Lines with no franchise listing at all → no score
  if (state === 'NO_LISTING_INTERNAL' ||
      state === 'NO_LISTING_MILSPEC'  ||
      state === 'NO_LISTING_UNKNOWN') {
    return null;
  }

  let score = 0;
  // FRANCHISE_OUT_OF_STOCK is the real scarcity signal
  if (state === 'FRANCHISE_OUT_OF_STOCK') score += 12;

  if (offeredQty > 0 && summary.totalStock < offeredQty) score += 8;
  if (offeredQty > 0 && summary.totalStock < 2 * offeredQty &&
      summary.totalStock >= offeredQty)                     score += 4;
  if (summary.distributorsWithStock >= 3 && offeredQty > 0 &&
      summary.totalStock > 10 * offeredQty)                 score -= 10;

  return Math.max(0, Math.min(40, score));
}

function scoreDemand(demand) {
  let score = 0;
  if (demand.activeRfqCount > 0) score += 10;
  if (demand.activeRfqCount >= 3) score += 5;
  if (demand.brokerSaleCount > 0 || demand.customerSaleCount > 0) score += 7;
  return Math.max(0, Math.min(25, score));
}

function tierForScore(rawScore, maxScore) {
  if (rawScore == null) return 'UNSCORED';
  const normalized = (rawScore / maxScore) * 100;
  if (normalized >= 70) return 'HOT';
  if (normalized >= 40) return 'WARM';
  if (normalized >= 20) return 'COOL';
  return 'SKIP';
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== GE Aerospace Rev-Share Batch 1 Analysis ===');
  console.log(`Target offer: search key ${OFFER_SEARCH_KEY} (chuboe_offer_id ${OFFER_ID})`);
  console.log('');

  // Step 1: Fetch
  const lines = await fetchOffer();
  if (lines.length === 0) {
    console.error('FATAL: no lines fetched from OT');
    process.exit(1);
  }

  // Step 2: Intent (hardcoded for this run — see workflow doc for inference rules)
  const intent = 'consignment';
  console.log(`\n=== STEP 2: Intent → ${intent} ===`);
  console.log('  (hardcoded; rules-based classifier not yet built — will hit it in Batch 2)');
  console.log('');

  // Step 3a: Bulk demand fetch (one query for all MPNs)
  console.log(`=== STEP 3a: Bulk demand fetch (1 SQL query, ${lines.length} MPNs) ===`);
  const uniqueMpnCleans = Array.from(new Set(lines.map(l => l.mpnClean).filter(Boolean)));
  const demandMap = fetchDemandBulk(uniqueMpnCleans);
  console.log(`  ${demandMap.size} unique MPN cleans returned with demand data`);
  console.log('');

  // Step 3b: Per-line franchise enrichment (parallel batches of 10)
  console.log(`=== STEP 3b: Franchise API enrichment (parallel batches of 10) ===`);
  const BATCH_SIZE = 10;
  const startMs = Date.now();
  const enriched = new Array(lines.length);
  let supplyErrors = 0;
  let processed = 0;

  for (let bs = 0; bs < lines.length; bs += BATCH_SIZE) {
    const batch = lines.slice(bs, bs + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (line, j) => {
      const franchise = await enrichSupply(line);
      if (franchise.source === 'error') supplyErrors++;

      const state = franchiseStateOf(line, franchise.summary);

      // Demand from bulk map
      const demandRaw = demandMap.get(line.mpnClean) || { activeRfqCount: 0, soCount: 0, vqCount: 0 };
      const demand = {
        vqCount: demandRaw.vqCount,
        brokerSaleCount: 0, // not split in bulk query — would need broker tagging join
        customerSaleCount: demandRaw.soCount, // all SOs treated as customer for now
        activeRfqCount: demandRaw.activeRfqCount,
        historicalRfqCount: 0,
        demandStrength: 'BULK',
        historicalBuyers: [],
      };

      const supplyScore = scoreSupply(state, franchise.summary, line.qty || 0);
      const priceScore = 0; // N/A — Batch 1 has no offer prices
      const demandScore = scoreDemand(demand);
      const rawScore = supplyScore == null ? null : supplyScore + priceScore + demandScore;
      const maxScore = 65;
      const tier = tierForScore(rawScore, maxScore);

      return {
        ...line,
        franchise: franchise.summary,
        franchiseSource: franchise.source,
        state,
        demand,
        supplyScore,
        priceScore,
        demandScore,
        rawScore,
        tier,
        flags: [
          'NO_OFFER_PRICE',
          state, // include the state itself as a flag
          ...(demand.activeRfqCount > 0 ? ['ACTIVE_RFQ'] : []),
          ...(demand.customerSaleCount > 0 ? ['HAS_SO_HISTORY'] : []),
        ],
      };
    }));

    for (let j = 0; j < batchResults.length; j++) {
      enriched[bs + j] = batchResults[j];
    }
    processed += batchResults.length;

    // Progress to stderr (line-buffered, flushes immediately)
    if (processed % 25 === 0 || processed === lines.length) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
      const rate = (processed / (elapsed || 1)).toFixed(1);
      const eta = ((lines.length - processed) / Math.max(rate, 0.1)).toFixed(0);
      process.stderr.write(`  [${processed}/${lines.length}] elapsed=${elapsed}s rate=${rate}/s supplyErr=${supplyErrors} eta=${eta}s\n`);
    }
  }

  console.log('');
  console.log('=== STEP 4: Aggregation (three-state) ===');

  // State + tier counts
  const stats = {
    IN_STOCK: 0, FRANCHISE_OUT_OF_STOCK: 0,
    NO_LISTING_INTERNAL: 0, NO_LISTING_MILSPEC: 0, NO_LISTING_UNKNOWN: 0,
    tier: { HOT: 0, WARM: 0, COOL: 0, SKIP: 0, UNSCORED: 0 },
    activeRfq: 0, priorSo: 0, zeroDemand: 0,
  };
  for (const e of enriched) {
    stats[e.state] = (stats[e.state] || 0) + 1;
    stats.tier[e.tier] = (stats.tier[e.tier] || 0) + 1;
    if (e.demand.activeRfqCount > 0) stats.activeRfq++;
    if (e.demand.brokerSaleCount + e.demand.customerSaleCount > 0) stats.priorSo++;
    if (e.demand.activeRfqCount === 0 && e.demand.brokerSaleCount + e.demand.customerSaleCount === 0) stats.zeroDemand++;
  }

  console.log('Franchise state breakdown:');
  for (const k of ['IN_STOCK', 'FRANCHISE_OUT_OF_STOCK', 'NO_LISTING_INTERNAL', 'NO_LISTING_MILSPEC', 'NO_LISTING_UNKNOWN']) {
    const pct = ((stats[k] / enriched.length) * 100).toFixed(1);
    console.log(`  ${k.padEnd(24)} ${String(stats[k]).padStart(4)}  (${pct}%)`);
  }
  console.log('Tier breakdown:');
  for (const k of ['HOT', 'WARM', 'COOL', 'SKIP', 'UNSCORED']) {
    const pct = ((stats.tier[k] / enriched.length) * 100).toFixed(1);
    console.log(`  ${k.padEnd(10)} ${String(stats.tier[k]).padStart(4)}  (${pct}%)`);
  }

  // Step 5: Build outputs in memory + send email — NO disk writes
  console.log('\n=== STEP 5: Build buffers + email ===');
  const xlsxBuffer = buildXlsxBuffer(enriched, stats);
  console.log(`  xlsx buffer: ${(xlsxBuffer.length / 1024).toFixed(0)} KB`);
  const csvBuffer = buildSidecarCsvBuffer();
  console.log(`  sidecar csv buffer: ${(csvBuffer.length / 1024).toFixed(1)} KB`);
  console.log('  Sending email...');
  const info = await sendEmail(buildHtml(enriched, stats), xlsxBuffer, csvBuffer);
  console.log(`  ✓ Sent — messageId: ${info.messageId}`);
  console.log(`  response: ${info.response}`);
  console.log(`\nTotal elapsed: ${((Date.now() - startMs) / 1000).toFixed(0)}s`);
  return; // skip the legacy disk-writing block below
}

// ─── OUTPUT BUILDERS (in-memory buffers, no disk writes) ─────────────────────

function buildLotSummaryRows(enriched, stats) {
  const total = enriched.length;
  const pct = n => total > 0 ? +(n / total).toFixed(4) : 0;
  return [
    ['GE Aerospace Rev-Share Batch 1 — Lot Analysis (CORRECTED v2)'],
    [],
    ['Partner', PARTNER_NAME],
    ['Offer search key', OFFER_SEARCH_KEY],
    ['chuboe_offer_id', OFFER_ID],
    ['Source file', path.basename(SOURCE_FILE)],
    ['Analysis date', '2026-04-08 (v2 corrected)'],
    ['Intent', 'Consignment (rev share)'],
    [],
    ['Volume'],
    ['Source rows total',          622],
    ['Source rows loaded into OT', total],
    ['Source rows skipped (#N/A / #REF! errors in source file)', 622 - total],
    [],
    ['Franchise coverage state', 'Count', '% of loaded'],
    ['IN_STOCK',                                                            stats.IN_STOCK,                pct(stats.IN_STOCK)],
    ['FRANCHISE_OUT_OF_STOCK (real scarcity)',                              stats.FRANCHISE_OUT_OF_STOCK,  pct(stats.FRANCHISE_OUT_OF_STOCK)],
    ['NO_LISTING_INTERNAL (push back to GE for industry MPNs)',             stats.NO_LISTING_INTERNAL,    pct(stats.NO_LISTING_INTERNAL)],
    ['NO_LISTING_MILSPEC (mil-spec one-offs)',                              stats.NO_LISTING_MILSPEC,     pct(stats.NO_LISTING_MILSPEC)],
    ['NO_LISTING_UNKNOWN (no franchise hit, no clear pattern)',             stats.NO_LISTING_UNKNOWN,     pct(stats.NO_LISTING_UNKNOWN)],
    [],
    ['Tier breakdown', 'Count', '% of loaded'],
    ['HOT (top opportunity)',          stats.tier.HOT,      pct(stats.tier.HOT)],
    ['WARM (worth pursuing)',          stats.tier.WARM,     pct(stats.tier.WARM)],
    ['COOL (marginal)',                stats.tier.COOL,     pct(stats.tier.COOL)],
    ['SKIP (commodity / no signal)',   stats.tier.SKIP,     pct(stats.tier.SKIP)],
    ['UNSCORED (NO_LISTING_* lines)',  stats.tier.UNSCORED, pct(stats.tier.UNSCORED)],
    [],
    ['Demand signals', 'Count', '% of loaded'],
    ['Active RFQ in last 90d', stats.activeRfq,  pct(stats.activeRfq)],
    ['Prior SO history',       stats.priorSo,    pct(stats.priorSo)],
    ['Zero demand signal',     stats.zeroDemand, pct(stats.zeroDemand)],
    [],
    ['Notes'],
    ['Batch 1 has no offered prices — Price Advantage scoring is N/A on every line.'],
    ['Max raw score = 65 (Supply 40 + Demand 25). NO_LISTING_* lines are unscored.'],
    ['83 source-file rows had #N/A or #REF! in the AML column — see sidecar CSV.'],
    ['v2 correction: previous run treated NO_LISTING as scarcity. Now distinguished.'],
  ];
}

function buildXlsxBuffer(enriched, stats) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Lot Summary
  const wsSummary = XLSX.utils.aoa_to_sheet(buildLotSummaryRows(enriched, stats));
  wsSummary['!cols'] = [{ wch: 50 }, { wch: 14 }, { wch: 14 }];
  // Apply % format to count rows where col C is a percentage
  for (const r of [15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30, 31]) {
    const addr = `C${r + 1}`;
    if (wsSummary[addr] && typeof wsSummary[addr].v === 'number') wsSummary[addr].z = '0.0%';
  }
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Lot Summary');

  // Sheet 2: Top 25 opportunities (sorted by score, exclude UNSCORED)
  const scored = enriched.filter(e => e.rawScore != null);
  const top = [...scored].sort((a, b) => b.rawScore - a.rawScore).slice(0, 25);
  const topHeaders = ['Rank', 'MPN', 'Description', 'Qty', 'State', 'Score', 'Tier',
                      'Franchise Stock', 'Distributors Carrying', 'Distributors w/ Stock',
                      'Active RFQ', 'Prior SO', 'Flags'];
  const topRows = top.map((e, i) => [
    i + 1, e.mpn, e.description, e.qty || 0, e.state, e.rawScore, e.tier,
    e.franchise.totalStock, e.franchise.distributorsCarrying || 0, e.franchise.distributorsWithStock,
    e.demand.activeRfqCount, e.demand.brokerSaleCount + e.demand.customerSaleCount,
    e.flags.join('; '),
  ]);
  const wsTop = XLSX.utils.aoa_to_sheet([topHeaders, ...topRows]);
  wsTop['!cols'] = [
    { wch: 6 }, { wch: 28 }, { wch: 38 }, { wch: 9 }, { wch: 22 }, { wch: 8 }, { wch: 10 },
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 11 }, { wch: 11 }, { wch: 36 },
  ];
  XLSX.utils.book_append_sheet(wb, wsTop, 'Top 25 Opportunities');

  // Sheet 3: Internal-only — for the GE pushback list
  const internals = enriched.filter(e => e.state === 'NO_LISTING_INTERNAL');
  const intHeaders = ['MPN', 'Description', 'Qty', 'Why flagged internal'];
  const intRows = internals.map(e => [
    e.mpn, e.description, e.qty || 0,
    /\(SCRN\)/.test(e.mpn) || /\(PROG\)/.test(e.mpn) ? 'Process annotation in MPN'
      : /\bREV\s+[A-Z]/i.test(e.mpn) ? 'Revision marker (REV X)'
      : (e.cpc && e.cpc !== e.mpn) ? 'CPC differs from MPN'
      : 'Internal pattern',
  ]);
  const wsInt = XLSX.utils.aoa_to_sheet([intHeaders, ...intRows]);
  wsInt['!cols'] = [{ wch: 32 }, { wch: 42 }, { wch: 9 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(wb, wsInt, 'GE Internal — Push Back');

  // Sheet 4: Per-line detail (all loaded lines, sorted; UNSCORED at bottom)
  const sortedAll = [...enriched].sort((a, b) => {
    if (a.rawScore == null && b.rawScore == null) return 0;
    if (a.rawScore == null) return 1;
    if (b.rawScore == null) return -1;
    return b.rawScore - a.rawScore;
  });
  const detHeaders = ['MPN', 'Description', 'Qty', 'State', 'Score', 'Tier',
                      'Supply', 'Demand',
                      'Franchise Stock', 'Carrying', 'In Stock', 'Lowest Franchise',
                      'Active RFQ', 'Broker SO', 'Cust SO', 'Flags'];
  const detRows = sortedAll.map(e => [
    e.mpn, e.description, e.qty || 0, e.state,
    e.rawScore == null ? '' : e.rawScore, e.tier,
    e.supplyScore == null ? '' : e.supplyScore, e.demandScore,
    e.franchise.totalStock, e.franchise.distributorsCarrying || 0, e.franchise.distributorsWithStock,
    e.franchise.lowestPrice == null ? '' : e.franchise.lowestPrice,
    e.demand.activeRfqCount, e.demand.brokerSaleCount, e.demand.customerSaleCount,
    e.flags.join('; '),
  ]);
  const wsDet = XLSX.utils.aoa_to_sheet([detHeaders, ...detRows]);
  wsDet['!cols'] = [
    { wch: 28 }, { wch: 38 }, { wch: 8 }, { wch: 22 }, { wch: 7 }, { wch: 9 },
    { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 16 },
    { wch: 11 }, { wch: 10 }, { wch: 9 }, { wch: 36 },
  ];
  // $ format on lowest franchise price column (L)
  for (let r = 1; r <= detRows.length; r++) {
    const addr = `L${r + 1}`;
    if (wsDet[addr] && typeof wsDet[addr].v === 'number') wsDet[addr].z = '$#,##0.0000';
  }
  XLSX.utils.book_append_sheet(wb, wsDet, 'Per-Line Detail');

  // Build the buffer in memory — no disk write
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildSidecarCsvBuffer() {
  // Read source file just for the error rows — this is reading our own
  // local working copy of the source file, not writing analysis output.
  const wb = XLSX.readFile(SOURCE_FILE);
  const sheet = wb.Sheets[SOURCE_SHEET];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rows = ['Excel Row,AML Error,Description,Qty'];
  for (let r = 2; r <= range.e.r; r++) {
    const aCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    const bCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
    const cCell = sheet[XLSX.utils.encode_cell({ r, c: 2 })];
    if (aCell && aCell.t === 'e') {
      const desc = String(bCell?.v || '').replace(/"/g, '""');
      const qty = cCell?.v ?? '';
      rows.push(`${r + 1},${aCell.w || '#?'},"${desc}",${qty}`);
    }
  }
  return Buffer.from(rows.join('\n') + '\n', 'utf-8');
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

function buildHtml(enriched, stats) {
  const total = enriched.length;
  const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0.0%';
  const cell = (v, align = 'left') => `<td align="${align}" style="padding:4px 10px;border:1px solid #ccc">${v}</td>`;

  return `<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#222;max-width:820px">
<h2 style="margin-bottom:4px">GE Aerospace Rev-Share Batch 1 — Analysis (CORRECTED v2)</h2>
<p style="color:#666;margin-top:0">
<b>Why a corrected version:</b> The first email I sent today bucketed all "no franchise stock" lines as <i>scarcity opportunities</i>. That was wrong — most of them weren't out-of-stock; they had no franchise listing at all because they're customer-internal codes or mil-spec one-offs. Below is the corrected three-state breakdown.<br><br>
Source email: 4/8/2026 — Pat Bade @ GE Aerospace, "Items for rev share"<br>
OT offer search key: <b>1025923</b> (chuboe_offer_id 1026030)<br>
Source file: <code>Astute rev share parts.xlsx</code> ("Legacy Obsolete" sheet)
</p>

<h3>Headline pushback (corrected)</h3>
<p>Of GE's 622-row submission:</p>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">Bucket</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Lines</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">% of 622</th>
  </tr>
  <tr>${cell('Loaded into OT (had AML value)')}${cell(total, 'right')}${cell(((total/622)*100).toFixed(1) + '%', 'right')}</tr>
  <tr>${cell('Source <code>#N/A</code> / <code>#REF!</code> errors (broken VLOOKUPs in your file)')}${cell(83, 'right')}${cell('13.3%', 'right')}</tr>
  <tr>${cell('Footer / blank')}${cell(1, 'right')}${cell('0.2%', 'right')}</tr>
</table>

<h3>Of the ${total} loaded — franchise distribution state</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0">
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">State</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">Count</th>
    <th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th>
    <th align="left" style="padding:4px 10px;border:1px solid #ccc">What it means</th>
  </tr>
  <tr style="background:#e8f5e8">${cell('<b>IN_STOCK</b>')}${cell(stats.IN_STOCK, 'right')}${cell(pct(stats.IN_STOCK), 'right')}${cell('Franchise has inventory — standard')}</tr>
  <tr style="background:#fff4e0">${cell('<b>FRANCHISE_OUT_OF_STOCK</b>')}${cell(stats.FRANCHISE_OUT_OF_STOCK, 'right')}${cell(pct(stats.FRANCHISE_OUT_OF_STOCK), 'right')}${cell('Lists it but zero inventory — <b>real scarcity opportunity</b>')}</tr>
  <tr style="background:#fde0e0">${cell('<b>NO_LISTING_INTERNAL</b>')}${cell(stats.NO_LISTING_INTERNAL, 'right')}${cell(pct(stats.NO_LISTING_INTERNAL), 'right')}${cell('GE-internal AML codes — <b>push back to GE</b>')}</tr>
  <tr style="background:#f0f0f0">${cell('<b>NO_LISTING_MILSPEC</b>')}${cell(stats.NO_LISTING_MILSPEC, 'right')}${cell(pct(stats.NO_LISTING_MILSPEC), 'right')}${cell('Mil-spec one-offs — manual broker channel')}</tr>
  <tr style="background:#f8f8f8">${cell('<b>NO_LISTING_UNKNOWN</b>')}${cell(stats.NO_LISTING_UNKNOWN, 'right')}${cell(pct(stats.NO_LISTING_UNKNOWN), 'right')}${cell('No franchise hit, no clear pattern — research case-by-case')}</tr>
</table>

<h3>What to send back to Pat Bade (sub-bucket by sub-bucket)</h3>
<ul>
  <li><b>${stats.NO_LISTING_INTERNAL} lines are GE-internal AML codes</b> (REV markers, SCRN/PROG annotations). The customer needs to provide industry MPNs or cross-references — Astute can't sell parts by GE's internal codes. <b>The "GE Internal — Push Back" sheet in the attachment is the list to send back to Pat.</b></li>
  <li><b>${stats.NO_LISTING_MILSPEC} lines are mil-spec one-offs</b> (5962-XXXXX, JANTX-, M-prefix patterns). Legitimate industry parts but not in standard franchise channels. We'd source these manually if the volume justifies it.</li>
  <li><b>${stats.NO_LISTING_UNKNOWN} lines have no clear pattern</b> — neither obviously internal nor mil-spec. These need case-by-case research. May include obsolete parts that franchise no longer carries.</li>
  <li><b>${stats.FRANCHISE_OUT_OF_STOCK} lines are real scarcity opportunities</b> — franchise lists them but has zero stock. These are the parts where Astute can add value as a broker.</li>
  <li><b>${stats.IN_STOCK} lines have franchise inventory</b> — standard market, less broker premium opportunity but still worth scoring.</li>
  <li><b>${stats.tier.HOT} HOT</b> + <b>${stats.tier.WARM} WARM</b> = <b>${stats.tier.HOT + stats.tier.WARM} actively-pursuable lines</b> across the whole lot.</li>
  <li><b>83 lines are broken in the source file</b> (<code>#N/A</code> / <code>#REF!</code> in the AML column from failed VLOOKUPs). See the sidecar CSV — these need GE-side resolution.</li>
</ul>

<h3>Demand signals</h3>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px">
  <tr style="background:#f0f0f0"><th align="left" style="padding:4px 10px;border:1px solid #ccc">Signal</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">Count</th><th align="right" style="padding:4px 10px;border:1px solid #ccc">%</th></tr>
  <tr>${cell('Active open RFQ (90d)')}${cell(stats.activeRfq, 'right')}${cell(pct(stats.activeRfq), 'right')}</tr>
  <tr>${cell('Prior SO history (12mo)')}${cell(stats.priorSo, 'right')}${cell(pct(stats.priorSo), 'right')}</tr>
  <tr>${cell('Zero demand signal')}${cell(stats.zeroDemand, 'right')}${cell(pct(stats.zeroDemand), 'right')}</tr>
</table>

<h3>Attachments</h3>
<ul>
  <li><b>GE_Aerospace_RevShare_Batch1_v2.xlsx</b> — 4 sheets: Lot Summary, Top 25 Opportunities, GE Internal — Push Back, Per-Line Detail (all ${total} sorted by score)</li>
  <li><b>GE_Aerospace_RevShare_Batch1_source_quality_issues.csv</b> — the 83 broken AML rows with descriptions and qtys</li>
</ul>

<p style="color:#666;font-size:11px;margin-top:20px">v2 corrections: (1) three-state franchise classification using the new <code>distributorsCarrying</code> field on franchise-api summary; (2) NO_LISTING sub-classification via <code>shared/mpn-classifier.js</code>; (3) <code>writePricingResult()</code> called on every API result so the cache populates this time; (4) outputs built as in-memory buffers, no disk writes per <code>feedback_outputs_emailed_not_persisted</code>; (5) <code>supplyScore = null</code> on NO_LISTING_* lines instead of conflating "no data" with "scarcity opportunity".</p>
</body></html>`;
}

async function sendEmail(htmlBody, xlsxBuffer, csvBuffer) {
  if (!process.env.WORKMAIL_PASS) throw new Error('WORKMAIL_PASS not set');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user: FROM_EMAIL, pass: process.env.WORKMAIL_PASS },
  });
  return transporter.sendMail({
    from: `"Market Offer Analysis" <${FROM_EMAIL}>`,
    to: TO_EMAIL,
    subject: 'GE Aerospace Rev-Share Batch 1 (CORRECTED v2) — three-state franchise breakdown',
    html: htmlBody,
    attachments: [
      { filename: 'GE_Aerospace_RevShare_Batch1_v2.xlsx', content: xlsxBuffer },
      { filename: 'GE_Aerospace_RevShare_Batch1_source_quality_issues.csv', content: csvBuffer },
    ],
  });
}

main().catch(err => {
  console.error('UNHANDLED:', err.stack || err.message || err);
  process.exit(1);
});
