#!/usr/bin/env node
/**
 * MPN Prefix Mining Script — C15 Bootstrap
 *
 * Mines `chuboe_vq_line` history for `(MPN prefix, MFR ID)` pairs that
 * consistently appear together. Produces a candidate-additions JSON for
 * human review, to be merged into `shared/data/mpn-prefixes.json`.
 *
 * Why this exists:
 *   The C15 MPN→MFR inference cog ships with a hand-curated 75-entry
 *   seed prefix table. Real coverage of all the parts Astute touches
 *   needs probably 300-500+ prefixes. This script extracts candidates
 *   from real Astute VQ history (where rows have BOTH MPN and MFR
 *   populated), surfacing prefixes where one MFR clearly dominates.
 *   Operator reviews + approves before merging into the canonical table.
 *
 * Algorithm:
 *   1. Query chuboe_vq_line for all rows with non-null mpn_clean + mfr_id
 *   2. For each prefix length 2-6, group rows by (prefix, mfr_id) and
 *      count co-occurrences
 *   3. For each prefix that appears at least MIN_OCCURRENCES times total,
 *      check if one MFR accounts for at least DOMINANT_THRESHOLD of the
 *      rows (default 80%)
 *   4. Resolve mfr_id → canonical name via chuboe_mfr table
 *   5. Filter out prefixes already in mpn-prefixes.json
 *   6. Filter out prefixes that are too generic (1 char) or contain
 *      digits-only (probably part of a serial number, not a brand prefix)
 *   7. Sort candidates by confidence (% dominant) × volume
 *   8. Output a candidate JSON file for human review
 *
 * USAGE:
 *
 *   node ~/workspace/astute-workinstructions/scripts/mine-mpn-prefixes.js
 *   node ~/workspace/astute-workinstructions/scripts/mine-mpn-prefixes.js --min-occurrences 50 --dominant 0.9
 *   node ~/workspace/astute-workinstructions/scripts/mine-mpn-prefixes.js --output ./candidates.json
 *
 * REVIEW WORKFLOW:
 *   1. Run the script → outputs candidates.json
 *   2. Review each candidate: does the prefix really mean that MFR?
 *      Common failure mode: the prefix matches a series within a brand
 *      that's also used by other brands (e.g., "C0" for Kemet ceramics
 *      vs C0805 for any 0805 cap)
 *   3. Approved entries → manually merge into shared/data/mpn-prefixes.json
 *   4. Re-run mfr-resolver smoke tests to confirm nothing breaks
 *
 * RE-RUN CADENCE:
 *   Quarterly is enough. The prefix table is mostly stable; new entries
 *   come from new manufacturer product lines. Scheduled as a Bucket B
 *   reminder for ~3 months from the bootstrap run date.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PREFIX_FILE = path.join(REPO, 'shared/data/mpn-prefixes.json');
const DEFAULT_OUTPUT = path.join(REPO, 'shared/data/mpn-prefixes-candidates.json');

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    minOccurrences: 20,        // prefix must appear at least this many times
    dominantThreshold: 0.80,   // dominant MFR must account for ≥this fraction
    minPrefixLength: 2,
    maxPrefixLength: 6,
    output: DEFAULT_OUTPUT,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-occurrences') opts.minOccurrences = parseInt(args[++i], 10);
    else if (args[i] === '--dominant') opts.dominantThreshold = parseFloat(args[++i]);
    else if (args[i] === '--min-prefix') opts.minPrefixLength = parseInt(args[++i], 10);
    else if (args[i] === '--max-prefix') opts.maxPrefixLength = parseInt(args[++i], 10);
    else if (args[i] === '--output') opts.output = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
  }
  return opts;
}

// ─── DB QUERY ────────────────────────────────────────────────────────────────

function psql(sql) {
  const r = execSync(`psql -A -F '\t' -t -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    timeout: 60000,
  });
  return r.split('\n').filter(l => l.trim() !== '').map(l => l.split('\t'));
}

// ─── EXISTING PREFIX SET ─────────────────────────────────────────────────────

function loadExistingPrefixes() {
  try {
    const data = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf-8'));
    return new Set(Object.keys(data.prefixes || {}).filter(k => !k.startsWith('_')));
  } catch (err) {
    console.error(`[mine] Failed to load existing prefixes: ${err.message}`);
    return new Set();
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 60).join('\n'));
    return 0;
  }

  console.log('=== MPN Prefix Mining ===');
  console.log(`Min occurrences:    ${opts.minOccurrences}`);
  console.log(`Dominant threshold: ${(opts.dominantThreshold * 100).toFixed(0)}%`);
  console.log(`Prefix length:      ${opts.minPrefixLength}-${opts.maxPrefixLength}`);
  console.log(`Existing prefixes:  ${loadExistingPrefixes().size} (will be skipped)`);
  console.log('');

  const existing = loadExistingPrefixes();

  // Aggregate by every prefix length, then merge into one map keyed by uppercase prefix
  // Map structure: prefix → { mfrs: { mfrName: count }, total: number }
  const byPrefix = new Map();

  for (let len = opts.minPrefixLength; len <= opts.maxPrefixLength; len++) {
    console.log(`Mining prefix length ${len}...`);
    // SQL: group VQ rows by (uppercase prefix of mpn_clean, mfr name) and count
    // Filter: only rows with non-null mfr_id AND mpn_clean of at least the prefix length
    const sql = `
      SELECT
        UPPER(SUBSTRING(vl.chuboe_mpn_clean FROM 1 FOR ${len})) AS prefix,
        mfr.name AS mfr_name,
        COUNT(*) AS cnt
      FROM adempiere.chuboe_vq_line vl
      JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = vl.chuboe_mfr_id
      WHERE vl.isactive = 'Y'
        AND vl.chuboe_mpn_clean IS NOT NULL
        AND LENGTH(vl.chuboe_mpn_clean) >= ${len}
        AND vl.chuboe_mfr_id IS NOT NULL
        AND mfr.isactive = 'Y'
      GROUP BY 1, 2
      HAVING COUNT(*) >= 5
      ORDER BY 1, 3 DESC
    `;

    const rows = psql(sql);
    for (const row of rows) {
      const [prefix, mfrName, cntStr] = row;
      const cnt = parseInt(cntStr, 10);
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, { mfrs: {}, total: 0 });
      }
      const entry = byPrefix.get(prefix);
      entry.mfrs[mfrName] = (entry.mfrs[mfrName] || 0) + cnt;
      entry.total += cnt;
    }
  }

  console.log('');
  console.log(`Total distinct prefixes (any length, any MFR co-occurrence ≥5): ${byPrefix.size}`);
  console.log('');

  // Build candidates: prefixes meeting min occurrences + dominant threshold + not already in table
  const candidates = [];
  const rejectedReasons = { tooFewOccurrences: 0, notDominant: 0, alreadyKnown: 0, allDigits: 0 };

  for (const [prefix, entry] of byPrefix.entries()) {
    if (entry.total < opts.minOccurrences) {
      rejectedReasons.tooFewOccurrences++;
      continue;
    }
    if (existing.has(prefix)) {
      rejectedReasons.alreadyKnown++;
      continue;
    }
    if (/^[0-9]+$/.test(prefix)) {
      // Pure-digit prefixes are noise (probably part of part numbers)
      rejectedReasons.allDigits++;
      continue;
    }

    // Find dominant MFR
    const sortedMfrs = Object.entries(entry.mfrs).sort((a, b) => b[1] - a[1]);
    const [topMfr, topCount] = sortedMfrs[0];
    const dominantPct = topCount / entry.total;

    if (dominantPct < opts.dominantThreshold) {
      rejectedReasons.notDominant++;
      continue;
    }

    candidates.push({
      prefix,
      mfr: topMfr,
      occurrences: entry.total,
      topMfrCount: topCount,
      dominantPct: parseFloat(dominantPct.toFixed(3)),
      otherMfrs: sortedMfrs.slice(1, 4).map(([name, count]) => ({ name, count })),
      score: dominantPct * Math.log(entry.total + 1),  // confidence × volume
    });
  }

  // Sort by score (highest leverage first)
  candidates.sort((a, b) => b.score - a.score);

  console.log('=== Mining Summary ===');
  console.log(`Candidates passing all filters: ${candidates.length}`);
  console.log(`Rejected (too few occurrences): ${rejectedReasons.tooFewOccurrences}`);
  console.log(`Rejected (not dominant):        ${rejectedReasons.notDominant}`);
  console.log(`Rejected (already in table):    ${rejectedReasons.alreadyKnown}`);
  console.log(`Rejected (digits only):         ${rejectedReasons.allDigits}`);
  console.log('');

  if (candidates.length === 0) {
    console.log('No candidates surfaced. Try lowering --min-occurrences or --dominant threshold.');
    return 0;
  }

  console.log('=== Top 30 Candidates (highest score) ===');
  console.log('prefix'.padEnd(10), 'occ'.padEnd(7), 'dom%'.padEnd(7), 'mfr');
  console.log('------'.padEnd(10), '---'.padEnd(7), '----'.padEnd(7), '---');
  candidates.slice(0, 30).forEach(c => {
    console.log(
      c.prefix.padEnd(10),
      String(c.occurrences).padEnd(7),
      (c.dominantPct * 100).toFixed(1).padEnd(7),
      c.mfr
    );
  });

  // Write candidates JSON
  const output = {
    _generated: new Date().toISOString(),
    _generatedBy: 'mine-mpn-prefixes.js',
    _params: opts,
    _instructions: 'Review each candidate. For approved entries, copy the prefix → mfr mapping into shared/data/mpn-prefixes.json under the "prefixes" key. Use the canonical chuboe_mfr.name (already done — these were resolved against the live DB). After merging, re-run mfr-resolver smoke tests.',
    candidates,
  };
  fs.writeFileSync(opts.output, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(`Wrote ${candidates.length} candidates to ${opts.output}`);
  console.log('');
  console.log('Next step: review each candidate, merge approved entries into shared/data/mpn-prefixes.json');

  return 0;
}

main().then(code => process.exit(code || 0)).catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
