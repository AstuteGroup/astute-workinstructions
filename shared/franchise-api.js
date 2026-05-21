/**
 * Centralized Franchise Distributor API Module
 *
 * Calls ALL active franchise distributor APIs and returns standardized results.
 * Each API hit with stock produces VQ-ready data for ERP import.
 *
 * USAGE:
 *   const { searchAllDistributors, searchPart } = require('../shared/franchise-api');
 *
 *   // Search all distributors for a part
 *   const results = await searchAllDistributors('ADS1115IDGST', 700);
 *   console.log(results.summary);       // { totalStock, lowestPrice, distributorCount }
 *   console.log(results.distributors);   // Array of per-distributor results
 *   console.log(results.vqLines);        // VQ-ready rows for ERP import
 *
 *   // Search a single distributor
 *   const dk = await searchPart('digikey', 'ADS1115IDGST', 700);
 *
 * CONSUMERS:
 *   - Franchise Screening: stock vs demand → skip/proceed decision
 *   - Suggested Resale: price levels + availability as scarcity signal
 *   - VQ Loading: generate VQ template rows from API data
 *   - Quick Quote: franchise price as ceiling reference
 *
 * IMPORTANT:
 *   - API data = confirmed pricing → captured as VQ lines
 *   - FindChips scraped data is NOT handled here (availability-only, see main.js)
 */

const path = require('path');

// All active distributor API modules
const API_DIR = path.resolve(__dirname, '../Trading Analysis/RFQ Sourcing/franchise_check');

const DISTRIBUTORS = {
  digikey: {
    name: 'DigiKey',
    script: path.join(API_DIR, 'digikey.js'),
    bpValue: '1002331',
    bpName: 'Digi-Key Electronics',
    bpId: 1000327,
    active: true,
  },
  arrow: {
    name: 'Arrow',
    script: path.join(API_DIR, 'arrow.js'),
    bpValue: '1002390',
    bpName: 'Arrow Electronics',
    bpId: 1000386,
    active: true,
  },
  rutronik: {
    name: 'Rutronik',
    script: path.join(API_DIR, 'rutronik.js'),
    bpValue: '1004668',
    bpName: 'Rutronik Inc.',
    bpId: 1002668,
    active: true,
  },
  future: {
    name: 'Future',
    script: path.join(API_DIR, 'future.js'),
    bpValue: '1002332',
    bpName: 'Future Electronics Corporation',
    bpId: 1000328,
    active: true,
  },
  newark: {
    name: 'Newark/Farnell',
    script: path.join(API_DIR, 'newark.js'),
    bpValue: '1002394',
    bpName: 'Newark in One (Element 14)',
    bpId: 1000390,
    active: true,
  },
  tti: {
    name: 'TTI',
    script: path.join(API_DIR, 'tti.js'),
    bpValue: '1002330',
    bpName: 'TTI Inc',
    bpId: 1000326,
    active: true,
  },
  mouser: {
    name: 'Mouser',
    script: path.join(API_DIR, 'mouser.js'),
    bpValue: '1002338',
    bpName: 'Mouser',
    bpId: 1000334,
    active: true,
  },
  master: {
    name: 'Master',
    script: path.join(API_DIR, 'master.js'),
    bpValue: '1002409',
    bpName: 'Master Electronics',
    bpId: 1000405,
    active: true,
  },
  waldom: {
    name: 'Waldom',
    script: path.join(API_DIR, 'waldom.js'),
    bpValue: '1002648',
    bpName: 'Waldom Electronics',
    bpId: 1000644,
    active: true,
  },
  sager: {
    name: 'Sager',
    script: path.join(API_DIR, 'sager.js'),
    bpValue: '1002339',
    bpName: 'Sager - v3004',
    bpId: 1000335,
    active: true,
  },
  // Verical is Arrow's broker marketplace — not searched directly (no separate API),
  // but Arrow's response surfaces Verical stock under a separate webSite tree.
  // arrow.js splits those into vqLines tagged with this BP. Listed here (inactive)
  // so cache reconstitution and SupplierName lookups can resolve "Verical" back
  // to the correct iDempiere business partner.
  verical: {
    name: 'Verical',
    script: null,
    bpValue: '1003440',
    bpName: 'Verical',
    bpId: 1001436,
    active: false,
  },
  // Farnell is queried via the Newark/element14 API (same API, different store).
  // newark.js emits per-store vqLines tagged with the correct BP. Listed here
  // (inactive) so cache reconstitution and SupplierName lookups can resolve
  // "Farnell Element 14" back to the correct iDempiere business partner.
  farnell: {
    name: 'Farnell Element 14',
    script: null,
    bpValue: '1002310',
    bpName: 'Farnell Element 14',
    bpId: 1000306,
    active: false,
  },
};

/**
 * Pick the highest tier price ≤ buyQty from a sorted price breaks list.
 * Mirror of arrow.js priceForBuy. Returns null if no tier is reachable.
 *
 * @param {Array<{qty: number, unitPrice: number}>} breaks
 * @param {number} buyQty
 * @returns {number|null}
 */
function priceAtQty(breaks, buyQty) {
  if (!Array.isArray(breaks) || breaks.length === 0 || buyQty <= 0) return null;
  const sorted = breaks.slice().sort((a, b) => (a.qty || 0) - (b.qty || 0));
  let chosen = null;
  for (const tier of sorted) {
    if ((tier.qty || 0) <= buyQty) chosen = tier;
    else break;
  }
  return chosen?.unitPrice ?? null;
}

