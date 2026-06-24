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

const { execFileSync } = require('child_process');
const { apiGet, apiPost, resolveBP, resolveBPBatch, resolveMFR, buildNaturalKeyFilter } = require('./api-client');
const { extractStockAndLtRows } = require('./franchise-api');
const { lookupMfr, sanitizeMfrText } = require('./mfr-lookup');
const { resolveMfrForRow } = require('./mfr-resolver');
const { normalizePackaging, PACKAGING_MAP } = require('./packaging-lookup');
const { isValidEccn } = require('./validators');
const { isRestrictedMfrName, isRestrictedMfrId } = require('./restricted-mfrs');
const { patchRecord } = require('./record-updater');
const logger = require('./logger').createLogger('VQWriter');

// ─── Profile VQ deactivation ────────────────────────────────────────────────
//
// When a real priced VQ arrives for an MPN that already has a $0 "profile" VQ
// (from Market Profiler), deactivate the profile VQ before writing the new one.
// This keeps the VQ list clean — profile VQs are placeholders for availability,
// replaced by real quotes when they arrive.
//
// Criteria for deactivation:
//   - Same RFQ line, MPN, and vendor (BP)
//   - Cost = 0 (profile VQs are always $0)
//   - Created within last 10 days (stale profiles left alone)
//   - IsActive = 'Y'
//
const PROFILE_VQ_MAX_AGE_DAYS = 10;

/**
 * Find and deactivate $0 profile VQs for the same RFQ line + MPN + vendor.
 * Called before writing a priced VQ to replace the placeholder.
 *
 * @param {number} rfqLineId - RFQ line ID
 * @param {string} mpn - MPN (will be uppercased for comparison)
 * @param {number} bpId - Vendor business partner ID
 * @returns {Promise<{deactivated: number[], errors: string[]}>}
 */
async function deactivateProfileVQs(rfqLineId, mpn, bpId) {
  const deactivated = [];
  const errors = [];

  // Find $0 profile VQs within the age window
  const cutoffDate = new Date(Date.now() - PROFILE_VQ_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10); // YYYY-MM-DD

  const sql = `
    SELECT chuboe_vq_line_id
    FROM adempiere.chuboe_vq_line
    WHERE chuboe_rfq_line_id = ${Number(rfqLineId)}
      AND UPPER(chuboe_mpn) = '${String(mpn).toUpperCase().replace(/'/g, "''")}'
      AND c_bpartner_id = ${Number(bpId)}
      AND cost = 0
      AND isactive = 'Y'
      AND created::date >= '${cutoffDate}'
  `;

  let profileVqIds = [];
  try {
    const out = execFileSync('psql', ['-At', '-c', sql], { encoding: 'utf8' });
    profileVqIds = out.split('\n').filter(l => /^\d+$/.test(l.trim())).map(l => Number(l.trim()));
  } catch (err) {
    // psql failed — log and continue (don't block the write)
    logger.warn(`Profile VQ lookup failed for RFQ line ${rfqLineId} / ${mpn}: ${err.message}`);
    return { deactivated, errors: [err.message] };
  }

  if (profileVqIds.length === 0) {
    return { deactivated, errors };
  }

  logger.info(`Deactivating ${profileVqIds.length} profile VQ(s) for ${mpn} (BP ${bpId}): ${profileVqIds.join(', ')}`);

  // Deactivate each profile VQ
  for (const vqId of profileVqIds) {
    try {
      await patchRecord('chuboe_vq_line', vqId, { IsActive: false }, {
        source: 'vq-writer:profile-deactivation'
      });
      deactivated.push(vqId);
    } catch (err) {
      logger.warn(`Failed to deactivate profile VQ ${vqId}: ${err.message}`);
      errors.push(`VQ ${vqId}: ${err.message}`);
    }
  }

  return { deactivated, errors };
}

// ─── Natural-key existence check via psql ──────────────────────────────────
// Why psql, not apiGet($filter): the iDempiere REST $filter on chuboe_vq_line
// (same issue on chuboe_offer_line) silently returns the wrong row when the
// filter doesn't parse — verified 2026-05-14 (offer_line) and 2026-05-19
// (vq_line during TTI EU smoke load). A bogus "already exists" cascades into
// silent dropped writes, which is worse than the duplicate it tries to prevent.
// psql is read-only, fast, and deterministic — use it for the pre-flight.
//
// Returns the existing chuboe_vq_line_id, or null if no active row matches.
function findExistingVqIdByNaturalKey(payload) {
  // Chuboe_Date_Code is part of the natural key (added 2026-05-21 after the
  // Ivy-forwards-LFZU incident — Southchip's 23+ DC quote was dropped because
  // dedup matched the 21+ DC row on (RFQ_Line × MPN × BP × Cost × Currency)).
  // Different DCs represent distinct inventory lots from the same vendor and
  // should be preserved as separate VQs. Null/empty DC matches null/empty;
  // populated DCs must match exactly (case-sensitive — matches DB collation).
  const dcRaw = payload.Chuboe_Date_Code;
  const dcStr = (dcRaw == null ? '' : String(dcRaw)).trim();
  const dcCondition = dcStr === ''
    ? `(chuboe_date_code IS NULL OR chuboe_date_code = '')`
    : `chuboe_date_code = '${dcStr.replace(/'/g, "''")}'`;
  const conditions = [
    `chuboe_rfq_line_id = ${Number(payload.Chuboe_RFQ_Line_ID)}`,
    `chuboe_mpn = '${String(payload.Chuboe_MPN || '').replace(/'/g, "''")}'`,
    `c_bpartner_id = ${Number(payload.C_BPartner_ID)}`,
    `cost = ${Number(payload.Cost)}`,
    `c_currency_id = ${Number(payload.C_Currency_ID || 100)}`,
    dcCondition,
    `isactive = 'Y'`,
  ];
  try {
    const out = execFileSync(
      'psql',
      ['-At', '-c', `SELECT chuboe_vq_line_id FROM adempiere.chuboe_vq_line WHERE ${conditions.join(' AND ')} LIMIT 1;`],
      { encoding: 'utf8' },
    );
    const id = out.split('\n').filter(Boolean).map(l => l.trim()).find(l => /^\d+$/.test(l));
    return id ? Number(id) : null;
  } catch (err) {
    // psql unavailable or query failed — caller's catch will fall through to POST,
    // accepting duplicate risk over data-loss risk.
    throw err;
  }
}

