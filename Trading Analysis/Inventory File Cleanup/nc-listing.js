#!/usr/bin/env node
/**
 * NC Listing Script — NetComponents Portal Upload Generator
 *
 * Separated from inventory_cleanup.js for independent Mon/Thu scheduling.
 *
 * What it does:
 * 1. Reads this week's saved inventory xlsx (from Monday's cleanup)
 * 2. Applies Active Sourcing exclusions (MPNs being price-checked)
 * 3. Generates two NC portal CSVs:
 *    - Non-authorized account #1167233 (all OT groups except Franchise_Stock + carryovers)
 *    - Franchised account #1126121 (Franchise_Stock only)
 * 4. Appends carryover lines to the non-auth CSV
 * 5. Sends upload emails to Jake (and optionally to NetComponents directly)
 *
 * Schedule:
 *   Mon 12 UTC — after inventory-cleanup (11 UTC), before active-sourcing (13:30 UTC)
 *   Thu 12 UTC — reuses Monday's inventory, updated exclusions
 *
 * Usage:
 *   node nc-listing.js                    # Live: generate and send
 *   node nc-listing.js --dry-run          # Preview: generate but don't send
 *   node nc-listing.js <file.xlsx>        # Use specific file instead of saved
 */

'use strict';

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { createNotifier } = require('../../shared/notifier');

// =============================================================================
// CONFIGURATION
// =============================================================================

const INVENTORY_STORAGE_DIR = path.join(process.env.HOME, 'workspace/.inventory-storage');

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

// Rows to skip at start of Infor file
const HEADER_ROWS_TO_SKIP = 7;

// Footer patterns to detect and remove
const FOOTER_PATTERNS = ['Page ', 'USS,'];

// Composite key fields for deduplication
const DEDUPE_FIELDS = ['Item', 'Lot', 'Location', 'Warehouse Name', 'Site', 'Date Lot'];

// Warehouse groupings
const WAREHOUSE_GROUPS = [
    ['Franchise_Stock', ['W104'], { column: 'Name', value: 'positronic' }],
    ['Free_Stock_Stevenage', ['W102'], null],
    ['GE_Consignment', ['W103'], null],
    ['Free_Stock_Austin', ['W104', 'W112'], null],
    ['Taxan_Consignment', ['W106'], null],
    ['Spartronics_Consignment', ['W107'], null],
    ['Free_Stock_Hong_Kong', ['W108', 'W113'], null],
    ['Free_Stock_Philippines', ['W109', 'W114'], null],
    ['LAM_Dead_Inventory', ['W115'], null],
    ['LAM_Consignment', ['W118'], null],
    ['Eaton_Consignment', ['W117'], null],
    ['LAM_3PL', ['W111'], null],
    ['Allocated_Warehouse', ['MAIN'], null],
    ['HK_Allocated_Warehouse', ['W105'], null],
];

// Groups that get written to OT and marketed on NC
// (mirrors WAREHOUSE_WRITEBACK from inventory_cleanup.js)
const OT_ELIGIBLE_GROUPS = [
    'Franchise_Stock',
    'Free_Stock_Stevenage',
    'GE_Consignment',
    'Free_Stock_Austin',
    'Taxan_Consignment',
    'Spartronics_Consignment',
    'Free_Stock_Hong_Kong',
    'Free_Stock_Philippines',
    'LAM_Dead_Inventory',
    'LAM_Consignment',
    'Eaton_Consignment',
];

// Portal export columns
const PORTAL_COLUMNS = ['Item', 'ItemDescription', 'Name', 'Lot Quantity', 'Date Code'];
const PORTAL_COLUMN_LABELS = {
    'Item':            'MPN',
    'ItemDescription': 'Description',
    'Name':            'Manufacturer',
    'Lot Quantity':    'Qty',
    'Date Code':       'D/C',
};

// =============================================================================
// HELPERS
// =============================================================================

function getWeekStartDate() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
}

function getThisWeekInventoryFile() {
    const weekStart = getWeekStartDate();
    const persistentPath = path.join(INVENTORY_STORAGE_DIR, `inventory_${weekStart}.xlsx`);
    if (fs.existsSync(persistentPath)) {
        return persistentPath;
    }
    return null;
}

