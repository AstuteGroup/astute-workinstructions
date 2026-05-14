/**
 * writeback-proxy-client.js
 *
 * Drop-in replacement for direct writer imports. Exposes the same function
 * surface as rfq-writer / offer-writeback / cq-writer / vq-writer / etc., but
 * routes the call through /opt/writeback/cli (run as analytics_user via
 * sudo) for any user who isn't analytics_user themselves.
 *
 * WHY THIS EXISTS:
 *   Only analytics_user holds iDempiere credentials. Other users (josh.syre,
 *   melissa.bojar) cannot read ~analytics_user/workspace/.env. To let their
 *   sessions still drive writebacks, they invoke the proxy CLI via sudo. This
 *   shim hides that plumbing so call sites can be migrated with a single
 *   `require()` swap. See `shared/writeback-proxy.md` for the full design.
 *
 * USAGE:
 *   const { writeRFQ, writeOffer, writeCQ, writeCQBatch, writeVQBatch,
 *           writeReviewedItems, writePricingResult, tickVQForPurchase,
 *           postApproveOrder, markCQSold,
 *           validateVQForPurchase, validateCQForSold } =
 *     require('../shared/writeback-proxy-client');
 *
 *   const result = await writeRFQ({ bpartnerId: 1000190, type: 'Stock', ... });
 *
 *   // Same signature as shared/rfq-writer.js — no other changes needed.
 *
 * BEHAVIOR BY USER:
 *   - Running as `analytics_user`: requires and calls the real writer
 *     directly. No subprocess, no sudo, identical performance to the
 *     original module.
 *   - Running as any other user: spawns `sudo -n -u analytics_user
 *     /opt/writeback/cli <subcommand>` with a JSON payload on stdin, parses
 *     the JSON response from stdout, returns the `result` field (or throws
 *     on non-zero exit / parse failure).
 *
 * ERROR MAPPING:
 *   Exit 1 (writer error)      -> throws Error with writer's message
 *   Exit 2 (validation/usage)  -> throws Error
 *   Exit 3 (loader error)      -> throws Error (likely permission / sudo)
 *   Exit 99 (fatal)            -> throws Error
 *   Stdout not valid JSON      -> throws Error with raw output
 *
 * SECURITY:
 *   stdin is the ONLY way payloads reach the CLI. argv carries only the
 *   subcommand name (a fixed string from the dispatch table below). The CLI
 *   validates required keys and rejects unknown subcommands. Every call is
 *   audited to /opt/writeback/audit/.
 */

'use strict';

const { spawn } = require('child_process');
const os = require('os');

const CLI_PATH = '/opt/writeback/cli';
const ANALYTICS_USER = 'analytics_user';

// Dispatch table: writer name -> (subcommand, positional arg names matching
// the original writer signature). Keep in sync with /opt/writeback/cli.js
// SUBCOMMANDS.
const DISPATCH = {
  writeRFQ:              { subcommand: 'rfq',                  args: ['opts'] },
  writeOffer:            { subcommand: 'offer',                args: ['opts'] },
  writeOffers:           { subcommand: 'offer-batch',          args: ['offers'] },
  writeCQ:               { subcommand: 'cq',                   args: ['rfqSearchKey', 'line', 'opts'] },
  writeCQBatch:          { subcommand: 'cq-batch',             args: ['rfqSearchKey', 'lines', 'opts'] },
  writeVQBatch:          { subcommand: 'vq-batch',             args: ['rfqSearchKey', 'items', 'opts'] },
  writeReviewedItems:    { subcommand: 'vq-reviewed',          args: ['rfqSearchKey', 'reviewedItems', 'opts'] },
  writePricingResult:    { subcommand: 'pricing',              args: ['opts'] },
  tickVQForPurchase:     { subcommand: 'tick-vq',              args: ['vqId', 'opts'] },
  postApproveOrder:      { subcommand: 'approve-order',        args: ['opts'] },
  markCQSold:            { subcommand: 'mark-cq-sold',         args: ['cqId', 'opts'] },
  validateVQForPurchase: { subcommand: 'validate-vq-purchase', args: ['vqId', 'opts'] },
  validateCQForSold:     { subcommand: 'validate-cq-sold',     args: ['cqId', 'opts'] },
};

// Map writer name -> source module so direct-mode (analytics_user) can
// require the original implementation lazily.
const DIRECT_MODULE = {
  writeRFQ:              './rfq-writer',
  writeOffer:            './offer-writeback',
  writeOffers:           './offer-writeback',
  writeCQ:               './cq-writer',
  writeCQBatch:          './cq-writer',
  writeVQBatch:          './vq-writer',
  writeReviewedItems:    './vq-writer',
  writePricingResult:    './api-result-writer',
  tickVQForPurchase:     './vq-patcher',
  postApproveOrder:      './r-request-writer',
  markCQSold:            './cq-patcher',
  validateVQForPurchase: './vq-purchase-validator',
  validateCQForSold:     './cq-sold-validator',
};

// The effective process user — i.e. who this Node process is running as
// right now. NOT process.env.SUDO_USER (which names the invoker who called
// sudo); we want the user the credentials check actually applies to. When
// the shim itself is run as analytics_user (e.g. analytics_user's session,
// or analytics_user's own scheduled jobs), we take the direct path.
function currentUser() {
  return os.userInfo().username;
}

function callViaProxy(subcommand, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', '-u', ANALYTICS_USER, CLI_PATH, subcommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('error', (e) => reject(new Error(`spawn sudo failed: ${e.message}`)));

    child.on('close', (code) => {
      if (code === 0) {
        let parsed;
        try { parsed = JSON.parse(stdout); }
        catch (e) {
          return reject(new Error(`proxy returned non-JSON stdout (code ${code}): ${stdout.slice(0, 500)}`));
        }
        return resolve(parsed.result);
      }
      // Non-zero: surface the stderr message from the CLI (which includes
      // the writer error or validation message).
      const msg = (stderr.trim() || stdout.trim() || `proxy exited ${code}`);
      return reject(new Error(msg));
    });

    child.stdin.on('error', (e) => reject(new Error(`stdin write failed: ${e.message}`)));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function buildPayload(argNames, args) {
  const payload = {};
  for (let i = 0; i < argNames.length; i++) {
    if (args[i] !== undefined) payload[argNames[i]] = args[i];
  }
  return payload;
}

function makeWrapper(name) {
  const spec = DISPATCH[name];
  const directPath = DIRECT_MODULE[name];

  return async function (...args) {
    if (currentUser() === ANALYTICS_USER) {
      // Direct mode: require the original writer lazily. Avoids loading
      // ~analytics_user/.env when running as someone else (which would log
      // a misleading dotenv "no .env file" warning).
      const mod = require(directPath);
      const fn = mod[name];
      if (typeof fn !== 'function') {
        throw new Error(`writeback-proxy-client: ${directPath} does not export ${name}`);
      }
      return fn.apply(null, args);
    }
    return callViaProxy(spec.subcommand, buildPayload(spec.args, args));
  };
}

const exported = {};
for (const name of Object.keys(DISPATCH)) {
  exported[name] = makeWrapper(name);
}

// Convenience metadata so callers / tests can introspect the proxy state.
exported.__proxy = {
  user: currentUser(),
  mode: currentUser() === ANALYTICS_USER ? 'direct' : 'sudo-cli',
  cliPath: CLI_PATH,
  subcommands: Object.fromEntries(
    Object.entries(DISPATCH).map(([k, v]) => [k, v.subcommand])
  ),
};

module.exports = exported;
