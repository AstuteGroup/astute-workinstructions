#!/usr/bin/env node
/**
 * RFQ API Enrichment — library + CLI
 *
 * Routes an RFQ through the franchise distributor APIs using the TTL-by-
 * RFQ-type cache gate from shared/franchise-api.js. For each qty-matched
 * franchise quote, writes VQ lines via shared/vq-writer.js. For each live
 * API call (cache miss), writes a thin-pointer row to
 * adempiere.chuboe_pricing_api_result via shared/api-result-writer.js.
 *
 * See Trading Analysis/RFQ API Enrichment/rfq-api-enrichment.md for the
 * full workflow spec and TTL table.
 *
 * CLI:
 *   node enrich-rfq.js --rfq 1132021
 *   node enrich-rfq.js --rfq 1132021 --dry-run
 *   node enrich-rfq.js --rfq 1132021 --force            # ignore cache
 *   node enrich-rfq.js --rfq 1132021 --max-lines 10     # cap for smoke-testing
 *
 * Library:
 *   const { enrichRFQ } = require('./enrich-rfq');
 *   const result = await enrichRFQ('1132021', { dryRun: false });
 *   // result: { rfq, summary, vqsWritten, apiCalls, cacheHits, errors }
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const { searchAllDistributors } = require('../../shared/franchise-api');
const { writePricingResult } = require('../../shared/api-result-writer');
const { writeVQFromAPI } = require('../../shared/vq-writer');

// ─── TTL TABLE ───────────────────────────────────────────────────────────────
// Source of truth: api-integration-roadmap.md § API Response Caching.
// Mirror here so lookups are explicit and self-documenting.
const TTL_BY_RFQ_TYPE = {
  'PPV': 30,
  'Astute Franchised': 30,
  'Shortage': 7,
  'Stock': 7,
  'EOL/LTB': 7,
  '3PL/VMI': 7,
  'Hot Parts': 7,
  'Proactive Offer': 7,
};
const DEFAULT_TTL = 7;

function ttlForRfqType(rfqType) {
  return TTL_BY_RFQ_TYPE[rfqType] ?? DEFAULT_TTL;
}

// ─── DB POOL ─────────────────────────────────────────────────────────────────
// Explicit user per feedback_cron_pg_user.md — $USER isn't inherited under cron
// so peer-auth via unix socket breaks unless we set it explicitly.
const pool = new Pool({
  host: '/var/run/postgresql',
  database: process.env.PGDATABASE || 'idempiere_replica',
  user: process.env.PGUSER || process.env.USER || 'analytics_user',
});

// ─── SQL: pull lines for an RFQ ─────────────────────────────────────────────
async function fetchRFQLines(rfqDocNumber) {
  const { rows } = await pool.query(`
    SELECT r.chuboe_rfq_id,
           r.value            AS rfq_value,
           bp.name            AS customer,
           rt.name            AS rfq_type,
           rlm.chuboe_rfq_line_id,
           rlm.chuboe_rfq_line_mpn_id,
           rlm.chuboe_mpn_clean  AS mpn,
           rlm.chuboe_mfr_text   AS mfr,
           rlm.chuboe_cpc_clean  AS cpc,
           rl.qty,
           rl.priceentered    AS target_price
    FROM adempiere.chuboe_rfq r
    JOIN adempiere.chuboe_rfq_line     rl  ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
    JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
    JOIN adempiere.chuboe_rfq_type     rt  ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
    LEFT JOIN adempiere.c_bpartner     bp  ON r.c_bpartner_id = bp.c_bpartner_id
    WHERE r.value = $1
      AND r.isactive='Y'
      AND rlm.chuboe_mpn_clean IS NOT NULL
      AND rlm.chuboe_mpn_clean <> ''
    ORDER BY rlm.chuboe_rfq_line_mpn_id
  `, [rfqDocNumber]);
  return rows;
}

// ─── CORE: enrichRFQ ────────────────────────────────────────────────────────
/**
 * Enrich a single RFQ by routing every line-MPN through the franchise APIs.
 *
 * @param {string} rfqDocNumber - RFQ document number (search_key), e.g. '1132021'
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - If true, skip all writes (VQ + api_result)
 * @param {boolean} [opts.force=false]  - If true, bypass cache (force API calls)
 * @param {number}  [opts.maxLines]     - Cap number of lines processed (smoke testing)
 * @param {function} [opts.onProgress]  - Callback (line, idx, total) for progress
 * @returns {Promise<object>} summary
 */
