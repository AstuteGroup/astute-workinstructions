#!/usr/bin/env node
/**
 * NC Listing Script — NetComponents Portal Upload Generator
 *
 * Subordinate to fetch-and-parse — loads from cache, not xlsx directly.
 *
 * What it does:
 * 1. Loads inventory from cached parse data (from Monday's fetch-and-parse)
 * 2. Applies Active Sourcing exclusions (MPNs being price-checked)
 * 3. Generates two NC portal CSVs:
 *    - Non-authorized account #1167233 (all OT groups except Franchise_Stock + carryovers)
 *    - Franchised account #1126121 (Franchise_Stock only)
 * 4. Appends carryover lines to the non-auth CSV
 * 5. Sends upload emails to Jake (and optionally to NetComponents directly)
 *
 * Schedule:
 *   Mon 12 UTC — after fetch-and-parse (10 UTC), before active-sourcing (13:30 UTC)
 *   Thu 12 UTC — reuses Monday's cache, updated exclusions
 *
 * Usage:
 *   node nc-listing.js                    # Live: generate and send
 *   node nc-listing.js --dry-run          # Preview: generate but don't send
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createNotifier } = require('../../shared/notifier');
const { loadCachedInventory } = require('../../shared/inventory-fetch-and-parse');

// =============================================================================
// CONFIGURATION
// =============================================================================

const EMAIL_CONFIG = {
    account: 'excess',
    recipient: 'jake.harris@astutegroup.com',
};

// NetComponents direct upload (disabled by default — Jake reviews first)
const NC_UPLOAD_CONFIG = {
    enabled: process.env.NC_UPLOAD_ENABLED === 'true',
    ncEmail: 'datamaster@netcomponents.com',
    ccEmail: 'jake.harris@astutegroup.com',
    fromEmail: 'stockrfq@orangetsunami.com',
    fromName: 'Astute Electronics'
};

/**
 * NC Portal Groups
 *
 * Each group maps to one or more warehouses and defines what goes
 * to each NetComponents account.
 *
 * The cache (from inventory-fetch-and-parse.js) stores rows by warehouse code.
 * These groups collect warehouses and apply any special filters.
 */
const NC_GROUPS = {
    // Non-authorized account #1167233 groups
    Free_Stock_Stevenage:     { warehouses: ['W102'] },
    GE_Consignment:           { warehouses: ['W103'] },
    Free_Stock_Austin:        { warehouses: ['W104', 'W112'], excludeMfr: ['positronic'] },
    Taxan_Consignment:        { warehouses: ['W106'] },
    Spartronics_Consignment:  { warehouses: ['W107'] },
    Free_Stock_Hong_Kong:     { warehouses: ['W108', 'W113'] },
    Free_Stock_Philippines:   { warehouses: ['W109', 'W114'] },
    LAM_Dead_Inventory:       { warehouses: ['W115'] },
    LAM_Consignment:          { warehouses: ['W118'] },
    Eaton_Consignment:        { warehouses: ['W117'] },

    // Franchised account #1126121 (separate)
    Franchise_Stock:          { warehouses: ['W104'], includeMfrOnly: ['positronic'] },
};

// Groups for non-authorized account (all except Franchise_Stock)
const NON_AUTH_GROUPS = Object.keys(NC_GROUPS).filter(g => g !== 'Franchise_Stock');

// Portal CSV column headers
const PORTAL_HEADERS = ['MPN', 'Description', 'Manufacturer', 'Qty', 'D/C'];

// =============================================================================
// HELPERS
// =============================================================================

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function arrayToCSV(rows, headers) {
    const escape = v => {
        const s = String(v != null ? v : '');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
        lines.push(headers.map(h => escape(row[h])).join(','));
    }
    return '\uFEFF' + lines.join('\n');
}

/**
 * Convert cache row to portal CSV format
 */
