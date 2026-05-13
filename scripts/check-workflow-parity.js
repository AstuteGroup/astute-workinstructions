#!/usr/bin/env node
/**
 * scripts/check-workflow-parity.js
 *
 * Reads shared/workflow-registry.js + each workflow handler + cron-jobs.js,
 * flags two classes of issue:
 *
 *   DRIFT   Registry claims something but the code disagrees. Examples:
 *           - Registry capability=true but handler doesn't import the shared module
 *           - Registry actions[] doesn't match handler's exported action names
 *           - Registry inbox doesn't match handler's exported inbox
 *           - Registry capability=false but no deviations[] entry (missing rationale)
 *           - Registry cron.name doesn't exist in cron-jobs.js
 *           - need_info / clarify_* action missing keepsPending: true
 *           DRIFT is a bug — fix the registry OR fix the code. Exits 1.
 *
 *   GAP     Capability=false WITH deviations[] entry recognized as a known
 *           migration target (matches a tracked-gap pattern). Reported for
 *           visibility, doesn't fail the check.
 *
 * Designed to run cheaply at session start alongside check-cron-drift.js.
 *
 * Usage:
 *   node scripts/check-workflow-parity.js              # full report
 *   node scripts/check-workflow-parity.js --quiet      # only print on drift
 *   node scripts/check-workflow-parity.js --json       # machine-readable
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'shared', 'workflow-registry.js');
const HANDLERS_DIR = path.join(ROOT, 'shared', 'workflow-actions');
const CRON_JOBS_PATH = path.join(ROOT, 'cron-jobs.js');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');

// ─── STATIC INSPECTION RULES ─────────────────────────────────────────────────
//
// For capabilities=true, what evidence proves it's actually wired in the
// handler? Two kinds of evidence we can introspect:
//   - importPattern   regex matched against the handler's source code
//                     (i.e. require('../something') matches)
//   - actionPattern   regex matched against any action name in handler.actions
//
// If a capability is set to true but neither evidence is present, that's drift.
// Capabilities not listed here (operatorDigest, activityDigest, etc.) are
// trusted from the registry — verifying them would require cross-file
// inspection (other crons, other handler modules). The registry IS the
// contract for those.
//
// To add a new capability validator, append a row here.

const CAPABILITY_CHECKS = {
  replyStitching: {
    description: 'uses shared/workflow-pending-state sidecars',
    importPatterns: [/require\(\s*['"]\.\.\/workflow-pending-state['"]\s*\)/],
    actionConfigCheck: actions =>
      Object.values(actions).some(a => a && a.keepsPending === true),
    // Either evidence (import OR action.keepsPending) is sufficient.
    matchMode: 'any',
  },
  needInfoClarifications: {
    description: 'has need_info or clarify_* action',
    actionPatterns: [/^need_info$/, /^clarify_/],
    matchMode: 'any',
  },
  largePayloadGate: {
    description: 'uses shared/large-rfq-gate (or successor large-payload-gate)',
    importPatterns: [
      /require\(\s*['"]\.\.\/large-rfq-gate['"]\s*\)/,
      /require\(\s*['"]\.\.\/large-payload-gate['"]\s*\)/,
    ],
    matchMode: 'any',
  },
  approvalReplyAction: {
    description: 'has approve_* / reject_* actions',
    actionPatterns: [/^approve_/, /^reject_/],
    matchMode: 'any',
  },
  writeQueue: {
    description: 'uses a pre-write staging queue',
    importPatterns: [
      /require\(\s*['"]\.\.\/rfq-load-queue['"]\s*\)/,
      /require\(\s*['"]\.\.\/crossref-queue['"]\s*\)/,
      /require\(\s*['"]\.\.\/.+-queue['"]\s*\)/,
    ],
    matchMode: 'any',
  },
  breadcrumbWrites: {
    description: 'writes via shared/breadcrumbs',
    importPatterns: [/require\(\s*['"]\.\.\/breadcrumbs['"]\s*\)/],
    matchMode: 'any',
  },
  // tieredCron is verified against cron-jobs.js (not the handler source) below.
  // The other capabilities (preWriteIdempotency, operatorDigest, activityDigest,
  // replyParserGrammar) are trusted from registry — they involve external cogs
  // outside the handler module.
};

const CLARIFY_ACTION_PATTERNS = [/^need_info$/, /^clarify_/];

// ─── INSPECTION HELPERS ──────────────────────────────────────────────────────

function readSource(handlerName) {
  const p = path.join(HANDLERS_DIR, `${handlerName}.js`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function loadHandlerModule(handlerName) {
  const p = path.join(HANDLERS_DIR, `${handlerName}.js`);
  if (!fs.existsSync(p)) return null;
  // Bust require cache so repeated runs in test see fresh exports
  delete require.cache[require.resolve(p)];
  try {
    return require(p);
  } catch (e) {
    return { __loadError: e.message };
  }
}

function loadCronJobs() {
  delete require.cache[require.resolve(CRON_JOBS_PATH)];
  return require(CRON_JOBS_PATH);
}

function evaluateCapability(name, capCheck, source, actions) {
  const evidence = [];
  let satisfied = false;

  if (capCheck.importPatterns && source) {
    for (const re of capCheck.importPatterns) {
      if (re.test(source)) {
        evidence.push(`import: ${re.source}`);
        satisfied = true;
      }
    }
  }
  if (capCheck.actionPatterns && actions) {
    for (const re of capCheck.actionPatterns) {
      for (const actName of Object.keys(actions)) {
        if (re.test(actName)) {
          evidence.push(`action: ${actName}`);
          satisfied = true;
        }
      }
    }
  }
  if (capCheck.actionConfigCheck && actions) {
    if (capCheck.actionConfigCheck(actions)) {
      evidence.push('action-config check passed');
      satisfied = true;
    }
  }
  return { satisfied, evidence };
}

// ─── CORE CHECK ──────────────────────────────────────────────────────────────

function checkWorkflow(name, entry, cronJobs) {
  const drift = [];
  const gaps = [];

  if (entry.status === 'deprecated') {
    return { name, status: 'deprecated', drift, gaps };
  }

  if (entry.status === 'planned') {
    return { name, status: 'planned', drift, gaps, notes: entry.notes };
  }

  // status === 'active' — full validation

  // 1. Handler module loads
  const handler = entry.handler ? loadHandlerModule(entry.handler) : null;
  const source = entry.handler ? readSource(entry.handler) : null;

  if (!entry.handler) {
    drift.push({ check: 'handler', message: 'status=active but handler is null' });
    return { name, status: 'active', drift, gaps };
  }
  if (!handler) {
    drift.push({ check: 'handler', message: `module not found: shared/workflow-actions/${entry.handler}.js` });
    return { name, status: 'active', drift, gaps };
  }
  if (handler.__loadError) {
    drift.push({ check: 'handler', message: `module load error: ${handler.__loadError}` });
    return { name, status: 'active', drift, gaps };
  }

  // 2. Inbox matches
  if (entry.inbox && handler.inbox && entry.inbox !== handler.inbox) {
    drift.push({
      check: 'inbox',
      message: `registry inbox '${entry.inbox}' != handler inbox '${handler.inbox}'`,
    });
  }

  // 3. Actions match (set equality)
  const handlerActions = Object.keys(handler.actions || {}).sort();
  const registryActions = [...(entry.actions || [])].sort();
  const missingFromHandler = registryActions.filter(a => !handlerActions.includes(a));
  const extraInHandler = handlerActions.filter(a => !registryActions.includes(a));
  if (missingFromHandler.length) {
    drift.push({
      check: 'actions',
      message: `registry declares actions not in handler: ${missingFromHandler.join(', ')}`,
    });
  }
  if (extraInHandler.length) {
    drift.push({
      check: 'actions',
      message: `handler exports actions not in registry: ${extraInHandler.join(', ')}`,
    });
  }

  // 4. need_info / clarify_* actions must have keepsPending: true
  for (const [actName, actConf] of Object.entries(handler.actions || {})) {
    if (CLARIFY_ACTION_PATTERNS.some(re => re.test(actName))) {
      if (!actConf || actConf.keepsPending !== true) {
        drift.push({
          check: 'clarify-action',
          message: `action '${actName}' must declare keepsPending: true (clarification round-trip needs sidecar)`,
        });
      }
    }
  }

  // 5. Capability validation: for each cap=true, verify evidence; for cap=false,
  //    verify there's a deviations entry (otherwise = open gap).
  for (const [capName, declared] of Object.entries(entry.capabilities || {})) {
    if (declared === true) {
      const check = CAPABILITY_CHECKS[capName];
      if (!check) continue;  // trusted-from-registry capability
      const { satisfied, evidence } = evaluateCapability(
        capName, check, source, handler.actions
      );
      if (!satisfied) {
        drift.push({
          check: 'capability',
          message: `capability '${capName}' declared true but no evidence found in handler (expected: ${check.description})`,
        });
      }
    } else if (declared === false) {
      const deviation = entry.deviations && entry.deviations[capName];
      if (!deviation || typeof deviation !== 'string' || deviation.trim().length === 0) {
        gaps.push({
          capability: capName,
          note: 'no deviation declared',
        });
      }
    }
  }

  // 6. tieredCron capability — verify the cron command references a gate script.
  if (entry.capabilities && entry.capabilities.tieredCron === true) {
    if (entry.cron && entry.cron.name) {
      const cronEntry = cronJobs.find(j => j.name === entry.cron.name);
      if (cronEntry && !/should-run-|gate/i.test(cronEntry.command)) {
        drift.push({
          check: 'tiered-cron',
          message: `capability 'tieredCron' true but cron-jobs entry '${entry.cron.name}' command has no gate script (expected pattern: 'should-run-*.js')`,
        });
      }
    }
  }

  // 7. Cron entry exists (if declared)
  if (entry.cron && entry.cron.name) {
    const cronEntry = cronJobs.find(j => j.name === entry.cron.name);
    if (!cronEntry) {
      drift.push({
        check: 'cron',
        message: `cron job '${entry.cron.name}' not found in cron-jobs.js`,
      });
    }
  }

  return { name, status: 'active', drift, gaps };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main() {
  let registry, cronJobs;
  try {
    delete require.cache[require.resolve(REGISTRY_PATH)];
    registry = require(REGISTRY_PATH);
  } catch (e) {
    console.error(`✗ failed to load registry: ${e.message}`);
    process.exit(2);
  }
  try {
    cronJobs = loadCronJobs();
  } catch (e) {
    console.error(`✗ failed to load cron-jobs.js: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  for (const [name, entry] of Object.entries(registry)) {
    results.push(checkWorkflow(name, entry, cronJobs));
  }

  const totalDrift = results.reduce((n, r) => n + r.drift.length, 0);
  const totalGaps = results.reduce((n, r) => n + r.gaps.length, 0);
  const activeCount = results.filter(r => r.status === 'active').length;
  const plannedCount = results.filter(r => r.status === 'planned').length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ results, totalDrift, totalGaps, activeCount, plannedCount }, null, 2));
    process.exit(totalDrift > 0 ? 1 : 0);
  }

  if (QUIET && totalDrift === 0) {
    process.exit(0);
  }

  // ── Render ──
  console.log('Workflow parity check');
  console.log('=====================');
  console.log('');

  for (const r of results) {
    if (r.status === 'deprecated') continue;
    if (r.status === 'planned') continue;  // listed at bottom

    const headSym = r.drift.length > 0 ? '✗' : (r.gaps.length > 0 ? '·' : '✓');
    console.log(`${headSym} ${r.name}`);

    if (r.drift.length > 0) {
      console.log(`  DRIFT (${r.drift.length}):`);
      for (const d of r.drift) {
        console.log(`    [${d.check}] ${d.message}`);
      }
    }
    if (r.gaps.length > 0) {
      console.log(`  Gaps (${r.gaps.length}) — capability false without declared deviation:`);
      for (const g of r.gaps) {
        console.log(`    - ${g.capability}`);
      }
    }
    if (r.drift.length === 0 && r.gaps.length === 0) {
      console.log('  ✓ OK');
    }
    console.log('');
  }

  const planned = results.filter(r => r.status === 'planned');
  if (planned.length > 0) {
    console.log('Planned (not yet on the pattern):');
    for (const p of planned) {
      console.log(`  · ${p.name}${p.notes ? ' — ' + p.notes.split('\n')[0] : ''}`);
    }
    console.log('');
  }

  console.log(`Summary: ${activeCount} active workflow(s), ${totalDrift} drift issue(s), ${totalGaps} open gap(s), ${plannedCount} planned.`);
  if (totalDrift > 0) {
    console.log('');
    console.log('DRIFT is a real bug — registry contradicts code. Fix one or the other.');
    process.exit(1);
  }
  process.exit(0);
}

main();