async function enrichRFQ(rfqDocNumber, opts = {}) {
  const { dryRun = false, force = false, maxLines = null, onProgress = null } = opts;
  const startedAt = new Date();

  const rows = await fetchRFQLines(rfqDocNumber);
  if (rows.length === 0) {
    return {
      rfq: rfqDocNumber,
      error: 'RFQ not found or has no active line-MPNs',
      startedAt,
      finishedAt: new Date(),
    };
  }

  const rfqType = rows[0].rfq_type;
  const customer = rows[0].customer;
  const rfqId = Number(rows[0].chuboe_rfq_id);
  const ttlDays = force ? 0 : ttlForRfqType(rfqType);

  const lines = maxLines ? rows.slice(0, maxLines) : rows;

  const counters = {
    lines: lines.length,
    apiCalls: 0,
    cacheHits: 0,
    vqsWritten: 0,
    vqsFlagged: 0,
    flagReasonCounts: {},  // { NO_RFQ_LINE: 12, MPN_CROSS_REF: 40, ... }
    flagSamples: [],        // first 5 flag {reason, detail, mpn}
    apiResultRowsWritten: 0,
    qtyMatches: 0,
    partialCoverage: 0,
    noCoverage: 0,
    errors: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { mpn, cpc, qty, target_price: targetPrice } = line;

    if (onProgress) onProgress(line, i, lines.length);

    // Build bypass predicate for PPV + under-target rule
    let cacheBypassIf = null;
    if (rfqType === 'PPV' && targetPrice != null && Number(targetPrice) > 0) {
      const target = Number(targetPrice);
      cacheBypassIf = (env) => {
        const cachedLowest = env?.data?.Pricings
          ?.flatMap(p => (p.Pricings || []).map(b => b.UnitPrice))
          .filter(p => p != null && p > 0);
        if (!cachedLowest || cachedLowest.length === 0) return false;
        return Math.min(...cachedLowest) < target;
      };
    }

    let result;
    try {
      result = await searchAllDistributors(mpn, Number(qty) || 1, {
        cacheTTL: ttlDays,
        cacheBypassIf,
      });
    } catch (err) {
      counters.errors.push({ mpn, cpc, stage: 'search', message: err.message });
      continue;
    }

    const fromCache = result?.summary?.fromCache === true;
    if (fromCache) counters.cacheHits++;
    else counters.apiCalls++;

    // Coverage bookkeeping
    if (result.summary.coverage === 'FULL') counters.qtyMatches++;
    else if (result.summary.coverage === 'PARTIAL') counters.partialCoverage++;
    else counters.noCoverage++;

    // Write VQs for this MPN (all distributors with price; vq-writer.js decides
    // per-distributor what to write). This mirrors the Stock RFQ Loading pattern
    // — we want the full franchise price surface captured as VQ history, not
    // only qty-full coverage.
    //
    // _rfqLineIdOverride: we already know chuboe_rfq_line_id from the SQL pull
    // above, so bypass vq-writer's resolveRFQLine() lookup (which keys on
    // searchedMpn + cpc and can fail on PPV RFQs where those don't round-trip
    // cleanly). Strictly better than the lookup path — we're handing vq-writer
    // the exact line ID we loaded the MPN from.
    if (!dryRun && (result.found?.length || 0) > 0) {
      try {
        const { written = [], flagged = [] } = await writeVQFromAPI(
          rfqDocNumber,
          cpc || '',
          result,
          {
            searchedMpn: mpn,
            _rfqLineIdOverride: Number(line.chuboe_rfq_line_id),
          }
        );
        counters.vqsWritten += written.length;
        counters.vqsFlagged += flagged.length;
        for (const f of flagged) {
          const reason = f.reason || 'UNKNOWN';
          counters.flagReasonCounts[reason] = (counters.flagReasonCounts[reason] || 0) + 1;
          if (counters.flagSamples.length < 5) {
            counters.flagSamples.push({ mpn: f.mpn || mpn, reason, detail: f.detail, vendor: f.vendor });
          }
        }
      } catch (err) {
        counters.errors.push({ mpn, cpc, stage: 'vq-write', message: err.message });
      }
    }

    // Write thin-pointer row to api_result (audit trail) — only on live calls,
    // not on cache hits (the cache hit already has a prior audit row).
    if (!dryRun && !fromCache) {
      try {
        const writeResult = await writePricingResult({
          searchResult: result,
          mpn,
          qty: Number(qty) || 1,
          rfqId,
          source: 'rfq-api-enrichment',
        });
        // Count only when the DB row actually landed — cacheFile-only writes
        // still count as success in writePricingResult but we want the DB
        // counter to track the audit-trail row specifically.
        if (writeResult?.dbId) counters.apiResultRowsWritten++;
      } catch (err) {
        counters.errors.push({ mpn, cpc, stage: 'api-result-write', message: err.message });
      }
    }
  }

  return {
    rfq: rfqDocNumber,
    customer,
    rfqType,
    ttlDaysApplied: ttlDays,
    startedAt,
    finishedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    ...counters,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const getArg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const hasFlag = (flag) => argv.includes(flag);

  const rfq = getArg('--rfq');
  if (!rfq) {
    console.error('Usage: node enrich-rfq.js --rfq <documentNumber> [--dry-run] [--force] [--max-lines N]');
    process.exit(1);
  }

  const opts = {
    dryRun: hasFlag('--dry-run'),
    force: hasFlag('--force'),
    maxLines: getArg('--max-lines') ? parseInt(getArg('--max-lines'), 10) : null,
    onProgress: (line, idx, total) => {
      if ((idx + 1) % 25 === 0 || idx === total - 1) {
        process.stderr.write(`  [${idx + 1}/${total}] ${line.mpn}\n`);
      }
    },
  };

  console.log(`\nEnriching RFQ ${rfq}${opts.dryRun ? ' (DRY RUN)' : ''}${opts.force ? ' (FORCE — cache bypassed)' : ''}${opts.maxLines ? ` (max ${opts.maxLines} lines)` : ''}\n`);

  try {
    const summary = await enrichRFQ(rfq, opts);
    console.log('\n─── Summary ─────────────────────────────────');
    console.log(`RFQ:          ${summary.rfq} (${summary.customer || '?'})`);
    console.log(`Type:         ${summary.rfqType || '?'}`);
    console.log(`TTL applied:  ${summary.ttlDaysApplied} days`);
    console.log(`Lines:        ${summary.lines}`);
    console.log(`API calls:    ${summary.apiCalls}`);
    console.log(`Cache hits:   ${summary.cacheHits}`);
    console.log(`VQs written:  ${summary.vqsWritten}`);
    console.log(`VQs flagged:  ${summary.vqsFlagged}`);
    console.log(`api_result rows: ${summary.apiResultRowsWritten}`);
    console.log(`Coverage:     FULL=${summary.qtyMatches}  PARTIAL=${summary.partialCoverage}  NONE=${summary.noCoverage}`);
    console.log(`Errors:       ${summary.errors.length}`);
    if (Object.keys(summary.flagReasonCounts || {}).length > 0) {
      console.log('Flag reasons:');
      for (const [reason, count] of Object.entries(summary.flagReasonCounts)) {
        console.log(`  ${reason}: ${count}`);
      }
      if (summary.flagSamples?.length) {
        console.log('Flag samples:');
        summary.flagSamples.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.reason} [${s.vendor || '?'}] ${s.mpn}: ${s.detail || '(no detail)'}`);
        });
      }
    }
    if (summary.errors.length > 0) {
      console.log('\nFirst 5 errors:');
      summary.errors.slice(0, 5).forEach(e => console.log(`  ${e.stage}: ${e.mpn} — ${e.message}`));
    }
    console.log(`Duration:     ${(summary.durationMs / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

module.exports = {
  enrichRFQ,
  ttlForRfqType,
  TTL_BY_RFQ_TYPE,
};