function toPortalRow(row) {
    return {
        'MPN':          row.mpn || '',
        'Description':  row.description || '',
        'Manufacturer': row.mfr || '',
        'Qty':          String(row.qty || ''),
        'D/C':          row.dateCode || '',
    };
}

/**
 * Filter rows by manufacturer (for Positronic routing)
 */
function filterByMfr(rows, includeMfrOnly = null, excludeMfr = null) {
    return rows.filter(row => {
        const mfr = (row.mfr || '').toLowerCase();

        if (includeMfrOnly && includeMfrOnly.length > 0) {
            return includeMfrOnly.some(m => mfr.includes(m.toLowerCase()));
        }

        if (excludeMfr && excludeMfr.length > 0) {
            return !excludeMfr.some(m => mfr.includes(m.toLowerCase()));
        }

        return true;
    });
}

// =============================================================================
// LOAD INVENTORY FROM CACHE
// =============================================================================

/**
 * Load inventory from cache and group by NC groups
 * Returns { cache, groupedRows } where groupedRows is keyed by NC group name
 */
function loadInventoryFromCache() {
    log('Loading inventory from cache...');

    const cache = loadCachedInventory({ allowStale: true });
    if (!cache) {
        throw new Error('No inventory cache found. Run fetch-and-parse first.');
    }

    log(`  Cache date: ${cache.metadata.cachedAt}`);
    log(`  Week of: ${cache.metadata.weekOf}`);
    if (cache.metadata.stale) {
        log('  WARNING: Using stale cache');
    }

    // Build grouped rows from cache
    const groupedRows = {};

    for (const [groupName, config] of Object.entries(NC_GROUPS)) {
        let rows = [];

        // Collect rows from all warehouses for this group
        for (const wh of config.warehouses) {
            const whRows = cache.byWarehouse[wh] || [];
            rows.push(...whRows);
        }

        // Apply manufacturer filters
        rows = filterByMfr(rows, config.includeMfrOnly, config.excludeMfr);

        groupedRows[groupName] = rows;
        log(`  ${groupName}: ${rows.length} rows`);
    }

    return { cache, groupedRows };
}

// =============================================================================
// LOAD CARRYOVER DATA
// =============================================================================

async function loadCarryoverLines() {
    // Load carryover lines from the registry files
    const carryoverDir = path.join(__dirname, 'carryover-registry');
    const carryoverLines = [];

    if (!fs.existsSync(carryoverDir)) {
        console.log('  No carryover registry directory found');
        return carryoverLines;
    }

    const files = fs.readdirSync(carryoverDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(carryoverDir, file), 'utf8'));
            if (data.lines && Array.isArray(data.lines)) {
                for (const line of data.lines) {
                    carryoverLines.push({
                        'MPN':          String(line.Chuboe_MPN || line.mpn || '').trim(),
                        'Description':  String(line.Description || line.description || '').trim(),
                        'Manufacturer': String(line.Chuboe_MFR_Text || line.mfr || '').trim(),
                        'Qty':          String(line.Qty != null ? line.Qty : (line.qty || '')),
                        'D/C':          String(line.Chuboe_Date_Code || line.dateCode || '').trim(),
                        '_source':      file.replace('.json', ''),
                    });
                }
            }
        } catch (e) {
            console.warn(`  Warning: Could not load carryover file ${file}: ${e.message}`);
        }
    }

    return carryoverLines;
}

// =============================================================================
// GENERATE NC PORTAL FILES
// =============================================================================

