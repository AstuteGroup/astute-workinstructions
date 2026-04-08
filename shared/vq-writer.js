/**
 * VQ Writer — writes franchise API results as Chuboe_VQ_Line records via iDempiere REST API
 *
 * Resolves BP IDs by search key at runtime (environment-agnostic).
 * Resolves MFR IDs via shared/mfr-lookup.js (cached from production DB).
 * Flags low-confidence matches for review instead of silently writing bad data.
 *
 * USAGE:
 *   const { writeVQFromAPI, writeVQBatch } = require('../shared/vq-writer');
 *
 *   // Single MPN — write franchise results as VQ lines
 *   const result = await writeVQFromAPI(rfqSearchKey, cpc, franchiseResults);
 *   // result = { written: [...], flagged: [...], failed: [...] }
 *
 *   // Batch — write VQ lines for multiple MPNs
 *   const result = await writeVQBatch(rfqSearchKey, items);
 *   // items = [{ cpc, mpn, franchiseResults }, ...]
 *
 * CONSUMERS:
 *   - LAM EPG Award purchasing flow
 *   - Stock RFQ → VQ pipeline (future)
 *   - LAM Kitting reorder sourcing (future)
 */

const { apiGet, apiPost, resolveBP, resolveBPBatch, resolveMFR } = require('./api-client');
const { lookupMfr } = require('./mfr-lookup');
const { isValidEccn } = require('./validators');
const logger = require('./logger').createLogger('VQWriter');

// Flag reason codes
const FLAG = {
  BP_NOT_FOUND: 'BP_NOT_FOUND',
  MFR_NO_MATCH: 'MFR_NO_MATCH',
  MFR_LOW_CONFIDENCE: 'MFR_LOW_CONFIDENCE',
  MFR_SYSTEM_ONLY: 'MFR_SYSTEM_ONLY',
  MPN_CROSS_REF: 'MPN_CROSS_REF',
  MISSING_MANDATORY: 'MISSING_MANDATORY',
  API_WRITE_ERROR: 'API_WRITE_ERROR',
};

// ─── Tier 1 Defaults (set at VQ load time) ─────────────────────────────────
// See shared/data-model.md § VQ Field Requirements by Stage

const DEFAULTS = {
  C_UOM_ID: 100,                       // Each
  C_Country_ID: 1000001,               // PENDING (if vendor didn't specify COO)
  Chuboe_RoHS: 'Y',                    // Yes unless otherwise noted
};

// Traceability derived from vendor type
const TRACEABILITY = {
  FRANCHISE: 1000001,     // Authorized Distribution Certs (vendor type 1000002)
  DEFAULT: 1000003,       // Non-Traceable (all others)
};

// Vendor types where we trust the source enough to auto-default missing date code.
// All authorized-channel vendors (mfr direct + franchise + catalog distributors + online distributors)
// sell new stock, so "within 2 years" is a safe assumption when the API doesn't return a specific code.
// Brokers / non-traceable vendors must NOT get this default — DC there is meaningful.
//
// Note: OT classifies the major franchise distributors (DigiKey, Mouser, Newark, TTI, Waldom, Avnet)
// as "Catalog" or "Online Distributor" rather than "Franchise". They are still authorized channels
// for purposes of date code expectations, so they are included here.
const MFR_DIRECT_OR_FRANCHISE = new Set([
  1000001, // Manufacture Direct Component
  1000002, // Franchise
  1000007, // Manufacture Direct Assemblies
  1000008, // Catalog (DigiKey, Mouser, Newark, TTI, Waldom, etc.)
  1000009, // Online Distributor (Avnet, etc.)
]);
const DEFAULT_DATE_CODE_AUTHORIZED = 'within 2 years';

// Packaging string → chuboe_packaging_id (verified against DB).
// Inputs are normalized to lowercase with whitespace collapsed.
// Returns null on no match — caller's opts.packagingId is the fallback.
const PACKAGING_MAP = {
  // REEL family → F-REEL is the universal canonical (used across all vendor types)
  'reel': 1000001,
  'tape and reel': 1000001,
  'tape & reel': 1000001,
  't&r': 1000001,
  'tr': 1000001,
  'digi-reel': 1000001,
  'digireel': 1000001,
  // CUT TAPE
  'cut tape': 1000006,
  'cuttape': 1000006,
  'ct': 1000006,
  // F-TUBE (only tube option in DB — no plain TUBE)
  'tube': 1000003,
  'f-tube': 1000003,
  'ftube': 1000003,
  // F-TRAY (universal canonical)
  'tray': 1000002,
  'f-tray': 1000002,
  'ftray': 1000002,
  // BULK family
  'bulk': 1000008,
  'each': 1000008,
  'bag': 1000008,
  'ea': 1000008,
  // BOX
  'box': 1000007,
  // AMMO
  'ammo': 1000009,
  'ammo pack': 1000009,
};