/**
 * Synthesize stock + lead-time vqLines from a normalized distributor result.
 *
 * Per the spec clarification 2026-04-09 (operator): when a single distributor
 * returns BOTH stock AND a lead-time field for additional qty, we should
 * write TWO VQs from that source — one stock row and one lead-time row —
 * because they represent two distinct supply offers the seller needs to
 * compare independently. The stock row is "what they have today at this
 * price"; the lead-time row is "what they can deliver in N weeks at a
 * different (often better) tier price."
 *
 * Rules:
 *   stockQty > 0, no leadTime              → 1 row (stock only)
 *   stockQty > 0, leadTime, stock ≥ rfqQty → 1 row (stock fully covers, no separate LT row needed)
 *   stockQty > 0, leadTime, stock < rfqQty → 2 rows (stock at stock-tier price + LT at rfqQty-tier price)
 *   stockQty = 0, leadTime                 → 1 row (lead-time only, qty=0 + leadTime set)
 *   stockQty = 0, no leadTime              → 0 rows (nothing to quote)
 *
 * The stock row's price = price tier reachable at min(rfqQty, stockQty)
 * The lead-time row's price = price tier reachable at rfqQty (potentially a
 *   better/deeper tier than the stock row)
 *
 * Pricing follows the same "tier must be reachable" rule arrow.js uses:
 * priceAtQty(breaks, buyQty) picks the highest tier ≤ buyQty.
 *
 * Skipped when result.vqLines is already populated (arrow.js handles its own
 * multi-source split via the parser-level vqLines path).
 */
function synthesizeStockLtVqLines(result, mpn, qty, config) {
  if (Array.isArray(result.vqLines) && result.vqLines.length > 0) return null;

  const stockQty = Number(result.franchiseQty) || 0;
  const leadTime = result.vqLeadTime || '';
  const hasLeadTime = String(leadTime).trim() !== '';
  const breaks = result.priceBreaks || [];
  // currencyId may be set on the result by the cache-replay path (Farnell GBP
  // round-trip). Default null lets vq-writer fall back to USD on its own.
  const currencyId = result.currencyId || null;

  if (stockQty === 0 && !hasLeadTime) return null;  // nothing to quote

  const lines = [];

  // Stock row
  if (stockQty > 0) {
    const stockBuyQty = Math.min(qty, stockQty);
    const stockPrice = priceAtQty(breaks, stockBuyQty)
      || result.franchiseRfqPrice
      || result.vqPrice
      || result.franchisePrice;
    if (stockPrice != null && stockPrice > 0) {
      lines.push({
        vendorBP: config.bpValue,
        vendorName: config.bpName,
        channel: config.name,
        mpn: result.vqMpn || mpn,
        manufacturer: result.vqManufacturer || '',
        description: result.vqDescription || '',
        qty: stockQty,           // surface the lot's available stock
        cost: stockPrice,
        currencyId,
        moq: result.vqMoq || null,
        spq: result.vqSpq || null,
        dateCode: result.vqDateCode || null,
        leadTime: null,           // stock row → no LT
        vendorNotes: result.vqVendorNotes || '',
        priceBreaks: breaks,
      });
    }
  }

  // Lead-time row — only when stock can't fully cover the RFQ qty
  // (otherwise the stock row already serves the demand and a separate LT row
  // is just noise). For stockQty=0 + leadTime, this is the only row.
  //
  // MOQ enforcement: factory-order parts often have a MOQ much larger than the
  // RFQ qty (e.g. Mouser QII-0.006-00-61 → MOQ 9,217 against a 100-pc RFQ).
  // The synthesized line's `qty` is the ACTUAL commit qty (max of remaining
  // demand and MOQ), and `vendorNotes` carries a loud ⚠ MOQ warning so no
  // downstream report can render the line as if the RFQ qty were buyable.
  if (hasLeadTime && stockQty < qty) {
    const moq = Number(result.vqMoq) || 1;
    const remainingDemand = Math.max(qty - stockQty, 1);
    const ltBuyQty = Math.max(remainingDemand, moq);
    const ltPrice = priceAtQty(breaks, ltBuyQty)
      || result.franchiseRfqPrice
      || result.vqPrice
      || result.franchisePrice;
    if (ltPrice != null && ltPrice > 0) {
      let notes = result.vqVendorNotes || '';
      if (moq > remainingDemand) {
        const warn = `⚠ MOQ ${moq.toLocaleString()} (RFQ ${qty.toLocaleString()})`;
        notes = notes ? `${warn} | ${notes}` : warn;
      }
      lines.push({
        vendorBP: config.bpValue,
        vendorName: config.bpName,
        channel: config.name,
        mpn: result.vqMpn || mpn,
        manufacturer: result.vqManufacturer || '',
        description: result.vqDescription || '',
        qty: ltBuyQty,            // actual commit qty (honors MOQ)
        cost: ltPrice,
        currencyId,
        moq: result.vqMoq || null,
        spq: result.vqSpq || null,
        dateCode: result.vqDateCode || null,
        leadTime: String(leadTime),
        vendorNotes: notes,
        priceBreaks: breaks,
      });
    }
  }

  return lines.length > 0 ? lines : null;
}

/**
 * Call a single distributor API
 * Each script exports searchPart(mpn, qty) → result object
 */
