/**
 * Shared RFQ Fast Loader — concurrent line writer, no enrichment
 *
 * Writes RFQ header + lines + line MPNs via iDempiere REST API using
 * N concurrent workers. No MFR ID resolution, no description lookup,
 * no psql calls. This is the speed-critical loading path.
 *
 * MFR IDs are resolved later by the MFR reconciler cron (J4).
 * Franchise API enrichment is handled by enrich-poller.js (separate).
 *
 * USAGE:
 *   const { loadRFQ } = require('../shared/rfq-fast-loader');
 *
 *   const result = await loadRFQ({
 *     bpartnerId: 1000383,
 *     type: 'PPV',
 *     description: 'Honeywell PPV — AMERICAS',
 *     salesrepId: 1000011,
 *     userId: 1048311,
 *     lines: [{ mpn: 'SC900860EPR2', mfrText: 'NXP', qty: 2040000, targetPrice: 0.95 }],
 *     concurrency: 10,
 *   });
 *   // result: { rfqId, searchKey, linesWritten, mpnsWritten, errors, elapsedMs, linesPerSec }
 *
 * RESUME:
 *   // After interruption, pass rfqId + startFrom to skip already-loaded lines:
 *   const result = await loadRFQ({ ...opts, rfqId: 1141735, startFrom: 2868 });
 *
 * PREEMPTION (daemon use):
 *   const ac = new AbortController();
 *   const result = await loadRFQ({ ...opts, abortSignal: ac.signal });
 *   // To preempt: ac.abort() — workers finish current line, then return.
 *
 * CONSUMERS:
 *   - rfq-loader-daemon.js (queued/prioritized loading)
 *   - RFQ Loading workflow (Path A-Fast for 500+ line RFQs)
 *   - Ad-hoc scripts (volume RFQ loading)
 */

const logger = require('./logger').createLogger('FastLoader');
const { apiPost } = require('./api-client');
const { cleanMpn } = require('./db-helpers');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const DEFAULT_SALESREP_ID = 1000004; // Jake Harris
const DEFAULT_STATUS_ID = 1000022;   // New

const RFQ_TYPES = {
  'Shortage':             1000000,
  'PPV':                  1000001,
  'EOL/LTB':              1000003,
  '3PL/VMI':              1000004,
  'Proactive Offer':      1000005,
  'Import':               1000006,
  'Stock':                1000007,
  'Hot Parts':            1000013,
  'Astute Franchised':    1000002,
  'Unqualified Spot RFQ': 1000012,
};

// ─── MAIN LOADER ─────────────────────────────────────────────────────────────

/**
 * Load an RFQ concurrently — header + lines + line MPNs, raw text only.
 *
 * @param {object} opts
 * @param {number}  opts.bpartnerId      - C_BPartner_ID (required)
 * @param {string}  opts.type            - RFQ type name: 'Stock', 'PPV', etc. (required)
 * @param {string}  [opts.description]   - RFQ header description
 * @param {number}  [opts.salesrepId]    - SalesRep_ID (default: Jake Harris 1000004)
 * @param {number}  opts.userId          - Chuboe_User_ID — contact person (required)
 * @param {number}  [opts.statusId]      - R_Status_ID (default: 1000022 New)
 * @param {Array}   opts.lines           - Line items (required, at least 1)
 * @param {string}  opts.lines[].mpn     - Manufacturer Part Number (required)
 * @param {string}  [opts.lines[].mfrText]    - Manufacturer text (raw, no ID resolution)
 * @param {number}  opts.lines[].qty          - Quantity
 * @param {number}  [opts.lines[].targetPrice] - Target price (default 0)
 * @param {string}  [opts.lines[].cpc]        - Customer part code
 * @param {string}  [opts.lines[].description] - Part description
 * @param {string}  [opts.lines[].dateCode]   - Date code
 * @param {number}  [opts.concurrency=10]     - Number of concurrent workers
 * @param {number}  [opts.startFrom=0]        - Resume index (0-based into lines[])
 * @param {number}  [opts.rfqId]              - Existing RFQ ID (skip header POST if resuming)
 * @param {Function} [opts.onProgress]        - callback(done, total, linesPerSec, etaSec)
 * @param {AbortSignal} [opts.abortSignal]    - Signal to abort (for daemon preemption)
 * @returns {Promise<{rfqId, searchKey, linesWritten, mpnsWritten, errors, elapsedMs, linesPerSec}>}
 */
