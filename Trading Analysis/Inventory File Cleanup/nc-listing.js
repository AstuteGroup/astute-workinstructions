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
const XLSX = require('xlsx');
const { createNotifier } = require('../../shared/notifier');
const { loadCachedInventory } = require('../../shared/inventory-fetch-and-parse');
const { reconcileCarryoverFile } = require('../../shared/carryover-reconciler');

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
    GM_Stock_US:              { warehouses: ['W121'] }, // Astute Electronics Inc (GM Stock) — added 2026-08-21
    GM_Stock_HK:              { warehouses: ['W122'] }, // Astute Electronics HK LTD (GM Stock) — added 2026-08-21, minimal data so far

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
// LOAD CARRYOVER DATA (with weekly reconciliation)
// =============================================================================

// Which warehouse(s) each carryover-registry file should be checked for
// arrival against. This is what makes reconciliation automatic instead of
// a manual weekly task someone has to remember to run — see
// shared/carryover-reconciler.js for the full rationale.
const CARRYOVER_RECONCILE_MAP = {
    'lam-consignment.json':        ['W118'],
    'eaton-consignment.json':      ['W117'],
    'free-stock-philippines.json': ['W109', 'W114'],
    'gm-stock.json':                ['W121'], // US site only — confirmed 2026-08-21 no overlap with W122/HK
};

async function loadCarryoverLines(cache, opts = {}) {
    const { write = true } = opts;

    // Load carryover lines from the registry files
    const carryoverDir = path.join(__dirname, 'carryover-registry');
    const carryoverLines = [];
    const reconciliationAudit = [];

    if (!fs.existsSync(carryoverDir)) {
        console.log('  No carryover registry directory found');
        return { carryoverLines, reconciliationAudit };
    }

    const files = fs.readdirSync(carryoverDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
        try {
            const filePath = path.join(carryoverDir, file);
            const warehouses = CARRYOVER_RECONCILE_MAP[file];

            let outputLines;
            if (warehouses && cache) {
                // Reconcile against live cache — drops fully-arrived lines
                // from the registry (persisted). Partial-arrival lines keep
                // their ORIGINAL qty in the registry (never mutated — see
                // shared/carryover-reconciler.js for why); use
                // audit.linesForOutput (reduced qty on partials) for the CSV
                // so the portal doesn't double-count the arrived portion.
                const audit = reconcileCarryoverFile(filePath, warehouses, cache, { write });
                if (audit) {
                    reconciliationAudit.push(audit);
                    log(`  Reconciled ${file}: ${audit.dropped.length} arrived (dropped), ` +
                        `${audit.reduced.length} partial (reduced for output only), ${audit.stillPending.length} still pending`);
                    outputLines = audit.linesForOutput;
                }
            } else if (!warehouses) {
                log(`  WARNING: ${file} has no reconciliation mapping — loading as-is, never auto-reconciled`);
            }

            // Fall back to the raw file if there's no reconciliation mapping
            // (unmapped future file) or reconciliation didn't run (no cache).
            if (!outputLines) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                outputLines = data.lines || [];
            }

            for (const line of outputLines) {
                carryoverLines.push({
                    'MPN':          String(line.Chuboe_MPN || line.mpn || '').trim(),
                    'Description':  String(line.Description || line.description || '').trim(),
                    'Manufacturer': String(line.Chuboe_MFR_Text || line.mfr || '').trim(),
                    'Qty':          String(line.Qty != null ? line.Qty : (line.qty || '')),
                    'D/C':          String(line.Chuboe_Date_Code || line.dateCode || '').trim(),
                    '_source':      file.replace('.json', ''),
                });
            }
        } catch (e) {
            console.warn(`  Warning: Could not load carryover file ${file}: ${e.message}`);
        }
    }

    return { carryoverLines, reconciliationAudit };
}

// =============================================================================
// GENERATE NC PORTAL FILES
// =============================================================================

async function generateNCFiles(groupedRows, outputDir, dryRun, cache) {
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

    // Load and append carryover lines to non-auth (reconciling against the
    // live cache first — see shared/carryover-reconciler.js). In dry-run
    // mode we preview the reconciliation but don't write it back, so a
    // --dry-run doesn't mutate the carryover-registry files.
    log('Loading carryover lines...');
    const { carryoverLines, reconciliationAudit } = await loadCarryoverLines(cache, { write: !dryRun });
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
        franchiseRows: franchisePortalRows,
        reconciliationAudit,
    };
}

// =============================================================================
// RECONCILIATION AUDIT REPORT (partial + never-arrived, for operator review)
// =============================================================================