async function searchPart(distributor, mpn, qty, opts = {}) {
  const config = DISTRIBUTORS[distributor];
  if (!config || !config.active) {
    return { distributor, name: config?.name || distributor, found: false, error: 'Not configured or inactive' };
  }

  // Negative cache check — serves prior "not carried" results without burning
  // a live API call. Skipped when opts.skipCache is true (for callers that
  // explicitly need fresh data — probes, debugging, intentional refresh).
  // Errors from the cache layer MUST never block the live API call.
  let _negCache = null;
  try { _negCache = require('./api-negative-cache'); } catch { /* module optional */ }
  // Pre-call peek captures cache state BEFORE any API call or record.
  // Used by shadow-mode audit below to compare "what we would have served"
  // vs "what the live API actually returned" on THIS call.
  let _preCallCacheState = null;
  if (_negCache && !opts.skipCache) {
    try {
      _preCallCacheState = _negCache.peek({ mpn, mfr: opts.mfr, disty: distributor });
      const hit = _negCache.check({ mpn, mfr: opts.mfr, disty: distributor });
      if (hit && hit.result === 'not_carried') {
        return {
          distributor,
          name: config.name,
          bpValue: config.bpValue,
          bpName: config.bpName,
          bpId: config.bpId,
          found: false,
          cached: true,
          cachedAt: hit.cached_at,
          cacheExpires: hit.expires_at,
          matchType: null,
          franchiseQty: 0,
          franchisePrice: null,
          franchiseBulkPrice: null,
          franchiseRfqPrice: null,
          priceBreaks: [],
          vqLines: null,
        };
      }
    } catch { /* swallow cache errors */ }
  }

  try {
    const mod = require(config.script);

    // Hard local daily-call ceiling — pre-flight check that synthesizes a
    // MaxCallPerDay error when we've hit the per-cog daily cap (currently
    // only Mouser enforces by default, 900/day; others opt in via env).
    // Companion to the jitter in api-retry-policy.js: jitter spreads retries
    // across the morning, ceiling prevents legitimate fresh traffic from
    // re-burning the new quota before backlog drains. The thrown error flows
    // through the wrapper's catch below → classify() → MaxCallPerDay rule →
    // jittered enqueue, same path as a real supplier-side MaxCallPerDay.
    // See api-daily-counter.js.
    if (!opts.skipCeiling) {
      try {
        const counter = require('./api-daily-counter');
        const verdict = counter.checkAndIncrement(distributor);
        if (!verdict.allowed) {
          throw new Error(`MaxCallPerDay (local ceiling): ${distributor} ${verdict.count}/${verdict.ceiling} for this Chicago-midnight day — see shared/api-daily-counter.js`);
        }
      } catch (e) {
        // Re-throw real MaxCallPerDay; swallow other counter errors (e.g.
        // module load failure, corrupt counter file) so a broken counter
        // never blocks real API calls.
        if (e.message && e.message.includes('MaxCallPerDay')) throw e;
      }
    }

    // Per-disty throttle — blocks until a token is available so we never
    // exceed the supplier's per-minute window. Distys without a configured
    // limit pass through unchanged. See shared/api-throttle.js.
    try {
      await require('./api-throttle').acquire(distributor);
    } catch (throttleErr) {
      // Throttle gave up after max wait — treat as a rate-limit so the
      // wrapper's catch enqueues for retry instead of just dropping the call.
      throw throttleErr;
    }

    // opts.mfr — searched MFR — enables the MPN-match MFR veto (rejects
    // candidates whose MFR is MISMATCH per shared/mfr-equivalence). Optional;
    // existing call sites that don't pass it get the old behavior (no veto).
    const result = await mod.searchPart(mpn, qty, opts);

    // Auth-failure alerting — if the cog returned result.error and it matches
    // auth patterns, fire the debounced alerter. Non-blocking, swallows its
    // own errors. See shared/auth-failure-alerts.js for the pattern list.
    //
    // Clean responses (no result.error) clear any prior alerted-failure state
    // for this disty and trigger a one-time recovery email. Without this,
    // `firstFailureAt` is sticky across recoveries — a failure today + a
    // recovery + a failure 4 days later reads in the day-5 alert as "first
    // detected 4 days ago" even though the disty was actually clean for 4 days.
    if (result?.error) {
      try {
        require('./auth-failure-alerts')
          .alertIfAuthFailure({ distributor, error: result.error, mpn })
          .catch(() => {});
      } catch { /* module optional */ }
    } else if (result) {
      try {
        require('./auth-failure-alerts')
          .noteAuthSuccess({ distributor })
          .catch(() => {});
      } catch { /* module optional */ }
    }

    // Negative cache record — only cache clean outcomes (no error field).
    // Upstream errors (429/5xx/timeouts) are NOT cached — the retry queue
    // handles them. Per-disty envelope/context gates are enforced inside
    // the cache module; missing metadata = safe no-op.
    if (_negCache && !opts.skipCache && !result?.error) {
      try {
        const hasPriceBreaks = Array.isArray(result?.priceBreaks) && result.priceBreaks.length > 0;
        if (result?.found === true && hasPriceBreaks) {
          _negCache.record({
            mpn,
            mfr: opts.mfr,
            disty: distributor,
            result: 'carried',
            priceBreaksN: result.priceBreaks.length,
            stockQty: result.franchiseQty || result.inventoryQty || null,
            costUnit: result.franchisePrice || result.franchiseRfqPrice || null,
          });
        } else if (result?.found === false) {
          // Clean 200-empty. Envelope / context flow through for per-disty gates.
          _negCache.record({
            mpn,
            mfr: opts.mfr,
            disty: distributor,
            result: 'not_carried',
            envelope: result?.envelope,
            context: opts.cacheContext,
            reason: result?.cacheExcludeReason,
          });
        }
        // Shadow audit: compare what cache WOULD have served (pre-call peek)
        // to what the live API actually returned on THIS call.
        if (_negCache.SHADOW_MODE) {
          _negCache.logShadow({
            mpn, mfr: opts.mfr, disty: distributor,
            cachedResult: _preCallCacheState?.result || null,
            actualResult: result?.found ? 'carried' : 'not_carried',
          });
        }
      } catch { /* cache errors never block the result path */ }
    }

    return {
      distributor,
      name: config.name,
      bpValue: config.bpValue,
      bpName: config.bpName,
      bpId: config.bpId,
      found: result.found || false,
      // 'exact' = MPN normalized-equal to searched, 'variant' = packaging-suffix
      // prefix relationship (e.g., LM358N ↔ LM358N/NOPB), null = no MPN match
      // attempted (legacy parsers that haven't been retrofitted yet)
      matchType: result.matchType || null,
      franchiseQty: result.franchiseQty || 0,
      franchisePrice: result.franchisePrice || null,       // unit price (qty=1)
      franchiseBulkPrice: result.franchiseBulkPrice || null, // lowest price break
      franchiseRfqPrice: result.franchiseRfqPrice || null,   // price at RFQ qty
      // VQ-ready fields
      vqPrice: result.vqPrice || result.franchiseRfqPrice || null,
      vqMpn: result.vqMpn || mpn,
      vqManufacturer: result.vqManufacturer || '',
      vqDescription: result.vqDescription || '',
      vqMoq: result.vqMoq || null,
      vqSpq: result.vqSpq || null,
      vqVendorNotes: result.vqVendorNotes || '',
      vqDateCode: result.vqDateCode || '',
      vqPackaging: result.vqPackaging || '',  // Mouser/Sager/TTI populate this; vq-writer normalizes to chuboe_packaging_id
      vqLeadTime: result.vqLeadTime || '',
      // Compliance data — HTS/ECCN are properties of the part, not the seller.
      // DigiKey + Mouser populate these reliably; Arrow's standard search doesn't
      // (separate compliance endpoint required), TTI/Waldom inconsistent. Backfill
      // workflows should join these onto chuboe_vq_line by (mpn, mfr).
      vqHts: result.vqHts || null,
      vqEccn: result.vqEccn || null,
      // Full price break array for api-result-writer capture
      priceBreaks: result.priceBreaks || [],
      // Multi-source split. Two paths populate this:
      //   1. Parser-native (arrow.js) — emits one entry per real source-with-stock,
      //      tagged with the right vendor BP. Used for the Arrow + Verical channel
      //      split where one API call returns multiple distinct lots.
      //   2. Wrapper-synthesized (synthesizeStockLtVqLines below) — for parsers
      //      that return a single normalized result (digikey, mouser, tti, future,
      //      etc.), splits into stock + lead-time rows when the supplier has both.
      //      Per spec clarification 2026-04-09: stock and lead-time are two
      //      distinct supply offers from the same supplier and the seller needs
      //      to see them as separate VQ rows, not one row with a lead_time note.
      vqLines: result.vqLines || synthesizeStockLtVqLines(result, mpn, qty, config),
      // Raw result for workflow-specific needs
      raw: result,
    };
  } catch (err) {
    // Auth-failure alerting on thrown errors (e.g. the cog rejects before
    // returning a structured result — Mouser's "Unauthorized" path throws).
    try {
      require('./auth-failure-alerts')
        .alertIfAuthFailure({ distributor, error: err, mpn })
        .catch(() => {});
    } catch { /* module optional */ }

    // Centralized retry policy — classify the error and enqueue if retry-able.
    // Replaces per-cog enqueue logic that used to live in mouser.js / digikey.js.
    // All 10 active cogs now get retry coverage automatically; cogs only need
    // to throw descriptive Errors. See shared/api-retry-policy.js for the rules.
    //
    // Also logs every failure to ~/workspace/.api-failures.ndjson so when a
    // supplier exhibits weird behavior we have evidence on hand instead of
    // having to add a logger and wait for the next failure. Cogs that need
    // richer per-call HTTP context (status code, headers, response body) keep
    // their own loggers — Mouser uses ~/workspace/.mouser-failures.ndjson —
    // and we correlate by timestamp.
    //
    // Skipped when API_RETRY_IN_FLIGHT=1 — prevents the queue worker from
    // re-enqueueing a call it's currently retrying (which would create
    // duplicate queue items on every failed attempt).
    let _verdict = null;
    try {
      const { classify } = require('./api-retry-policy');
      _verdict = classify(err);
    } catch { /* policy module load failure → fall through with null verdict */ }

    if (process.env.API_RETRY_IN_FLIGHT !== '1') {
      try {
        if (_verdict?.retry) {
          const { enqueueRetry } = require('./api-queue');
          const argsB64 = Buffer.from(JSON.stringify({ distributor, mpn, qty })).toString('base64');
          const runnerPath = path.resolve(__dirname, '../scripts/api-retry-runner.js');
          enqueueRetry({
            id: `${distributor}-${mpn}-${Date.now()}`,
            kind: `api-retry-${distributor}`,
            command: `API_RETRY_IN_FLIGHT=1 API_RETRY_ARGS_B64=${argsB64} node ${JSON.stringify(runnerPath)}`,
            blocked_until_hours: _verdict.blockedHours,
            reason: `${distributor} ${_verdict.category}: ${_verdict.reason} on ${mpn} (${err.message.slice(0, 100)})`,
            priority: opts.priority || 'P2',
          });
        }
      } catch { /* enqueue is best-effort; never block the result path */ }
    }

    // Diagnostic log — append every failure (including in-flight retries)
    // so the digest can show a rolling 24h health summary per disty.
    try {
      const fs = require('fs');
      const home = process.env.HOME || '/home/analytics_user';
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        distributor,
        mpn,
        qty,
        errorMessage: (err.message || String(err)).slice(0, 500),
        category: _verdict?.category || 'UNCLASSIFIED',
        retry: _verdict?.retry ?? null,
        blockedHours: _verdict?.blockedHours ?? null,
        inFlightRetry: process.env.API_RETRY_IN_FLIGHT === '1',
      }) + '\n';
      fs.appendFileSync(path.join(home, 'workspace/.api-failures.ndjson'), line);
    } catch { /* logging is best-effort; never block the result path */ }

    return {
      distributor,
      name: config.name,
      found: false,
      error: err.message,
      franchiseQty: 0,
    };
  }
}