async function generateNCFiles(groupedRows, outputDir, dryRun) {
    const today = new Date();
    const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Load Active Sourcing exclusions
    let sourcingExclusions = new Set();
    const exclusionFile = path.join(process.env.HOME, 'workspace/.sourcing-exclusions.json');
    if (fs.existsSync(exclusionFile)) {
        try {
            const exclusionData = JSON.parse(fs.readFileSync(exclusionFile, 'utf8'));
            const now = new Date();
            const activeExclusions = (exclusionData.entries || [])
                .filter(e => new Date(e.expiresAt) > now)
                .map(e => e.mpn.toUpperCase());
            sourcingExclusions = new Set(activeExclusions);
            if (sourcingExclusions.size > 0) {
                log(`  Active Sourcing: ${sourcingExclusions.size} MPNs excluded from NC upload`);
            }
        } catch (e) {
            console.warn(`  Warning: Could not load sourcing exclusions: ${e.message}`);
        }
    }

    // Collect rows for each account
    const collectRows = (groupNames) => {
        const out = [];
        for (const g of groupNames) out.push(...(groupedRows[g] || []));
        return out;
    };

    const filterExcludedMpns = (rows) => {
        if (sourcingExclusions.size === 0) return rows;
        return rows.filter(row => {
            const mpn = (row.mpn || '').toUpperCase();
            return !sourcingExclusions.has(mpn);
        });
    };

    const nonAuthSourceRows = filterExcludedMpns(collectRows(NON_AUTH_GROUPS));
    const franchiseSourceRows = filterExcludedMpns(groupedRows['Franchise_Stock'] || []);

    // Convert to portal format
    const nonAuthPortalRows = nonAuthSourceRows.map(toPortalRow);
    const franchisePortalRows = franchiseSourceRows.map(toPortalRow);

    // Load and append carryover lines to non-auth
    log('Loading carryover lines...');
    const carryoverLines = await loadCarryoverLines();
    if (carryoverLines.length > 0) {
        log(`  Appending ${carryoverLines.length} carryover lines to non-auth CSV`);
        // Filter carryovers by exclusions too
        const filteredCarryovers = carryoverLines.filter(line => {
            const mpn = (line.MPN || '').toUpperCase();
            return !sourcingExclusions.has(mpn);
        });
        for (const line of filteredCarryovers) {
            nonAuthPortalRows.push({
                'MPN':          line.MPN,
                'Description':  line.Description,
                'Manufacturer': line.Manufacturer,
                'Qty':          line.Qty,
                'D/C':          line['D/C'],
            });
        }
    }

    // Write non-auth CSV
    const portalFile = path.join(outputDir, `Netcomponents 1167233 ${mmdd}.csv`);
    fs.writeFileSync(portalFile, arrayToCSV(nonAuthPortalRows, PORTAL_HEADERS));
    log(`  Saved: ${path.basename(portalFile)} (${nonAuthPortalRows.length} rows)`);

    // Write franchise CSV
    const franchisePortalFile = path.join(outputDir, `Netcomponents 1126121 ${mmdd}.csv`);
    fs.writeFileSync(franchisePortalFile, arrayToCSV(franchisePortalRows, PORTAL_HEADERS));
    log(`  Saved: ${path.basename(franchisePortalFile)} (${franchisePortalRows.length} rows)`);

    return {
        portalFile,
        franchisePortalFile,
        nonAuthRows: nonAuthPortalRows,
        franchiseRows: franchisePortalRows
    };
}

// =============================================================================
// EMAIL SENDING
// =============================================================================

async function sendNCEmails(portalFile, franchisePortalFile, dryRun) {
    // Send directly to NetComponents (CC to jake for visibility)
    if (!NC_UPLOAD_CONFIG.enabled) {
        log('  NC_UPLOAD_ENABLED=false — skipping NetComponents emails');
        return true;
    }

    if (dryRun) {
        log('  [dry-run] Would send to NetComponents');
        return true;
    }

    const ncNotifier = createNotifier({
        fromEmail: NC_UPLOAD_CONFIG.fromEmail,
        fromName: NC_UPLOAD_CONFIG.fromName,
        smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
    });

    log(`  Sending non-auth CSV to NetComponents: ${NC_UPLOAD_CONFIG.ncEmail} (CC: ${NC_UPLOAD_CONFIG.ccEmail})`);
    await ncNotifier.sendWithAttachment(
        NC_UPLOAD_CONFIG.ncEmail,
        'Data Upload - Non-Authorized Account # 1167233',
        'Hello,\n\nPlease find attached updated stock inventory.\n\nBest regards,\nAstute Electronics',
        [{ filename: path.basename(portalFile), path: portalFile }],
        { cc: NC_UPLOAD_CONFIG.ccEmail }
    );

    log(`  Sending franchise CSV to NetComponents: ${NC_UPLOAD_CONFIG.ncEmail} (CC: ${NC_UPLOAD_CONFIG.ccEmail})`);
    await ncNotifier.sendWithAttachment(
        NC_UPLOAD_CONFIG.ncEmail,
        'Data upload - Franchised account # 1126121',
        'Hello,\n\nPlease find attached updated franchise inventory.\n\nBest regards,\nAstute Electronics',
        [{ filename: path.basename(franchisePortalFile), path: franchisePortalFile }],
        { cc: NC_UPLOAD_CONFIG.ccEmail }
    );

    return true;
}