function normalizePackaging(text) {
  if (!text) return null;
  const key = String(text).toLowerCase().trim().replace(/\s+/g, ' ');
  return PACKAGING_MAP[key] || null;
}

// ─── BP Vendor Type Cache ───────────────────────────────────────────────────
const _bpVendorTypeCache = new Map();

/**
 * Get vendor type ID for a business partner.
 */
async function getBPVendorType(bpId) {
  if (_bpVendorTypeCache.has(bpId)) return _bpVendorTypeCache.get(bpId);
  const result = await apiGet('C_BPartner', { filter: `C_BPartner_ID eq ${bpId}`, top: 1 });
  const vtId = result.records?.[0]?.Chuboe_VendorType_ID?.id || result.records?.[0]?.Chuboe_VendorType_ID || null;
  _bpVendorTypeCache.set(bpId, vtId);
  return vtId;
}

/**
 * Derive traceability from vendor type.
 * Franchise (1000002) → Auth Dist Certs; all others → Non-Traceable.
 */
function deriveTraceability(vendorTypeId) {
  return vendorTypeId === 1000002 ? TRACEABILITY.FRANCHISE : TRACEABILITY.DEFAULT;
}

// ─── Mandatory Field Validation ─────────────────────────────────────────────

// Tier 1 mandatory fields. Note Chuboe_MFR_ID is intentionally NOT in this list:
// system-level MFR records (AD_Client_ID=0) cause 500 errors when posted via the REST API,
// so we omit the ID for those cases and let the server's bean callout resolve from
// Chuboe_MFR_Text instead. This mirrors the rfq-writer pattern proven on RFQ 1132040.
// Chuboe_MFR_Text IS mandatory — server cannot resolve without it.
const TIER1_MANDATORY = [
  'Chuboe_RFQ_ID', 'Chuboe_RFQ_Line_ID', 'C_BPartner_ID',
  'Chuboe_MPN', 'Chuboe_MFR_Text', 'Cost', 'Qty', 'Chuboe_Packaging_ID',
  'Chuboe_Buyer_ID',
];

const TIER2_MANDATORY = [
  ...TIER1_MANDATORY,
  'C_BPartner_Location_ID', 'Chuboe_Warehouse_Group_ID', 'Chuboe_Warehouse_ID',
  'M_Shipper_ID', 'Chuboe_Inco_Term_ID', 'DatePromised', 'DueDate',
  'C_UOM_ID', 'C_Country_ID', 'Chuboe_RoHS', 'Chuboe_Traceability_ID',
  'Chuboe_VendorType_ID', 'Chuboe_Date_Code',
];

/**
 * Validate payload has all mandatory fields for the given tier.
 * Returns { valid: boolean, missing: string[] }
 */
function validatePayload(payload, tier = 1) {
  const required = tier === 2 ? TIER2_MANDATORY : TIER1_MANDATORY;
  const missing = required.filter(f => payload[f] == null || payload[f] === '');
  return { valid: missing.length === 0, missing };
}

// ─── RFQ Resolution ─────────────────────────────────────────────────────────

let _rfqCache = new Map(); // rfqSearchKey -> { id, lines: Map<cpc, lineId> }

/**
 * Resolve RFQ by search key. Caches CPC->lineId and MPN->lineId maps.
 */
