/**
 * Arrow API Integration — Multi-Source Parser
 *
 * Uses Arrow Pricing & Availability API v4
 * Auth: Query parameters (login + apikey)
 *
 * Channel split (2026-04-09 fix):
 *   Arrow's API returns inventory under TWO webSite trees: `arrow.com` (Arrow
 *   franchise: Europe / Americas / APAC) and `Verical.com` (Verical broker).
 *   The parser:
 *     1. Walks every sourcePart across both trees.
 *     2. Drops `arrow.com` rows whose sourcePartId starts with "V" — these
 *        are Verical mirrors that the API double-publishes under arrow.com,
 *        causing 2x stock counts in the legacy parser.
 *     3. Classifies the remainder as 'Arrow' (Europe/Americas/APAC) or
 *        'Verical' channel.
 *     4. For each source-with-stock, computes price-at-qty bounded by
 *        on-hand stock (a $2 break at qty>=240 is unreachable from a 120pcs
 *        lot — the legacy parser surfaced these as "best bulk price").
 *     5. Emits one entry per qualifying source into `vqLines[]`, tagged
 *        with the right vendor BP. franchise-api spreads these into the
 *        master vqLines so each opportunity is surfaced and actionable.
 *
 * Top-level legacy fields (`franchiseQty`, `franchiseBulkPrice`, etc.) reflect
 * ARROW franchise only — Verical no longer leaks into screening. Verical
 * stock/price are exposed as `vericalQty`/`vericalBestPrice` for callers
 * that want a single number for the broker channel.
 */

const https = require('https');

// Arrow API Configuration
const ARROW_CONFIG = {
  login: process.env.ARROW_LOGIN || 'astutegroup1',
  apiKey: process.env.ARROW_API_KEY || 'fe8176be3335c19ce3d5f82cc8a06b21d04e62354e137b60994f4a95190a6d76',
  baseUrl: 'api.arrow.com',
  searchPath: '/itemservice/v4/en/search/token',

  // iDempiere Business Partner — Arrow franchise channel
  bpId: 1000386,
  bpValue: '1002390',
  bpName: 'Arrow Electronics',

  // iDempiere Business Partner — Verical broker channel (Arrow's marketplace arm)
  vericalBpId: 1001436,
  vericalBpValue: '1003440',
  vericalBpName: 'Verical',
};

/**
 * Search Arrow for a part number
 * @param {string} mpn - Manufacturer part number
 * @param {number} rfqQty - Customer requested quantity (for price break selection)
 * @returns {Object} Screening and VQ data
 */
