#!/usr/bin/env node
/**
 * HTS / ECCN Backfill — RFQ-scoped
 *
 * Pulls every active VQ line on a given RFQ that's missing HTS or ECCN, calls
 * the franchise APIs to look them up, and PATCHes the values back via the
 * shared record-updater (idempotent — never overwrites populated fields).
 *
 * USAGE:
 *   node hts-eccn-backfill.js --rfq <search_key> [--dry-run] [--limit N]
 *
 * EXAMPLES:
 *   # Dry run — show what would change, no writes
 *   node hts-eccn-backfill.js --rfq 1132040 --dry-run
 *
 *   # Live run against full RFQ
 *   node hts-eccn-backfill.js --rfq 1132040
 *
 *   # Test against a small sample
 *   node hts-eccn-backfill.js --rfq 1132040 --limit 5
 *
 * RESOLUTION RULES (per agreed design):
 *   - Source priority: DigiKey > Mouser (Arrow's standard search doesn't return classification)
 *   - HTS: take highest-priority non-null source. If both return AND digit-stripped
 *          values disagree → leave NULL and log disagreement.
 *   - HTS format: prefer DigiKey's dotted format (8542.33.0001) over Mouser's
 *          flat format (8542330001) — same value, dotted is canonical HS notation.
 *   - ECCN: only use if all returning sources agree (after case-fold). Disagreement → NULL + log.
 *   - Apply resolved values to ALL chuboe_vq_line rows for the (mpn_clean, mfr_text) tuple
 *     on the RFQ — HTS/ECCN are properties of the part, not the seller.
 *   - skipIfNotNull: never overwrite an existing populated value (handled by record-updater).
 *
 * AUDIT TRAIL:
 *   On every run, dumps to ./logs/:
 *     - {timestamp}-resolution-log.json — what each (mpn,mfr) tuple resolved to
 *     - {timestamp}-disagreement-log.json — sources that disagreed
 *     - hts-eccn-backfill-{timestamp}-patch-log.json — successful PATCHes (record-updater)
 *     - hts-eccn-backfill-{timestamp}-skip-log.json — rows already populated
 *     - hts-eccn-backfill-{timestamp}-error-log.json — failures
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SHARED = path.resolve(__dirname, '../../shared');
const { searchAllDistributors } = require(path.join(SHARED, 'franchise-api'));
const { patchBatch } = require(path.join(SHARED, 'record-updater'));
const { ECCN_REGEX } = require(path.join(SHARED, 'validators'));
const logger = require(path.join(SHARED, 'logger')).createLogger('HTS-ECCN');

const LOGS_DIR = path.join(__dirname, 'logs');
const SOURCE_TAG = 'hts-eccn-backfill';

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { rfq: null, dryRun: false, limit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rfq') opts.rfq = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 35).join('\n'));
      process.exit(0);
    }
  }
  if (!opts.rfq) {
    console.error('Missing --rfq <search_key>. Use --help for usage.');
    process.exit(1);
  }
  return opts;
}

// ─── DB QUERIES ──────────────────────────────────────────────────────────────

function psql(sql) {
  const r = spawnSync('psql', ['-A', '-F', '\t', '-t', '-c', sql], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`psql error: ${r.stderr || r.stdout}`);
  }
  return r.stdout
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => l.split('\t'));
}

function resolveRfqId(searchKey) {
  const rows = psql(`SELECT chuboe_rfq_id FROM adempiere.chuboe_rfq WHERE value = '${searchKey.replace(/'/g, "''")}' AND isactive = 'Y' LIMIT 1;`);
  if (rows.length === 0) {
    throw new Error(`RFQ search_key '${searchKey}' not found`);
  }
  return parseInt(rows[0][0], 10);
}

function loadVQLines(rfqId, limit) {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const rows = psql(`
    SELECT
      chuboe_vq_line_id,
      COALESCE(chuboe_mpn_clean, chuboe_mpn) AS mpn_clean,
      chuboe_mpn,
      COALESCE(chuboe_mfr_text, '') AS mfr_text,
      COALESCE(chuboe_mfr_id::text, '') AS mfr_id,
      COALESCE(chuboe_hts, '') AS current_hts,
      COALESCE(chuboe_eccn, '') AS current_eccn
    FROM adempiere.chuboe_vq_line
    WHERE chuboe_rfq_id = ${rfqId}
      AND isactive = 'Y'
      AND (chuboe_hts IS NULL OR chuboe_eccn IS NULL)
    ORDER BY chuboe_vq_line_id
    ${limitClause};
  `);
  return rows.map(r => ({
    id: parseInt(r[0], 10),
    mpnClean: r[1],
    mpn: r[2],
    mfrText: r[3],
    mfrId: r[4],
    currentHts: r[5] || null,
    currentEccn: r[6] || null,
  }));
}

// ─── HTS/ECCN RESOLUTION ─────────────────────────────────────────────────────

/**
 * Strip non-digits from HTS for comparison. "8542.33.0001" → "8542330001".
 */