async function resolveRFQ(rfqSearchKey) {
  if (_rfqCache.has(rfqSearchKey)) return _rfqCache.get(rfqSearchKey);

  // Get RFQ header
  const rfqResult = await apiGet('Chuboe_RFQ', { filter: `Value eq '${rfqSearchKey}'`, top: 1 });
  if (!rfqResult.records || rfqResult.records.length === 0) {
    throw new Error(`RFQ '${rfqSearchKey}' not found`);
  }
  const rfqId = rfqResult.records[0].id;

  // Get all RFQ lines (CPC -> line ID)
  let allLines = [];
  let skip = 0;
  while (true) {
    const batch = await apiGet('Chuboe_RFQ_Line', {
      filter: `Chuboe_RFQ_ID eq ${rfqId}`, top: 100, skip, orderby: 'Line'
    });
    if (batch.records) allLines = allLines.concat(batch.records);
    if (!batch.records || batch.records.length < 100) break;
    skip += 100;
  }
  const cpcToLine = new Map();
  for (const l of allLines) {
    if (l.Chuboe_CPC) cpcToLine.set(l.Chuboe_CPC, l.id);
  }

  // Get all RFQ Line MPNs (MPN -> line ID)
  let allMpns = [];
  skip = 0;
  while (true) {
    const batch = await apiGet('Chuboe_RFQ_Line_MPN', {
      filter: `Chuboe_RFQ_ID eq ${rfqId}`, top: 100, skip
    });
    if (batch.records) allMpns = allMpns.concat(batch.records);
    if (!batch.records || batch.records.length < 100) break;
    skip += 100;
  }
  const mpnToLine = new Map();
  for (const m of allMpns) {
    const mpn = (m.Chuboe_MPN || '').toUpperCase();
    const lineId = m.Chuboe_RFQ_Line_ID?.id || m.Chuboe_RFQ_Line_ID;
    if (mpn && lineId) mpnToLine.set(mpn, lineId);
  }

  const entry = { id: rfqId, lines: cpcToLine, mpnToLine };
  _rfqCache.set(rfqSearchKey, entry);
  console.log(`[vq-writer] RFQ ${rfqSearchKey} resolved: ID ${rfqId}, ${cpcToLine.size} CPC lines, ${mpnToLine.size} MPNs`);
  return entry;
}

// ─── MPN → RFQ Line Resolution ─────────────────────────────────────────────