/**
 * Reconstitute a searchAllDistributors()-shaped result from a cached envelope.
 *
 * Used when the cacheTTL gate returns fresh — lets us return the same shape
 * without re-hitting any APIs. Driven by the envelope's Pricings[] array which
 * captures per-distributor data at capture time.
 *
 * Price breaks in the envelope use QtyBreak/UnitPrice; we translate back to
 * the distributor-module shape (unitPrice at requested qty, bulk = last break).
 */
function envelopeToResult(envelope, mpn, qty) {
  const pricings = envelope?.data?.Pricings || [];
  const statusArr = envelope?.data?.Status || [];

  // Status entries cover distributors that were queried but returned no pricing
  // (empty / failed). Build a distributors[] array that mirrors the live flow:
  // one entry per distributor that was checked at capture time.
  const distributorsFromPricings = pricings.map(p => {
    const breaks = (p.Pricings || []).slice().sort((a, b) => a.QtyBreak - b.QtyBreak);

    // Price at requested qty: highest break whose QtyBreak <= qty
    let vqPrice = null;
    for (let i = breaks.length - 1; i >= 0; i--) {
      if (breaks[i].QtyBreak <= qty) { vqPrice = breaks[i].UnitPrice; break; }
    }
    if (vqPrice === null && breaks.length > 0) vqPrice = breaks[0].UnitPrice;

    const bulkPrice = breaks.length > 0 ? breaks[breaks.length - 1].UnitPrice : null;
    const firstPrice = breaks.length > 0 ? breaks[0].UnitPrice : null;

    // Try to map back to a DISTRIBUTORS entry by name for bpId/bpValue.
    // Per-store cogs (Newark/Farnell, Arrow/Verical) emit SupplierName as the
    // BP NAME ('Newark in One (Element 14)'), not the parser name ('Newark/Farnell').
    // Match against either field so cache replay restores bpValue + bpId
    // — without this, vq-writer falls back to a name search and iDempiere
    // 500s on names containing parens.
    const key = Object.keys(DISTRIBUTORS).find(k =>
      DISTRIBUTORS[k].name === p.SupplierName ||
      DISTRIBUTORS[k].bpName === p.SupplierName
    );
    const cfg = key ? DISTRIBUTORS[key] : {};

    // Map cached Currency back to c_currency_id so downstream VQ writes use
    // the original quote currency (Farnell quotes in GBP — without this it
    // would silently get stamped USD on replay).
    const currencyId = p.Currency === 'GBP' ? 114 : 100;

    return {
      distributor: key || p.SupplierName,
      name: p.SupplierName,
      bpValue: cfg.bpValue,
      bpName: cfg.bpName,
      bpId: cfg.bpId,
      found: true,
      franchiseQty: p.CurrentStockQty || 0,
      franchisePrice: firstPrice,
      franchiseBulkPrice: bulkPrice,
      franchiseRfqPrice: vqPrice,
      vqPrice,
      currencyId,
      vqMpn: p.ManufacturerPartNumber || mpn,
      vqManufacturer: p.ManufacturerName || '',
      vqDescription: p.Description || '',
      vqMoq: p.MinimumBuy || null,
      vqSpq: p.Multiplier || null,
      vqVendorNotes: p.VendorNotes || '',
      vqDateCode: p.DateCode || '',
      vqPackaging: p.Packaging || '',
      vqLeadTime: p.LeadTime || '',
      vqHts: p.HTSCode || null,
      vqEccn: p.ECCN || null,
      priceBreaks: breaks.map(b => ({ qty: b.QtyBreak, unitPrice: b.UnitPrice })),
      raw: { fromCache: true, envelopeTimestamp: envelope?.data?._meta?.timestamp },
    };
  });

  // Also include status-only entries (queried but empty/failed) so downstream
  // counts like distributorsChecked stay honest.
  const pricingNames = new Set(pricings.map(p => p.SupplierName));
  const distributorsFromStatus = statusArr
    .filter(s => !pricingNames.has(s.APIName))
    .map(s => {
      const key = Object.keys(DISTRIBUTORS).find(k => DISTRIBUTORS[k].name === s.APIName);
      const cfg = key ? DISTRIBUTORS[key] : {};
      return {
        distributor: key || s.APIName,
        name: s.APIName,
        bpValue: cfg.bpValue,
        bpName: cfg.bpName,
        bpId: cfg.bpId,
        found: false,
        franchiseQty: 0,
        error: s.FailedReason || null,
        raw: { fromCache: true, envelopeTimestamp: envelope?.data?._meta?.timestamp },
      };
    });

  const results = [...distributorsFromPricings, ...distributorsFromStatus];
  const carrying = results.filter(r => r.found);
  const found = carrying.filter(r => r.franchiseQty > 0);
  const totalStock = found.reduce((sum, r) => sum + (r.franchiseQty || 0), 0);

  const catalogPrices = carrying.map(r => r.franchiseBulkPrice).filter(p => p != null && p > 0);
  const stockedPrices = found.map(r => r.franchiseBulkPrice).filter(p => p != null && p > 0);
  const sortedAsc = arr => [...arr].sort((a, b) => a - b);

  const summary = {
    mpn,
    qty,
    totalStock,
    distributorsWithStock: found.length,
    distributorsCarrying: carrying.length,
    distributorsChecked: results.length,
    lowestPrice:  catalogPrices.length > 0 ? Math.min(...catalogPrices) : null,
    highestPrice: catalogPrices.length > 0 ? Math.max(...catalogPrices) : null,
    medianPrice:  catalogPrices.length > 0 ? sortedAsc(catalogPrices)[Math.floor(catalogPrices.length / 2)] : null,
    priceSource:  catalogPrices.length === 0 ? null
                  : stockedPrices.length > 0 ? 'STOCKED' : 'CATALOG_ONLY',
    lowestStockedPrice:  stockedPrices.length > 0 ? Math.min(...stockedPrices) : null,
    highestStockedPrice: stockedPrices.length > 0 ? Math.max(...stockedPrices) : null,
    medianStockedPrice:  stockedPrices.length > 0 ? sortedAsc(stockedPrices)[Math.floor(stockedPrices.length / 2)] : null,
    coverage: totalStock >= qty ? 'FULL' : totalStock > 0 ? 'PARTIAL' : 'NONE',
    coveragePct: qty > 0 ? Math.round(totalStock / qty * 100) : 0,
    fromCache: true,
    cacheAgeDays: envelope?.data?._meta?.timestamp
      ? Math.floor((Date.now() - new Date(envelope.data._meta.timestamp).getTime()) / 86400000)
      : null,
  };

  // Build master vqLines. Most distributors emit ONE row per result. Arrow
  // splits into multiple (Arrow franchise + Verical broker channels) and
  // exposes them via r.vqLines — when present, we spread those instead of
  // collapsing the multi-source response into a single row.
  const vqLines = [];
  for (const r of found) {
    if (Array.isArray(r.vqLines) && r.vqLines.length > 0) {
      for (const sub of r.vqLines) {
        vqLines.push({
          vendorBP: sub.vendorBP,
          vendorName: sub.vendorName,
          mpn: sub.mpn,
          manufacturer: sub.manufacturer,
          cost: sub.cost,
          qty: sub.qty,
          description: sub.description,
          vendorNotes: sub.vendorNotes,
          dateCode: sub.dateCode,
          leadTime: sub.leadTime,
          moq: sub.moq,
          spq: sub.spq,
          channel: sub.channel,
          sourcePartId: sub.sourcePartId,
        });
      }
    } else if (r.vqPrice != null && r.vqPrice > 0) {
      vqLines.push({
        vendorBP: r.bpValue,
        vendorName: r.bpName,
        mpn: r.vqMpn,
        manufacturer: r.vqManufacturer,
        cost: r.vqPrice,
        qty: r.franchiseQty,
        currencyId: r.currencyId,
        description: r.vqDescription,
        vendorNotes: r.vqVendorNotes,
        dateCode: r.vqDateCode,
        leadTime: r.vqLeadTime,
        moq: r.vqMoq,
        spq: r.vqSpq,
      });
    }
  }

  return { summary, distributors: results, found, vqLines };
}

