#!/usr/bin/env node
/**
 * manage-carryover — label-agnostic CLI for static-carryover lifecycle.
 *
 * Replaces the per-label one-off scripts (bootstrap_gm_carryover.js,
 * lam_static_bootstrap.js, eaton_carryover_patch.js, philippines_carryover_patch.js,
 * retire-pmv450enear-carryover.js, ...) with a single tool.
 *
 *   node manage-carryover.js bootstrap --label "GE Consignment" \
 *        --csv ge-bootstrap.csv --bp 1003001 --offer-type 1000004 \
 *        --paired W103 --portal "Astute Electronics Inc. - GE (Carryover)" \
 *        [--dry-run]
 *
 *   node manage-carryover.js add --label "Eaton Consignment" \
 *        --csv additions.csv [--dry-run]
 *
 *   node manage-carryover.js retire --label "Eaton Consignment" \
 *        --mpns PMV450ENEAR,XYZ123 --reason "physical in Austin" \
 *        [--dry-run]
 *
 *   node manage-carryover.js list --label "Eaton Consignment"
 *
 * CSV schema (bootstrap & add):
 *   MPN, MFR, Qty                                      (required)
 *   DateCode, PackageDesc, Price, MOQ, SPQ, LineDescription   (optional)
 * Headers are matched case-insensitively. See lib/carryover-ops.js → parseCarryoverCsv.
 *
 * Audit log: carryover-audit.csv (in this folder). Every bootstrap/add/retire
 * appends a row. Operator defaults to $USER, override with --operator.
 *
 * Retire defense-in-depth: if the registry entry for `--label` exists in
 * inventory_cleanup.js → STATIC_CARRYOVER_OFFERS, retire also deactivates
 * matching lines on the bootstrapId offer, so the bootstrap-fallback path
 * can't resurrect retired MPNs. Auto-detected — no flag needed.
 */

const path = require('path');
const ops = require('./lib/carryover-ops');

// Import the registry directly so retire can do the bootstrap defense-in-depth
let STATIC_CARRYOVER_OFFERS = [];
try {
    // inventory_cleanup.js doesn't export the registry; require it just to
    // exec the file would run side effects. Re-declare here via require of
    // a small extractor? Simpler: parse the file with a regex.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, 'inventory_cleanup.js'), 'utf-8');
    const match = src.match(/const STATIC_CARRYOVER_OFFERS = (\[[\s\S]*?\n\]);/);
    if (match) {
        // eslint-disable-next-line no-new-func
        STATIC_CARRYOVER_OFFERS = new Function('return ' + match[1])();
    }
} catch (e) {
    console.warn(`Warning: could not load STATIC_CARRYOVER_OFFERS from inventory_cleanup.js (${e.message}). Retire will skip bootstrap defense-in-depth.`);
}

function parseArgs(argv) {
    const out = { _: [], flags: {} };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                out.flags[key] = true;
                i++;
            } else {
                out.flags[key] = next;
                i += 2;
            }
        } else {
            out._.push(a);
            i++;
        }
    }
    return out;
}

function findRegistryEntry(label) {
    return STATIC_CARRYOVER_OFFERS.find(e => e.label === label) || null;
}

function usageAndExit(msg) {
    if (msg) console.error(`\nError: ${msg}\n`);
    console.error('Usage:');
    console.error('  manage-carryover.js bootstrap --label X --csv Y --bp N --offer-type N [--paired W103,W117] [--portal "name"] [--dry-run]');
    console.error('  manage-carryover.js add       --label X --csv Y [--dry-run]');
    console.error('  manage-carryover.js retire    --label X --mpns A,B,C --reason "..." [--dry-run]');
    console.error('  manage-carryover.js list      --label X');
    process.exit(1);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const sub = args._[0];
    const f = args.flags;
    if (!sub) usageAndExit('subcommand required');

    const dryRun = !!f['dry-run'];
    const operator = f.operator || process.env.USER || 'unknown';
    const label = f.label;

    if (sub === 'bootstrap') {
        if (!label || !f.csv || !f.bp || !f['offer-type']) {
            usageAndExit('bootstrap requires --label, --csv, --bp, --offer-type');
        }
        const paired = f.paired ? String(f.paired).split(',').map(s => s.trim()).filter(Boolean) : undefined;
        await ops.bootstrap({
            label,
            bpId: Number(f.bp),
            offerTypeId: Number(f['offer-type']),
            csvPath: path.resolve(f.csv),
            pairedWarehouses: paired,
            portalWarehouseName: f.portal || undefined,
            dryRun,
            operator,
        });
        return;
    }

    if (sub === 'add') {
        if (!label || !f.csv) usageAndExit('add requires --label, --csv');
        await ops.add({
            label,
            csvPath: path.resolve(f.csv),
            dryRun,
            operator,
        });
        return;
    }

    if (sub === 'retire') {
        if (!label || !f.mpns || !f.reason) usageAndExit('retire requires --label, --mpns, --reason');
        const mpns = String(f.mpns).split(',').map(s => s.trim()).filter(Boolean);
        const registryEntry = findRegistryEntry(label);
        if (!registryEntry) {
            console.warn(`Note: '${label}' not in STATIC_CARRYOVER_OFFERS — skipping bootstrap defense-in-depth.`);
        }
        await ops.retire({
            label,
            mpns,
            reason: f.reason,
            registryEntry,
            dryRun,
            operator,
        });
        return;
    }

    if (sub === 'list') {
        if (!label) usageAndExit('list requires --label');
        await ops.list({ label });
        return;
    }

    usageAndExit(`unknown subcommand: ${sub}`);
}

main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
