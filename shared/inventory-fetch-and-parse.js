#!/usr/bin/env node
/**
 * Inventory Fetch and Parse
 *
 * Single foundational job that all inventory workflows depend on.
 * Fetches Infor xlsx from email, parses all warehouses, caches result.
 *
 * Cron: Monday 6 AM (runs FIRST, before any inventory workflows)
 *
 * Usage:
 *   node inventory-fetch-and-parse.js           # Fetch from email + parse
 *   node inventory-fetch-and-parse.js --local   # Parse existing xlsx (skip fetch)
 *   node inventory-fetch-and-parse.js --status  # Show cache status
 *
 * Output:
 *   ~/.inventory-storage/inventory_YYYY-MM-DD.xlsx  (source file)
 *   ~/.inventory-storage/parsed_YYYY-MM-DD.json     (cached parse result)
 *
 * Consumers:
 *   const { loadCachedInventory, getCacheStatus } = require('./inventory-fetch-and-parse');
 *   const inv = loadCachedInventory();  // Returns parsed data or null
 *   const rows = inv.byWarehouse['W111'];
 *
 * @module shared/inventory-fetch-and-parse
 */

const fs = require('fs');
const path = require('path');
const { createFetcher } = require('./email-fetcher');
const { createNotifier } = require('./notifier');
const { parseInventoryFile } = require('./inventory-parser');

// =============================================================================
// CONFIGURATION
// =============================================================================

const STORAGE_DIR = path.join(process.env.HOME, '.inventory-storage');
const EMAIL_ACCOUNT = 'excess';
const EMAIL_SUBJECT_PATTERN = /Task finished: \[success\] \d+ AST Item Lots Report Inputs/i;
const PROCESSED_FOLDER = 'Inventory Processed';
const NOTIFY_EMAIL = 'jake.harris@astutegroup.com';

// Max age in days before cache is considered stale
const MAX_CACHE_AGE_DAYS = 7;

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// =============================================================================
// DATE HELPERS
// =============================================================================

function getDateStamp() {
    return new Date().toISOString().split('T')[0];
}

function getWeekStartDate() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
}

// =============================================================================
// FILE PATHS
// =============================================================================

function getXlsxPath(dateStr = null) {
    const date = dateStr || getWeekStartDate();
    return path.join(STORAGE_DIR, `inventory_${date}.xlsx`);
}

function getParsedPath(dateStr = null) {
    const date = dateStr || getWeekStartDate();
    return path.join(STORAGE_DIR, `parsed_${date}.json`);
}

// =============================================================================
// EMAIL FUNCTIONS
// =============================================================================

const fetcher = createFetcher(EMAIL_ACCOUNT);
const notifier = createNotifier({
    fromEmail: `${EMAIL_ACCOUNT}@orangetsunami.com`,
    fromName: 'Inventory Fetch',
});

async function listEmails(folder = 'INBOX') {
    return await fetcher.listEnvelopes(folder, 100);
}

async function downloadAttachment(messageId, folder = 'INBOX') {
    console.log(`  Downloading attachments from message ${messageId}...`);

    // Clean up any previous ASTItemLotsReport files in /tmp
    const oldFiles = fs.readdirSync('/tmp').filter(f => f.includes('ASTItemLotsReport'));
    for (const f of oldFiles) {
        try { fs.unlinkSync(path.join('/tmp', f)); } catch (e) { /* ignore */ }
    }

    const attachments = await fetcher.downloadAttachments(messageId, folder, '/tmp');
    if (!attachments || attachments.length === 0) {
        throw new Error('No attachments found in message');
    }

    // Find the xlsx attachment
    const xlsxAtt = attachments.find(a =>
        a.filename.includes('ASTItemLotsReport') &&
        (a.filename.endsWith('.xlsx') || a.filename.endsWith('.xls'))
    );

    if (xlsxAtt) {
        console.log(`  Found: ${xlsxAtt.path}`);
        return xlsxAtt.path;
    }

    // Check if any attachment is an xlsx by content
    for (const att of attachments) {
        if (att.filename.includes('ASTItemLotsReport')) {
            const xlsxPath = att.path.replace(/\.[^.]+$/, '.xlsx');
            if (xlsxPath !== att.path) {
                fs.copyFileSync(att.path, xlsxPath);
                console.log(`  Converted ${att.filename} to ${path.basename(xlsxPath)}`);
            }
            return xlsxPath;
        }
    }

    throw new Error('No ASTItemLotsReport attachment found. Files: ' +
        attachments.map(a => a.filename).join(', '));
}