/**
 * Search ALL active distributors for a part
 * Returns aggregated results + VQ-ready lines
 *
 * Caching (see api-integration-roadmap.md § API Response Caching for TTL table):
 *   options.cacheTTL       — max age in days to reuse cached envelope (e.g., 7, 30)
 *   options.cacheBypassIf  — predicate(envelope) => bool; force refresh if true
 * When a fresh cache hit occurs, returns the same shape as a live call and the
 * summary includes { fromCache: true, cacheAgeDays }.
 */
const DEFAULT_PER_DISTRIBUTOR_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, distributor, mpn) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        distributor,
        mpn,
        found: false,
        franchiseQty: 0,
        errorState: 'timeout',
        errorMessage: `Timed out after ${ms}ms`,
        timedOut: true,
      });
    }, ms);
  });
  return Promise.race([
    promise.then(r => { clearTimeout(timer); return r; }),
    timeout,
  ]);
}

async function searchAllDistributors(mpn, qty, options = {}) {
  const {
    parallel = true, exclude = [], onResult = null,
    cacheTTL = null, cacheBypassIf = null, mfr = null,
    priority = null,
    cacheOnly = false,
    perDistributorTimeoutMs = DEFAULT_PER_DISTRIBUTOR_TIMEOUT_MS,
  } = options;
  // `mfr` — the searched MFR (typically the RFQ's MFR text). When provided,
  // each distributor's parser applies the MFR veto via shared/mpn-match.js,
  // rejecting candidates whose MFR resolves to MISMATCH. Opt-in — existing
  // callers that don't pass mfr get the old behavior (MPN match only, no veto).
  //
  // `priority` — 'P1' | 'P2' | 'P3' from rfq-priority.assignPriority(). Threaded
  // through to searchPart's opts so that on retry-enqueue, the queue item is
  // tagged with the originating RFQ's dispatch priority. process-api-queue.js
  // then sorts retries P1 → P2 → P3 so small RFQs / user-waiting work doesn't
  // queue behind P3 backlog drain.
  const perCallOpts = {};
  if (mfr) perCallOpts.mfr = mfr;
  if (priority) perCallOpts.priority = priority;

  // ── Cache gate ───────────────────────────────────────────────────────────
  // If caller supplied a cacheTTL, consult getFreshness() first. On a hit we
  // return immediately without touching any distributor APIs — this is the
  // primary rate-limit saver for the RFQ API Enrichment cron workflow.
  if (cacheTTL && cacheTTL > 0) {
    try {
      const { getFreshness } = require('./api-result-writer');
      const check = getFreshness(mpn, cacheTTL, { bypassIf: cacheBypassIf });
      if (check.fresh && check.envelope) {
        return envelopeToResult(check.envelope, mpn, qty);
      }
    } catch (err) {
      // Freshness lookup must never break a live call — just log and proceed.
      // eslint-disable-next-line no-console
      console.error(`[franchise-api] freshness lookup failed for ${mpn}: ${err.message}`);
    }
  }

  // cacheOnly mode — caller (e.g., large-RFQ gate "YES --cache-only" approval)
  // wants to skip live API calls entirely. If we got past the cache gate
  // without returning, there's no fresh envelope. Return an empty-coverage
  // result so the caller's writer skips this line cleanly.
  if (cacheOnly) {
    return {
      mpn, qty,
      found: [],
      distributors: [],
      summary: { coverage: 'NONE', fromCache: false, cacheOnlyMiss: true },
    };
  }

  const activeDistributors = Object.keys(DISTRIBUTORS)
    .filter(d => DISTRIBUTORS[d].active && !exclude.includes(d));

  let results;
  if (parallel) {
    // Run all APIs concurrently; each wrapped in a hard timeout so a single
    // stuck distributor can't hang the entire MPN. Observed 2026-04-14: a
    // single API call hung for 23h on RFQ 1132340 because there was no
    // timeout anywhere in the stack.
    results = await Promise.all(
      activeDistributors.map(async (d) => {
        const result = await withTimeout(
          searchPart(d, mpn, qty, perCallOpts),
          perDistributorTimeoutMs, d, mpn,
        );
        if (onResult) onResult(result);
        return result;
      })
    );
  } else {
    // Sequential (for rate-limit-sensitive scenarios)
    results = [];
    for (const d of activeDistributors) {
      const result = await withTimeout(
        searchPart(d, mpn, qty, perCallOpts),
        perDistributorTimeoutMs, d, mpn,
      );
      if (onResult) onResult(result);
      results.push(result);
    }
  }

  // Aggregate.
  // Three populations matter for downstream classification:
  //   - distributorsChecked: how many we asked (always = active count)
  //   - distributorsCarrying: how many returned ANY catalog entry (r.found === true), regardless of stock
  //   - distributorsWithStock: subset of carrying that have stock > 0
  // The carrying-vs-with-stock distinction lets callers distinguish "real
  // scarcity" (carrying > 0, with-stock = 0) from "not in franchise universe"
  // (carrying = 0). See market-offer-analysis.md § Step 3a three-state model.
  const carrying = results.filter(r => r.found);
  const found = carrying.filter(r => r.franchiseQty > 0);
  const totalStock = found.reduce((sum, r) => sum + (r.franchiseQty || 0), 0);

  // ── Per-distributor health flag ──────────────────────────────────────────
  // Surface "this distributor seems off" signals to the caller so they can
  // notice rate-limit issues without having to inspect the Bucket A queue.
  // Two heuristics:
  //   1. Did the distributor throw an error (errorState set on result)?
  //   2. Did the distributor return found=false unexpectedly? Single-call
  //      detection isn't reliable (could be legit), but at the BATCH level,
  //      a distributor returning empty for >70% of MPNs is a strong signal
  //      they're rate-limited or broken. (This is the same logic as
  //      digikey.js silent-throttle detection but applied at the per-call
  //      aggregation level for ALL distributors.)
  // The caller (or wrapping cron job) can log or surface these warnings.
  const distributorHealth = results.reduce((acc, r) => {
    const name = r.name || r.distributor;
    if (!name) return acc;
    if (!acc[name]) acc[name] = { errors: 0, empties: 0, found: 0, timeouts: 0 };
    if (r.timedOut) acc[name].timeouts++;
    else if (r.error) acc[name].errors++;
    else if (!r.found) acc[name].empties++;
    else acc[name].found++;
    return acc;
  }, {});

  // Build warnings list — distributors that errored, OR returned empty
  // for everything we asked them. (Single-MPN searches will always show
  // 100% empty for distributors that don't carry the part — these warnings
  // are most useful at the BATCH level via aggregateBatchHealth() below.)
  const warnings = [];
  for (const [name, h] of Object.entries(distributorHealth)) {
    if (h.errors > 0) {
      warnings.push(`${name}: errored (${h.errors})`);
    }
  }

  // Pricing — capture across ALL carrying distributors, not just stocked.
  // Most distributor APIs (DigiKey, Mouser, Arrow, TTI) return catalog price
  // even when stock = 0; throwing those away wastes the most valuable signal
  // for FRANCHISE_OUT_OF_STOCK scoring. We expose two views:
  //   - lowestPrice / highestPrice / medianPrice: across ALL carrying distributors
  //     (stocked or not). This is what scoring should use.
  //   - lowestStockedPrice etc.: legacy "stock > 0 only" view, retained for any
  //     caller that genuinely needs it (e.g., immediate-fulfillment quoting).
  const catalogPrices = carrying.map(r => r.franchiseBulkPrice).filter(p => p != null && p > 0);
  const stockedPrices = found.map(r => r.franchiseBulkPrice).filter(p => p != null && p > 0);
  const sortedAsc = arr => [...arr].sort((a, b) => a - b);

  const summary = {
    mpn,
    qty,
    totalStock,
    distributorsWithStock: found.length,
    distributorsCarrying: carrying.length,
    distributorsChecked: results.length,
    // PRIMARY pricing — across all carrying distributors (stocked or catalog-only)
    lowestPrice:  catalogPrices.length > 0 ? Math.min(...catalogPrices) : null,
    highestPrice: catalogPrices.length > 0 ? Math.max(...catalogPrices) : null,
    medianPrice:  catalogPrices.length > 0 ? sortedAsc(catalogPrices)[Math.floor(catalogPrices.length / 2)] : null,
    priceSource:  catalogPrices.length === 0 ? null
                  : stockedPrices.length > 0 ? 'STOCKED' : 'CATALOG_ONLY',
    // Stocked-only view (legacy semantic)
    lowestStockedPrice:  stockedPrices.length > 0 ? Math.min(...stockedPrices) : null,
    highestStockedPrice: stockedPrices.length > 0 ? Math.max(...stockedPrices) : null,
    medianStockedPrice:  stockedPrices.length > 0 ? sortedAsc(stockedPrices)[Math.floor(stockedPrices.length / 2)] : null,
    // Availability assessment
    coverage: totalStock >= qty ? 'FULL' : totalStock > 0 ? 'PARTIAL' : 'NONE',
    coveragePct: qty > 0 ? Math.round(totalStock / qty * 100) : 0,
    // Health signals — populated when individual distributors errored
    // (rate-limited, network failure, etc.). Empty array = clean run.
    distributorWarnings: warnings,
    distributorHealth, // per-distributor counts {errors, empties, found}
  };

  // Generate VQ lines for each distributor with stock+pricing (API data = confirmed → log as VQ)
  // Build master vqLines. Most distributors emit ONE row per result. Arrow
  // splits into multiple (Arrow franchise + Verical broker channels) and
  // exposes them via r.vqLines — when present, we spread those instead of
  // collapsing the multi-source response into a single row.
  const vqLines = [];
  for (const r of found) {
    if (Array.isArray(r.vqLines) && r.vqLines.length > 0) {
      for (const sub of r.vqLines) {
        vqLines.push({
          vendorBP: sub.vendorBP,
          vendorName: sub.vendorName,
          mpn: sub.mpn,
          manufacturer: sub.manufacturer,
          cost: sub.cost,
          qty: sub.qty,
          description: sub.description,
          vendorNotes: sub.vendorNotes,
          dateCode: sub.dateCode,
          leadTime: sub.leadTime,
          moq: sub.moq,
          spq: sub.spq,
          channel: sub.channel,
          sourcePartId: sub.sourcePartId,
        });
      }
    } else if (r.vqPrice != null && r.vqPrice > 0) {
      vqLines.push({
        vendorBP: r.bpValue,
        vendorName: r.bpName,
        mpn: r.vqMpn,
        manufacturer: r.vqManufacturer,
        cost: r.vqPrice,
        qty: r.franchiseQty,
        description: r.vqDescription,
        vendorNotes: r.vqVendorNotes,
        dateCode: r.vqDateCode,
        leadTime: r.vqLeadTime,
        moq: r.vqMoq,
        spq: r.vqSpq,
      });
    }
  }

  return {
    summary,
    distributors: results,
    found,
    vqLines,
  };
}

