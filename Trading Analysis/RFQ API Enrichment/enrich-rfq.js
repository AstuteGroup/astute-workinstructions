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
const { computeMfrMatch } = require('../../shared/mfr-equivalence');
const { isRestrictedMfr } = require('../../shared/restricted-mfrs');

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
           rlm.chuboe_mfr_id     AS mfr_id,
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
  // Scope guard — Layer 1. enrichRFQ() is explicitly single-RFQ. An empty or
  // non-string rfqDocNumber is a bug in the caller: it means scope wasn't
  // resolved before invocation (or an array was passed by mistake). Refuse
  // to run so we don't silently enrich nothing or, worse, fan out to multiple
  // RFQs via a malformed caller. See 2026-04-15 JCI incident where scope
  // creep spilled enrichment across three RFQs.
  if (typeof rfqDocNumber !== 'string' || rfqDocNumber.trim() === '') {
    throw new Error(
      `enrichRFQ: rfqDocNumber must be a non-empty string (the RFQ search key, ` +
      `e.g. "1132593"). Got: ${JSON.stringify(rfqDocNumber)}. Callers must ` +
      `resolve scope to a single RFQ before invoking.`
    );
  }

  const { dryRun = false, force = false, maxLines = null, onProgress = null, ignorePause = false } = opts;
  const startedAt = new Date();

  const rawRows = await fetchRFQLines(rfqDocNumber);
  if (rawRows.length === 0) {
    return {
      rfq: rfqDocNumber,
      error: 'RFQ not found or has no active line-MPNs',
      startedAt,
      finishedAt: new Date(),
    };
  }

  // ── Defensive dedup at read ──
  // Source table chuboe_rfq_line_mpn frequently contains duplicate rows for
  // the same (line_id, mpn_clean, mfr_id) tuple — pre-existing upstream
  // (typically from the iDempiere mass-import wizard being run multiple times
  // on PPV RFQs, often with the same Sanmina Excel file containing the same
  // MPN at different qtys across summary/detail rows). If we don't dedup here,
  // we make N duplicate franchise-API calls and write N duplicate VQs.
  //
  // KEY: (line_id, mpn_clean, mfr_id). MFR is included so legitimate cross-MFR
  // AVL alternates (e.g., DG441DY from both Renesas and Vishay on the same
  // line) are NOT collapsed — only same-MFR dups are.
  //
  // QTY TIE-BREAKING: when a group contains rows with different qty values
  // (the wizard-replay-with-different-qty pattern), we keep the largest qty.
  // Larger qty gives the most conservative coverage check — if API coverage
  // is FULL at the larger qty, it's definitely FULL at the smaller qty too.
  // We log when this happens so the operator knows there was ambiguity.
  //
  // This dedup is independent of the api-client.js check-before-retry safety
  // net; both layers exist together (one prevents source amplification, the
  // other prevents POST retry amplification).
  const groups = new Map(); // key -> chosen row
  const qtyAmbiguous = []; // groups where qty varies within
  for (const r of rawRows) {
    const key = `${r.chuboe_rfq_line_id}|${r.mpn}|${r.mfr_id || 0}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, r);
      continue;
    }
    const rQty = Number(r.qty) || 0;
    const eQty = Number(existing.qty) || 0;
    if (rQty !== eQty) {
      // Track first occurrence per key, not per row
      if (!qtyAmbiguous.find(a => a.key === key)) {
        qtyAmbiguous.push({ key, mpn: r.mpn, line_id: r.chuboe_rfq_line_id, qtys: new Set([eQty, rQty]) });
      } else {
        qtyAmbiguous.find(a => a.key === key).qtys.add(rQty);
      }
    }
    // Keep the larger qty; tiebreak by larger (later) chuboe_rfq_line_mpn_id
    if (rQty > eQty || (rQty === eQty && r.chuboe_rfq_line_mpn_id > existing.chuboe_rfq_line_mpn_id)) {
      groups.set(key, r);
    }
  }
  const rows = Array.from(groups.values());
  const dupesSkipped = rawRows.length - rows.length;
  if (dupesSkipped > 0) {
    console.log(`[enrich-rfq] Deduped ${dupesSkipped} duplicate (line_id, mpn, mfr) rows from source (${rawRows.length} → ${rows.length}). Upstream chuboe_rfq_line_mpn dups; skipping to avoid amplification.`);
  }
  if (qtyAmbiguous.length > 0) {
    console.log(`[enrich-rfq] WARNING: ${qtyAmbiguous.length} (line, mpn, mfr) groups have multiple qty values upstream — kept the largest (most conservative for coverage). Sample:`);
    for (const a of qtyAmbiguous.slice(0, 3)) {
      console.log(`  - line ${a.line_id} ${a.mpn}: qtys ${Array.from(a.qtys).sort((x,y) => y-x).join(', ')}`);
    }
  }

  const rfqType = rows[0].rfq_type;
  const customer = rows[0].customer;
  const rfqId = Number(rows[0].chuboe_rfq_id);
  const ttlDays = force ? 0 : ttlForRfqType(rfqType);

  // Restricted-MFR ordering — lines whose MFR is franchise-restricted
  // (ADI, Maxim, Linear Tech, TI) run LAST so that quota-limited APIs
  // (e.g., DigiKey 1,000/day) spend their budget on parts we can actually
  // purchase first. Restricted lines still get the full API sweep and
  // chuboe_pricing_api_result capture when budget remains; they just
  // don't produce VQ writes (see shared/vq-writer.js restricted-MFR gate).
  // Single source of truth: shared/restricted-mfrs.json
  const nonRestrictedLines = [];
  const restrictedLines = [];
  for (const r of rows) {
    if (isRestrictedMfr({ mfrId: r.mfr_id, mfrName: r.mfr })) {
      restrictedLines.push(r);
    } else {
      nonRestrictedLines.push(r);
    }
  }
  if (restrictedLines.length > 0) {
    console.log(`[enrich-rfq] ${restrictedLines.length} of ${rows.length} lines are franchise-restricted MFRs (ADI/Maxim/Linear/TI) — deferred to end of run; VQ writes will be skipped (data still captured to chuboe_pricing_api_result).`);
  }
  const orderedRows = [...nonRestrictedLines, ...restrictedLines];

  const lines = maxLines ? orderedRows.slice(0, maxLines) : orderedRows;

  const counters = {
    lines: lines.length,
    apiCalls: 0,
    cacheHits: 0,
    vqsWritten: 0,
    vqsFlagged: 0,
    vqsFailed: 0,           // server-side write rejections (5xx etc.)
    vqsSkippedRestricted: 0, // restricted-MFR rows: data captured to chuboe_pricing_api_result, VQ write skipped
    restrictedLines: restrictedLines.length,
    flagReasonCounts: {},  // { NO_RFQ_LINE: 12, MPN_CROSS_REF: 40, ... }
    flagSamples: [],        // first 5 flag {reason, detail, mpn}
    failSamples: [],        // first 5 failed writes {reason, detail, mpn}
    apiResultRowsWritten: 0,
    qtyMatches: 0,
    partialCoverage: 0,
    noCoverage: 0,
    // MFR comparison via shared/mfr-equivalence — informational only, no
    // behavior change. Counts how many distributor responses come back with
    // a manufacturer that doesn't match what the customer asked for.
    // 'mismatch' = both populated, different companies (after alias +
    // acquisitions resolution). '?' = one side blank.
    mfrMatch: 0,
    mfrMismatch: 0,
    mfrUnknown: 0,
    mfrMismatchSamples: [],  // first 5 {mpn, rfqMfr, supplierMfr, distributor}
    // Per-distributor health aggregated across all lines in this RFQ.
    // distinguishes "we tried 7 APIs, got nothing" from "we skipped".
    // Schema: { name: { calls, found, errors, withStock } }
    //   calls   = number of times we asked this distributor (live API only, not cache)
    //   found   = times distributor returned ANY catalog entry (carrying)
    //   withStock = times distributor returned stock > 0
    //   errors  = times distributor errored (rate-limited, network failure, etc.)
    distributorStats: {},
    errors: [],
    // Anomaly warnings — populated AFTER the loop in finalizeAndDetectAnomalies()
    // below. The smoking-gun pattern is "we processed N lines, made API calls
    // OR got cache hits, the writer reported 0 errors, but ZERO VQs landed."
    // That happened on the 17:30 cron tick on 2026-04-09 because mfr-lookup
    // was silently degrading under cron's no-PGUSER environment. The shared
    // module catches now re-throw infrastructure errors so this should bubble
    // as real failures, but the anomaly detector is the second line of
    // defense — it catches ANY future silent-skip pattern (not just psql
    // auth failures) by comparing inputs to outputs.
    warnings: [],
  };

  // Yield to foreground workflows (LAM Kitting Reorder, Stock RFQ pricing, etc.)
  // Check at every MPN boundary — cheap; sleep 30s if a pause is active.
  const apiPause = require('../../shared/api-pause');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const { mpn, cpc, qty, target_price: targetPrice } = line;

    // Pause-file yield — if a foreground workflow is running, sleep until it's done.
    // ignorePause=true bypasses (manual ops invocations that need to run despite an active pause).
    if (!ignorePause) {
      await apiPause.waitIfPaused({ log: (msg) => console.log(`[enrich-rfq] ${msg}`) });
    }

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

    // Per-distributor stats — only count live API calls, not cache hits
    // (cache hits don't tell us anything about current distributor health).
    // Tracks "we tried 7 distributors" vs "we got cache and skipped".
    if (!fromCache && Array.isArray(result.distributors)) {
      for (const d of result.distributors) {
        const name = d.name || d.distributor || 'unknown';
        if (!counters.distributorStats[name]) {
          counters.distributorStats[name] = { calls: 0, found: 0, withStock: 0, errors: 0 };
        }
        const s = counters.distributorStats[name];
        s.calls++;
        if (d.error || d.errorState) s.errors++;
        if (d.found) s.found++;
        if (d.found && (d.franchiseQty || 0) > 0) s.withStock++;
      }
    }

    // MFR comparison — for each distributor response, check whether the
    // supplier's manufacturer matches the customer's RFQ MFR ask. Uses the
    // shared mfr-equivalence module so the comparison rules are identical
    // to Vortex Matches and any other consumer. Informational only — does
    // NOT change what gets written. Surfaced in the run summary.
    const rfqMfr = line.mfr || '';
    const distributors = Array.isArray(result.distributors) ? result.distributors : [];
    for (const d of distributors) {
      if (!d.found) continue;
      // Check vqLines first (Arrow splits into franchise + Verical sub-lines);
      // fall back to d.vqManufacturer for single-result distributors.
      const supplierMfrs = Array.isArray(d.vqLines) && d.vqLines.length > 0
        ? d.vqLines.map(s => s.manufacturer || d.vqManufacturer || '')
        : [d.vqManufacturer || ''];
      for (const supplierMfr of supplierMfrs) {
        const flag = computeMfrMatch(rfqMfr, supplierMfr);
        if (flag === '') counters.mfrMatch++;
        else if (flag === 'MISMATCH') {
          counters.mfrMismatch++;
          if (counters.mfrMismatchSamples.length < 5) {
            counters.mfrMismatchSamples.push({
              mpn,
              rfqMfr,
              supplierMfr,
              distributor: d.name || d.distributor || '?',
            });
          }
        }
        else counters.mfrUnknown++;
      }
    }

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
        const { written = [], flagged = [], failed = [], skipped = [] } = await writeVQFromAPI(
          rfqDocNumber,
          cpc || '',
          result,
          {
            searchedMpn: mpn,
            _rfqLineIdOverride: Number(line.chuboe_rfq_line_id),
            applyRestrictedMfrGate: true,
          }
        );
        counters.vqsWritten += written.length;
        counters.vqsFlagged += flagged.length;
        counters.vqsFailed += failed.length;
        counters.vqsSkippedRestricted += skipped.length;
        for (const f of flagged) {
          const reason = f.reason || 'UNKNOWN';
          counters.flagReasonCounts[reason] = (counters.flagReasonCounts[reason] || 0) + 1;
          if (counters.flagSamples.length < 5) {
            counters.flagSamples.push({ mpn: f.mpn || mpn, reason, detail: f.detail, vendor: f.vendor });
          }
        }
        for (const f of failed) {
          if (counters.failSamples.length < 5) {
            counters.failSamples.push({ mpn: f.mpn || mpn, reason: f.reason, detail: f.detail, vendor: f.vendor });
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

  // ── Anomaly detection ────────────────────────────────────────────────────
  // Catch silent-degradation patterns where the run "looked successful" but
  // produced no work. The smoking-gun signature from the 2026-04-09 17:30
  // cron tick:
  //   - we processed >0 lines
  //   - we made API calls OR got cache hits (so we DID query distributors)
  //   - the writer reported 0 errors AND 0 flagged
  //   - BUT 0 VQs landed in chuboe_vq_line
  //
  // That combination is structurally impossible if everything works — at
  // minimum every line should produce a flagged row if it couldn't write.
  // 0/0/0 means rows are being silently dropped somewhere in the pipeline.
  // Surface as a loud warning so the operator can investigate before the
  // pattern compounds across hundreds of RFQs.
  const totalAttempts = counters.apiCalls + counters.cacheHits;
  // "Lines that actually had supply to quote" — FULL or PARTIAL coverage
  // means searchAllDistributors found at least one distributor with stock
  // for that line. NONE means the APIs returned nothing, in which case
  // 0 VQs is the legitimate outcome (not a silent skip).
  const linesWithSupply = counters.qtyMatches + counters.partialCoverage;

  if (
    counters.lines > 0 &&
    totalAttempts > 0 &&
    linesWithSupply > 0 &&  // ← gate: only flag when we DID find supply
    counters.vqsWritten === 0 &&
    counters.vqsFailed === 0 &&
    counters.vqsFlagged === 0 &&
    counters.errors.length === 0 &&
    !dryRun
  ) {
    counters.warnings.push({
      severity: 'HIGH',
      pattern: 'SILENT_NO_VQS',
      detail: `${counters.lines} lines, ${counters.apiCalls} API calls + ${counters.cacheHits} cache hits, ${linesWithSupply} lines had supply (FULL/PARTIAL coverage), 0 VQs written, 0 errors, 0 flagged. Structurally impossible if the writer is healthy — investigate the MFR/BP/packaging resolution path for silent failures.`,
    });
  }

  // Lower-severity warning: yield ratio < 25% with no errors. Same gate —
  // only consider lines that had supply (NONE-coverage lines are
  // legitimately 0-VQ and shouldn't drag down the ratio).
  if (
    linesWithSupply >= 10 &&
    counters.vqsWritten > 0 &&
    counters.vqsFailed === 0 &&
    counters.errors.length === 0 &&
    !dryRun
  ) {
    const yieldRatio = counters.vqsWritten / linesWithSupply;
    if (yieldRatio < 0.25) {
      counters.warnings.push({
        severity: 'MEDIUM',
        pattern: 'LOW_VQ_YIELD',
        detail: `${counters.vqsWritten} VQs written from ${linesWithSupply} lines with supply (${(yieldRatio * 100).toFixed(0)}% yield). Expected ratio depends on supplier count but <25% with 0 errors suggests silent skips somewhere — verify against api_pricing_cache for the same MPNs.`,
      });
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

// Probe an RFQ's MPN count — used to decide whether to claim the pause file.
// Returns 0 if RFQ not found or query fails (will skip pause).
async function psqlProbeRfqSize(rfqDocNumber) {
  const probePool = new (require('pg').Pool)({
    user: process.env.PGUSER || process.env.USER || 'analytics_user',
    host: '/var/run/postgresql',
    database: 'idempiere_replica',
  });
  try {
    const { rows } = await probePool.query(`
      SELECT COUNT(rlm.chuboe_rfq_line_mpn_id)::int AS n
      FROM adempiere.chuboe_rfq r
      LEFT JOIN adempiere.chuboe_rfq_line rl ON rl.chuboe_rfq_id = r.chuboe_rfq_id AND rl.isactive='Y'
      LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON rlm.chuboe_rfq_line_id = rl.chuboe_rfq_line_id AND rlm.isactive='Y'
      WHERE r.value = $1 AND r.isactive='Y'
    `, [String(rfqDocNumber)]);
    return rows[0]?.n || 0;
  } finally {
    await probePool.end();
  }
}

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
    ignorePause: hasFlag('--ignore-pause'),
    maxLines: getArg('--max-lines') ? parseInt(getArg('--max-lines'), 10) : null,
    onProgress: (line, idx, total) => {
      if ((idx + 1) % 25 === 0 || idx === total - 1) {
        process.stderr.write(`  [${idx + 1}/${total}] ${line.mpn}\n`);
      }
    },
  };

  console.log(`\nEnriching RFQ ${rfq}${opts.dryRun ? ' (DRY RUN)' : ''}${opts.force ? ' (FORCE — cache bypassed)' : ''}${opts.maxLines ? ` (max ${opts.maxLines} lines)` : ''}\n`);

  // J5 pause — CLI invocations are user-initiated (foreground). For small RFQs
  // claim the pause so the background enricher yields; for large RFQs run
  // alongside (cache hits dedupe most competition). Size-gated via shouldPause().
  // Probe the RFQ size before enriching so we know which mode.
  let pauseRefreshTimer = null;
  let pauseClaimed = false;
  if (!opts.dryRun) {
    try {
      const apiPause = require('../../shared/api-pause');
      const sizeProbe = await psqlProbeRfqSize(rfq);
      if (apiPause.shouldPause(sizeProbe)) {
        apiPause.claimPause('enrich-rfq-cli', sizeProbe);
        pauseClaimed = true;
        pauseRefreshTimer = setInterval(() => apiPause.refreshPause(), 5 * 60 * 1000);
        console.log(`[pause] claimed (${sizeProbe} MPNs < 100, TTL 10m) — background enricher will yield`);
      } else {
        console.log(`[pause] skipped (${sizeProbe} MPNs ≥ 100) — running alongside enricher`);
      }
    } catch (e) {
      console.log(`[pause] probe failed: ${e.message} — running without pause`);
    }
  }

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
    console.log(`VQs failed:   ${summary.vqsFailed}`);
    console.log(`api_result rows: ${summary.apiResultRowsWritten}`);
    console.log(`Coverage:     FULL=${summary.qtyMatches}  PARTIAL=${summary.partialCoverage}  NONE=${summary.noCoverage}`);
    const mfrTotal = summary.mfrMatch + summary.mfrMismatch + summary.mfrUnknown;
    if (mfrTotal > 0) {
      const mismatchPct = mfrTotal > 0 ? ((summary.mfrMismatch / mfrTotal) * 100).toFixed(1) : '0.0';
      console.log(`MFR check:    MATCH=${summary.mfrMatch}  MISMATCH=${summary.mfrMismatch} (${mismatchPct}%)  UNKNOWN=${summary.mfrUnknown}`);
      if (summary.mfrMismatchSamples?.length) {
        console.log('MFR mismatch samples:');
        summary.mfrMismatchSamples.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.mpn}: customer asked '${s.rfqMfr}', ${s.distributor} returned '${s.supplierMfr}'`);
        });
      }
    }
    console.log(`Errors:       ${summary.errors.length}`);
    // Anomaly warnings — surface BEFORE the regular flag/fail samples so the
    // operator sees them at eye level. Silent-skip patterns matter even when
    // (and ESPECIALLY when) "errors=0".
    if (summary.warnings?.length > 0) {
      console.log('\n⚠ ANOMALY WARNINGS:');
      summary.warnings.forEach((w, i) => {
        console.log(`  [${w.severity}] ${w.pattern}: ${w.detail}`);
      });
      console.log('');
    }
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
    if (summary.failSamples?.length) {
      console.log('Fail samples (server-side):');
      summary.failSamples.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.reason || 'API_WRITE_ERROR'} [${s.vendor || '?'}] ${s.mpn}: ${s.detail || '(no detail)'}`);
      });
    }
    if (summary.errors.length > 0) {
      console.log('\nFirst 5 errors:');
      summary.errors.slice(0, 5).forEach(e => console.log(`  ${e.stage}: ${e.mpn} — ${e.message}`));
    }
    console.log(`Duration:     ${(summary.durationMs / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
    // Release pause claim (if we made one)
    if (pauseClaimed) {
      try {
        clearInterval(pauseRefreshTimer);
        require('../../shared/api-pause').releasePause('enrich-rfq-cli');
        console.log('[pause] released');
      } catch (e) { /* ignore */ }
    }
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
