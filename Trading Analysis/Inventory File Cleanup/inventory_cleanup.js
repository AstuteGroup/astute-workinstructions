#!/usr/bin/env node
/**
 * Inventory File Cleanup Script (Node.js version)
 * Processes Infor ERP inventory exports for Astute Electronics
 *
 * Workflow:
 * 1. Convert Excel to CSV (if needed)
 * 2. Clean raw export (remove header rows 1-7, footer rows)
 * 3. Deduplicate based on composite key
 * 4. Split by warehouse group
 * 5. Export to Chuboe format for iDempiere import
 * 6. Create consolidated file for industry portals
 *
 * Usage:
 *     node inventory_cleanup.js <input_file.xlsx|csv> [output_directory]
 *     node inventory_cleanup.js fetch    # Fetch from email and process automatically
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { createGzip } = require('zlib');
const { pipeline } = require('stream/promises');

// =============================================================================
// CONFIGURATION
// =============================================================================

// Email configuration
const EMAIL_CONFIG = {
    account: 'excess',
    recipient: 'jake.harris@astutegroup.com',
    subjectPattern: /Task finished: \[success\] \d+ AST Item Lots Report Inputs/i,
    processedFolder: 'Inventory-Processed'
};

// Himalaya binary path
const HIMALAYA_BIN = process.env.HIMALAYA_BIN || path.join(process.env.HOME, 'bin', 'himalaya');

// Rows to skip at start of file (Infor report header)
const HEADER_ROWS_TO_SKIP = 7;

// Footer patterns to detect and remove
const FOOTER_PATTERNS = ['Page ', 'USS,'];

// Composite key fields for deduplication
const DEDUPE_FIELDS = ['Item', 'Lot', 'Location', 'Warehouse Name', 'Site', 'Date Lot'];

// Warehouse groupings: [group_name, warehouse_codes, special_filter]
// Special filter format: {column, value} or null
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
    ['SPE_ATX', ['W112'], null],
    ['Main_Warehouse', ['MAIN'], null],
    ['HK_Warehouse', ['W105'], null],
];

// Chuboe output column mapping
const CHUBOE_COLUMNS = [
    ['Chuboe_Offer_ID[Value]', '__BLANK__'],
    ['Chuboe_MPN', 'Item'],
    ['Chuboe_MFR_ID[Value]', '__BLANK__'],
    ['Chuboe_MFR_Text', 'Name'],
    ['Qty', 'Lot Quantity'],
    ['Chuboe_Lead_Time', '__BLANK__'],
    ['Chuboe_Package_Desc', 'Lot|Location'],
    ['C_Country_ID[Name]', '__BLANK__'],
    ['Chuboe_Date_Code', 'Date Code'],
    ['C_Currency_ID[ISO_Code]', '__BLANK__'],
    ['Description', 'ItemDescription'],
    ['IsActive', '__BLANK__'],
    ['Chuboe_MPN_Clean', '__BLANK__'],
    ['Chuboe_CPC', '__BLANK__'],
    ['PriceEntered', 'Lot Unit Cost'],
    ['Chuboe_MOQ', '__BLANK__'],
    ['Chuboe_SPQ', '__BLANK__'],
];

// Groups where PriceEntered should be blanked
const CONSIGNMENT_GROUPS = [
    'GE_Consignment', 'Taxan_Consignment', 'Spartronics_Consignment',
    'LAM_Consignment', 'Eaton_Consignment'
];

// Portal export columns
const PORTAL_COLUMNS = [
    'Item', 'ItemDescription', 'Name', 'Lot Quantity', 'Date Code',
    'Lot Unit Cost', 'Currency', 'Warehouse Name', 'Location'
];

// =============================================================================
// HIMALAYA EMAIL FUNCTIONS
// =============================================================================

function runHimalaya(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const fullArgs = ['--output', 'json', ...args];
        console.log(`  [himalaya] ${fullArgs.join(' ')}`);

        execFile(HIMALAYA_BIN, fullArgs, {
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env }
        }, (error, stdout, stderr) => {
            if (error) {
                console.error(`  [himalaya error] ${error.message}`);
                if (stderr) console.error(`  [himalaya stderr] ${stderr}`);
                return reject(new Error(`himalaya failed: ${error.message}`));
            }
            try {
                const cleaned = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
                if (!cleaned) return resolve(null);
                const parsed = JSON.parse(cleaned);
                resolve(parsed);
            } catch (e) {
                resolve(stdout.trim());
            }
        });
    });
}

function runHimalayaRaw(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        execFile(HIMALAYA_BIN, args, {
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env }
        }, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`himalaya failed: ${error.message}`));
            }
            resolve(stdout);
        });
    });
}

async function listEmails(folder = 'INBOX') {
    try {
        const result = await runHimalaya([
            'envelope', 'list',
            '--account', EMAIL_CONFIG.account,
            '--folder', folder,
            '--page-size', '100'
        ]);
        if (!result || !Array.isArray(result)) return [];
        return result.map(env => ({
            id: env.id,
            subject: env.subject || '',
            from: env.from || {},
            date: env.date || '',
            hasAttachment: env.has_attachment || false
        }));
    } catch (err) {
        console.error('Failed to list emails:', err.message);
        return [];
    }
}

async function downloadAttachment(messageId, folder = 'INBOX') {
    // Use 'message export' instead of 'attachment download' - more reliable
    // This exports attachments to /tmp with their original filenames

    return new Promise((resolve, reject) => {
        console.log(`  Exporting message ${messageId} to extract attachments...`);

        const proc = spawn(HIMALAYA_BIN, [
            'message', 'export',
            '--account', EMAIL_CONFIG.account,
            '--folder', folder,
            String(messageId)
        ], {
            cwd: '/tmp',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Message export timeout'));
        }, 300000); // 5 minutes

        proc.on('close', (code) => {
            clearTimeout(timer);

            console.log(`  Export complete, searching for xlsx file...`);

            // Find xlsx file in /tmp (himalaya exports attachments there)
            // Files may have .aaf extension but are actually xlsx
            const tmpFiles = fs.readdirSync('/tmp');

            // First try exact xlsx match
            let xlsxFile = tmpFiles.find(f =>
                f.includes('ASTItemLotsReport') && (f.endsWith('.xlsx') || f.endsWith('.xls'))
            );

            // If not found, check for .aaf files (himalaya sometimes uses this extension)
            if (!xlsxFile) {
                const aafFile = tmpFiles.find(f =>
                    f.includes('ASTItemLotsReport') && f.endsWith('.aaf')
                );
                if (aafFile) {
                    // Rename to xlsx
                    const aafPath = path.join('/tmp', aafFile);
                    const xlsxPath = aafPath.replace('.aaf', '.xlsx');
                    fs.copyFileSync(aafPath, xlsxPath);
                    xlsxFile = path.basename(xlsxPath);
                    console.log(`  Converted ${aafFile} to ${xlsxFile}`);
                }
            }

            if (xlsxFile) {
                const fullPath = path.join('/tmp', xlsxFile);
                console.log(`  Found: ${fullPath}`);
                resolve(fullPath);
            } else {
                reject(new Error('No xlsx attachment found after export'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Export failed: ${err.message}`));
        });
    });
}

async function moveEmail(messageId, targetFolder, sourceFolder = 'INBOX') {
    try {
        // Ensure target folder exists
        await runHimalaya(['folder', 'create', '--account', EMAIL_CONFIG.account, targetFolder])
            .catch(() => {}); // Ignore if already exists

        await runHimalaya([
            'message', 'move',
            '--account', EMAIL_CONFIG.account,
            '--folder', sourceFolder,
            targetFolder,
            String(messageId)
        ]);
        console.log(`  Moved message ${messageId} to ${targetFolder}`);
        return true;
    } catch (err) {
        console.error(`  Failed to move message: ${err.message}`);
        return false;
    }
}

async function sendEmail(to, subject, body, attachments = []) {
    // Build MML template with attachments
    let mml = `From: ${EMAIL_CONFIG.account}@orangetsunami.com
To: ${to}
Subject: ${subject}

<#part type=text/plain>
${body}
<#/part>`;

    // Add attachments
    for (const attachment of attachments) {
        if (fs.existsSync(attachment)) {
            mml += `
<#part filename="${attachment}" disposition=attachment>
<#/part>`;
        }
    }

    return new Promise((resolve) => {
        console.log(`  Sending email to ${to}: ${subject}`);

        const proc = spawn(HIMALAYA_BIN, [
            'template', 'send',
            '--account', EMAIL_CONFIG.account
        ], {
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`  Email sent successfully`);
                resolve(true);
            } else {
                console.error(`  Failed to send email: ${stderr}`);
                resolve(false);
            }
        });

        proc.on('error', (err) => {
            console.error(`  Failed to send email: ${err.message}`);
            resolve(false);
        });

        // Write template to stdin and close
        proc.stdin.write(mml);
        proc.stdin.end();
    });
}

async function sendFailureNotice(error) {
    const body = `Inventory File Cleanup FAILED

Error: ${error}

Time: ${new Date().toISOString()}

Please check the excess@orangetsunami.com inbox for the source email and investigate.`;

    await sendEmail(
        EMAIL_CONFIG.recipient,
        'FAILED: Inventory Cleanup Error',
        body
    );
}

// =============================================================================
// ZIP FUNCTIONS
// =============================================================================

async function createZipArchive(files, outputPath) {
    const archiver = require('archiver');

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`  Created zip: ${outputPath} (${archive.pointer()} bytes)`);
            resolve(outputPath);
        });

        archive.on('error', (err) => reject(err));
        archive.pipe(output);

        for (const file of files) {
            if (fs.existsSync(file)) {
                archive.file(file, { name: path.basename(file) });
            }
        }

        archive.finalize();
    });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function cleanNumeric(value) {
    if (value == null) return '';
    return String(value).replace(/"/g, '').replace(/,/g, '');
}

function isFooterRow(row) {
    const rowText = Object.values(row).join(',');
    return FOOTER_PATTERNS.some(pattern => rowText.includes(pattern));
}

function isBlankRow(row) {
    return Object.values(row).every(cell => !String(cell || '').trim());
}

function getDedupeKey(row) {
    return DEDUPE_FIELDS.map(field => String(row[field] || '').trim().toLowerCase()).join('|');
}

function matchesWarehouseGroup(row, groupConfig) {
    const [groupName, warehouseCodes, specialFilter] = groupConfig;

    const warehouse = String(row['Warehouse'] || '').trim().toUpperCase();

    if (!warehouseCodes.map(wc => wc.toUpperCase()).includes(warehouse)) {
        return false;
    }

    if (specialFilter) {
        const colVal = String(row[specialFilter.column] || '').trim().toLowerCase();
        if (colVal !== specialFilter.value.toLowerCase()) {
            return false;
        }
    }

    return true;
}

function transformToChuboe(row, groupName) {
    const isConsignment = CONSIGNMENT_GROUPS.includes(groupName);
    const output = {};

    for (const [outCol, source] of CHUBOE_COLUMNS) {
        if (source === '__BLANK__') {
            output[outCol] = '';
        } else if (source.includes('|')) {
            const parts = source.split('|');
            const values = parts
                .map(part => String(row[part] || '').trim())
                .filter(v => v);
            output[outCol] = values.join(';');
        } else if (source === 'Lot Unit Cost' && isConsignment) {
            output[outCol] = '';
        } else {
            let val = String(row[source] || '').trim();
            if (['Lot Quantity', 'Lot Unit Cost', 'Lot Cost'].includes(source)) {
                val = cleanNumeric(val);
            }
            output[outCol] = val;
        }
    }

    return output;
}

function arrayToCSV(rows, headers) {
    const escape = (val) => {
        const str = String(val || '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };

    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
        lines.push(headers.map(h => escape(row[h])).join(','));
    }
    return lines.join('\n');
}

// =============================================================================
// MAIN PROCESSING
// =============================================================================

function processInventoryFile(inputFile, outputDir) {
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: Input file not found: ${inputFile}`);
        process.exit(1);
    }

    // Get today's date for folder name
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // Create dated output directory
    if (!outputDir) {
        outputDir = path.join(path.dirname(inputFile), `Inventory ${dateStr}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const timestamp = today.toISOString().replace(/[-:T]/g, '').slice(0, 15);

    console.log(`Processing: ${inputFile}`);
    console.log(`Output directory: ${outputDir}`);
    console.log('-'.repeat(60));

    // ==========================================================================
    // STEP 1: Read the file (Excel or CSV)
    // ==========================================================================
    console.log('Step 1: Reading and cleaning file...');

    const workbook = XLSX.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to array of arrays
    const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    // Skip header rows (rows 1-7, indices 0-6)
    // Row 8 (index 7) is the header row
    const headers = rawData[HEADER_ROWS_TO_SKIP].map(h => String(h).trim());

    // Process data rows
    const allRows = [];
    for (let i = HEADER_ROWS_TO_SKIP + 1; i < rawData.length; i++) {
        const rawRow = rawData[i];

        // Convert array to object with headers
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = rawRow[idx] !== undefined ? rawRow[idx] : '';
        });

        // Skip blank rows
        if (isBlankRow(row)) continue;

        // Stop at footer
        if (isFooterRow(row)) break;

        allRows.push(row);
    }

    console.log(`  - Headers found: ${headers.filter(h => h).length} columns`);
    console.log(`  - Data rows read: ${allRows.length}`);

    // ==========================================================================
    // STEP 2: Deduplicate
    // ==========================================================================
    console.log('\nStep 2: Deduplicating...');

    const seenKeys = new Set();
    const uniqueRows = [];
    const duplicateRows = [];

    for (const row of allRows) {
        const key = getDedupeKey(row);
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueRows.push(row);
        } else {
            duplicateRows.push(row);
        }
    }

    console.log(`  - Unique rows: ${uniqueRows.length}`);
    console.log(`  - Duplicate rows removed: ${duplicateRows.length}`);

    // Save duplicates for review
    if (duplicateRows.length > 0) {
        const dupFile = path.join(outputDir, `duplicates_${timestamp}.csv`);
        fs.writeFileSync(dupFile, arrayToCSV(duplicateRows, headers));
        console.log(`  - Duplicates saved to: ${dupFile}`);
    }

    // ==========================================================================
    // STEP 3: Split by warehouse group
    // ==========================================================================
    console.log('\nStep 3: Splitting by warehouse group...');

    const groupedRows = {};
    const unmatchedRows = [];

    for (const row of uniqueRows) {
        let matched = false;

        for (const groupConfig of WAREHOUSE_GROUPS) {
            const [groupName] = groupConfig;

            if (matchesWarehouseGroup(row, groupConfig)) {
                // Special handling for W104: skip if Positronic (handled by Franchise_Stock)
                if (groupName === 'Free_Stock_Austin') {
                    const nameVal = String(row['Name'] || '').trim().toLowerCase();
                    if (nameVal === 'positronic') {
                        continue;
                    }
                }

                if (!groupedRows[groupName]) {
                    groupedRows[groupName] = [];
                }
                groupedRows[groupName].push(row);
                matched = true;
                break;
            }
        }

        if (!matched) {
            unmatchedRows.push(row);
        }
    }

    const sortedGroups = Object.keys(groupedRows).sort();
    for (const groupName of sortedGroups) {
        console.log(`  - ${groupName}: ${groupedRows[groupName].length} rows`);
    }

    if (unmatchedRows.length > 0) {
        console.log(`  - Unmatched (Other): ${unmatchedRows.length} rows`);
    }

    // ==========================================================================
    // STEP 4: Export Chuboe format files
    // ==========================================================================
    console.log('\nStep 4: Exporting Chuboe format files...');

    const chuboeHeaders = CHUBOE_COLUMNS.map(col => col[0]);
    const chuboeFiles = [];

    for (const groupName of sortedGroups) {
        const rows = groupedRows[groupName];
        if (!rows || rows.length === 0) continue;

        const transformed = rows.map(row => transformToChuboe(row, groupName));
        const outFile = path.join(outputDir, `${groupName}_chuboe.csv`);
        fs.writeFileSync(outFile, arrayToCSV(transformed, chuboeHeaders));
        chuboeFiles.push(outFile);
        console.log(`  - Saved: ${groupName}_chuboe.csv (${rows.length} rows)`);
    }

    // ==========================================================================
    // STEP 5: Export consolidated portal file
    // ==========================================================================
    console.log('\nStep 5: Exporting consolidated portal file...');

    const portalHeaders = PORTAL_COLUMNS.filter(col => headers.includes(col));
    const portalRows = uniqueRows.map(row => {
        const out = {};
        for (const col of portalHeaders) {
            let val = String(row[col] || '').trim();
            if (['Lot Quantity', 'Lot Unit Cost'].includes(col)) {
                val = cleanNumeric(val);
            }
            out[col] = val;
        }
        return out;
    });

    const portalFile = path.join(outputDir, `consolidated_portal_${timestamp}.csv`);
    fs.writeFileSync(portalFile, arrayToCSV(portalRows, portalHeaders));
    console.log(`  - Saved: consolidated_portal_${timestamp}.csv (${uniqueRows.length} rows)`);

    // ==========================================================================
    // STEP 6: Save cleaned master file
    // ==========================================================================
    console.log('\nStep 6: Saving cleaned master file...');

    const masterFile = path.join(outputDir, `inventory_cleaned_${timestamp}.csv`);
    fs.writeFileSync(masterFile, arrayToCSV(uniqueRows, headers));
    console.log(`  - Saved: inventory_cleaned_${timestamp}.csv (${uniqueRows.length} rows)`);

    // ==========================================================================
    // SUMMARY
    // ==========================================================================
    console.log('\n' + '='.repeat(60));
    console.log('PROCESSING COMPLETE');
    console.log('='.repeat(60));
    console.log(`Input file: ${inputFile}`);
    console.log(`Output directory: ${outputDir}`);
    console.log(`Total rows processed: ${allRows.length}`);
    console.log(`Unique rows: ${uniqueRows.length}`);
    console.log(`Duplicates removed: ${duplicateRows.length}`);
    console.log(`Warehouse groups: ${Object.keys(groupedRows).length}`);
    console.log(`Unmatched rows: ${unmatchedRows.length}`);

    return {
        totalRows: allRows.length,
        uniqueRows: uniqueRows.length,
        duplicates: duplicateRows.length,
        groups: groupedRows,
        unmatched: unmatchedRows.length,
        outputDir: outputDir,
        portalFile: portalFile,
        chuboeFiles: chuboeFiles,
        timestamp: timestamp
    };
}

// =============================================================================
// FETCH COMMAND - Email automation
// =============================================================================

async function fetchAndProcess() {
    console.log('='.repeat(60));
    console.log('INVENTORY CLEANUP - AUTOMATED FETCH');
    console.log('='.repeat(60));
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Looking for emails matching: ${EMAIL_CONFIG.subjectPattern}`);
    console.log('-'.repeat(60));

    try {
        // Step 1: List emails
        console.log('\nStep 1: Checking inbox...');
        const emails = await listEmails('INBOX');
        console.log(`  Found ${emails.length} emails in INBOX`);

        // Step 2: Find matching email
        const matchingEmail = emails.find(e => EMAIL_CONFIG.subjectPattern.test(e.subject));

        if (!matchingEmail) {
            console.log('\n  No matching inventory report email found.');
            console.log('  Expected subject pattern: "Task finished: [success] NNNNNN AST Item Lots Report Inputs"');
            return { success: false, reason: 'No matching email found' };
        }

        console.log(`\n  Found matching email:`);
        console.log(`    ID: ${matchingEmail.id}`);
        console.log(`    Subject: ${matchingEmail.subject}`);
        console.log(`    Date: ${matchingEmail.date}`);

        // Step 3: Download attachment
        console.log('\nStep 2: Downloading attachment...');
        let attachmentPath;
        try {
            attachmentPath = await downloadAttachment(matchingEmail.id);
            console.log(`  Downloaded: ${attachmentPath}`);
        } catch (err) {
            throw new Error(`Failed to download attachment: ${err.message}`);
        }

        // Step 4: Process the file
        console.log('\nStep 3: Processing inventory file...');
        const scriptDir = path.dirname(__filename);
        const result = processInventoryFile(attachmentPath, null);

        // Step 5: Create zip of Chuboe files
        console.log('\nStep 4: Creating zip archive of Chuboe files...');
        const dateStr = new Date().toISOString().split('T')[0];
        const zipPath = path.join(result.outputDir, `OT_Chuboe_Files_${dateStr}.zip`);
        await createZipArchive(result.chuboeFiles, zipPath);

        // Step 6: Send emails
        console.log('\nStep 5: Sending notification emails...');

        // Email 1: Netcomponents Upload
        const sent1 = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Netcomponents Upload',
            `Inventory cleanup completed successfully.

Attached: Consolidated portal file for Netcomponents upload.

Processed: ${result.uniqueRows.toLocaleString()} unique rows
Date: ${dateStr}`,
            [result.portalFile]
        );

        // Email 2: OT Inventory Upload
        const sent2 = await sendEmail(
            EMAIL_CONFIG.recipient,
            'OT Inventory Upload',
            `Inventory cleanup completed successfully.

Attached: Zipped Chuboe files for iDempiere import (${result.chuboeFiles.length} warehouse groups).

Processed: ${result.uniqueRows.toLocaleString()} unique rows
Warehouse groups: ${Object.keys(result.groups).length}
Date: ${dateStr}`,
            [zipPath]
        );

        // Step 7: Move processed email
        console.log('\nStep 6: Moving email to processed folder...');
        await moveEmail(matchingEmail.id, EMAIL_CONFIG.processedFolder);

        // Step 8: Cleanup attachment
        console.log('\nStep 7: Cleaning up temp files...');
        try {
            fs.unlinkSync(attachmentPath);
        } catch (e) { /* ignore */ }

        console.log('\n' + '='.repeat(60));
        console.log('FETCH AND PROCESS COMPLETE');
        console.log('='.repeat(60));
        console.log(`Emails sent: ${sent1 && sent2 ? 'Yes' : 'Partial'}`);
        console.log(`Output: ${result.outputDir}`);

        return { success: true, result };

    } catch (err) {
        console.error('\n' + '='.repeat(60));
        console.error('FETCH FAILED');
        console.error('='.repeat(60));
        console.error(`Error: ${err.message}`);

        // Send failure notification
        await sendFailureNotice(err.message);

        return { success: false, error: err.message };
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.log('Usage: node inventory_cleanup.js <input_file.xlsx|csv> [output_directory]');
        console.log('       node inventory_cleanup.js fetch');
        console.log('\nCommands:');
        console.log('  fetch                    Fetch from email inbox and process automatically');
        console.log('  <file.xlsx>              Process a specific file');
        console.log('\nExamples:');
        console.log('  node inventory_cleanup.js fetch');
        console.log('  node inventory_cleanup.js ASTItemLotsReportInputs_USS_4544132.xlsx');
        process.exit(1);
    }

    if (args[0] === 'fetch') {
        fetchAndProcess()
            .then(result => {
                process.exit(result.success ? 0 : 1);
            })
            .catch(err => {
                console.error('Unexpected error:', err);
                process.exit(1);
            });
    } else {
        const inputFile = args[0];
        const outputDir = args[1] || null;
        processInventoryFile(inputFile, outputDir);
    }
}

module.exports = { processInventoryFile, fetchAndProcess };