/**
 * Aggregate per-distributor health across a BATCH of searchAllDistributors
 * results. Used by cron-driven workflows to detect batch-level patterns
 * (e.g., DigiKey returning empty for >70% of MPNs in this batch suggests
 * silent throttling, even though no single call errored).
 *
 * USAGE:
 *
 *   const batchResults = [];
 *   for (const mpn of mpns) {
 *     batchResults.push(await searchAllDistributors(mpn, qty));
 *   }
 *   const health = aggregateBatchHealth(batchResults);
 *   for (const w of health.warnings) {
 *     logger.warn('Distributor health: ' + w);
 *     // Optional: enqueue affected MPNs for retry, send notification, etc.
 *   }
 *
 * @param {Array<object>} batchResults - Array of searchAllDistributors() return values
 * @param {object} [opts]
 * @param {number} [opts.suspiciousEmptyRate=0.7] - Empty rate above which a distributor is flagged
 * @param {number} [opts.minCalls=5] - Minimum batch size before flagging
 * @returns {{ perDistributor: object, warnings: string[] }}
 */
function aggregateBatchHealth(batchResults, opts = {}) {
  const SUSPICIOUS_EMPTY_RATE = opts.suspiciousEmptyRate || 0.7;
  const MIN_CALLS = opts.minCalls || 5;

  // Sum per-distributor counters across the batch
  const perDistributor = {};
  for (const result of batchResults) {
    if (!result || !result.summary || !result.summary.distributorHealth) continue;
    for (const [name, h] of Object.entries(result.summary.distributorHealth)) {
      if (!perDistributor[name]) perDistributor[name] = { errors: 0, empties: 0, found: 0 };
      perDistributor[name].errors += h.errors || 0;
      perDistributor[name].empties += h.empties || 0;
      perDistributor[name].found += h.found || 0;
    }
  }

  const warnings = [];
  for (const [name, h] of Object.entries(perDistributor)) {
    const total = h.errors + h.empties + h.found;
    if (total < MIN_CALLS) continue;

    if (h.errors > 0) {
      const errorRate = (h.errors / total * 100).toFixed(0);
      warnings.push(`${name}: ${h.errors}/${total} calls errored (${errorRate}%)`);
    }

    const nonError = h.empties + h.found;
    if (nonError >= MIN_CALLS) {
      const emptyRate = h.empties / nonError;
      if (emptyRate >= SUSPICIOUS_EMPTY_RATE) {
        const pct = (emptyRate * 100).toFixed(0);
        warnings.push(`${name}: ${h.empties}/${nonError} non-error calls returned empty (${pct}% empty rate — possible silent throttling)`);
      }
    }
  }

  return { perDistributor, warnings };
}