// Vendor prefixes to strip (Bussmann/Eaton fuse numbering)
const VENDOR_PREFIXES = [/^BK[0-9]?[-\/]/, /^#/];

/**
 * Resolve an MPN to its RFQ line ID. Tries multiple strategies:
 * 1. Exact MPN match
 * 2. Strip packaging suffixes
 * 3. Strip vendor prefixes (BK/, BK1-)
 * 4. Strip both prefix and suffix
 * 5. Try with # prefix (some SIPOC MPNs start with #)
 * 6. Strip lead-free packaging variants (#PBF ↔ #WTRPBF)
 * 7. Fall back to CPC if provided
 */
function resolveRFQLine(rfq, mpn, cpc) {
  const upper = mpn.toUpperCase();

  // 1. Exact MPN match
  if (rfq.mpnToLine.has(upper)) return rfq.mpnToLine.get(upper);

  // 2. Strip packaging suffixes
  const noSuffix = upper.replace(/-(R7|RL7|REEL7|ND|R)$/i, '').replace(/T$/, '');
  if (rfq.mpnToLine.has(noSuffix)) return rfq.mpnToLine.get(noSuffix);

  // 3. Strip vendor prefixes
  let noPrefix = upper;
  for (const pat of VENDOR_PREFIXES) noPrefix = noPrefix.replace(pat, '');
  if (noPrefix !== upper && rfq.mpnToLine.has(noPrefix)) return rfq.mpnToLine.get(noPrefix);

  // 4. Strip both
  const noBoth = noPrefix.replace(/-(R7|RL7|REEL7|ND|R)$/i, '').replace(/T$/, '');
  if (rfq.mpnToLine.has(noBoth)) return rfq.mpnToLine.get(noBoth);

  // 5. Try with # prefix
  if (rfq.mpnToLine.has('#' + noPrefix)) return rfq.mpnToLine.get('#' + noPrefix);
  if (rfq.mpnToLine.has('#' + noBoth)) return rfq.mpnToLine.get('#' + noBoth);

  // 6. Lead-free packaging variants (#PBF ↔ #WTRPBF ↔ #TRPBF ↔ #TRMPBF)
  const noPkg = upper.replace(/#(W?TR?M?PBF|TRPBF|TRMPBF|PBF)$/, '');
  if (noPkg !== upper) {
    for (const [k, v] of rfq.mpnToLine) {
      if (k.replace(/#(W?TR?M?PBF|TRPBF|TRMPBF|PBF)$/, '') === noPkg) return v;
    }
  }

  // 7. CPC fallback
  if (cpc && rfq.lines.has(cpc)) return rfq.lines.get(cpc);

  return null;
}

// ─── MFR Confidence Check ───────────────────────────────────────────────────

/**
 * Check if MFR lookup result is high enough confidence to write automatically.
 * Returns { ok: boolean, reason: string|null }
 */
function checkMfrConfidence(mfrLookupResult, originalText) {
  if (!mfrLookupResult.matched) {
    return { ok: false, reason: FLAG.MFR_NO_MATCH };
  }

  // Fuzzy matches with low confidence get flagged
  if (mfrLookupResult.source.startsWith('fuzzy(')) {
    const conf = mfrLookupResult.source.match(/fuzzy\((\w+)\)/)?.[1];
    if (conf === 'low') {
      return { ok: false, reason: FLAG.MFR_LOW_CONFIDENCE };
    }
  }

  // Alias matched but no DB ID — MFR exists in alias file but not in DB
  if (mfrLookupResult.source === 'alias' && !mfrLookupResult.id) {
    return { ok: false, reason: FLAG.MFR_NO_MATCH };
  }

  return { ok: true, reason: null };
}

// ─── MPN Cross-Reference ────────────────────────────────────────────────────

// Packaging/ordering suffixes and trailing characters that don't change the base part
const PACKAGING_SUFFIXES = [
  '-ND',           // DigiKey ordering code
  '-TR', '-CT',    // Tape & reel, cut tape
  '-T1', '-T2', '-T3', '-T5',  // Tape packaging variants
  '#PBF', '#TRPBF', '#TRMPBF', // Lead-free variants
  '/NOPB',         // TI no-lead
  '-TP',           // Tape packaging
  '-R', '-E',      // Reel, embossed
  'TR', 'CT',      // Without hyphen
];

// Trailing single characters that indicate packaging (T=tape, R=reel, E=embossed, etc.)
const PACKAGING_CHARS = new Set(['T', 'R', 'E', 'C', 'X']);

/**
 * Strip all known packaging suffixes from an MPN to get the base part.
 */
function stripPackaging(mpn) {
  let clean = mpn.toUpperCase().replace(/[-\s\/]/g, '');
  // Sort suffixes longest-first to avoid partial matches
  const sorted = [...PACKAGING_SUFFIXES].map(s => s.replace(/[-\s\/]/g, '').toUpperCase()).sort((a, b) => b.length - a.length);
  for (const sfx of sorted) {
    if (clean.endsWith(sfx)) {
      clean = clean.slice(0, -sfx.length);
      break;
    }
  }
  return clean;
}

/**
 * Compare searched MPN against API-returned MPN.
 * Returns { mismatch: boolean, suffix: string|null }
 *   mismatch=true  → genuinely different part, should flag
 *   mismatch=false → same part, possibly with packaging suffix
 *   suffix         → if non-null, the packaging difference (e.g., "-TR")
 */
function checkMpnCrossRef(searched, returned) {
  const cleanSearch = searched.replace(/[-\s\/]/g, '').toUpperCase();
  const cleanReturn = returned.replace(/[-\s\/]/g, '').toUpperCase();

  // Exact match after normalization
  if (cleanSearch === cleanReturn) return { mismatch: false, suffix: null };

  // Strip packaging from both and compare base parts
  const baseSearch = stripPackaging(searched);
  const baseReturn = stripPackaging(returned);
  if (baseSearch === baseReturn) {
    // Same base part, different packaging
    const diff = returned.replace(new RegExp(searched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim();
    return { mismatch: false, suffix: diff || 'packaging variant' };
  }

  // Check if they differ only by a single trailing packaging character
  // e.g., TPS3837K33DBVT vs TPS3837K33DBVR (T→R, both packaging)
  if (cleanSearch.length === cleanReturn.length && cleanSearch.length >= 6) {
    const diffPos = [...cleanSearch].findIndex((ch, i) => ch !== cleanReturn[i]);
    if (diffPos === cleanSearch.length - 1) {
      // Only last character differs
      if (PACKAGING_CHARS.has(cleanSearch[diffPos]) && PACKAGING_CHARS.has(cleanReturn[diffPos])) {
        return { mismatch: false, suffix: `${searched[searched.length-1]}→${returned[returned.length-1]}` };
      }
    }
  }

  // Check if returned starts with searched (API added suffix)
  if (cleanSearch.length >= 6 && cleanReturn.startsWith(cleanSearch)) {
    const extra = cleanReturn.substring(cleanSearch.length);
    return { mismatch: false, suffix: extra || null };
  }
  if (cleanReturn.length >= 6 && cleanSearch.startsWith(cleanReturn)) {
    return { mismatch: false, suffix: null };
  }

  // Genuine mismatch
  return { mismatch: true, suffix: null };
}

// ─── Core Write Function ────────────────────────────────────────────────────

/**
 * Write VQ lines from franchise API results for a single MPN.
 *
 * @param {string} rfqSearchKey - RFQ document number (e.g., '1131217')
 * @param {string} cpc - Customer Part Code (links to RFQ line)
 * @param {Object} franchiseResults - Return value from franchiseApi.searchAllDistributors()
 * @param {Object} [opts] - Options
 * @param {string} [opts.searchedMpn] - The MPN that was searched (for cross-ref check)
 * @returns {{ written: Array, flagged: Array, failed: Array }}
 */
async function writeVQFromAPI(rfqSearchKey, cpc, franchiseResults, opts = {}) {
  const written = [];
  const flagged = [];
  const failed = [];

  // Resolve RFQ and line
  const rfq = await resolveRFQ(rfqSearchKey);
  const rfqLineId = opts._rfqLineIdOverride || resolveRFQLine(rfq, opts.searchedMpn || '', cpc);
  if (!rfqLineId) {
    flagged.push({ cpc, mpn: opts.searchedMpn, reason: 'NO_RFQ_LINE',
      detail: `MPN '${opts.searchedMpn}' / CPC '${cpc}' not found in RFQ lines` });
    return { written, flagged, failed };
  }

  // Process each distributor result
  const distributors = franchiseResults.distributors || [];
  for (const d of distributors) {
    if (!d.found || !d.franchiseRfqPrice || d.franchiseRfqPrice <= 0) continue;

    const mpn = d.vqMpn || d.raw?.vqMpn || opts.searchedMpn || '';
    const mfrText = d.vqManufacturer || d.raw?.vqManufacturer || '';
    const price = d.vqPrice || d.franchiseRfqPrice;
    const qty = d.franchiseQty || 0;
    const leadTime = d.vqLeadTime || d.raw?.vqLeadTime || '';
    const moq = d.vqMoq || d.raw?.vqMoq || null;
    const spq = d.vqSpq || d.raw?.vqSpq || null;
    const bpSearchKey = d.bpValue;

    // Cross-reference check: is the API-returned MPN the same part?
    // Packaging variants → write with note. Genuine mismatches → flag with full payload for user review.
    let packagingNote = '';
    if (opts.searchedMpn && mpn) {
      const crossRef = checkMpnCrossRef(opts.searchedMpn, mpn);
      if (crossRef.mismatch) {
        // Don't write — hold for user confirmation. Include full payload so it can be written later.
        flagged.push({
          mpn, searchedMpn: opts.searchedMpn, vendor: d.name, bpSearchKey,
          price, qty, mfrText, leadTime, moq, spq,
          cpc, rfqId: rfq.id, rfqLineId,
          reason: FLAG.MPN_CROSS_REF,
          detail: `Searched '${opts.searchedMpn}' but API quoted '${mpn}'. Confirm to proceed.`
        });
        continue;
      }
      if (crossRef.suffix) {
        packagingNote = `Quoted MPN: ${mpn} (${crossRef.suffix})`;
      }
    }

    // Resolve BP — search key first, name fallback, same path for all vendors
    const bp = await resolveBP(bpSearchKey, d.name);
    if (!bp) {
      flagged.push({
        mpn, vendor: d.name, bpSearchKey, price, qty,
        reason: FLAG.BP_NOT_FOUND,
        detail: `Vendor '${d.name}' (SK: ${bpSearchKey || 'none'}) not found in target system`
      });
      continue;
    }

    // Resolve MFR — normalize via mfr-lookup, optionally enrich with live DB lookup.
    // SYSTEM-ONLY MFRs (AD_Client_ID=0): omit Chuboe_MFR_ID and let the server's bean
    // callout resolve from Chuboe_MFR_Text. This is the same pattern as rfq-writer.js
    // (proven on RFQ 1132040, 2026-04-06). The text field is the load-bearing one.
    const mfrResult = lookupMfr(mfrText);
    const mfrCanonical = mfrResult.canonical || mfrText;

    // Try to enrich with a non-system ID via live DB lookup. Failures here are non-fatal
    // — we'll fall back to the cache result, and if that's also system-only we omit the ID.
    let resolvedMfrId = null;
    if (mfrResult.id && !mfrResult.isSystem) {
      // Cache already has a client-level ID — trust it
      resolvedMfrId = mfrResult.id;
    } else {
      try {
        const live = await resolveMFR(mfrCanonical);
        if (live && live.id && !live.isSystem) resolvedMfrId = live.id;
      } catch (_) { /* ignore — fall through to text-only write */ }
    }
    // resolvedMfrId may be null here (system-only or no match) — that's OK,
    // the payload will omit Chuboe_MFR_ID and the server will resolve from text.

    // Build vendor notes — combine API notes with packaging info
    const vendorNotes = [d.vqVendorNotes, packagingNote].filter(Boolean).join(' | ');

    // Resolve vendor type and traceability from BP
    const vendorTypeId = await getBPVendorType(bp.id);
    const traceabilityId = deriveTraceability(vendorTypeId);

    // Resolve packaging — distributor data wins, then opts fallback.
    // Accepts either an explicit ID (vqPackagingId) or a string (vqPackaging) that we normalize.
    const packagingId = d.vqPackagingId
      || normalizePackaging(d.vqPackaging)
      || opts.packagingId
      || null;

    // Resolve date code — distributor data wins. If empty AND vendor is mfr-direct/franchise,
    // default to "within 2 years" (these are authorized-channel purchases of new stock).
    // Brokers (and other vendor types) get no default — must come from caller or stay null.
    const dateCodeFromApi = d.vqDateCode || (d.raw && d.raw.vqDateCode) || null;
    const dateCode = dateCodeFromApi
      || (MFR_DIRECT_OR_FRANCHISE.has(vendorTypeId) ? DEFAULT_DATE_CODE_AUTHORIZED : null)
      || opts.dateCode
      || null;

    // HTS / ECCN — sourced from franchise API data when available, with explicit
    // validation on ECCN (chuboe_eccn is varchar(25) and the value flows back to
    // compliance/customs filings, so a malformed write is worse than skipping it).
    // HTS has no regex validator (codes too varied) — only a length guard.
    let htsValue = d.vqHts || opts.hts || null;
    if (htsValue && String(htsValue).length > 25) {
      logger.warn(`HTS value too long for ${d.name || 'vendor'} on ${mpn}, skipping: ${htsValue}`);
      htsValue = null;
    }
    let eccnValue = d.vqEccn || opts.eccn || null;
    if (eccnValue && !isValidEccn(eccnValue)) {
      logger.warn(`ECCN value failed validation for ${d.name || 'vendor'} on ${mpn}, skipping: ${eccnValue}`);
      eccnValue = null;
    }

    // Build payload — use searched MPN (our MPN), not the API's variant.
    // Chuboe_MFR_ID is conditional: only include when we have a non-system client-level ID.
    // Server resolves system-only / unknown MFRs from Chuboe_MFR_Text via bean callout.
    const payload = {
      Chuboe_RFQ_ID: rfq.id,
      Chuboe_RFQ_Line_ID: rfqLineId,
      C_BPartner_ID: bp.id,
      Chuboe_MPN: opts.searchedMpn || mpn,
      Chuboe_MFR_Text: mfrCanonical,
      ...(resolvedMfrId ? { Chuboe_MFR_ID: resolvedMfrId } : {}),
      Cost: price,
      Qty: qty,
      C_Currency_ID: 100, // USD
      Chuboe_Lead_Time: leadTime || null,
      Chuboe_MOQ: moq ? String(moq) : null,
      Chuboe_SPQ: spq ? String(spq) : null,
      Chuboe_Note_Public: vendorNotes || null,

      // Tier 1 defaults — populated at VQ load time
      C_UOM_ID: opts.uomId || DEFAULTS.C_UOM_ID,
      C_Country_ID: d.vqCooCountryId || opts.cooCountryId || DEFAULTS.C_Country_ID,
      Chuboe_RoHS: d.vqRohs || opts.rohs || DEFAULTS.Chuboe_RoHS,
      Chuboe_Traceability_ID: traceabilityId,
      Chuboe_VendorType_ID: vendorTypeId,
      Chuboe_Packaging_ID: packagingId,
      Chuboe_Date_Code: dateCode,
      Chuboe_Buyer_ID: opts.buyerId || null,

      // HTS/ECCN — from franchise API data when available (validated above)
      Chuboe_HTS: htsValue,
      Chuboe_ECCN: eccnValue,
    };

    // Validate Tier 1 mandatory fields before writing
    const validation = validatePayload(payload, 1);
    if (!validation.valid) {
      flagged.push({
        mpn, vendor: d.name, bpId: bp.id, price, qty,
        reason: FLAG.MISSING_MANDATORY,
        detail: `Missing mandatory fields: ${validation.missing.join(', ')}`,
        payload, // include for manual completion
      });
      continue;
    }

    // Write
    try {
      const result = await apiPost('Chuboe_VQ_Line', payload);
      written.push({
        vqLineId: result.id, mpn, vendor: d.name, bpId: bp.id,
        mfrId: resolvedMfrId, mfr: mfrCanonical, price, qty
      });
    } catch (e) {
      failed.push({
        mpn, vendor: d.name, bpId: bp.id, price, qty,
        reason: FLAG.API_WRITE_ERROR,
        detail: e.message.substring(0, 200)
      });
    }
  }

  return { written, flagged, failed };
}

// ─── Batch Write (Two-Pass) ──────────────────────────────────────────────────

/**
 * Exact-only MPN match — no stripping, no fuzzy. For pass 1.
 */
function resolveRFQLineExact(rfq, mpn, cpc) {
  const upper = (mpn || '').toUpperCase();
  if (rfq.mpnToLine.has(upper)) return rfq.mpnToLine.get(upper);
  if (cpc && rfq.lines.has(cpc)) return rfq.lines.get(cpc);
  return null;
}

/**
 * Write VQ lines in two passes:
 *
 * PASS 1: Exact match on MPN/CPC, BP search key, MFR name.
 *   → Writes everything that matches cleanly. Fast, no ambiguity.
 *   → Returns unmatched lines to caller.
 *
 * PASS 2: Fuzzy resolution on unmatched lines.
 *   → Strips vendor prefixes, packaging suffixes, tries name-based BP lookup.
 *   → Returns results for user review before writing.
 *
 * @param {string} rfqSearchKey - RFQ document number
 * @param {Array<{cpc?: string, mpn: string, franchiseResults: Object}>} items
 * @param {Object} [opts]
 * @param {number} [opts.delayMs=100] - Delay between API writes
 * @param {boolean} [opts.pass2Auto=false] - If true, write pass 2 matches automatically. If false (default), return them for review.
 * @returns {{ written: Array, flagged: Array, failed: Array, needsReview: Array, summary: Object }}
 */
async function writeVQBatch(rfqSearchKey, items, opts = {}) {
  const delayMs = opts.delayMs || 100;
  const pass2Auto = opts.pass2Auto || false;

  const allWritten = [];
  const allFlagged = [];
  const allFailed = [];
  const allNeedsReview = [];

  // Pre-warm: resolve RFQ (loads CPC and MPN maps)
  const rfq = await resolveRFQ(rfqSearchKey);

  // Pre-warm: resolve all BPs and MFRs
  const vendorSet = new Map();
  const mfrSet = new Set();
  for (const item of items) {
    for (const d of (item.franchiseResults?.distributors || [])) {
      if (!d.found) continue;
      const key = d.bpValue || d.name || '';
      if (!vendorSet.has(key)) vendorSet.set(key, { searchKey: d.bpValue, name: d.name });
      const mfrText = d.vqManufacturer || d.raw?.vqManufacturer || '';
      if (mfrText) mfrSet.add(mfrText);
    }
  }
  console.log(`[vq-writer] Pre-warming ${vendorSet.size} vendors, ${mfrSet.size} manufacturers...`);
  await resolveBPBatch([...vendorSet.values()]);
  for (const m of mfrSet) {
    const lookup = lookupMfr(m);
    await resolveMFR(lookup.canonical || m);
  }

  // ── PASS 1: Exact match ──────────────────────────────────────────────────
  console.log(`[vq-writer] Pass 1: exact match on ${items.length} items...`);
  const pass2Items = []; // items that need fuzzy resolution

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Try exact RFQ line match
    const rfqLineId = resolveRFQLineExact(rfq, item.mpn, item.cpc);
    if (!rfqLineId) {
      pass2Items.push(item);
      continue;
    }

    // Write all distributor results for this item
    const result = await writeVQFromAPI(rfqSearchKey, item.cpc, item.franchiseResults, {
      ...opts, // forward batch-level defaults: packagingId, buyerId, dateCode, etc.
      searchedMpn: item.mpn,
      _rfqLineIdOverride: rfqLineId, // skip internal resolution, we already matched
    });

    allWritten.push(...result.written);
    allFlagged.push(...result.flagged);
    allFailed.push(...result.failed);

    if (i < items.length - 1 && result.written.length > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  const pass1Written = allWritten.length;
  console.log(`[vq-writer] Pass 1 complete: ${pass1Written} written, ${pass2Items.length} need resolution`);

  // ── PASS 2: Fuzzy resolution ─────────────────────────────────────────────
  if (pass2Items.length > 0) {
    console.log(`[vq-writer] Pass 2: resolving ${pass2Items.length} unmatched items...`);

    for (const item of pass2Items) {
      // Try full resolution chain (stripping, prefixes, etc.)
      const rfqLineId = resolveRFQLine(rfq, item.mpn, item.cpc);

      if (!rfqLineId) {
        allFlagged.push({
          mpn: item.mpn, cpc: item.cpc,
          reason: 'NO_RFQ_LINE',
          detail: `MPN '${item.mpn}' not found after fuzzy resolution`
        });
        continue;
      }

      if (pass2Auto) {
        // Write automatically
        const result = await writeVQFromAPI(rfqSearchKey, item.cpc, item.franchiseResults, {
          ...opts, // forward batch-level defaults
          searchedMpn: item.mpn,
          _rfqLineIdOverride: rfqLineId,
        });
        allWritten.push(...result.written);
        allFlagged.push(...result.flagged);
        allFailed.push(...result.failed);
      } else {
        // Hold for review — include the resolved line ID so caller can write later
        allNeedsReview.push({
          ...item,
          resolvedRfqLineId: rfqLineId,
          resolution: 'fuzzy',
          detail: `MPN '${item.mpn}' matched via prefix/suffix stripping`
        });
      }
    }
  }

  const summary = {
    total: items.length,
    pass1Written,
    pass2Resolved: pass2Auto ? allWritten.length - pass1Written : allNeedsReview.length,
    written: allWritten.length,
    flagged: allFlagged.length,
    failed: allFailed.length,
    needsReview: allNeedsReview.length,
    byReason: {},
  };

  for (const f of allFlagged) {
    if (!summary.byReason[f.reason]) summary.byReason[f.reason] = 0;
    summary.byReason[f.reason]++;
  }

  console.log(`[vq-writer] Done: ${summary.written} written (${pass1Written} pass1), ${summary.needsReview} needs review, ${summary.flagged} flagged, ${summary.failed} failed`);

  return { written: allWritten, flagged: allFlagged, failed: allFailed, needsReview: allNeedsReview, summary };
}

/**
 * Write items that were held for review after pass 2.
 * Call after user confirms the fuzzy-matched items.
 */
async function writeReviewedItems(rfqSearchKey, reviewedItems, opts = {}) {
  const delayMs = opts.delayMs || 100;
  const results = { written: [], flagged: [], failed: [] };

  for (let i = 0; i < reviewedItems.length; i++) {
    const item = reviewedItems[i];
    const result = await writeVQFromAPI(rfqSearchKey, item.cpc, item.franchiseResults, {
      searchedMpn: item.mpn,
      _rfqLineIdOverride: item.resolvedRfqLineId,
    });
    results.written.push(...result.written);
    results.flagged.push(...result.flagged);
    results.failed.push(...result.failed);
    if (i < reviewedItems.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  console.log(`[vq-writer] Review items written: ${results.written.length} written, ${results.flagged.length} flagged, ${results.failed.length} failed`);
  return results;
}

// ─── Cache Management ────────────────────────────────────────────────────────

function clearCaches() {
  _rfqCache = new Map();
  _bpVendorTypeCache.clear();
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  writeVQFromAPI,
  writeVQBatch,
  writeReviewedItems,
  clearCaches,
  validatePayload,
  normalizePackaging,
  FLAG,
  DEFAULTS,
  PACKAGING_MAP,
  MFR_DIRECT_OR_FRANCHISE,
  DEFAULT_DATE_CODE_AUTHORIZED,
  TIER1_MANDATORY,
  TIER2_MANDATORY,
};