function normalizeHts(hts) {
  if (!hts) return null;
  return String(hts).replace(/[^0-9]/g, '');
}

/**
 * Resolve HTS from per-source results.
 * @param {object} sources - { digikey: 'val'|null, mouser: 'val'|null }
 * @returns {{ value: string|null, source: string|null, disagreement: object|null }}
 */
function resolveHts(sources) {
  const dk = sources.digikey || null;
  const ms = sources.mouser || null;

  // Both null
  if (!dk && !ms) return { value: null, source: null, disagreement: null };

  // Only one source
  if (dk && !ms) return { value: dk, source: 'digikey', disagreement: null };
  if (!dk && ms) return { value: ms, source: 'mouser', disagreement: null };

  // Both present — compare normalized
  if (normalizeHts(dk) === normalizeHts(ms)) {
    // Agree — prefer DigiKey's dotted format
    return { value: dk, source: 'digikey+mouser', disagreement: null };
  }

  // Disagree — leave blank, return both for log
  return { value: null, source: null, disagreement: { digikey: dk, mouser: ms } };
}

/**
 * Resolve ECCN from per-source results. Stricter than HTS — only use on full agreement.
 */
function resolveEccn(sources) {
  const present = Object.entries(sources).filter(([, v]) => v != null && v !== '');
  if (present.length === 0) return { value: null, source: null, disagreement: null };

  if (present.length === 1) {
    const [src, val] = present[0];
    return { value: val, source: src, disagreement: null };
  }

  // Multiple sources — all must agree (case-insensitive)
  const normalized = present.map(([, v]) => String(v).trim().toUpperCase());
  const allAgree = normalized.every(v => v === normalized[0]);

  if (allAgree) {
    // Use first source's value (preserves original casing)
    return { value: present[0][1], source: present.map(p => p[0]).join('+'), disagreement: null };
  }

  return {
    value: null,
    source: null,
    disagreement: Object.fromEntries(present),
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startedAt = new Date();
  const timestamp = startedAt.toISOString().replace(/:/g, '-').replace(/\..+/, '');

  console.log(`\n=== HTS/ECCN Backfill ===`);
  console.log(`RFQ search_key:    ${opts.rfq}`);
  console.log(`Mode:              ${opts.dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (opts.limit) console.log(`Limit:             ${opts.limit}`);
  console.log(`Started:           ${startedAt.toISOString()}\n`);

  // Step 1: Resolve RFQ
  const rfqId = resolveRfqId(opts.rfq);
  console.log(`Resolved RFQ:      chuboe_rfq_id=${rfqId}`);

  // Step 2: Load in-scope VQ lines
  const vqLines = loadVQLines(rfqId, opts.limit);
  console.log(`In-scope VQ lines: ${vqLines.length}\n`);

  if (vqLines.length === 0) {
    console.log('Nothing to backfill — every line already has both HTS and ECCN.');
    return;
  }

  // Step 3: Group by (mpn_clean, mfr_text) — one API call set per unique tuple
  const groups = new Map();
  for (const line of vqLines) {
    const key = `${line.mpnClean}||${line.mfrText}`;
    if (!groups.has(key)) {
      groups.set(key, {
        mpn: line.mpn,
        mpnClean: line.mpnClean,
        mfrText: line.mfrText,
        lines: [],
      });
    }
    groups.get(key).lines.push(line);
  }
  console.log(`Distinct (mpn, mfr) tuples to query: ${groups.size}\n`);

  // Step 4: For each group, call DigiKey + Mouser, resolve
  const resolutions = [];
  const disagreements = [];
  let i = 0;
  const groupArray = Array.from(groups.values());

  for (const group of groupArray) {
    i++;
    process.stdout.write(`\r[${i}/${groupArray.length}] ${group.mpn}`.padEnd(80));

    let dkHts = null, dkEccn = null, msHts = null, msEccn = null;
    const errors = [];

    try {
      const search = await searchAllDistributors(group.mpn, 1, {
        exclude: ['arrow', 'rutronik', 'future', 'newark', 'tti', 'master', 'waldom', 'sager'],
      });

      for (const d of search.distributors) {
        if (d.distributor === 'digikey') {
          dkHts = d.vqHts || null;
          dkEccn = d.vqEccn || null;
          if (d.error) errors.push(`digikey: ${d.error}`);
        } else if (d.distributor === 'mouser') {
          msHts = d.vqHts || null;
          msEccn = d.vqEccn || null;
          if (d.error) errors.push(`mouser: ${d.error}`);
        }
      }
    } catch (err) {
      errors.push(`searchAllDistributors: ${err.message}`);
    }

    const htsResult = resolveHts({ digikey: dkHts, mouser: msHts });
    const eccnResult = resolveEccn({ digikey: dkEccn, mouser: msEccn });

    const resolution = {
      mpn: group.mpn,
      mpnClean: group.mpnClean,
      mfrText: group.mfrText,
      lineCount: group.lines.length,
      sources: { digikey: { hts: dkHts, eccn: dkEccn }, mouser: { hts: msHts, eccn: msEccn } },
      resolved: {
        hts: htsResult.value,
        htsSource: htsResult.source,
        eccn: eccnResult.value,
        eccnSource: eccnResult.source,
      },
      errors,
    };
    resolutions.push(resolution);

    if (htsResult.disagreement) {
      disagreements.push({ kind: 'hts', mpn: group.mpn, mfrText: group.mfrText, ...htsResult.disagreement });
    }
    if (eccnResult.disagreement) {
      disagreements.push({ kind: 'eccn', mpn: group.mpn, mfrText: group.mfrText, ...eccnResult.disagreement });
    }
  }
  process.stdout.write('\r' + ' '.repeat(80) + '\r');

  // Step 5: Build patchBatch updates — one entry per VQ line
  const updates = [];
  for (const r of resolutions) {
    if (r.resolved.hts === null && r.resolved.eccn === null) continue;
    const group = groups.get(`${r.mpnClean}||${r.mfrText}`);
    for (const line of group.lines) {
      const payload = {};
      if (r.resolved.hts !== null) payload.Chuboe_HTS = r.resolved.hts;
      if (r.resolved.eccn !== null) payload.Chuboe_ECCN = r.resolved.eccn;
      if (Object.keys(payload).length > 0) {
        updates.push({ id: line.id, payload });
      }
    }
  }

  // Step 6: Summary
  const stats = {
    totalGroups: resolutions.length,
    groupsWithHts: resolutions.filter(r => r.resolved.hts !== null).length,
    groupsWithEccn: resolutions.filter(r => r.resolved.eccn !== null).length,
    groupsBothNull: resolutions.filter(r => r.resolved.hts === null && r.resolved.eccn === null).length,
    htsDisagreements: disagreements.filter(d => d.kind === 'hts').length,
    eccnDisagreements: disagreements.filter(d => d.kind === 'eccn').length,
    vqLinesToPatch: updates.length,
  };

  console.log('=== Resolution Summary ===');
  console.log(`Distinct tuples queried:     ${stats.totalGroups}`);
  console.log(`  with resolved HTS:         ${stats.groupsWithHts}`);
  console.log(`  with resolved ECCN:        ${stats.groupsWithEccn}`);
  console.log(`  no data either side:       ${stats.groupsBothNull}`);
  console.log(`  HTS disagreements:         ${stats.htsDisagreements}`);
  console.log(`  ECCN disagreements:        ${stats.eccnDisagreements}`);
  console.log(`VQ line PATCHes to apply:    ${stats.vqLinesToPatch}\n`);

  // Step 7: Always write resolution + disagreement logs
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const resPath = path.join(LOGS_DIR, `${timestamp}-resolution-log.json`);
  fs.writeFileSync(resPath, JSON.stringify({ rfq: opts.rfq, rfqId, stats, resolutions }, null, 2));
  console.log(`Resolution log:    ${resPath}`);
  if (disagreements.length > 0) {
    const disPath = path.join(LOGS_DIR, `${timestamp}-disagreement-log.json`);
    fs.writeFileSync(disPath, JSON.stringify(disagreements, null, 2));
    console.log(`Disagreement log:  ${disPath}`);
  }

  // Step 8: Dry-run sample preview
  if (opts.dryRun) {
    console.log(`\n=== DRY RUN — sample of proposed PATCHes (first 10) ===`);
    for (const u of updates.slice(0, 10)) {
      console.log(`  vq_line_id=${u.id}  ${JSON.stringify(u.payload)}`);
    }
    console.log(`\n(${updates.length - Math.min(10, updates.length)} more not shown)`);
    console.log(`\nDry run complete. Re-run without --dry-run to apply.`);
    return;
  }

  // Step 9: Live patch
  if (updates.length === 0) {
    console.log('No updates to apply. Done.');
    return;
  }

  console.log(`\n=== Applying ${updates.length} PATCHes ===`);
  const summary = await patchBatch('chuboe_vq_line', updates, {
    skipIfNotNull: ['Chuboe_HTS', 'Chuboe_ECCN'],
    validate: { Chuboe_ECCN: ECCN_REGEX },
    concurrency: 5,
    source: SOURCE_TAG,
    auditDir: LOGS_DIR,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} processed`),
  });
  process.stdout.write('\n');

  console.log(`\n=== PATCH Summary ===`);
  console.log(`Total processed:       ${summary.total}`);
  console.log(`  patched:             ${summary.patched}`);
  console.log(`  skipped (already set): ${summary.skipped}`);
  console.log(`  validation failed:   ${summary.validationFailed}`);
  console.log(`  errors:              ${summary.errors}`);
  console.log(`\nAudit logs in:         ${LOGS_DIR}`);
  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`Elapsed:               ${elapsed}s`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