function formatReconciliationAudit(reconciliationAudit) {
    const lines = [];
    let totalDropped = 0, totalReduced = 0, totalPending = 0;

    for (const audit of reconciliationAudit) {
        totalDropped += audit.dropped.length;
        totalReduced += audit.reduced.length;
        totalPending += audit.stillPending.length;

        lines.push(`\n=== ${audit.label || audit.file} ===`);
        lines.push(`  Arrived (dropped): ${audit.dropped.length} | Partial (reduced): ${audit.reduced.length} | Still outstanding: ${audit.stillPending.length}`);

        if (audit.stillPending.length > 0) {
            lines.push(`  --- Still outstanding (needs audit) ---`);
            for (const p of audit.stillPending) {
                lines.push(`    [${p.status}] ${p.mpn} (${p.mfr || 'unknown mfr'}) — qty ${p.expected}`);
            }
        }
    }

    lines.unshift(`Reconciliation summary: ${totalDropped} arrived (dropped), ${totalReduced} partial (reduced), ${totalPending} still outstanding across ${reconciliationAudit.length} carryover file(s)`);
    return lines.join('\n');
}

/**
 * Build the weekly reconciliation workbook — one tab per warehouse/carryover
 * group showing what's still outstanding (partial + never-arrived), plus a
 * Summary tab. This is a separate deliverable from the NC portal CSVs —
 * operator asked (2026-08-21) for a standalone weekly report to slowly audit
 * against, broken out by warehouse.
 *
 * @param {Array} reconciliationAudit - from generateNCFiles / loadCarryoverLines
 * @param {string} outputDir
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string|null} path to the written xlsx, or null if nothing to report
 */