// =============================================================================
// MAIN
// =============================================================================

async function main(opts = {}) {
    const dryRun = !!opts.dryRun;
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    log('='.repeat(60));
    log('NC LISTING — NetComponents Portal Upload');
    log('='.repeat(60));
    log(`Mode: ${dryRun ? 'DRY-RUN (no emails sent)' : 'LIVE'}`);
    log('-'.repeat(60));

    try {
        // Step 1: Load inventory from cache
        log('\nStep 1: Loading inventory from cache...');
        const { cache, groupedRows } = loadInventoryFromCache();

        const totalRows = Object.values(groupedRows).reduce((sum, arr) => sum + arr.length, 0);
        log(`  Total rows: ${totalRows}`);
        log(`  NC groups: ${Object.keys(groupedRows).length}`);

        // Step 2: Create output directory
        const outputDir = path.join('/tmp', `NC-Listing-${dateStr}`);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Step 3: Generate NC portal files
        log('\nStep 2: Generating NetComponents portal files...');
        const { portalFile, franchisePortalFile, nonAuthRows, franchiseRows } =
            await generateNCFiles(groupedRows, outputDir, dryRun);

        // Step 4: Send emails
        log('\nStep 3: Sending notification emails...');
        if (dryRun) {
            log('  [DRY-RUN] Skipping email send');
        } else {
            await sendNCEmails(portalFile, franchisePortalFile, dryRun);
        }

        // Summary
        log('\n' + '='.repeat(60));
        log('NC LISTING COMPLETE');
        log('='.repeat(60));
        log(`Cache date: ${cache.metadata.cachedAt}`);
        log(`Non-auth CSV: ${portalFile} (${nonAuthRows.length} rows)`);
        log(`Franchise CSV: ${franchisePortalFile} (${franchiseRows.length} rows)`);
        log(`Emails sent: ${dryRun ? 'No (dry-run)' : 'Yes'}`);

        return { success: true, portalFile, franchisePortalFile };

    } catch (err) {
        log('='.repeat(60));
        log('NC LISTING FAILED');
        log('='.repeat(60));
        log(`Error: ${err.message}`);
        console.error(err.stack);
        return { success: false, error: err.message };
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (require.main === module) {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');

    if (argv.includes('--help')) {
        console.log(`
NC Listing — NetComponents Portal Upload

Usage:
  node nc-listing.js             Generate and send NC CSVs
  node nc-listing.js --dry-run   Preview without sending emails
  node nc-listing.js --help      Show this help

Requires:
  Inventory cache from fetch-and-parse (runs Monday 5 AM CT)

Output:
  - Netcomponents 1167233 MM-DD.csv (non-authorized account)
  - Netcomponents 1126121 MM-DD.csv (franchised account)
`);
        process.exit(0);
    }

    main({ dryRun })
        .then(result => {
            process.exit(result.success ? 0 : 1);
        })
        .catch(err => {
            console.error('Unhandled error:', err);
            process.exit(1);
        });
}

module.exports = { main, generateNCFiles, loadCarryoverLines };
