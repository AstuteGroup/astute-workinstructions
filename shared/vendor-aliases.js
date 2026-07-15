/**
 * shared/vendor-aliases.js
 *
 * Lookup helper for curated vendor-label aliases — the structural blind spot
 * of resolveBP / resolveBPHistorical.
 *
 * Why a separate static map exists alongside the historical fallback:
 *
 *   * `resolveBP` Phase 1 (strict normalize) catches case + punctuation
 *     variants of the canonical name.
 *   * `resolveBP` Phase 2 (Levenshtein ≤ 2) catches typos like
 *     "Savilter" → "Saviliter".
 *   * `resolveBPHistorical` catches short labels that have been previously
 *     written under that exact label (the operational history learns).
 *
 * Acronyms break all three: "XJH" is not a typo of any chunk of "Xin Jun
 * Hong (HK) Industry Co., Ltd", and the historical store has zero rows
 * stored under the literal label "XJH" (operator clarify-replies always
 * resolved to the canonical name pre-write).
 *
 * This file is for those cases. Small, curated, governance documented in
 * the JSON's _comment field.
 *
 * Read path: in-process cache, ~5 min TTL so edits become visible without
 * a restart. (Same pattern as user-role-registry.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'vendor-aliases.json');
const TTL_MS = 5 * 60 * 1000;

let _cache = null;
let _cacheAt = 0;

function load() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < TTL_MS) return _cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    // Build a normalized lookup: UPPERCASE + collapsed-whitespace key.
    // Values are objects { searchKey, name }.
    const normalized = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;  // skip _comment/_format/_governance
      if (!v || typeof v !== 'object') continue;
      if (!v.searchKey || typeof v.searchKey !== 'string') continue;
      normalized[normalizeKey(k)] = { searchKey: v.searchKey, name: v.name || null };
    }
    _cache = normalized;
    _cacheAt = now;
  } catch (_) {
    _cache = {};
    _cacheAt = now;
  }
  return _cache;
}

function normalizeKey(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * If `label` matches a curated alias, return `{ searchKey, name }`.
 * Otherwise return null.
 *
 * The caller (resolveBP) uses the searchKey to look up the BP via the
 * exact-match Value field — bypasses fuzzy name matching and the
 * iDempiere REST 500 trap on special-char canonical names.
 */
function lookupVendorAlias(label) {
  if (!label || typeof label !== 'string') return null;
  const key = normalizeKey(label);
  if (!key) return null;
  const aliases = load();
  return aliases[key] || null;
}

/**
 * Learn a vendor alias from a successful clarify_vendor resolution.
 * Called automatically when an operator picks a vendor from the candidates
 * and the VQ load succeeds.
 *
 * Guards:
 *   - Label must be ≥ 3 chars (too short = too generic)
 *   - Label must NOT be a substring of the BP name (historical fallback handles those)
 *   - Alias must not already exist for this label
 *
 * @param {string} label      Original vendor label that failed to resolve
 * @param {string} searchKey  BP search key (c_bpartner.value) that was selected
 * @param {string} name       BP canonical name (for human readability)
 * @returns {{ learned: boolean, reason: string }}
 */
function learnVendorAlias(label, searchKey, name) {
  if (!label || typeof label !== 'string') {
    return { learned: false, reason: 'no label' };
  }
  if (!searchKey || typeof searchKey !== 'string') {
    return { learned: false, reason: 'no searchKey' };
  }

  const key = normalizeKey(label);
  if (key.length < 3) {
    return { learned: false, reason: 'label too short (< 3 chars)' };
  }

  // Don't learn if the label is a substring of the BP name — historical fallback handles those
  const normName = normalizeKey(name || '');
  if (normName && normName.includes(key)) {
    return { learned: false, reason: 'label is substring of BP name (historical fallback will catch it)' };
  }

  // Check if already exists
  const existing = lookupVendorAlias(label);
  if (existing) {
    if (existing.searchKey === searchKey) {
      return { learned: false, reason: 'alias already exists (same mapping)' };
    }
    // Different mapping exists — don't overwrite, log warning
    console.warn(`[vendor-aliases] CONFLICT: "${label}" already maps to ${existing.searchKey} (${existing.name}), not overwriting with ${searchKey} (${name})`);
    return { learned: false, reason: `conflict: already maps to ${existing.searchKey}` };
  }

  // Read raw JSON, add entry, write back
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);

    // Use the original label casing as the key (normalized lookup still works)
    obj[label.trim()] = {
      searchKey: String(searchKey),
      name: name || null,
      learned: new Date().toISOString(),  // audit trail
    };

    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2) + '\n');

    // Invalidate cache so next lookup sees the new entry
    _cache = null;
    _cacheAt = 0;

    console.log(`[vendor-aliases] LEARNED: "${label}" → ${searchKey} (${name})`);
    return { learned: true, reason: 'added to vendor-aliases.json' };
  } catch (err) {
    console.error(`[vendor-aliases] Failed to learn alias: ${err.message}`);
    return { learned: false, reason: `write error: ${err.message}` };
  }
}

module.exports = { lookupVendorAlias, learnVendorAlias };