function buildReconciliationReport(reconciliationAudit, outputDir, dateStr) {
    const withPending = reconciliationAudit.filter(a => a.stillPending.length > 0);
    if (withPending.length === 0) return null;

    const wb = XLSX.utils.book_new();

    // Summary tab first
    const summaryRows = reconciliationAudit.map(a => ({
        'Group':               a.label || path.basename(a.file, '.json'),
        'Total Before':        a.totalBefore,
        'Arrived (dropped)':   a.dropped.length,
        'Partial (reduced)':   a.reduced.length,
        'Still Outstanding':   a.stillPending.length,
    }));
    const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
    summaryWs['!cols'] = [{ wch: 26 }, { wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    // One tab per group with pending lines
    for (const audit of withPending) {
        const rows = audit.stillPending.map(p => ({
            'MPN':              p.mpn,
            'Manufacturer':     p.mfr || '',
            'Status':           p.status === 'NEVER_ARRIVED' ? 'Never Arrived' : 'Partial',
            'Qty Outstanding':  p.expected,
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 14 }, { wch: 16 }];

        // Sheet names capped at 31 chars, no special chars — reuse the label
        let sheetName = (audit.label || path.basename(audit.file, '.json')).slice(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const outPath = path.join(outputDir, `Carryover_Reconciliation_${dateStr}.xlsx`);
    XLSX.writeFile(wb, outPath);
    return outPath;
}

// =============================================================================
// EMAIL SENDING
// =============================================================================

/**
 * Send Jake his own review copies of the two portal CSVs directly.
 *
 * NOT CURRENTLY CALLED (see main()) — kept defined + exported for history
 * and in case it's needed again.
 *
 * Timeline: existed originally; removed 2026-06-08 (commit 1011461) on the
 * assumption that CC'ing jake@ on the NetComponents-direct emails made this
 * redundant. That assumption was wrong AT THE TIME: shared/notifier.js
 * aborted the ENTIRE send (including cc) whenever `to` had zero allowed
 * internal recipients — and `to` there was datamaster@netcomponents.com,
 * external and blocked (netcomponents.com wasn't yet an allowlist
 * exception). So Jake never actually received the CSVs through the CC path
 * for ~10 days before nc-listing itself got paused for an unrelated reason.
 * Restored 2026-08-21 as a stopgap while that was true.
 *
 * netcomponents.com was added to shared/notifier.js's ALLOWED_DOMAINS the
 * same day, which makes the CC path actually work now — so the original
 * 2026-06-08 rationale is correct again, and this function's call in main()
 * was removed to stop double-sending Jake both copies. If netcomponents.com
 * is ever removed from the allowlist, re-add the call in main() (see the
 * commented-out line there) rather than assuming the CC still works.
 */
async function sendReviewEmails(portalFile, franchisePortalFile, dryRun) {
    if (dryRun) {
        log(`  [dry-run] Would send review copies to ${EMAIL_CONFIG.recipient}`);
        return true;
    }

    const notifier = createNotifier({
        fromEmail: `${EMAIL_CONFIG.account}@orangetsunami.com`,
        fromName: 'NC Listing',
        smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS,
    });

    log(`  Sending non-auth CSV to ${EMAIL_CONFIG.recipient}...`);
    await notifier.sendWithAttachment(
        EMAIL_CONFIG.recipient,
        'Data Upload - Non Authorized Account #1167233',
        'Hello,\n\nPlease find attached updated stock inventory for NetComponents upload.\n\nBest regards,\nAstute Electronics',
        [{ filename: path.basename(portalFile), path: portalFile }]
    );

    log(`  Sending franchise CSV to ${EMAIL_CONFIG.recipient}...`);
    await notifier.sendWithAttachment(
        EMAIL_CONFIG.recipient,
        'Data Upload - Franchised Account #1126121',
        'Hello,\n\nPlease find attached updated franchise inventory for NetComponents upload.\n\nBest regards,\nAstute Electronics',
        [{ filename: path.basename(franchisePortalFile), path: franchisePortalFile }]
    );

    return true;
}

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
        const { portalFile, franchisePortalFile, nonAuthRows, franchiseRows, reconciliationAudit } =
            await generateNCFiles(groupedRows, outputDir, dryRun, cache);

        // Step 4: Send emails
        // NOTE: sendReviewEmails() (direct-to-Jake CSV copies) is intentionally
        // NOT called here — netcomponents.com is now an allowlist exception
        // (shared/notifier.js), so Jake's CC on the NetComponents email below
        // actually delivers. Calling both would double-send him every CSV.
        // See sendReviewEmails()'s docstring before re-adding this call.
        //   await sendReviewEmails(portalFile, franchisePortalFile, dryRun);
        log('\nStep 3: Sending notification emails...');
        if (dryRun) {
            log('  [DRY-RUN] Skipping NetComponents-direct email send');
        } else {
            await sendNCEmails(portalFile, franchisePortalFile, dryRun);
        }

        // Reconciliation audit — surfaced every run so "still outstanding"
        // carryover lines get regular operator eyes instead of rotting
        // silently (see shared/carryover-reconciler.js for why this exists).
        let reconciliationReportFile = null;
        if (reconciliationAudit.length > 0) {
            log('\n' + formatReconciliationAudit(reconciliationAudit));

            // Standalone weekly report — separate deliverable from the NC
            // portal CSVs, one tab per warehouse group (operator ask,
            // 2026-08-21). Sent every run that has anything outstanding,
            // live runs only (dry-run previews but doesn't email).
            reconciliationReportFile = buildReconciliationReport(reconciliationAudit, outputDir, dateStr);
            if (reconciliationReportFile) {
                log(`\nReconciliation report: ${path.basename(reconciliationReportFile)}`);
                if (dryRun) {
                    log('  [DRY-RUN] Skipping reconciliation report email');
                } else {
                    const reportNotifier = createNotifier({
                        fromEmail: `${EMAIL_CONFIG.account}@orangetsunami.com`,
                        fromName: 'Inventory Reconciliation',
                    });
                    const totalPending = reconciliationAudit.reduce((s, a) => s + a.stillPending.length, 0);
                    await reportNotifier.sendWithAttachment(
                        EMAIL_CONFIG.recipient,
                        `Carryover Reconciliation — ${totalPending} still outstanding — ${dateStr}`,
                        `Hi Jake,\n\nWeekly carryover reconciliation report attached — one tab per warehouse group, ` +
                        `showing parts still outstanding (partial or never-arrived) after checking against this week's ` +
                        `Infor cache.\n\n${totalPending} lines still need review across ${reconciliationAudit.length} group(s). ` +
                        `See the Summary tab for the breakdown.\n\nBest,\nInventory Reconciliation`,
                        [{ filename: path.basename(reconciliationReportFile), path: reconciliationReportFile }]
                    );
                    log(`  Sent to ${EMAIL_CONFIG.recipient}`);
                }
            }
        }

        // Summary
        log('\n' + '='.repeat(60));
        log('NC LISTING COMPLETE');
        log('='.repeat(60));
        log(`Cache date: ${cache.metadata.cachedAt}`);
        log(`Non-auth CSV: ${portalFile} (${nonAuthRows.length} rows)`);
        log(`Franchise CSV: ${franchisePortalFile} (${franchiseRows.length} rows)`);
        log(`Reconciliation report: ${reconciliationReportFile ? path.basename(reconciliationReportFile) : 'none (nothing outstanding)'}`);
        log(`Emails sent: ${dryRun ? 'No (dry-run)' : 'Yes'}`);

        return { success: true, portalFile, franchisePortalFile, reconciliationAudit, reconciliationReportFile };

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

module.exports = { main, generateNCFiles, loadCarryoverLines, formatReconciliationAudit, buildReconciliationReport, sendReviewEmails };