function cleanNumeric(val) {
    if (val == null) return '';
    const str = String(val).replace(/,/g, '').trim();
    const num = parseFloat(str);
    return isNaN(num) ? str : String(Math.round(num));
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

// =============================================================================
// INVENTORY PROCESSING
// =============================================================================

function processInventoryFile(inputFile) {
    console.log(`Processing: ${inputFile}`);

    // Read file
    const workbook = XLSX.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    // Skip header rows
    const dataRows = allRows.slice(HEADER_ROWS_TO_SKIP);

    // Get headers from row after skipped rows
    const headers = dataRows[0].map(h => String(h).trim());
    const bodyRows = dataRows.slice(1);

    // Remove footer rows
    const cleanRows = bodyRows.filter(row => {
        const firstCell = String(row[0] || '');
        return !FOOTER_PATTERNS.some(p => firstCell.includes(p));
    });

    // Convert to objects
    const rows = cleanRows.map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
    });

    // Deduplicate
    const seen = new Set();
    const uniqueRows = [];
    for (const row of rows) {
        const key = DEDUPE_FIELDS.map(f => String(row[f] || '').trim()).join('|');
        if (!seen.has(key)) {
            seen.add(key);
            uniqueRows.push(row);
        }
    }

    // Group by warehouse
    const groupedRows = {};
    const unmatchedRows = [];

    for (const row of uniqueRows) {
        // 'Warehouse' has the code (W102, MAIN, etc.), 'Warehouse Name' has company name
        const warehouseCode = String(row['Warehouse'] || '').trim().toUpperCase();
        let matched = false;

        for (const [groupName, codes, filter] of WAREHOUSE_GROUPS) {
            if (!codes.map(c => c.toUpperCase()).includes(warehouseCode)) continue;

            // Check special filter
            if (filter) {
                const filterVal = String(row[filter.column] || '').trim().toLowerCase();
                if (!filterVal.includes(filter.value.toLowerCase())) continue;
            }

            if (!groupedRows[groupName]) groupedRows[groupName] = [];
            groupedRows[groupName].push(row);
            matched = true;
            break;
        }

        if (!matched) {
            unmatchedRows.push(row);
        }
    }

    return { headers, uniqueRows, groupedRows, unmatchedRows };
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

async function generateNCFiles(groupedRows, headers, outputDir, dryRun) {
    const today = new Date();
    const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Determine which source columns are available
    const portalSourceCols = PORTAL_COLUMNS.filter(col => headers.includes(col));
    const portalOutputHeaders = portalSourceCols.map(c => PORTAL_COLUMN_LABELS[c] || c);

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
                console.log(`  Active Sourcing: ${sourcingExclusions.size} MPNs excluded from NC upload`);
            }
        } catch (e) {
            console.warn(`  Warning: Could not load sourcing exclusions: ${e.message}`);
        }
    }

    // Collect rows for each account
    const FRANCHISE_GROUP = 'Franchise_Stock';
    const nonAuthGroupNames = OT_ELIGIBLE_GROUPS.filter(g => g !== FRANCHISE_GROUP);

    const collectRows = (groupNames) => {
        const out = [];
        for (const g of groupNames) out.push(...(groupedRows[g] || []));
        return out;
    };

    const filterExcludedMpns = (rows) => {
        if (sourcingExclusions.size === 0) return rows;
        return rows.filter(row => {
            const mpn = String(row['Item'] || '').trim().toUpperCase();
            return !sourcingExclusions.has(mpn);
        });
    };

    const nonAuthSourceRows = filterExcludedMpns(collectRows(nonAuthGroupNames));
    const franchiseSourceRows = filterExcludedMpns(collectRows([FRANCHISE_GROUP]));

    const toPortalRows = (sourceRows) => sourceRows.map(row => {
        const out = {};
        for (const col of portalSourceCols) {
            let val = String(row[col] || '').trim();
            if (col === 'Lot Quantity') val = cleanNumeric(val);
            out[PORTAL_COLUMN_LABELS[col] || col] = val;
        }
        return out;
    });

    // Generate non-auth CSV
    const portalFile = path.join(outputDir, `Netcomponents 1167233 ${mmdd}.csv`);
    const nonAuthRows = toPortalRows(nonAuthSourceRows);

    // Load and append carryover lines
    console.log('\n  Loading carryover lines...');
    const carryoverLines = await loadCarryoverLines();
    if (carryoverLines.length > 0) {
        console.log(`  Appending ${carryoverLines.length} carryover lines to non-auth CSV`);
        // Filter carryovers by exclusions too
        const filteredCarryovers = carryoverLines.filter(line => {
            const mpn = String(line.MPN || '').trim().toUpperCase();
            return !sourcingExclusions.has(mpn);
        });
        for (const line of filteredCarryovers) {
            nonAuthRows.push({
                'MPN':          line.MPN,
                'Description':  line.Description,
                'Manufacturer': line.Manufacturer,
                'Qty':          line.Qty,
                'D/C':          line['D/C'],
            });
        }
    }

    fs.writeFileSync(portalFile, arrayToCSV(nonAuthRows, portalOutputHeaders));
    console.log(`  Saved: ${path.basename(portalFile)} (${nonAuthRows.length} rows)`);

    // Generate franchise CSV
    const franchisePortalFile = path.join(outputDir, `Netcomponents 1126121 ${mmdd}.csv`);
    const franchiseRows = toPortalRows(franchiseSourceRows);
    fs.writeFileSync(franchisePortalFile, arrayToCSV(franchiseRows, portalOutputHeaders));
    console.log(`  Saved: ${path.basename(franchisePortalFile)} (${franchiseRows.length} rows)`);

    return { portalFile, franchisePortalFile, nonAuthRows, franchiseRows };
}