async function moveEmail(messageId, targetFolder, sourceFolder = 'INBOX') {
    return await fetcher.moveMessage(messageId, targetFolder, sourceFolder);
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Fetch xlsx from email
 * @returns {Promise<string>} Path to saved xlsx
 */
async function fetchFromEmail() {
    console.log('='.repeat(60));
    console.log('INVENTORY FETCH');
    console.log('='.repeat(60));
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Looking for: ${EMAIL_SUBJECT_PATTERN}`);
    console.log('-'.repeat(60));

    // Step 1a: Sort inbox - move inventory emails to Inventory Reports folder
    console.log('\nStep 1a: Sorting inbox...');
    const inboxEmails = await listEmails('INBOX');
    const inventoryInInbox = inboxEmails.filter(e => EMAIL_SUBJECT_PATTERN.test(e.subject));
    if (inventoryInInbox.length > 0) {
        console.log(`  Found ${inventoryInInbox.length} inventory email(s) in INBOX`);
        for (const e of inventoryInInbox) {
            await moveEmail(e.id, 'Inventory Reports', 'INBOX');
        }
        console.log('  Moved to Inventory Reports folder');
    } else {
        console.log('  No new inventory emails in INBOX');
    }

    // Step 1b: Recover any inventory emails misrouted to NotOffer by the offer-poller
    console.log('\nStep 1b: Checking NotOffer for misrouted inventory emails...');
    try {
        const notOfferEmails = await listEmails('NotOffer');
        const inventoryInNotOffer = notOfferEmails.filter(e => EMAIL_SUBJECT_PATTERN.test(e.subject));
        if (inventoryInNotOffer.length > 0) {
            console.log(`  Found ${inventoryInNotOffer.length} inventory email(s) in NotOffer — recovering`);
            for (const e of inventoryInNotOffer) {
                await moveEmail(e.id, 'Inventory Reports', 'NotOffer');
            }
            console.log('  Moved to Inventory Reports folder');
        } else {
            console.log('  No inventory emails in NotOffer');
        }
    } catch (err) {
        console.log(`  Warning: Could not check NotOffer: ${err.message}`);
    }

    // Step 2: Check Inventory Reports folder
    console.log('\nStep 2: Checking Inventory Reports folder...');
    const emails = await listEmails('Inventory Reports');
    console.log(`  Found ${emails.length} emails`);

    // Find most recent matching email (highest task number)
    const matchingEmails = emails.filter(e => EMAIL_SUBJECT_PATTERN.test(e.subject));
    const matchingEmail = matchingEmails.sort((a, b) => {
        const numA = parseInt((a.subject.match(/(\d{7})/) || [0, 0])[1]) || 0;
        const numB = parseInt((b.subject.match(/(\d{7})/) || [0, 0])[1]) || 0;
        return numB - numA;
    })[0];

    if (!matchingEmail) {
        throw new Error('No matching inventory email found');
    }

    console.log(`\n  Found:`);
    console.log(`    Subject: ${matchingEmail.subject}`);
    console.log(`    Date: ${matchingEmail.date}`);

    // Step 3: Download attachment
    console.log('\nStep 3: Downloading attachment...');
    const tempPath = await downloadAttachment(matchingEmail.id, 'Inventory Reports');

    // Step 4: Save to storage
    const weekStart = getWeekStartDate();
    const xlsxPath = getXlsxPath(weekStart);
    fs.copyFileSync(tempPath, xlsxPath);
    console.log(`  Saved: ${xlsxPath}`);

    // Step 5: Move email to processed
    console.log('\nStep 4: Moving email to processed...');
    try {
        await moveEmail(matchingEmail.id, PROCESSED_FOLDER, 'Inventory Reports');
        console.log(`  Moved to ${PROCESSED_FOLDER}`);
    } catch (err) {
        console.log(`  Warning: Could not move email: ${err.message}`);
    }

    return xlsxPath;
}

/**
 * Parse xlsx and cache result
 * @param {string} xlsxPath - Path to xlsx file
 * @returns {object} Parsed inventory data
 */
function parseAndCache(xlsxPath) {
    console.log('\n' + '='.repeat(60));
    console.log('INVENTORY PARSE');
    console.log('='.repeat(60));
    console.log(`Source: ${path.basename(xlsxPath)}`);

    // Parse
    console.log('\nParsing...');
    const result = parseInventoryFile(xlsxPath);

    console.log(`  Total rows: ${result.metadata.uniqueRows}`);
    console.log(`  Warehouses: ${Object.keys(result.byWarehouse).length}`);

    // Add cache metadata
    result.metadata.cachedAt = new Date().toISOString();
    result.metadata.weekOf = getWeekStartDate();

    // Save to cache
    const parsedPath = getParsedPath(result.metadata.weekOf);
    fs.writeFileSync(parsedPath, JSON.stringify(result, null, 2));
    console.log(`  Cached: ${parsedPath}`);

    // Print warehouse summary
    console.log('\nWarehouse breakdown:');
    const sortedWarehouses = Object.entries(result.metadata.warehouseSummary)
        .sort((a, b) => a[0].localeCompare(b[0]));
    for (const [wh, count] of sortedWarehouses) {
        console.log(`  ${wh}: ${count.toLocaleString()} rows`);
    }

    return result;
}

/**
 * Full fetch and parse flow
 * @returns {Promise<object>} Parsed inventory data
 */
async function fetchAndParse() {
    const xlsxPath = await fetchFromEmail();
    return parseAndCache(xlsxPath);
}

// =============================================================================
// CONSUMER FUNCTIONS (for use by workflows)
// =============================================================================

/**
 * Load cached inventory data
 * @param {object} options
 * @param {number} options.maxAgeDays - Max age in days (default: 7)
 * @param {boolean} options.allowStale - Return stale data if fresh not available
 * @returns {object|null} Cached data or null if not found/stale
 */
function loadCachedInventory(options = {}) {
    const { maxAgeDays = MAX_CACHE_AGE_DAYS, allowStale = false } = options;

    // Try this week's cache first
    const weekStart = getWeekStartDate();
    const parsedPath = getParsedPath(weekStart);

    if (fs.existsSync(parsedPath)) {
        const data = JSON.parse(fs.readFileSync(parsedPath, 'utf8'));
        const cachedAt = new Date(data.metadata.cachedAt);
        const ageDays = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60 * 24);

        if (ageDays <= maxAgeDays) {
            return data;
        } else if (allowStale) {
            console.warn(`Warning: Using stale cache (${Math.round(ageDays)} days old)`);
            data.metadata.stale = true;
            return data;
        }
    }

    // Try to find any recent cache file
    if (allowStale) {
        const cacheFiles = fs.readdirSync(STORAGE_DIR)
            .filter(f => f.startsWith('parsed_') && f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(STORAGE_DIR, f),
                mtime: fs.statSync(path.join(STORAGE_DIR, f)).mtime,
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (cacheFiles.length > 0) {
            const data = JSON.parse(fs.readFileSync(cacheFiles[0].path, 'utf8'));
            data.metadata.stale = true;
            console.warn(`Warning: Using stale cache from ${cacheFiles[0].name}`);
            return data;
        }
    }

    return null;
}

/**
 * Get cache status
 * @returns {object} { hasFreshCache, hasStaleCache, cacheAge, cachePath }
 */
function getCacheStatus() {
    const weekStart = getWeekStartDate();
    const parsedPath = getParsedPath(weekStart);

    if (fs.existsSync(parsedPath)) {
        const stats = fs.statSync(parsedPath);
        const ageDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

        return {
            hasFreshCache: ageDays <= MAX_CACHE_AGE_DAYS,
            hasStaleCache: true,
            cacheAge: Math.round(ageDays * 10) / 10,
            cachePath: parsedPath,
            cacheDate: stats.mtime.toISOString(),
            weekOf: weekStart,
        };
    }

    // Check for any stale cache
    const cacheFiles = fs.readdirSync(STORAGE_DIR)
        .filter(f => f.startsWith('parsed_') && f.endsWith('.json'))
        .sort()
        .reverse();

    if (cacheFiles.length > 0) {
        const stalePath = path.join(STORAGE_DIR, cacheFiles[0]);
        const stats = fs.statSync(stalePath);
        const ageDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

        return {
            hasFreshCache: false,
            hasStaleCache: true,
            cacheAge: Math.round(ageDays * 10) / 10,
            cachePath: stalePath,
            cacheDate: stats.mtime.toISOString(),
            weekOf: cacheFiles[0].replace('parsed_', '').replace('.json', ''),
        };
    }

    return {
        hasFreshCache: false,
        hasStaleCache: false,
        cacheAge: null,
        cachePath: null,
        cacheDate: null,
        weekOf: null,
    };
}

/**
 * Get rows for specific warehouses from cache
 * @param {string[]} warehouseCodes - e.g., ['W111', 'W115']
 * @param {object} options - Options for loadCachedInventory
 * @returns {object[]} Combined rows or empty array
 */
function getWarehouseRowsFromCache(warehouseCodes, options = {}) {
    const cache = loadCachedInventory(options);
    if (!cache) return [];

    const rows = [];
    for (const code of warehouseCodes) {
        const upperCode = code.toUpperCase();
        if (cache.byWarehouse[upperCode]) {
            rows.push(...cache.byWarehouse[upperCode]);
        }
    }
    return rows;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--status')) {
        const status = getCacheStatus();
        console.log('Inventory Cache Status');
        console.log('='.repeat(40));
        console.log(`Fresh cache: ${status.hasFreshCache ? 'YES' : 'NO'}`);
        console.log(`Stale cache: ${status.hasStaleCache ? 'YES' : 'NO'}`);
        if (status.cachePath) {
            console.log(`Cache path: ${status.cachePath}`);
            console.log(`Cache date: ${status.cacheDate}`);
            console.log(`Cache age: ${status.cacheAge} days`);
            console.log(`Week of: ${status.weekOf}`);
        } else {
            console.log('No cache found');
        }
        return;
    }

    if (args.includes('--local')) {
        // Parse existing xlsx without fetching
        const xlsxPath = args.find(a => a.endsWith('.xlsx')) || getXlsxPath();
        if (!fs.existsSync(xlsxPath)) {
            console.error(`Error: xlsx not found: ${xlsxPath}`);
            process.exit(1);
        }
        parseAndCache(xlsxPath);
        return;
    }

    // Default: fetch and parse
    try {
        await fetchAndParse();
        console.log('\n' + '='.repeat(60));
        console.log('COMPLETE');
        console.log('='.repeat(60));
    } catch (err) {
        console.error('\nERROR:', err.message);

        // Send failure notification
        try {
            await notifier.sendEmail(
                NOTIFY_EMAIL,
                'FAILED: Inventory Fetch and Parse',
                `Inventory fetch/parse failed at ${new Date().toISOString()}\n\nError: ${err.message}`
            );
        } catch (e) {
            console.error('Could not send failure notification:', e.message);
        }

        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Core functions
    fetchAndParse,
    fetchFromEmail,
    parseAndCache,

    // Consumer functions (for workflows)
    loadCachedInventory,
    getCacheStatus,
    getWarehouseRowsFromCache,

    // Path helpers
    getXlsxPath,
    getParsedPath,
    getWeekStartDate,

    // Constants
    STORAGE_DIR,
    MAX_CACHE_AGE_DAYS,
};
