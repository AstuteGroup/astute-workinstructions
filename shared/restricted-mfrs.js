const path = require('path');
const config = require(path.join(__dirname, 'restricted-mfrs.json'));

const RESTRICTED_IDS = new Set();
const RESTRICTED_PATTERNS = [];

for (const entry of config.restricted_mfrs) {
  for (const id of entry.mfr_ids) RESTRICTED_IDS.add(Number(id));
  for (const pat of entry.name_patterns) {
    RESTRICTED_PATTERNS.push({ canonical: entry.canonical, re: new RegExp(pat, 'i') });
  }
}

function isRestrictedMfrId(mfrId) {
  if (mfrId == null) return null;
  const n = Number(mfrId);
  if (Number.isNaN(n)) return null;
  if (!RESTRICTED_IDS.has(n)) return null;
  for (const entry of config.restricted_mfrs) {
    if (entry.mfr_ids.includes(n)) return entry.canonical;
  }
  return null;
}

function isRestrictedMfrName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  for (const p of RESTRICTED_PATTERNS) {
    if (p.re.test(trimmed)) return p.canonical;
  }
  return null;
}

function isRestrictedMfr({ mfrId, mfrName } = {}) {
  return isRestrictedMfrId(mfrId) || isRestrictedMfrName(mfrName);
}

function partitionByRestriction(lines, getMfr) {
  const nonRestricted = [];
  const restricted = [];
  for (const line of lines) {
    const mfr = getMfr(line) || {};
    if (isRestrictedMfr(mfr)) restricted.push(line);
    else nonRestricted.push(line);
  }
  return { nonRestricted, restricted };
}

module.exports = {
  policy: config.policy,
  isRestrictedMfrId,
  isRestrictedMfrName,
  isRestrictedMfr,
  partitionByRestriction,
  RESTRICTED_IDS,
};