const { classifyWriteError } = require('./ot-error');
const rateLimiter = require('./rate-limiter');
const otBudget = require('./ot-api-budget');

// Flag reason codes
const FLAG = {
  OT_UNREACHABLE: 'OT_UNREACHABLE',   // network/transport failure (OT down) — retryable, NOT a data problem
  BP_NOT_FOUND: 'BP_NOT_FOUND',
  MFR_NO_MATCH: 'MFR_NO_MATCH',
  MFR_LOW_CONFIDENCE: 'MFR_LOW_CONFIDENCE',
  MFR_SYSTEM_ONLY: 'MFR_SYSTEM_ONLY',
  MPN_CROSS_REF: 'MPN_CROSS_REF',
  MISSING_MANDATORY: 'MISSING_MANDATORY',
  API_WRITE_ERROR: 'API_WRITE_ERROR',
  RESTRICTED_MFR: 'RESTRICTED_MFR',
  PRE_EXISTING_DUPLICATE: 'PRE_EXISTING_DUPLICATE',
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
// sell new stock, so a current-year-minus-2 floor is a safe assumption when the
// API doesn't return a specific code. Brokers / non-traceable vendors must NOT
// get this default — DC there is meaningful.
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

// Default date code for authorized-channel rows when API doesn't return one.
// Two-digit year format ("YY+") so it lines up with the standard YYWW
// week-code convention buyers see on actual parts. Two different defaults:
//
//   - Stock row (no lead time): YY = current year - 2.
//     In-stock parts are reasonably up to 2 years old.
//
//   - Lead-time row (has lead time): YY = current year.
//     LT items are newly manufactured against the order, so the date code
//     should be the current year or fresher.
//
// Computed at module-load time so the floor auto-rolls each January.
// Replaces the prior hard-coded "within 2 years" string per operator
// feedback 2026-04-14 — buyers want a concrete YY+ floor that aligns with
// week codes (YYWW), not a vague window applied uniformly to both row types.
const _yy2 = (n) => String(n).slice(-2);
const DEFAULT_DATE_CODE_STOCK = `${_yy2(new Date().getFullYear() - 2)}+`;          // e.g. "24+"
const DEFAULT_DATE_CODE_LEAD_TIME = `${_yy2(new Date().getFullYear())}+`;           // e.g. "26+"

// Backward-compat name (some callers may import this) — points to the stock
// default since that was the historical behavior. New code should pick stock
// vs LT based on whether the row has a lead time.
const DEFAULT_DATE_CODE_AUTHORIZED = DEFAULT_DATE_CODE_STOCK;

// Packaging normalization moved to shared/packaging-lookup.js (C9b, 2026-04-08).
// PACKAGING_MAP and normalizePackaging are imported above. The shared cog
// implements the three-path factory policy (explicit marker / authorized
// + full pack qty / plain default) — see its docstring for details.

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
//
// Chuboe_Packaging_ID and Chuboe_Buyer_ID were previously in this list but were
// causing every API→VQ consumer (Stock RFQ Loading, LAM Kitting, HTS/ECCN backfill,
// RFQ API Enrichment, Market Offer Analysis) to silently flag MISSING_MANDATORY
// when distributors didn't return a packaging string or no buyer was assigned.
// Audit on 2026-04-08: in 30 days of recent prod VQs, 86% have NULL packaging
// and 4.6% have NULL buyer (581 have both NULL and wrote successfully). The DB
// and bean callouts accept NULL for both. The validation was stricter than
// reality. Removed both from TIER1 to match production behavior.
const TIER1_MANDATORY = [
  'Chuboe_RFQ_ID', 'Chuboe_RFQ_Line_ID', 'C_BPartner_ID',
  'Chuboe_MPN', 'Chuboe_MFR_Text', 'Cost', 'Qty',
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
  // lineIdToQty: needed by extractStockAndLtRows so it can pick the right
  // qty-break tier when computing per-distributor row prices. Without this,
  // the centralized helper would fall back to qty=1 pricing on every line
  // for callers that don't pass an explicit rfqQty.
  const lineIdToQty = new Map();
  for (const m of allMpns) {
    const mpn = (m.Chuboe_MPN || '').trim().toUpperCase();
    const lineId = m.Chuboe_RFQ_Line_ID?.id || m.Chuboe_RFQ_Line_ID;
    if (mpn && lineId) mpnToLine.set(mpn, lineId);
    if (lineId && m.Qty != null) lineIdToQty.set(lineId, Number(m.Qty));
  }

  const entry = { id: rfqId, lines: cpcToLine, mpnToLine, lineIdToQty };
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
  const upper = (mpn || '').trim().toUpperCase();

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
 * Check if MFR resolution result is high enough confidence to write automatically.
 * Returns { ok: boolean, reason: string|null }
 *
 * Accepts either the legacy lookupMfr return shape (no `path` field) or the
 * new resolveMfrForRow shape (`path: 'text'|'mpn'|'none'`). Path-aware logic:
 *
 *   - text path → existing fuzzy/alias confidence rules apply
 *   - mpn path  → confidence comes from the prefix length (classifyMpnToMfr
 *                 returns 'high' for ≥3 chars, 'medium' for shorter — flag medium)
 */
function checkMfrConfidence(mfrLookupResult, originalText) {
  if (!mfrLookupResult.matched) {
    return { ok: false, reason: FLAG.MFR_NO_MATCH };
  }

  // MPN-path results: trust 'high' confidence (long prefix), flag 'medium'
  // (short prefix, more collision-prone) for review.
  if (mfrLookupResult.path === 'mpn') {
    if (mfrLookupResult.confidence === 'medium' || mfrLookupResult.confidence === 'low') {
      return { ok: false, reason: FLAG.MFR_LOW_CONFIDENCE };
    }
    // High-confidence MPN inference: still need a non-system ID to write
    // (same rule as text path)
    if (!mfrLookupResult.id) {
      return { ok: false, reason: FLAG.MFR_NO_MATCH };
    }
    return { ok: true, reason: null };
  }

  // Text path (or legacy lookupMfr shape with no `path` field):
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
  const skipped = [];

  // Resolve RFQ and line
  const rfq = await resolveRFQ(rfqSearchKey);
  const rfqLineId = opts._rfqLineIdOverride || resolveRFQLine(rfq, opts.searchedMpn || '', cpc);
  if (!rfqLineId) {
    flagged.push({ cpc, mpn: opts.searchedMpn, reason: 'NO_RFQ_LINE',
      detail: `MPN '${opts.searchedMpn}' / CPC '${cpc}' not found in RFQ lines` });
    return { written, flagged, failed, skipped };
  }

  // Process each distributor result via the centralized extractor.
  //
  // extractStockAndLtRows() in shared/franchise-api.js handles all the cases:
  //   - Arrow's pre-built vqLines (multi-source Arrow + Verical split)
  //   - Synthesized stock + lead-time split for distributors that return both
  //   - Single-row stock-only or LT-only distributors
  //
  // Per architectural guidance 2026-04-09: do NOT roll your own field access
  // (`d.franchiseRfqPrice || d.vqPrice` etc) — always go through the helper.
  // Centralizes qty-break tier logic in one place.
  //
  // The rfq qty for tier selection: prefer caller-provided opts.rfqQty,
  // then look it up from the resolved RFQ line (rfq.lineIdToQty), then
  // fall back to 1. The fallback will cause priceAtQty to pick the unit-1
  // tier — synthesizeStockLtVqLines's fallback chain (priceAtQty → cached
  // franchiseRfqPrice → vqPrice) will still surface the correct cached
  // price as long as the distributor module computed it at the right qty
  // when searchAllDistributors was called.
  const rfqQtyForTier = (opts.rfqQty != null && opts.rfqQty > 0)
    ? Number(opts.rfqQty)
    : (rfq.lineIdToQty?.get(rfqLineId) || 1);

  const distributors = franchiseResults.distributors || [];
  // Track a global row index across all distributors for stable cross-ref
  // candidate IDs (see shared/crossref-queue.makeCandidateId). Same envelope
  // re-enriched later will produce the same supplierIdx → same candidate ID
  // → idempotent staging.
  let globalRowIdx = 0;
  for (const d of distributors) {
    if (!d.found) continue;

    // extractStockAndLtRows returns rows in the canonical shape:
    //   { vendorBP, vendorName, channel, mpn, manufacturer, description,
    //     qty, cost, moq, spq, dateCode, leadTime, vendorNotes, priceBreaks }
    const extractedRows = extractStockAndLtRows(d, opts.searchedMpn || '', rfqQtyForTier) || [];
    if (extractedRows.length === 0) continue;

    const rowsToWrite = extractedRows
      // Accept (a) standard quotes: cost > 0 AND qty > 0, OR
      //        (b) no-bid records: cost === 0 AND qty === 0 (vendor was asked,
      //            declined or has no stock — captures the "we asked, no" signal
      //            in OT so sellers/buyers see it). Filter null/negative/mixed.
      .filter(sub => sub.cost != null && sub.qty != null &&
        ((sub.cost > 0 && sub.qty > 0) || (sub.cost === 0 && sub.qty === 0)))
      .map(sub => ({
        mpn: sub.mpn || opts.searchedMpn || '',
        mfrText: sub.manufacturer || d.vqManufacturer || '',
        price: sub.cost,
        qty: sub.qty,
        leadTime: sub.leadTime || '',
        moq: sub.moq || null,
        spq: sub.spq || null,
        bpSearchKey: sub.vendorBP,
        vendorName: sub.vendorName,
        vendorNotes: sub.vendorNotes || '',
        dateCode: sub.dateCode || null,
        channel: sub.channel || null,
        currencyId: sub.currencyId || null,
        supplierIdx: globalRowIdx++,
      }));

    for (const row of rowsToWrite) {
      // Restricted-MFR gate — OPT-IN via opts.applyRestrictedMfrGate.
      // Franchise-restricted MFRs (ADI, Maxim, Linear Tech, TI) cannot be
      // bought through franchise distribution. When the caller is a
      // franchise-API path (enrich-rfq, LAM Kitting sourcing, etc.),
      // it passes applyRestrictedMfrGate=true: we still capture API data
      // via chuboe_pricing_api_result (independent path) for market intel,
      // but skip the VQ write.
      //
      // Manual / vendor-direct loaders (LAM EPG lib-load-vq-row.js,
      // load-ti-store-vqs.js, broker VQ loads, etc.) DO NOT pass the flag
      // — TI Store is manufacturer-direct, brokers are non-franchise, and
      // those flows must continue writing VQs for restricted MFRs.
      // Single source of truth: shared/restricted-mfrs.json
      if (opts.applyRestrictedMfrGate) {
        const restrictedCanonical = isRestrictedMfrName(row.mfrText);
        if (restrictedCanonical) {
          skipped.push({
            mpn: row.mpn, vendor: row.vendorName || d.name, price: row.price, qty: row.qty,
            mfrText: row.mfrText, canonical: restrictedCanonical,
            cpc, rfqId: rfq.id, rfqLineId,
            reason: FLAG.RESTRICTED_MFR,
            detail: `MFR '${restrictedCanonical}' franchise-restricted — VQ skipped; pricing captured in chuboe_pricing_api_result`
          });
          continue;
        }
      }

      const mpn = row.mpn;
      const mfrText = row.mfrText;
      const price = row.price;
      const qty = row.qty;
      const leadTime = row.leadTime;
      const moq = row.moq;
      const spq = row.spq;
      const bpSearchKey = row.bpSearchKey;
      const vendorDisplay = row.vendorName || d.name;

    // Cross-reference check: is the API-returned MPN the same part?
    // Packaging variants → write with note. Genuine mismatches → flag (or
    // route through opts.crossRefClassifier if provided).
    let packagingNote = '';
    if (opts.searchedMpn && mpn) {
      const crossRef = checkMpnCrossRef(opts.searchedMpn, mpn);
      if (crossRef.mismatch) {
        // Caller can intercept genuine mismatches with a classifier callback.
        // The callback returns a decision controlling whether to write, flag,
        // or silently drop. Side-effects (e.g. writing to a review queue) are
        // the caller's responsibility — the writer just applies the decision.
        // See shared/crossref-classifier.js + shared/crossref-queue.js for
        // the standard implementation used by enrich-rfq.js.
        let decision = null;
        if (typeof opts.crossRefClassifier === 'function') {
          try {
            decision = await opts.crossRefClassifier({
              searchedMpn: opts.searchedMpn, returnedMpn: mpn,
              rfqMfrText: opts.rfqMfrText || '', supplierMfrText: mfrText,
              rfqValue: rfqSearchKey, rfqId: rfq.id, rfqLineId,
              rfqLineMpnId: opts.rfqLineMpnId || null,
              supplierIdx: row.supplierIdx,
              qty, price, leadTime, moq, spq,
              dateCode: row.dateCode, channel: row.channel,
              vendorNotes: row.vendorNotes, vendorName: vendorDisplay,
              bpSearchKey,
            });
          } catch (err) {
            // Classifier failure must not block the writer — fall through
            // to the default flag behavior.
            decision = null;
          }
        }
        const action = decision?.action || 'flag';
        if (action === 'auto-approve') {
          // Note becomes the audit trail on Chuboe_Note_User.
          packagingNote = decision.note ||
            `Cross-ref auto-approved: ${opts.searchedMpn} → ${mpn}`;
          // fall through to write
        } else if (action === 'auto-reject' || action === 'drop' || action === 'pending') {
          // Silent — classifier already counted it and (for 'pending')
          // wrote to the review queue. No flag, no failure.
          continue;
        } else {
          // 'flag' or unknown — preserve existing behavior.
          flagged.push({
            mpn, searchedMpn: opts.searchedMpn, vendor: vendorDisplay, bpSearchKey,
            price, qty, mfrText, leadTime, moq, spq,
            cpc, rfqId: rfq.id, rfqLineId,
            reason: FLAG.MPN_CROSS_REF,
            detail: `Searched '${opts.searchedMpn}' but API quoted '${mpn}'. Confirm to proceed.`
          });
          continue;
        }
      }
      if (crossRef.suffix) {
        packagingNote = `Quoted MPN: ${mpn} (${crossRef.suffix})`;
      }
    }

    // Resolve BP — search key first, name fallback, same path for all vendors
    let bp = await resolveBP(bpSearchKey, vendorDisplay);
    let vendorNamePrefix = '';

    // Exception: When BP doesn't exist but caller provided unknownVendorPlaceholderBpId,
    // use the placeholder BP and store the actual vendor name in notes. This allows
    // loading quotes from vendors not yet set up in OT without blocking on BP creation.
    // Operator directive 2026-05-26: when asked "note vendor in VQ notes", this path
    // fires instead of the needs_vendor escalation.
    if (!bp && opts.unknownVendorPlaceholderBpId) {
      bp = { id: opts.unknownVendorPlaceholderBpId };
      vendorNamePrefix = `Vendor: ${vendorDisplay}`;
      logger.info(`Using placeholder BP ${opts.unknownVendorPlaceholderBpId} for unknown vendor '${vendorDisplay}' - name stored in notes`);
    }

    if (!bp) {
      flagged.push({
        mpn, vendor: vendorDisplay, bpSearchKey, price, qty,
        reason: FLAG.BP_NOT_FOUND,
        detail: `Vendor '${vendorDisplay}' (SK: ${bpSearchKey || 'none'}) not found in target system`
      });
      continue;
    }

    // Resolve MFR via the unified resolver: text path (Policy D #1) when the
    // distributor returned a manufacturer string; MPN-prefix inference + the
    // acquisition map (Policy D #3) as fallback when text is empty.
    //
    // SYSTEM-ONLY MFRs (AD_Client_ID=0): omit Chuboe_MFR_ID and let the server's
    // bean callout resolve from Chuboe_MFR_Text. This is the same pattern as
    // rfq-writer.js (proven on RFQ 1132040, 2026-04-06). The text field is the
    // load-bearing one.
    // consultMfrHistory: when lookupMfr (alias/cache/db/fuzzy) can't connect
    // the raw label to a canonical chuboe_mfr row, fall back to "what id did
    // we write last time we saw this label?" — see shared/mfr-from-vq-history.js.
    // Same write-side defensive pattern as resolveBPHistorical for BPs.
    const mfrResult = resolveMfrForRow({ mfrText, mpn, consultMfrHistory: true });
    // Sanitize the raw-text fallback — sanitizeMfrText drops U+FFFD
    // mojibake AND infrastructure-noise strings (psql password prompts,
    // fe_sendauth, etc.) so they cannot land in Chuboe_MFR_Text. Without
    // this, a bad mfrText ("Password for user analytics_user:") slipped
    // past the resolver and the writer fell back to the raw value —
    // 459 leak rows between 2026-04-09 and 2026-05-08.
    const mfrCanonical = mfrResult.canonical || sanitizeMfrText(mfrText) || '';
    if (mfrResult.acquisitionApplied) {
      logger.info(`MFR inferred from MPN '${mpn}' via prefix '${mfrResult.prefix}' → ${mfrCanonical} (acquisition: ${mfrResult.originalMfr} → ${mfrCanonical})`);
    }

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

    // Build internal enrichment notes — combine parser-built notes (per-row or
    // top-level) with packaging context. Despite the legacy "vendorNotes" field
    // name, the content is buyer-internal (stock counts, MOQ, MFR tags, packaging
    // confirmations) — NONE of it is vendor-facing. Goes to Chuboe_Note_User.
    // Anything genuinely vendor-safe should be added via opts.publicNote instead.
    //
    // vendorNamePrefix: when BP resolution failed but caller provided
    // unknownVendorPlaceholderBpId, this contains "Vendor: <actual name>" to
    // preserve the original vendor identity in the notes (since the BP field
    // now points to a generic placeholder). Prepended to the notes list so it
    // always appears first.
    const baseNotes = row.vendorNotes || d.vqVendorNotes || '';
    const internalNotes = [vendorNamePrefix, baseNotes, packagingNote].filter(Boolean).join(' | ');

    // Resolve vendor type and traceability from BP
    const vendorTypeId = await getBPVendorType(bp.id);
    const traceabilityId = deriveTraceability(vendorTypeId);

    // Resolve packaging — distributor data wins, then opts fallback.
    // Accepts either an explicit ID (vqPackagingId) or a string (vqPackaging)
    // that we normalize via the shared packaging-lookup cog.
    //
    // Three paths to F-REEL/F-TRAY/F-TUBE per shared/packaging-lookup.js:
    //   1. Explicit factory marker in the input string ("MFR Reel", "F-REEL")
    //   2. Authorized vendor + qty matches/multiplies SPQ (factory pack math)
    //   3. Otherwise → plain REEL/TRAY (or null for TUBE — no plain variant)
    //
    // Caller-side context: the qty + spq + isAuthorized signals are already
    // available in scope from the franchise API result.
    const packagingId = d.vqPackagingId
      || normalizePackaging(d.vqPackaging, {
        qty,
        spq: spq || (d.vqSpq ? Number(d.vqSpq) : null),
        isAuthorized: MFR_DIRECT_OR_FRANCHISE.has(vendorTypeId),
      })
      || opts.packagingId
      || null;

    // Resolve date code — per-row first (multi-source split), then distributor-level,
    // then default. If empty AND vendor is mfr-direct/franchise, pick the right
    // default based on whether this is a stock or LT row:
    //   - Stock row (no leadTime): YY+ (current year - 2). 2-yr-old in-stock
    //     is fine.
    //   - LT row (has leadTime): YY+ (current year). Newly-built parts must
    //     have a current-year date code at minimum.
    // Brokers (and other vendor types) get no default — must come from
    // caller or stay null.
    const dateCodeFromApi = row.dateCode || d.vqDateCode || (d.raw && d.raw.vqDateCode) || null;
    const isLeadTimeRow = !!(row.leadTime && String(row.leadTime).trim());
    const authorizedDefault = isLeadTimeRow
      ? DEFAULT_DATE_CODE_LEAD_TIME
      : DEFAULT_DATE_CODE_STOCK;
    const dateCode = dateCodeFromApi
      || (MFR_DIRECT_OR_FRANCHISE.has(vendorTypeId) ? authorizedDefault : null)
      || opts.dateCode
      || null;

    // HTS / ECCN — sourced from franchise API data when available, with explicit
    // validation on ECCN (chuboe_eccn is varchar(25) and the value flows back to
    // compliance/customs filings, so a malformed write is worse than skipping it).
    // HTS has no regex validator (codes too varied) — only a length guard.
    let htsValue = d.vqHts || opts.hts || null;
    if (htsValue && String(htsValue).length > 25) {
      logger.warn(`HTS value too long for ${vendorDisplay || 'vendor'} on ${mpn}, skipping: ${htsValue}`);
      htsValue = null;
    }
    let eccnValue = d.vqEccn || opts.eccn || null;
    if (eccnValue && !isValidEccn(eccnValue)) {
      logger.warn(`ECCN value failed validation for ${vendorDisplay || 'vendor'} on ${mpn}, skipping: ${eccnValue}`);
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
      C_Currency_ID: row.currencyId || 100, // default USD; Farnell = 114 (GBP)
      Chuboe_Lead_Time: leadTime || null,
      Chuboe_MOQ: moq ? String(moq) : null,
      Chuboe_SPQ: spq ? String(spq) : null,
      // Note routing — three distinct fields on chuboe_vq_line:
      //   Chuboe_Note_Public  → "Public Vendor Order Notes" (flows to POV; vendor sees it)
      //   Chuboe_Note_Private → "Notes to Inspector" (QC/receiving; NOT buyer-internal)
      //   Chuboe_Note_User    → "Buyer Internal Notes" (where our enrichment goes)
      // Parser-built enrichment ALWAYS goes to Chuboe_Note_User. Caller supplies
      // opts.publicNote only if the content is genuinely vendor-safe.
      Chuboe_Note_Public: opts.publicNote || null,
      Chuboe_Note_User:   internalNotes || null,

      // Tier 1 defaults — populated at VQ load time
      C_UOM_ID: opts.uomId || DEFAULTS.C_UOM_ID,
      C_Country_ID: d.vqCooCountryId || opts.cooCountryId || DEFAULTS.C_Country_ID,
      Chuboe_RoHS: d.vqRohs || opts.rohs || DEFAULTS.Chuboe_RoHS,
      Chuboe_Traceability_ID: traceabilityId,
      Chuboe_VendorType_ID: vendorTypeId,
      Chuboe_Date_Code: dateCode,
      // Conditional reference columns — iDempiere REST cannot convert null to a
      // typed reference (AD_User, Chuboe_Packaging, etc.). Sending the field
      // explicitly as null returns 500 "Could not convert value null for X".
      // Omit when we don't have a resolved ID; the bean callout / DB default
      // handles the column. Same pattern as Chuboe_MFR_ID above.
      ...(packagingId ? { Chuboe_Packaging_ID: packagingId } : {}),
      ...(opts.buyerId ? { Chuboe_Buyer_ID: opts.buyerId } : {}),

      // HTS/ECCN — from franchise API data when available (validated above)
      Chuboe_HTS: htsValue,
      Chuboe_ECCN: eccnValue,
    };

    // Validate Tier 1 mandatory fields before writing
    const validation = validatePayload(payload, 1);
    if (!validation.valid) {
      flagged.push({
        mpn, vendor: vendorDisplay, bpId: bp.id, price, qty,
        reason: FLAG.MISSING_MANDATORY,
        detail: `Missing mandatory fields: ${validation.missing.join(', ')}`,
        payload, // include for manual completion
      });
      continue;
    }

    // Check-before-post idempotency guard.
    //
    // apiPost's `naturalKeyFields` only guards against retry-after-failure
    // duplicates (re-POST after a 5xx). It does NOT prevent distinct callers
    // (stacked enrichers, concurrent manual + cron, etc.) from each writing
    // a fresh row for the same logical VQ.
    //
    // Root cause of the 2026-04-14 Honeywell duplicate incident: 20 stacked
    // enricher processes each called writeVQFromAPI for the same RFQ lines,
    // all succeeding independently → 64K duplicate rows.
    //
    // Fix: GET with the natural-key filter before POSTing. If a row already
    // exists, skip (don't double-write). Adds one GET per VQ write but is
    // the only defense against concurrent distinct actors writing the same
    // logical row. Costs ~50-100ms per VQ, acceptable for data integrity.
    // C_Currency_ID is part of the natural key — passive components priced in
    // pennies/pence frequently coincide numerically between USD and GBP at
    // sub-cent values (verified 2026-05-19 during TTI EU smoke load: 7 of 19
    // GBP rows numerically matched pre-existing USD VQs at the same RFQ line
    // / MPN / BP_ID). Omitting currency causes silent drops of legitimate
    // multi-currency writes.
    //
    // Chuboe_Date_Code is part of the natural key — vendors routinely quote
    // the same MPN/qty/cost across distinct DC lots (e.g., 21+ and 23+). DC
    // distinguishes the lot. Omitting it silently drops the second lot
    // (verified 2026-05-21: Southchip's 23+ row was lost on UID 8544 because
    // a 21+ row at the same cost wrote first).
    //
    // Profile VQ deactivation: If this is a priced VQ (cost > 0), check for
    // existing $0 profile VQs from Market Profiler and deactivate them before
    // writing. This replaces the availability placeholder with real quote data.
    // Added 2026-06-11 to keep VQ list clean.
    if (price > 0 && rfqLineId) {
      try {
        const profileResult = await deactivateProfileVQs(rfqLineId, mpn, bp.id);
        if (profileResult.deactivated.length > 0) {
          logger.info(`Deactivated ${profileResult.deactivated.length} profile VQ(s) before writing priced VQ for ${mpn}`);
        }
      } catch (profileErr) {
        // Don't block the write if deactivation fails
        logger.warn(`Profile VQ deactivation failed for ${mpn}: ${profileErr.message}`);
      }
    }

    const NATURAL_KEY_FIELDS = ['Chuboe_RFQ_Line_ID', 'Chuboe_MPN', 'C_BPartner_ID', 'Cost', 'C_Currency_ID', 'Chuboe_Date_Code'];
    try {
      const existingId = findExistingVqIdByNaturalKey(payload);
      if (existingId) {
        // Already written by another caller (concurrent enricher, prior cron
        // tick, manual sourcer-load that happens to share the same natural
        // key, etc.). Route to `skipped` with a documented reason so caller
        // count reconciliation reflects what actually POSTed today — NOT
        // counted as `written`. (Pre-2026-05-20 behavior pushed to `written`
        // with _skippedAsDuplicate:true, which inflated the "claimed" count
        // in the digest and made claimed-vs-active reconciliation lie. See
        // deferred-work § writer accounting bug.)
        skipped.push({
          vqLineId: existingId, mpn, vendor: vendorDisplay, bpId: bp.id,
          mfrId: resolvedMfrId, mfr: mfrCanonical, price, qty,
          channel: row.channel || null,
          reason: FLAG.PRE_EXISTING_DUPLICATE || 'PRE_EXISTING_DUPLICATE',
          detail: `Existing chuboe_vq_line ${existingId} matches natural key (rfq_line × MPN × BP × cost × currency) — no new POST.`,
        });
        continue;
      }
    } catch (checkErr) {
      // If the pre-check fails (psql unavailable, etc.), log and fall through to POST —
      // better to risk a duplicate than to lose a legitimate write.
      // apiPost's naturalKeyFields retry guard is still active below.
    }

    // Write
    try {
      const result = await apiPost('Chuboe_VQ_Line', payload, {
        naturalKeyFields: NATURAL_KEY_FIELDS,
      });
      written.push({
        vqLineId: result.id, mpn, vendor: vendorDisplay, bpId: bp.id,
        mfrId: resolvedMfrId, mfr: mfrCanonical, price, qty,
        channel: row.channel || null,
      });
    } catch (e) {
      const { reason, network } = classifyWriteError(e, FLAG.API_WRITE_ERROR);
      failed.push({
        mpn, vendor: vendorDisplay, bpId: bp.id, price, qty,
        reason,
        network: network || undefined,
        detail: e.message.substring(0, 200)
      });
    }
    } // end row loop
  }

  return { written, flagged, failed, skipped };
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
  const unseenEmailCount = opts.unseenEmailCount || 0;
  const caller = opts.caller || 'vq-loading-agent';
  const estimatedVQs = items.length * 10; // rough estimate: 10 VQs per item on average
  const isBackfill = unseenEmailCount >= 20;

  // ── CHUNKED MODE for large batches ──
  // Large API enrichment batches (500+ items) would fail the budget check.
  // Instead of rejecting, we allow them through and rely on inter-item delays.
  const LARGE_BATCH_THRESHOLD = 200;  // items (each item ≈ 10 VQs)
  const useChunkedMode = items.length > LARGE_BATCH_THRESHOLD;

  if (!useChunkedMode) {
    // TIER 1: Global budget check for smaller batches
    const globalCheck = otBudget.checkBudget({
      table: 'chuboe_vq_line',
      count: estimatedVQs,
      caller,
      isBackfill,
    });

    if (!globalCheck.allowed) {
      logger.warn(`[vq-writer] Global budget exhausted: ${globalCheck.reason}`);
      logger.warn(`[vq-writer] Deferring ${items.length} items (est ${estimatedVQs} VQs)`);
      return {
        written: [],
        flagged: [],
        failed: [],
        skipped: [],
        needsReview: [],
        rateLimited: true,
        rateLimitReason: globalCheck.reason,
        rateLimitTier: 'global',
        summary: {
          total: items.length,
          rateLimited: true,
          message: globalCheck.reason,
        },
      };
    }
  } else {
    // Chunked mode: still check daily limit (skip burst checks - we self-pace)
    // Prevents perfect storm of normal loads + huge batch exceeding daily cap
    const status = otBudget.getStatus();
    const dailyUsed = parseInt(status.globalBudget.lastDay.split('/')[0], 10) || 0;
    const dailyLimit = otBudget.LIMITS.maxWritesPerDay;
    if (dailyUsed + estimatedVQs > dailyLimit) {
      logger.warn(`[vq-writer] Daily budget would be exceeded: ${dailyUsed}/${dailyLimit} + ${estimatedVQs} estimated`);
      return {
        written: [],
        flagged: [],
        failed: [],
        skipped: [],
        needsReview: [],
        rateLimited: true,
        rateLimitReason: `Daily limit: ${dailyUsed}/${dailyLimit} used, need ${estimatedVQs} more`,
        rateLimitTier: 'daily',
        summary: {
          total: items.length,
          rateLimited: true,
          message: `Daily limit: ${dailyUsed}/${dailyLimit} used, need ${estimatedVQs} more`,
        },
      };
    }
    logger.info(`[vq-writer] Large batch detected (${items.length} items, est ${estimatedVQs} VQs) — bypassing upfront budget check, using inter-item delays`);
  }

  // TIER 2: VQ-specific rate limiting (process-specific intelligence)
  // Also bypassed for large batches — they self-pace via inter-item delays
  const rateCheck = rateLimiter.checkVQLimit(estimatedVQs, { unseenEmailCount });
  if (!rateCheck.allowed && !useChunkedMode) {
    logger.warn(`[vq-writer] Rate limit reached: ${rateCheck.reason}`);
    logger.warn(`[vq-writer] Deferring ${items.length} items (est ${estimatedVQs} VQs)`);
    return {
      written: [],
      flagged: [],
      failed: [],
      skipped: [],
      needsReview: [],
      rateLimited: true,
      rateLimitReason: rateCheck.reason,
      summary: {
        total: items.length,
        rateLimited: true,
        message: rateCheck.reason,
      },
    };
  }

  // Use recommended delay based on backfill mode
  const delayMs = opts.delayMs || rateLimiter.getRecommendedDelay(unseenEmailCount);
  const pass2Auto = opts.pass2Auto || false;

  if (rateCheck.backfillMode) {
    logger.info(`[vq-writer] BACKFILL MODE: ${unseenEmailCount} unseen emails, using ${delayMs}ms delay`);
  }

  const allWritten = [];
  const allFlagged = [];
  const allFailed = [];
  const allSkipped = [];
  const allNeedsReview = [];

  // Pre-warm: resolve RFQ (loads CPC and MPN maps)
  const rfq = await resolveRFQ(rfqSearchKey);

  // Pre-warm: resolve all BPs and MFRs.
  // Multi-source distributors (Arrow → Arrow + Verical via d.vqLines) need
  // BOTH the top-level BP and each sub-line BP pre-resolved.
  const vendorSet = new Map();
  const mfrSet = new Set();
  for (const item of items) {
    for (const d of (item.franchiseResults?.distributors || [])) {
      if (!d.found) continue;
      if (Array.isArray(d.vqLines) && d.vqLines.length > 0) {
        for (const sub of d.vqLines) {
          const key = sub.vendorBP || sub.vendorName || '';
          if (!vendorSet.has(key)) vendorSet.set(key, { searchKey: sub.vendorBP, name: sub.vendorName });
          if (sub.manufacturer) mfrSet.add(sub.manufacturer);
        }
      } else {
        const key = d.bpValue || d.name || '';
        if (!vendorSet.has(key)) vendorSet.set(key, { searchKey: d.bpValue, name: d.name });
      }
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

  // Reserve global budget before writing
  otBudget.reserve('chuboe_vq_line', estimatedVQs, 'vq-loading-agent');

  // Claim backfill slot if in backfill mode
  if (isBackfill) {
    otBudget.claimBackfillSlot('vq-loading-agent');
  }

  const writeStartTime = Date.now();

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
    if (result.skipped) allSkipped.push(...result.skipped);

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
        if (result.skipped) allSkipped.push(...result.skipped);
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
    skipped: allSkipped.length,
    needsReview: allNeedsReview.length,
    chunkedMode: useChunkedMode,
    byReason: {},
  };

  for (const f of allFlagged) {
    if (!summary.byReason[f.reason]) summary.byReason[f.reason] = 0;
    summary.byReason[f.reason]++;
  }

  const skippedMsg = allSkipped.length > 0 ? `, ${allSkipped.length} skipped (restricted MFR)` : '';
  console.log(`[vq-writer] Done: ${summary.written} written (${pass1Written} pass1), ${summary.needsReview} needs review, ${summary.flagged} flagged, ${summary.failed} failed${skippedMsg}`);

  // Record writes for rate limiting (both tiers)
  const writeDuration = Date.now() - writeStartTime;

  if (allWritten.length > 0) {
    // Global budget tracking
    otBudget.recordWrites('chuboe_vq_line', allWritten.length, {
      caller,
      success: true,
      durationMs: writeDuration,
    });

    // VQ-specific tracking
    rateLimiter.recordVQWrites(allWritten.length);
    rateLimiter.recordSuccess();
    logger.info(`[vq-writer] Rate limiter: recorded ${allWritten.length} writes. Status: ${JSON.stringify(rateLimiter.getStatus())}`);
  }

  if (allFailed.length > 0) {
    allFailed.forEach(() => {
      rateLimiter.recordFailure();
      otBudget.recordFailure();
    });
  }

  // Release backfill slot if we claimed it
  if (isBackfill) {
    otBudget.releaseBackfillSlot('vq-loading-agent');
  }

  return { written: allWritten, flagged: allFlagged, failed: allFailed, skipped: allSkipped, needsReview: allNeedsReview, summary };
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
  checkMpnCrossRef,
  FLAG,
  DEFAULTS,
  PACKAGING_MAP,
  MFR_DIRECT_OR_FRANCHISE,
  DEFAULT_DATE_CODE_AUTHORIZED, // backward-compat alias for DEFAULT_DATE_CODE_STOCK
  DEFAULT_DATE_CODE_STOCK,
  DEFAULT_DATE_CODE_LEAD_TIME,
  TIER1_MANDATORY,
  TIER2_MANDATORY,
};