/**
 * Get list of active distributors
 */
function getActiveDistributors() {
  return Object.entries(DISTRIBUTORS)
    .filter(([, v]) => v.active)
    .map(([key, v]) => ({ key, ...v }));
}

/**
 * BP IDs Claude has API coverage for — includes actively queried distributors
 * AND surfaced-via-another-API distributors (Verical via Arrow, Farnell via
 * Newark). Used by the ROI tracker to distinguish "Claude calls this vendor
 * but missed the part" from "Claude doesn't call this distributor at all."
 *
 * Source of truth is the DISTRIBUTORS map above. Add/remove entries there;
 * this helper recomputes from that.
 */
function getApiCoverageBps() {
  return Object.values(DISTRIBUTORS)
    .filter(d => d.bpId)
    .map(d => d.bpId);
}

/**
 * Write VQ capture file from search results
 */
function writeVQCapture(filePath, vqLines) {
  const fs = require('fs');
  if (vqLines.length === 0) return null;

  const header = 'Vendor BP,Vendor Name,MPN,Manufacturer,Cost,Qty Available,Description,Vendor Notes,Date Code,Lead Time,MOQ,SPQ';
  const rows = vqLines.map(v => [
    v.vendorBP,
    `"${v.vendorName}"`,
    `"${v.mpn}"`,
    `"${v.manufacturer}"`,
    v.cost,
    v.qty,
    `"${v.description}"`,
    `"${v.vendorNotes}"`,
    `"${v.dateCode || ''}"`,
    `"${v.leadTime || ''}"`,
    v.moq || '',
    v.spq || '',
  ].join(','));

  fs.writeFileSync(filePath, [header, ...rows].join('\n') + '\n');
  return filePath;
}