async function searchPart(mpn, rfqQty = 1, searchOptions = {}) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      login: ARROW_CONFIG.login,
      apikey: ARROW_CONFIG.apiKey,
      search_token: mpn,
      rows: 5,  // Get top matches
    }).toString();

    const options = {
      hostname: ARROW_CONFIG.baseUrl,
      path: `${ARROW_CONFIG.searchPath}?${queryParams}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = parseSearchResults(json, mpn, rfqQty, searchOptions);
          resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse Arrow search results.
 *
 * Returns: {
 *   ...legacy top-level fields (Arrow franchise only),
 *   vqLines: [{vendorBP, vendorName, channel, mpn, ...}, ...]  // one per source-with-stock
 * }
 */
function parseSearchResults(json, searchMpn, rfqQty, searchOptions = {}) {
  const result = {
    searchMpn,
    rfqQty,
    found: false,
    // Screening fields — ARROW FRANCHISE ONLY (Verical excluded)
    franchiseQty: 0,
    franchisePrice: null,
    franchiseBulkPrice: null,
    franchiseRfqPrice: null,
    opportunityValue: null,
    // Verical channel — separate so screening doesn't conflate
    vericalQty: 0,
    vericalBestPrice: null,
    // Legacy single-VQ fields (best Arrow source — kept for backwards-compat)
    vqPrice: null,
    vqVendorNotes: null,
    vqMpn: null,
    vqDescription: null,
    vqManufacturer: null,
    vqDateCode: null,
    vqLeadTime: null,
    vqMoq: null,
    vqSpq: null,
    vqArrowSourcePartId: null,
    vqSourceType: null,
    priceBreaks: [],
    // NEW: per-source VQ rows — Arrow + Verical, one entry per real source-with-stock
    vqLines: [],
    // Diagnostic
    allSources: [],
    droppedMirrorSources: [],
  };

  const data = json?.itemserviceresult?.data?.[0];
  if (!data || !data.PartList || data.PartList.length === 0) return result;

  // Pick best part-level match. Restrict to MPN matches (exact or
  // packaging-suffix variant). Never fall back to PartList[0] — see
  // shared/mpn-match.js.
  const { pickBestCandidate } = require('../../../shared/mpn-match');
  const picked = pickBestCandidate(data.PartList, {
    getMpn: p => p.partNum,
    getMfr: p => p.manufacturer?.mfrName,
    getStock: () => 0,  // Arrow stock is per-source under InvOrg, not part-level
    searched: searchMpn,
    opts: { mfr: searchOptions?.mfr },
  });
  if (!picked) return result;
  const bestMatch = picked.candidate;
  result.matchType = picked.matchType;

  result.vqMpn = bestMatch.partNum;
  result.vqDescription = bestMatch.desc || '';
  result.vqManufacturer = bestMatch.manufacturer?.mfrName || '';

  const invOrg = bestMatch.InvOrg;
  if (!invOrg || !invOrg.webSites) return result;

  // ── Walk every sourcePart, classify, dedup ────────────────────────────────
  // Channel rules:
  //   webSite.code === 'Verical.com'  → 'Verical'
  //   webSite.code === 'arrow.com' AND sourcePartId starts with 'V'
  //                                   → DROP (Verical mirror, dup of Verical.com row)
  //   webSite.code === 'arrow.com' AND any other prefix  → 'Arrow'
  const candidates = [];
  for (const website of invOrg.webSites) {
    const websiteCode = website.code;
    for (const source of website.sources || []) {
      for (const sp of source.sourceParts || []) {
        const fohQty = sp.Availability?.[0]?.fohQty || 0;
        const priceList = (sp.Prices?.resaleList || [])
          .slice()
          .sort((a, b) => a.minQty - b.minQty);

        const sourcePartId = sp.sourcePartId || '';
        const isVericalMirrorOnArrowTree =
          websiteCode === 'arrow.com' && /^V/i.test(sourcePartId);

        // Diagnostic: capture every sourcePart we saw, even dropped ones
        const diag = {
          website: websiteCode,
          source: source.displayName,
          sourcePartId,
          fohQty,
          firstPrice: priceList[0]?.price ?? null,
          lastPrice: priceList[priceList.length - 1]?.price ?? null,
          dateCode: sp.dateCode || null,
          shipsFrom: sp.shipsFrom || null,
        };
        result.allSources.push(diag);

        if (isVericalMirrorOnArrowTree) {
          result.droppedMirrorSources.push(diag);
          continue;
        }

        const channel = websiteCode === 'Verical.com' ? 'Verical' : 'Arrow';

        candidates.push({
          channel,
          regionLabel: source.displayName,
          sourcePartId,
          fohQty,
          priceList,
          dateCode: sp.dateCode || null,
          shipsFrom: sp.shipsFrom || null,
          arrowLeadTime: sp.arrowLeadTime,
          mfrLeadTime: sp.mfrLeadTime,
          moq: sp.minimumOrderQuantity || null,
          spq: sp.packSize || null,
          rawSourcePart: sp,
        });
      }
    }
  }

  // ── Cross-channel duplicate detection ─────────────────────────────────────
  // Arrow's API sometimes lists the same physical inventory under both
  // channels — Arrow Europe direct AND a Verical broker mirror — when the
  // sourcePartId-prefix dedup (V* on arrow.com) doesn't catch it. The
  // remaining duplicates show up as separate sourceParts that share:
  //
  //   - identical fohQty
  //   - identical shipsFrom region
  //   - identical price-break ladder structure (same minQty values)
  //   - prices within ~2% on every break (channel markup spread)
  //
  // Example seen on IMZ120R030M1H: Verical sp[3] (88769791, Netherlands, 150)
  // and Arrow Europe sp[0] (E02:0323_13903138, Netherlands, 150) share an
  // identical 5-tier ladder with ~0.09% spread on every break — same pile of
  // parts, different sale channel.
  //
  // We do NOT auto-drop these — the buyer may have a procurement preference
  // (Arrow franchise vs Verical broker on the same stock). Instead we tag
  // both rows with a possibleDupOf cross-reference and a note. Lets the
  // human decide whether to consolidate.
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (likelyDuplicateLot(a, b)) {
        a.possibleDupOf = b.sourcePartId;
        a.possibleDupChannel = b.channel;
        b.possibleDupOf = a.sourcePartId;
        b.possibleDupChannel = a.channel;
      }
    }
  }

  // ── Build vqLines: one row per source-with-stock ──────────────────────────
  // Pricing constraint: a price tier only counts if it's reachable from the
  // on-hand quantity. The legacy parser surfaced "qty>=240 $2.069" from a 120pc
  // lot as the bulk price — that's a lie because you can't buy 240 from a
  // lot of 120. priceForBuy() enforces minQty ≤ buyQty.
  //
  // Two-phase pricing:
  //   Phase 1 — try the buyer's requested qty (capped at lot stock). Standard
  //             case for any lot whose tiers ladder cleanly down from qty 1.
  //   Phase 2 — fallback for lots whose ONLY tiers require more than rfqQty
  //             but are achievable from the lot itself (e.g. fohQty=120, sole
  //             tier qty>=120 $2.069). Surface the lot at the cheapest reachable
  //             tier; flag with `requiresBumpQty` so the buyer sees they'd need
  //             to take 120 instead of 100 to unlock that price. These are real
  //             opportunities — silently dropping them was the bug.
  for (const c of candidates) {
    if (c.fohQty <= 0 || c.priceList.length === 0) continue;

    let buyQty = Math.min(rfqQty, c.fohQty);
    let unitPrice = priceForBuy(c.priceList, buyQty);
    let requiresBumpQty = false;
    let bumpFromQty = null;

    if (unitPrice == null) {
      // No tier unlocked at the customer's requested qty.
      // Look for the cheapest tier that the LOT itself can unlock (minQty ≤ fohQty).
      const reachable = c.priceList.filter(t => t.minQty <= c.fohQty);
      if (reachable.length > 0) {
        const cheapest = reachable.reduce((a, b) => (a.price <= b.price ? a : b));
        unitPrice = cheapest.price;
        // To unlock this tier the buyer must take at least cheapest.minQty units;
        // they get whatever's on hand up to fohQty. Surface buyQty = the bump
        // target so vq-writer's Qty field reflects "this is the deal size".
        buyQty = Math.min(c.fohQty, Math.max(cheapest.minQty, 1));
        requiresBumpQty = buyQty > rfqQty;
        bumpFromQty = requiresBumpQty ? rfqQty : null;
      }
    }

    if (unitPrice == null) continue;

    // "achievable bulk price" = cheapest tier the lot can unlock
    const achievableBulk = priceForBuy(c.priceList, c.fohQty);
    // Lead time only meaningful when fohQty=0; for stocked rows we suppress it.
    const leadTime = null;

    const vendorBP = c.channel === 'Verical' ? ARROW_CONFIG.vericalBpValue : ARROW_CONFIG.bpValue;
    const vendorName = c.channel === 'Verical' ? ARROW_CONFIG.vericalBpName : ARROW_CONFIG.bpName;

    // Vendor notes go into Chuboe_Note_Public on the VQ row. Two facts must
    // land there because they change how a buyer reads the price:
    //
    //   1. STOCK ONLY (Verical / broker channel) — the quoted price applies
    //      only to the on-hand lot. Verical is Arrow's broker marketplace, not
    //      franchise; there's no lead-time fulfillment at this price. Without
    //      this tag the buyer can't tell whether the price scales.
    //
    //   2. MIN BUY — bump-tier case (lot's only achievable tier requires more
    //      than rfqQty). Note text is for human reading; the structured value
    //      also goes into the MOQ field below so OT's MOQ column reflects the
    //      tier minimum.
    //
    // % of demand is NOT recorded here — Vortex Matches calculates it on the
    // output side from VQ.qty / RFQ.qty.
    const noteParts = [];
    if (c.channel === 'Verical') {
      noteParts.push(`STOCK ONLY`);
    }
    const regionStr = c.regionLabel && c.regionLabel !== c.channel
      ? `${c.channel} ${c.regionLabel}`
      : c.channel;
    noteParts.push(regionStr);
    if (requiresBumpQty) {
      noteParts.push(`MIN BUY ${buyQty.toLocaleString()} for $${unitPrice}`);
    }
    if (c.possibleDupOf) {
      noteParts.push(`LIKELY SAME LOT as ${c.possibleDupChannel} ${c.possibleDupOf}`);
    }
    if (c.dateCode) noteParts.push(`DC: ${c.dateCode}`);
    if (c.shipsFrom) noteParts.push(`ships: ${c.shipsFrom}`);
    noteParts.push(`src: ${c.sourcePartId}`);

    // MOQ: when the lot is tier-locked, the bump qty IS the minimum order
    // quantity for the surfaced price. Override Arrow's minimumOrderQuantity
    // (which is the API's default MOQ, often 1) so OT's MOQ column carries
    // the actionable number.
    const effectiveMoq = requiresBumpQty ? buyQty : c.moq;

    result.vqLines.push({
      vendorBP,
      vendorName,
      channel: c.channel,
      mpn: result.vqMpn,
      manufacturer: result.vqManufacturer,
      description: result.vqDescription,
      // Qty represents the deal size: lot stock for normal lots, or the
      // bump-to-tier qty when the lot's only achievable tier requires more
      // than rfqQty. Either way, this is what the supplier is offering at
      // `cost` per unit. Vortex Matches divides this by RFQ qty to get
      // % of demand on its own; we don't precompute it here.
      qty: requiresBumpQty ? buyQty : c.fohQty,
      cost: unitPrice,
      // MOQ — for tier-locked bump lots this is the bump qty (the price's
      // minimum order); for normal lots it's whatever Arrow's API reported.
      moq: effectiveMoq,
      spq: c.spq,
      // Diagnostic fields used by the parser test harness; not written to OT.
      lotQty: c.fohQty,
      bulkPrice: achievableBulk,
      requiresBumpQty,
      dateCode: c.dateCode,
      leadTime,
      shipsFrom: c.shipsFrom,
      sourcePartId: c.sourcePartId,
      vendorNotes: noteParts.join(' | '),
      priceBreaks: c.priceList.map(p => ({ qty: p.minQty, unitPrice: p.price })),
    });
  }

  // ── Aggregate top-level (legacy) fields ───────────────────────────────────
  // franchiseQty / franchiseBulkPrice / franchiseRfqPrice = ARROW ONLY.
  // Verical surfaced separately as vericalQty / vericalBestPrice.
  const arrowLines = result.vqLines.filter(v => v.channel === 'Arrow');
  const vericalLines = result.vqLines.filter(v => v.channel === 'Verical');

  result.franchiseQty = arrowLines.reduce((s, v) => s + v.qty, 0);
  result.vericalQty = vericalLines.reduce((s, v) => s + v.qty, 0);

  if (arrowLines.length > 0) {
    // "best Arrow source" by lowest cost-at-rfqQty
    const bestArrow = arrowLines.slice().sort((a, b) => a.cost - b.cost)[0];
    result.found = true;
    result.franchisePrice = bestArrow.priceBreaks[0]?.unitPrice ?? null;
    result.franchiseBulkPrice = bestArrow.bulkPrice;
    result.franchiseRfqPrice = bestArrow.cost;
    result.vqPrice = bestArrow.cost;
    result.vqMoq = bestArrow.moq;
    result.vqSpq = bestArrow.spq;
    result.vqDateCode = bestArrow.dateCode;
    result.vqLeadTime = null;
    result.vqSourceType = 'Arrow';
    result.vqArrowSourcePartId = bestArrow.sourcePartId;
    result.priceBreaks = bestArrow.priceBreaks;
    result.opportunityValue = bestArrow.cost * rfqQty;
    result.vqVendorNotes = bestArrow.vendorNotes;
  } else if (vericalLines.length > 0) {
    // No Arrow franchise — surface best Verical so legacy single-VQ consumers
    // still see something. Mark sourceType so they know it's broker channel.
    const bestVerical = vericalLines.slice().sort((a, b) => a.cost - b.cost)[0];
    result.found = true;
    result.franchisePrice = null;          // not Arrow franchise
    result.franchiseBulkPrice = null;
    result.franchiseRfqPrice = null;
    result.vqPrice = bestVerical.cost;
    result.vqDateCode = bestVerical.dateCode;
    result.vqMoq = bestVerical.moq;
    result.vqSpq = bestVerical.spq;
    result.vqSourceType = 'Verical';
    result.vqArrowSourcePartId = bestVerical.sourcePartId;
    result.priceBreaks = bestVerical.priceBreaks;
    result.opportunityValue = bestVerical.cost * rfqQty;
    result.vqVendorNotes = bestVerical.vendorNotes;
  }

  if (vericalLines.length > 0) {
    result.vericalBestPrice = Math.min(...vericalLines.map(v => v.cost));
  }

  return result;
}

/**
 * Heuristic: do these two source-parts look like the same physical lot sold
 * under different channels (Arrow Europe direct vs Verical broker mirror)?
 *
 * Returns true when:
 *   - opposite channels
 *   - identical on-hand qty
 *   - identical shipsFrom region
 *   - identical ladder structure (same length AND same minQty per tier)
 *   - prices within 2% on every tier
 *
 * The 2% threshold accommodates the typical broker-channel markup spread
 * (observed ~0.09% on IMZ120R030M1H, but anything under a few percent is
 * almost certainly the same pile of parts).
 */
function likelyDuplicateLot(a, b) {
  if (a.channel === b.channel) return false;
  if (a.fohQty !== b.fohQty) return false;
  if ((a.shipsFrom || '') !== (b.shipsFrom || '')) return false;
  if (!a.priceList || !b.priceList) return false;
  if (a.priceList.length !== b.priceList.length) return false;
  if (a.priceList.length === 0) return false;
  for (let i = 0; i < a.priceList.length; i++) {
    if (a.priceList[i].minQty !== b.priceList[i].minQty) return false;
    const pa = a.priceList[i].price;
    const pb = b.priceList[i].price;
    if (pa <= 0 || pb <= 0) return false;
    const spread = Math.abs(pa - pb) / Math.max(pa, pb);
    if (spread > 0.02) return false;
  }
  return true;
}

/**
 * Pick the unit price for buying `buyQty` units, given a sorted price-break list.
 * Returns the price at the highest tier whose minQty <= buyQty.
 *
 * Critical rule: the legacy parser would return the lowest-tier price regardless
 * of whether buyQty actually unlocked that tier. A 120-piece lot can NOT buy at
 * a "qty>=240" tier — that price is unreachable. This function enforces the
 * constraint, so what you see is what you can actually pay.
 */
function priceForBuy(priceList, buyQty) {
  if (!priceList || priceList.length === 0 || buyQty <= 0) return null;
  let chosen = null;
  for (const tier of priceList) {
    if (tier.minQty <= buyQty) chosen = tier;
    else break;
  }
  return chosen?.price ?? null;
}

/**
 * Normalize MPN for comparison (remove dashes, spaces, case-insensitive)
 */
function normalizeMpn(mpn) {
  if (!mpn) return '';
  return mpn.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Search multiple parts
 * @param {Array} parts - Array of {mpn, qty} objects
 * @param {number} delayMs - Delay between requests (rate limiting)
 */
async function searchParts(parts, delayMs = 300) {
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { mpn, qty } = parts[i];

    try {
      const result = await searchPart(mpn, qty || 1);
      results.push(result);
      console.log(`[${i + 1}/${parts.length}] ${mpn}: ${result.found ? `${result.franchiseQty} @ $${result.vqPrice}` : 'Not found'}`);
    } catch (error) {
      console.error(`[${i + 1}/${parts.length}] ${mpn}: Error - ${error.message}`);
      results.push({
        searchMpn: mpn,
        rfqQty: qty,
        found: false,
        error: error.message,
      });
    }

    // Rate limiting
    if (i < parts.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// Export for use in other modules
module.exports = {
  ARROW_CONFIG,
  searchPart,
  searchParts,
  normalizeMpn,
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node arrow.js <MPN> [qty]');
    console.log('Example: node arrow.js LM317T 100');
    process.exit(1);
  }

  const mpn = args[0];
  const qty = parseInt(args[1]) || 1;

  searchPart(mpn, qty)
    .then(result => {
      console.log('\n=== Arrow Search Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