async function loadRFQ(opts) {
  const {
    bpartnerId,
    type,
    description = null,
    salesrepId = DEFAULT_SALESREP_ID,
    userId = null,
    statusId = DEFAULT_STATUS_ID,
    lines = [],
    concurrency = 10,
    startFrom = 0,
    rfqId: existingRfqId = null,
    onProgress = null,
    abortSignal = null,
  } = opts;

  // ── Validation ──
  if (!bpartnerId) throw new Error('rfq-fast-loader: bpartnerId is required');
  if (!type) throw new Error('rfq-fast-loader: type is required');
  if (!userId) throw new Error('rfq-fast-loader: userId (contact person) is required');
  if (!lines || lines.length === 0) throw new Error('rfq-fast-loader: at least one line is required');

  const typeId = RFQ_TYPES[type];
  if (!typeId) throw new Error(`rfq-fast-loader: unknown RFQ type '${type}'. Valid: ${Object.keys(RFQ_TYPES).join(', ')}`);

  const errors = [];
  let linesWritten = 0;
  let mpnsWritten = 0;
  let rfqId = existingRfqId;
  let searchKey = null;

  const startTime = Date.now();

  // ── RFQ Header ──
  if (!rfqId) {
    const rfqPayload = {
      C_BPartner_ID: bpartnerId,
      Chuboe_RFQ_Type_ID: typeId,
      SalesRep_ID: salesrepId,
      R_Status_ID: statusId,
    };
    if (description) rfqPayload.Description = description;
    if (userId) rfqPayload.Chuboe_User_ID = userId;

    try {
      const rfqResponse = await apiPost('chuboe_rfq', rfqPayload);
      rfqId = rfqResponse.id;
      searchKey = rfqResponse.Value || rfqResponse.value || null;
      if (!rfqId) throw new Error('No ID returned in response');
    } catch (e) {
      return {
        rfqId: null, searchKey: null,
        linesWritten: 0, mpnsWritten: 0,
        errors: [`Failed to insert RFQ header: ${e.message}`],
        elapsedMs: Date.now() - startTime, linesPerSec: 0,
      };
    }
    logger.info(`RFQ header created: searchKey=${searchKey}, rfqId=${rfqId}, BP=${bpartnerId}, type=${type}`);
  } else {
    logger.info(`Resuming RFQ rfqId=${rfqId} from line ${startFrom}`);
  }

  // ── Concurrent Workers ──
  const total = lines.length;
  let cursor = startFrom;

  // Progress tracking
  const progressInterval = Math.max(1, Math.floor((total - startFrom) / 20)); // ~5% increments

  async function worker() {
    while (true) {
      // Check abort signal (preemption / shutdown)
      if (abortSignal?.aborted) return;

      const myIdx = cursor++;
      if (myIdx >= total) return;

      const line = lines[myIdx];
      const lineNum = (myIdx + 1) * 10;
      const mpnRaw = line.mpn || '';
      const mpnCleanVal = cleanMpn(mpnRaw);

      if (!mpnRaw) {
        errors.push(`Line ${myIdx + 1}: empty MPN — skipped`);
        continue;
      }

      try {
        // POST chuboe_rfq_line
        const lineRes = await apiPost('chuboe_rfq_line', {
          Chuboe_RFQ_ID: rfqId,
          Line: lineNum,
          Qty: line.qty || 0,
          PriceEntered: line.targetPrice || 0,
          ...(line.cpc ? { Chuboe_CPC: line.cpc } : {}),
        }, {
          naturalKeyFields: ['Chuboe_RFQ_ID', 'Line'],
        });

        const lineId = lineRes.id;
        if (!lineId) {
          errors.push(`Line ${myIdx + 1} (${mpnRaw}): no ID returned from line POST`);
          continue;
        }
        linesWritten++;

        // POST chuboe_rfq_line_mpn — raw text only, no Chuboe_MFR_ID
        const mpnPayload = {
          Chuboe_RFQ_Line_ID: lineId,
          Chuboe_RFQ_ID: rfqId,
          Chuboe_MPN: mpnRaw,
          Chuboe_MPN_Clean: mpnCleanVal,
          Qty: line.qty || 0,
          PriceEntered: line.targetPrice || 0,
        };
        if (line.mfrText) mpnPayload.Chuboe_MFR_Text = line.mfrText;
        if (line.description) mpnPayload.Description = line.description;
        if (line.dateCode) mpnPayload.Chuboe_Date_Code = line.dateCode;

        await apiPost('chuboe_rfq_line_mpn', mpnPayload, {
          naturalKeyFields: ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN_Clean'],
        });
        mpnsWritten++;

      } catch (e) {
        errors.push(`Line ${myIdx + 1} (${mpnRaw}): ${e.message.slice(0, 150)}`);
      }

      // Progress callback
      const done = linesWritten + errors.length;
      if (onProgress && done > 0 && done % progressInterval === 0) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const lps = done / (elapsedSec || 1);
        const remaining = total - startFrom - done;
        const eta = Math.round(remaining / (lps || 1));
        onProgress(startFrom + done, total, lps, eta);
      }
    }
  }

  const workerCount = Math.min(concurrency, total - startFrom);
  logger.info(`Starting ${workerCount} workers for ${total - startFrom} lines (startFrom=${startFrom})...`);

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const elapsedMs = Date.now() - startTime;
  const linesPerSec = linesWritten / ((elapsedMs / 1000) || 1);

  const aborted = abortSignal?.aborted ? ' (ABORTED — preempted)' : '';
  logger.info(`Load complete${aborted}: searchKey=${searchKey}, rfqId=${rfqId}, ${linesWritten} lines, ${mpnsWritten} MPNs, ${errors.length} errors, ${(elapsedMs / 1000).toFixed(1)}s (${linesPerSec.toFixed(1)}/s)`);

  return { rfqId, searchKey, linesWritten, mpnsWritten, errors, elapsedMs, linesPerSec };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = { loadRFQ, RFQ_TYPES };