/**
 * Public extractor: take a single distributor result (as returned by
 * searchAllDistributors().distributors[i]) plus mpn + rfq qty, and return
 * the normalized stock and/or lead-time rows the same way the VQ writer
 * does internally.
 *
 * Use this in any consumer that needs the "what's the right cost at this
 * qty break, and what's the stock vs LT split" — DO NOT roll your own
 * field access (`d.franchiseRfqPrice || d.vqPrice` etc) in caller code.
 *
 * Returns null if the distributor has nothing to quote (no stock, no LT).
 *
 * Each row in the returned array has:
 *   {
 *     vendorBP, vendorName, channel,
 *     mpn, manufacturer, description,
 *     qty,           // stock qty for stock row, rfq qty for LT row
 *     cost,          // unit price at the correct qty-break tier
 *     moq, spq,
 *     dateCode,
 *     leadTime,      // null for stock row, string for LT row
 *     vendorNotes,
 *     priceBreaks,   // full break ladder for downstream display
 *   }
 *
 * Consumers SHOULD also surface row-level fields they need (vqHts, vqEccn,
 * vqRohs, vqCooCountryId, vqPackaging) directly off the distributor result —
 * those are not part of the row shape because they're attributes of the
 * distributor's quote, not the stock-vs-LT split.
 */
function extractStockAndLtRows(distributorResult, mpn, qty) {
  if (!distributorResult || !distributorResult.found) return null;

  // If the distributor module already produced its own vqLines (arrow.js does
  // this for the Arrow + Verical multi-source split), return those directly.
  // The shape matches what synthesizeStockLtVqLines produces, so callers
  // can treat both paths uniformly.
  if (Array.isArray(distributorResult.vqLines) && distributorResult.vqLines.length > 0) {
    return distributorResult.vqLines;
  }

  const config = {
    name: distributorResult.name,
    bpValue: distributorResult.bpValue,
    bpName: distributorResult.bpName,
  };
  return synthesizeStockLtVqLines(distributorResult, mpn, qty, config);
}

module.exports = {
  searchPart,
  searchAllDistributors,
  aggregateBatchHealth,
  getActiveDistributors,
  getApiCoverageBps,
  writeVQCapture,
  DISTRIBUTORS,
  // Centralized parsing primitives — use these instead of rolling your own
  // field-access patterns in caller code (per architectural guidance 2026-04-09).
  extractStockAndLtRows,
  synthesizeStockLtVqLines,
  priceAtQty,
};