// =============================================================================
// EMAIL SENDING
// =============================================================================

async function sendNCEmails(portalFile, franchisePortalFile, dryRun) {
    // Send directly to NetComponents (CC to jake for visibility)
    if (!NC_UPLOAD_CONFIG.enabled) {
        console.log('  NC_UPLOAD_ENABLED=false — skipping NetComponents emails');
        return true;
    }

    if (dryRun) {
        console.log('  [dry-run] Would send to NetComponents');
        return true;
    }

    const ncNotifier = createNotifier({
        fromEmail: NC_UPLOAD_CONFIG.fromEmail,
        fromName: NC_UPLOAD_CONFIG.fromName,
        smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
    });

    console.log(`  Sending non-auth CSV to NetComponents: ${NC_UPLOAD_CONFIG.ncEmail} (CC: ${NC_UPLOAD_CONFIG.ccEmail})`);
    await ncNotifier.sendWithAttachment(
        NC_UPLOAD_CONFIG.ncEmail,
        'Data Upload - Non-Authorized Account # 1167233',
        'Hello,\n\nPlease find attached updated stock inventory.\n\nBest regards,\nAstute Electronics',
        [{ filename: path.basename(portalFile), path: portalFile }],
        { cc: NC_UPLOAD_CONFIG.ccEmail }
    );

    console.log(`  Sending franchise CSV to NetComponents: ${NC_UPLOAD_CONFIG.ncEmail} (CC: ${NC_UPLOAD_CONFIG.ccEmail})`);
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

async function main(inputFile, opts = {}) {
    const dryRun = !!opts.dryRun;
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    console.log('='.repeat(60));
    console.log('NC LISTING — NetComponents Portal Upload');
    console.log('='.repeat(60));
    console.log(`Time: ${today.toISOString()}`);
    console.log(`Mode: ${dryRun ? 'DRY-RUN (no emails sent)' : 'LIVE'}`);
    console.log(`Input: ${inputFile}`);
    console.log('-'.repeat(60));

    try {
        // Step 1: Process inventory file
        console.log('\nStep 1: Processing inventory file...');
        const { headers, uniqueRows, groupedRows, unmatchedRows } = processInventoryFile(inputFile);
        console.log(`  Total unique rows: ${uniqueRows.length}`);
        console.log(`  Warehouse groups: ${Object.keys(groupedRows).length}`);

        // Step 2: Create output directory
        const outputDir = path.join('/tmp', `NC-Listing-${dateStr}`);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Step 3: Generate NC portal files
        console.log('\nStep 2: Generating NetComponents portal files...');
        const { portalFile, franchisePortalFile, nonAuthRows, franchiseRows } =
            await generateNCFiles(groupedRows, headers, outputDir, dryRun);

        // Step 4: Send emails
        console.log('\nStep 3: Sending notification emails...');
        if (dryRun) {
            console.log('  [DRY-RUN] Skipping email send');
        } else {
            await sendNCEmails(portalFile, franchisePortalFile, dryRun);
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('NC LISTING COMPLETE');
        console.log('='.repeat(60));
        console.log(`Non-auth CSV: ${portalFile} (${nonAuthRows.length} rows)`);
        console.log(`Franchise CSV: ${franchisePortalFile} (${franchiseRows.length} rows)`);
        console.log(`Emails sent: ${dryRun ? 'No (dry-run)' : 'Yes'}`);

        return { success: true, portalFile, franchisePortalFile };

    } catch (err) {
        console.error('\n' + '='.repeat(60));
        console.error('NC LISTING FAILED');
        console.error('='.repeat(60));
        console.error(`Error: ${err.message}`);
        console.error(err.stack);
        return { success: false, error: err.message };
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (require.main === module) {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const args = argv.filter(a => !a.startsWith('--'));
    const dryRun = flags.has('--dry-run');

    let inputFile;

    if (args.length > 0 && fs.existsSync(args[0])) {
        // Explicit file provided
        inputFile = args[0];
    } else {
        // Use this week's saved file
        inputFile = getThisWeekInventoryFile();
        if (!inputFile) {
            console.error('ERROR: No inventory file found for this week.');
            console.error(`Expected: ${INVENTORY_STORAGE_DIR}/inventory_${getWeekStartDate()}.xlsx`);
            console.error('\nRun inventory_cleanup.js fetch first to process Monday\'s Infor export.');
            process.exit(1);
        }
    }

    main(inputFile, { dryRun })
        .then(result => {
            process.exit(result.success ? 0 : 1);
        })
        .catch(err => {
            console.error('Unhandled error:', err);
            process.exit(1);
        });
}

module.exports = { main, generateNCFiles, loadCarryoverLines };
