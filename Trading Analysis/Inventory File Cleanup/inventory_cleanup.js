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
const { createGzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { createFetcher } = require('../../shared/email-fetcher');
const { createNotifier } = require('../../shared/notifier');

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

// NetComponents upload configuration
// Set NC_UPLOAD_ENABLED=true to send CSVs directly to NetComponents
const NC_UPLOAD_CONFIG = {
    enabled: process.env.NC_UPLOAD_ENABLED === 'true',
    nonAuthEmail: process.env.NC_NONAUTH_EMAIL || null,      // e.g., 'upload@netcomponents.com'
    franchiseEmail: process.env.NC_FRANCHISE_EMAIL || null,  // e.g., 'upload@netcomponents.com'
    fromEmail: 'stockrfq@orangetsunami.com',
    fromName: 'Astute Electronics'
};

// Persistent storage for inventory xlsx (for Thursday reprocess)
const INVENTORY_STORAGE_DIR = path.join(process.env.HOME, 'workspace/.inventory-storage');
if (!fs.existsSync(INVENTORY_STORAGE_DIR)) {
    fs.mkdirSync(INVENTORY_STORAGE_DIR, { recursive: true });
}

/**
 * Get the Monday of the current week as YYYY-MM-DD string.
 * Used to identify which week's inventory file to use for reprocessing.
 */
function getWeekStartDate() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
}

/**
 * Get the path to this week's saved inventory file.
 * Returns null if no file exists for this week.
 */
function getThisWeekInventoryFile() {
    const weekStart = getWeekStartDate();
    const persistentPath = path.join(INVENTORY_STORAGE_DIR, `inventory_${weekStart}.xlsx`);
    if (fs.existsSync(persistentPath)) {
        return persistentPath;
    }
    return null;
}

// Rows to skip at start of file (Infor report header)
const HEADER_ROWS_TO_SKIP = 7;

// Footer patterns to detect and remove
const FOOTER_PATTERNS = ['Page ', 'USS,'];

// Composite key fields for deduplication
const DEDUPE_FIELDS = ['Item', 'Lot', 'Location', 'Warehouse Name', 'Site', 'Date Lot'];

// Warehouse groupings: [group_name, warehouse_codes, special_filter]
// Special filter format: {column, value} or null
// File naming: {warehouse_codes}_{group_name}.csv (e.g., W104_W112_Free_Stock_Austin.csv)
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

// Static carryover offers — manually loaded inventory that lives outside the
// weekly Infor export but still needs to be marketed in OT. Each weekly run
// re-creates these offers under fresh chuboe_offer IDs so the Created date
// stays current and they remain visible in date-sensitive consumers (Vortex
// Matches, etc.).
//
// Lookup strategy: each refreshed offer is written with description
// `[Carryover] {label} — refreshed YYYY-MM-DD`, so subsequent runs find them
// via `startswith(Description, '[Carryover] {label}')`. The bootstrapId is
// only used on the very first run before any refresh has happened — once
// the description prefix lands, the bootstrap ID is irrelevant.
//
// To stop refreshing one of these (e.g. it's been received into Infor and
// no longer needs the carryover), remove its entry from this list. The
// existing offer will stay in OT but stop being refreshed; manually
// deactivate it via the OT UI when ready.
//
// Roadmap B4 (open-PO inventory) is the long-term replacement for this
// workaround — once the loader can pull from Infor's open-PO data the
// static carryover list should empty out.
// Unified-offer model (2026-05-12 refactor): entries with `mergeIntoGroup`
// no longer write their own `[Carryover] {label}` offer. Instead the seed
// lives in `carryover-registry/{slug}.json` and is merged into the matching
// `WAREHOUSE_WRITEBACK` group's weekly write (Infor-row wins on MPN clash).
// Standalone `[Carryover]` offers in OT are deactivated as a one-time cleanup
// on the first cron run after this change. The `bootstrapId` field is kept
// for historical reference (the original OT offer used during initial seed).
const STATIC_CARRYOVER_OFFERS = [
    {
        label: 'Eaton Consignment',
        registrySlug: 'eaton-consignment',
        bootstrapId: 1024798,
        portalWarehouseName: 'Astute Electronics Inc. - Eaton (Carryover)',
        // Eaton consignment stock lands in Infor W117 once received — pair for
        // auto-retire of carryover MPNs that show up in the weekly Infor export.
        // Re-enabled 2026-04-22 after one-off cleanup; reconcileCarryover
        // treats MFR mismatches as informational (Infor's W117 MFR tag is
        // unreliable — see project_chuboe_warehouse_group_unreliable.md).
        pairedWarehouses: ['W117'],
        mergeIntoGroup: 'Eaton_Consignment',
    },
    {
        label: 'Free Stock - Philippines',
        registrySlug: 'free-stock-philippines',
        bootstrapId: 1025258,
        portalWarehouseName: 'Astute Electronics Inc. - Philippines (Carryover)',
        // Philippines (W109/W114) currently has no live Infor data — both
        // warehouses have been empty for at least 2 weeks (verified 5/07,
        // master CSV has 0 rows in W109 and 0 in W114). Registry holds the
        // 195 active lines as a manual-add. When stock physically moves in
        // and Infor starts reporting W109/W114 again, reconcileCarryover
        // will auto-retire matching MPNs at the 95% qty threshold, same
        // pattern as Eaton (W117) and LAM (W118). Until then the loop
        // finds 0 paired-warehouse rows for every MPN and keeps everything.
        pairedWarehouses: ['W109', 'W114'],
        mergeIntoGroup: 'Free_Stock_Philippines',
    },
    {
        label: 'LAM Consignment',
        registrySlug: 'lam-consignment',
        bootstrapId: 1026158,
        portalWarehouseName: 'Astute Electronics Inc. - LAM (Carryover)',
        // LAM consignment stock lands in Infor W118 once received — pair for
        // auto-retire as lines are received (same pattern as Eaton). Seeded
        // 2026-04-22 from master static file (POV0071878, 103 MPNs, $2.14M).
        pairedWarehouses: ['W118'],
        mergeIntoGroup: 'LAM_Consignment',
    },
    // 'Incoming Lot bid from Marvell' was removed 2026-05-07 — bootstrap
    // 1024030 was created 2025-07-17 but NEVER seeded with any lines (0
    // active, 0 inactive ever). The slot was placeholder-only; nobody ever
    // followed through to populate it with a won-lot's lines, so the weekly
    // refresh has been "leaving as-is" for 10 months. Removing the dead
    // entry. Open business question — see deferred-work.md "Marvell carryover
    // — should we be tracking incoming lot bids at all?"
    {
        label: 'GM Stock',
        registrySlug: 'gm-stock',
        bootstrapId: 1026173,
        portalWarehouseName: 'Astute Electronics Inc. - GM Stock',
        // Bootstrapped 2026-04-28 from Josh Pucci's "GM Inventory" email
        // (4/27, attachment "Ready To Ship - GM GP 11.14.25.xlsx", tab
        // "1120 Price Update"). 19 MPNs / 2,628,000 pcs (Nexperia + Onsemi).
        // Posted under Astute Electronics Inc → Stock - Austin Warehouse.
        // No paired Infor warehouse — this stock lives outside the weekly
        // export and propagates forward as-is until retired. NO mergeIntoGroup
        // — this carryover remains a standalone `[Carryover]` offer in OT.
    },
];

// reconcileCarryover threshold — if Infor paired-warehouse qty ≥ this fraction
// of the carryover qty, the line is considered fully received and is retired
// from next week's carryover. 0.95 accounts for minor lot/count drift.
const RECONCILE_QTY_THRESHOLD = 0.95;

// File-backed registry path for static carryover seeds (unified-offer model).
// Each STATIC_CARRYOVER_OFFERS entry with `registrySlug` reads from
// `carryover-registry/{slug}.json`. See carryover-registry/README — schema
// is { label, lineCount, lines: [{mpn, mfr, qty, dateCode, packageDesc,
// description, moq, spq}] }. The manage-carryover.js CLI reads/writes
// against these files; this script reads them at cron time to build the
// supplement set merged into each paired warehouse group's weekly write.
const CARRYOVER_REGISTRY_DIR = path.join(__dirname, 'carryover-registry');

function loadCarryoverRegistry(slug) {
    const filePath = path.join(CARRYOVER_REGISTRY_DIR, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`carryover registry not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.lines)) {
        throw new Error(`carryover registry malformed (no lines array): ${filePath}`);
    }
    return obj;
}

// Warehouse Group → OT write-back mapping
// Each entry produces one chuboe_offer (header) per weekly run, with the
// week's lots posted as chuboe_offer_line rows. Prior week's offers for the
// same (BP, OfferType) pair are deactivated before the new write.
//
// Groups intentionally NOT in this map (CSV-only, no OT write-back):
//   LAM_3PL, Allocated_Warehouse, HK_Allocated_Warehouse
const WAREHOUSE_WRITEBACK = {
    'Free_Stock_Austin':       { bpartnerId: 1000332, offerTypeId: 1000008 }, // Astute Electronics Inc → Austin
    'Free_Stock_Stevenage':    { bpartnerId: 1000332, offerTypeId: 1000006 }, // Astute Electronics Inc → Stevenage
    'Free_Stock_Hong_Kong':    { bpartnerId: 1000332, offerTypeId: 1000009 }, // Astute Electronics Inc → Hong Kong
    'Free_Stock_Philippines':  { bpartnerId: 1000332, offerTypeId: 1000014 }, // Astute Electronics Inc → Philippines
    'Franchise_Stock':         { bpartnerId: 1000325, offerTypeId: 1000008 }, // Astute - Franchise Stock → Austin
    'GE_Consignment':          { bpartnerId: 1003236, offerTypeId: 1000008 }, // Astute - GE Aviation Excess → Austin
    'Taxan_Consignment':       { bpartnerId: 1003621, offerTypeId: 1000008 }, // Astute - Taxan Excess → Austin
    'Spartronics_Consignment': { bpartnerId: 1005225, offerTypeId: 1000008 }, // Astute - Spartronics Excess → Austin
    'Eaton_Consignment':       { bpartnerId: 1010966, offerTypeId: 1000014 }, // Astute Inc - Eaton Consignment → Philippines
    'LAM_Consignment':         { bpartnerId: 1011267, offerTypeId: 1000014 }, // Astute - LAM Consignment → Philippines
    'LAM_Dead_Inventory':      { bpartnerId: 1000332, offerTypeId: 1000008 }, // Astute Electronics Inc → Austin (separate offer)
};

// Sanity check: every STATIC_CARRYOVER_OFFERS entry with `mergeIntoGroup`
// must name a real WAREHOUSE_WRITEBACK key. Catches typos / drift between
// the carryover registry and the writeback map at module load (fails fast).
for (const cfg of STATIC_CARRYOVER_OFFERS) {
    if (cfg.mergeIntoGroup && !WAREHOUSE_WRITEBACK[cfg.mergeIntoGroup]) {
        throw new Error(
            `STATIC_CARRYOVER_OFFERS misconfigured: label "${cfg.label}" has ` +
            `mergeIntoGroup="${cfg.mergeIntoGroup}" which is not a key in ` +
            `WAREHOUSE_WRITEBACK. Add the group to WAREHOUSE_WRITEBACK or fix the name.`
        );
    }
}

// Groups intentionally excluded from BOTH OT write-back AND the NetComponents
// portal CSVs. Internal-only — MAIN allocation, W105 HK allocated, W111 LAM
// 3PL transit. Not marketed externally, not represented as customer-facing
// chuboe_offer records.
//
// Any group present in result.groups that is NEITHER in WAREHOUSE_WRITEBACK
// NOR in this set will trip assertRoutingInvariants and abort the run. This
// is the tripwire that catches a new warehouse being added to the splitter
// without the dev consciously deciding which side it belongs on.
const KNOWN_INTERNAL_GROUPS = new Set([
    'HK_Allocated_Warehouse',
    'Allocated_Warehouse',
    'LAM_3PL',
]);

// Portal export columns — source columns from the cleaned Infor data.
// The output CSV uses friendlier headers via PORTAL_COLUMN_LABELS below.
const PORTAL_COLUMNS = [
    'Item', 'ItemDescription', 'Name', 'Lot Quantity', 'Date Code'
];

// Source column → output header in the NetComponents upload CSV.
const PORTAL_COLUMN_LABELS = {
    'Item':          'MPN',
    'ItemDescription': 'Description',
    'Name':          'Manufacturer',
    'Lot Quantity':  'Qty',
    'Date Code':     'D/C',
};

// =============================================================================
// EMAIL FUNCTIONS (using shared imapflow-based modules)
// =============================================================================

const fetcher = createFetcher(EMAIL_CONFIG.account);
const notifier = createNotifier({
    fromEmail: `${EMAIL_CONFIG.account}@orangetsunami.com`,
    fromName: 'Inventory Cleanup',
    smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
});

async function listEmails(folder = 'INBOX') {
    return await fetcher.listEnvelopes(folder, 100);
}

async function downloadAttachment(messageId, folder = 'INBOX') {
    console.log(`  Downloading attachments from message ${messageId}...`);

    // Clean up any previous ASTItemLotsReport files in /tmp to avoid stale matches
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

    // Check if any attachment is an xlsx by content (might have wrong extension)
    for (const att of attachments) {
        if (att.filename.includes('ASTItemLotsReport')) {
            // Rename to xlsx
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

async function sendEmail(to, subject, body, attachmentPaths = []) {
    console.log(`  Sending email to ${to}: ${subject}`);
    const attachments = attachmentPaths
        .filter(p => fs.existsSync(p))
        .map(p => ({ filename: path.basename(p), path: p }));

    if (attachments.length > 0) {
        return await notifier.sendWithAttachment(to, subject, body, attachments);
    }
    return await notifier.sendEmail(to, subject, body);
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
// OT WRITE-BACK
// =============================================================================

/**
 * Write the week's inventory to OT (iDempiere) via the REST API.
 * One chuboe_offer per warehouse group in WAREHOUSE_WRITEBACK. Prior week's
 * offers for the same (BP, OfferType) are deactivated before each new write.
 *
 * @param {object} groupedRows  - { groupName: [rawRow, rawRow, ...] } from processInventoryFile
 * @param {string} dateStr      - YYYY-MM-DD for offer description
 * @param {boolean} dryRun      - If true, log what would happen without calling the API
 * @returns {Array<object>}     - Per-group result records (status, counts, errors, offer ID)
 */
/**
 * Routing invariant tripwire — verifies the portal CSVs and the OT write-back
 * have stayed in lockstep. Catches the failure mode that creeps in over time
 * as new warehouse groups, carryovers, or routing rules get added: one side
 * of the pipeline (portal vs OT) gets wired up without mirroring the other.
 *
 * Hard-throws on:
 *   1. A data-bearing group not in WAREHOUSE_WRITEBACK and not in
 *      KNOWN_INTERNAL_GROUPS — caller has to consciously route it.
 *   2. Per-group portal vs OT-attempted row count mismatch — both sides
 *      should attempt the same rows for every WAREHOUSE_WRITEBACK group.
 *
 * Returns soft-warn data (no throw) for runtime degradation cases:
 *   - mainShortfall      → OT wrote fewer lines than attempted (per-line errors)
 *   - carryoverPartial   → Step 5d appended carryover rows to portal but OT
 *                          refresh failed/partial — portal advertises stock
 *                          OT doesn't actually hold
 *
 * @param {object} args
 * @param {object} args.result            - return of processInventoryFile
 * @param {Array}  args.writebackResults  - return of writeInventoryToOT
 * @param {Array}  [args.carryoverResults] - return of refreshStaticCarryoverOffers (fetch mode only)
 * @param {'fetch'|'manual'} args.mode    - which entrypoint is calling
 * @returns {object} reconciliation totals + soft-warn data for the email
 */
function assertRoutingInvariants({ result, writebackResults, carryoverResults = [], supplementsByGroup = {}, mode }) {
    const { cleanMpn } = require('../../shared/db-helpers');
    const otGroupNames = new Set(Object.keys(WAREHOUSE_WRITEBACK));
    const errors = [];

    // ─── Check 1: every data-bearing group is intentionally routed ──────────
    const orphans = [];
    for (const groupName of Object.keys(result.groups || {})) {
        const rowCount = (result.groups[groupName] || []).length;
        if (rowCount === 0) continue;
        if (otGroupNames.has(groupName)) continue;
        if (KNOWN_INTERNAL_GROUPS.has(groupName)) continue;
        orphans.push({ groupName, rowCount });
    }
    if (orphans.length > 0) {
        errors.push(
            `Group(s) not routed to OT and not in KNOWN_INTERNAL_GROUPS: ` +
            orphans.map(o => `${o.groupName} (${o.rowCount} rows)`).join(', ') +
            `. Add to WAREHOUSE_WRITEBACK (writes to OT + portal) or ` +
            `KNOWN_INTERNAL_GROUPS (excluded from both).`
        );
    }

    // ─── Check 2: per-group portal-vs-OT row counts agree on attempted ─────
    let portalMainTotal = 0;
    let otMainAttempted = 0;
    let otMainWritten = 0;
    const groupGaps = [];

    for (const groupName of otGroupNames) {
        // Mirror the writer's `.filter(l => l.mpn)` so the count compares
        // what each side actually attempts (rows w/ no Item value get
        // dropped on the OT side at line ~498).
        const inforInputCount = (result.groups[groupName] || []).filter(
            r => String(r['Item'] || '').trim()
        ).length;

        // Unified-offer supplements: paired carryovers contribute lines on
        // both sides. They land in the OT offer via writeInventoryToOT and
        // in the portal CSV via Step 5d (post-merge dedupe — Infor wins on
        // MPN clash). Count them on the portal side to keep the per-group
        // check balanced.
        const supplements = supplementsByGroup[groupName] || [];
        const inforMpnCleanSet = new Set(
            (result.groups[groupName] || [])
                .map(r => cleanMpn(String(r['Item'] || '').trim()))
                .filter(Boolean)
        );
        const supplementCountAfterDedupe = supplements.filter(s => {
            const c = cleanMpn(s.mpn);
            return c && !inforMpnCleanSet.has(c);
        }).length;
        const inputCount = inforInputCount + supplementCountAfterDedupe;

        const wb = writebackResults.find(r => r.groupName === groupName);
        let otAttempted = 0;
        let otWritten = 0;
        if (wb) {
            if (wb.status === 'dry-run') {
                otAttempted = wb.linesPlanned || 0;
            } else if (wb.status === 'success' || wb.status === 'partial' || wb.status === 'failed') {
                otAttempted = wb.linesAttempted || 0;
                otWritten = wb.linesWritten || 0;
            }
            // 'skipped' → 0/0
        }

        portalMainTotal += inputCount;
        otMainAttempted += otAttempted;
        otMainWritten += otWritten;

        if (inputCount !== otAttempted) {
            groupGaps.push({
                groupName,
                portalCount: inputCount,
                otAttempted,
                gap: inputCount - otAttempted,
            });
        }
    }

    if (groupGaps.length > 0) {
        const detail = groupGaps.map(g =>
            `${g.groupName}: portal=${g.portalCount}, ot-attempted=${g.otAttempted} (gap ${g.gap >= 0 ? '+' : ''}${g.gap})`
        ).join('; ');
        errors.push(
            `Per-group portal/OT row count mismatch on attempted writes: ${detail}. ` +
            `Both sides should attempt the same rows for every WAREHOUSE_WRITEBACK group.`
        );
    }

    // ─── Throw on hard errors before computing carryover summary ───────────
    if (errors.length > 0) {
        const message = `[Inventory routing invariant] ${errors.length} issue(s):\n  • ` + errors.join('\n  • ');
        const err = new Error(message);
        err.routingErrors = errors;
        err.orphanGroups = orphans;
        err.groupGaps = groupGaps;
        throw err;
    }

    // ─── Carryover reconciliation (soft-warn only, fetch mode only) ────────
    let carryoverPortalTotal = 0;
    let carryoverOtAttempted = 0;
    let carryoverOtWritten = 0;
    const carryoverPartial = [];

    if (mode === 'fetch') {
        for (const r of carryoverResults) {
            // Step 5d portal append iterates r.sourceLines unconditionally,
            // so this is "how many carryover lines hit the portal CSV".
            const portalLines = (r.sourceLines || []).length;
            let otAttempted = 0;
            let otWritten = 0;

            if (r.status === 'success' || r.status === 'partial') {
                otAttempted = r.linesAttempted || 0;
                otWritten = r.linesWritten || 0;
            } else if (r.status === 'dry-run') {
                otAttempted = r.linesPlanned || 0;
            } else if (r.status === 'failed') {
                // Step 5d still appended sourceLines to portal, OT wrote 0.
                otAttempted = portalLines;
            }
            // 'empty' → both 0, no divergence

            carryoverPortalTotal += portalLines;
            carryoverOtAttempted += otAttempted;
            carryoverOtWritten += otWritten;

            if (r.status !== 'dry-run' && portalLines > 0 && otWritten < portalLines) {
                carryoverPartial.push({
                    label: r.label,
                    portalLines,
                    otWritten,
                    gap: portalLines - otWritten,
                    status: r.status,
                    error: r.error || null,
                });
            }
        }
    }

    return {
        portalMainTotal,
        otMainAttempted,
        otMainWritten,
        mainShortfall: otMainAttempted - otMainWritten,
        carryoverPortalTotal,
        carryoverOtAttempted,
        carryoverOtWritten,
        carryoverShortfall: carryoverOtAttempted - carryoverOtWritten,
        carryoverPartial,
    };
}

async function writeInventoryToOT(groupedRows, dateStr, dryRun = false, supplementsByGroup = {}) {
    const { writeOffer, deactivatePriorOffers } = require('../../shared/offer-writeback');
    const { apiGet } = require('../../shared/api-client');
    const { cleanMpn } = require('../../shared/db-helpers');

    console.log('\n' + '='.repeat(60));
    console.log(dryRun ? 'OT WRITE-BACK (DRY RUN)' : 'OT WRITE-BACK');
    console.log('='.repeat(60));

    // Helper: query active chuboe_offer rows for a (BP, OfferType) pair,
    // optionally scoped to a description suffix. Used to capture priorOffers
    // BEFORE the deactivate call so the email summary can show OLD → NEW.
    //
    // IMPORTANT: iDempiere REST returns the chuboe_offer PK as `id` (not
    // `chuboe_offer_id`). The `Value` field is the search key — a separate
    // numeric-looking string that is NOT the PK. Always compare on `id`.
    //
    // The descriptionEndsWith argument is REQUIRED for inventory loaders
    // because multiple warehouse groups share (BP, OfferType) pairs and
    // are distinguished only by description suffix (e.g. "— Free_Stock_Austin"
    // vs "— LAM_Dead_Inventory" both under BP 1000332 + type 1000008).
    async function queryActiveOffers(bpartnerId, offerTypeId, descriptionEndsWith = null) {
        try {
            let filter = `C_BPartner_ID eq ${bpartnerId} and chuboe_offer_type_id eq ${offerTypeId} and IsActive eq true`;
            if (descriptionEndsWith) {
                const escaped = descriptionEndsWith.replace(/'/g, "''");
                filter += ` and endswith(Description,'${escaped}')`;
            }
            const result = await apiGet('chuboe_offer', {
                filter,
                select: 'Value,Created,Description',
                orderby: 'Created desc',
            });
            return (result.records || []).map(r => ({
                id: r.id,                                  // PK
                value: r.Value || r.value || null,         // search key (display)
                created: r.Created || r.created || null,
                description: r.Description || r.description || null,
            }));
        } catch (e) {
            console.warn(`  ! Failed to query active offers for BP=${bpartnerId}, type=${offerTypeId}: ${e.message}`);
            return [];
        }
    }

    const results = [];

    for (const [groupName, mapping] of Object.entries(WAREHOUSE_WRITEBACK)) {
        const rows = groupedRows[groupName] || [];
        const isConsignment = CONSIGNMENT_GROUPS.includes(groupName);
        const supplements = supplementsByGroup[groupName] || [];

        if (rows.length === 0 && supplements.length === 0) {
            console.log(`  ${groupName}: 0 rows (Infor + supplement) — skipping`);
            results.push({ groupName, status: 'skipped', reason: 'no rows', ...mapping });
            continue;
        }

        // Map raw inventory rows → offer-writeback line shape.
        // MFR placeholders ("Not Known Yet" / "Not Known") are scrubbed to
        // null so OT records don't carry junk MFR text — the MFR resolver
        // would otherwise fail to canonicalize them and write the raw string.
        const MFR_PLACEHOLDER_RE = /^(not known( yet)?)$/i;
        const inforLines = rows.map(row => {
            const lot = String(row['Lot'] || '').trim();
            const loc = String(row['Location'] || '').trim();
            const packageDesc = [lot, loc].filter(Boolean).join(';');
            const qty = parseFloat(cleanNumeric(row['Lot Quantity']));
            const rawPrice = parseFloat(cleanNumeric(row['Lot Unit Cost']));
            const mfrRaw = String(row['Name'] || '').trim();
            const mfrText = (!mfrRaw || MFR_PLACEHOLDER_RE.test(mfrRaw)) ? null : mfrRaw;
            return {
                mpn: String(row['Item'] || '').trim(),
                mfrText,
                qty: isNaN(qty) ? null : qty,
                price: isConsignment || isNaN(rawPrice) ? null : rawPrice,
                dateCode: String(row['Date Code'] || '').trim() || null,
                packageDesc: packageDesc || null,
                description: String(row['ItemDescription'] || '').trim() || null,
            };
        }).filter(l => l.mpn);

        // Merge static-seed supplements (Infor-row wins on MPN clash). Build
        // an Infor MPN-clean set, then keep only the supplement lines whose
        // cleaned MPN isn't already covered by Infor. Same semantics as the
        // pre-refactor auto-retire — once a line lands in Infor, the
        // static-seed entry stops being interesting.
        const inforMpnCleanSet = new Set(inforLines.map(l => cleanMpn(l.mpn)).filter(Boolean));
        const supplementSkipped = [];
        const supplementMerged = [];
        for (const sup of supplements) {
            const supClean = cleanMpn(sup.mpn);
            if (supClean && inforMpnCleanSet.has(supClean)) {
                supplementSkipped.push(sup.mpn);
            } else {
                supplementMerged.push(sup);
            }
        }
        if (supplements.length > 0) {
            console.log(`  ${groupName}: merge ${supplementMerged.length}/${supplements.length} static-seed line(s) (${supplementSkipped.length} skipped — already in Infor)`);
        }

        const lines = [...inforLines, ...supplementMerged];

        // Pre-query priorOffers in BOTH dry-run and live mode so the email
        // summary can show "OLD → NEW" mapping. In dry-run these are the
        // offers that *would* be deactivated; in live mode they're the
        // offers that will be deactivated by deactivatePriorOffers().
        //
        // SCOPE: each weekly inventory offer is written with description
        // `Weekly inventory YYYY-MM-DD — GroupName`, so we filter the
        // pre-query (and the deactivate below) by `endswith(Description,
        // '— GroupName')`. This ensures Free_Stock_Austin and
        // LAM_Dead_Inventory don't fight over the (1000332, 1000008) pair —
        // each only sees and replaces its own prior weekly run, and any
        // historical one-off loads with different description shapes are
        // left alone.
        const descriptionSuffix = `— ${groupName}`;
        const priorOffers = await queryActiveOffers(mapping.bpartnerId, mapping.offerTypeId, descriptionSuffix);

        if (dryRun) {
            const oldKeys = priorOffers.map(o => o.value || o.id).join(', ') || 'none';
            console.log(`  [DRY RUN] ${groupName}: would deactivate ${priorOffers.length} prior offer(s) [${oldKeys}] and write ${lines.length} new lines (BP ${mapping.bpartnerId}, OfferType ${mapping.offerTypeId})`);
            results.push({
                groupName,
                status: 'dry-run',
                linesPlanned: lines.length,
                priorOffers,
                ...mapping,
            });
            continue;
        }

        // Live: deactivate then write. Failures isolated per group.
        try {
            const deactResult = await deactivatePriorOffers(
                mapping.bpartnerId,
                mapping.offerTypeId,
                { descriptionEndsWith: descriptionSuffix }
            );
            console.log(`  ${groupName}: deactivated ${deactResult.offersDeactivated} prior offer(s), ${deactResult.linesDeactivated} lines`);

            const writeResult = await writeOffer({
                bpartnerId: mapping.bpartnerId,
                offerTypeId: mapping.offerTypeId,
                description: `Weekly inventory ${dateStr} — ${groupName}`,
                lines,
            });

            const status = writeResult.errors.length === 0 ? 'success' : 'partial';
            console.log(`  ${groupName}: wrote ${writeResult.linesWritten}/${lines.length} lines → offer ${writeResult.searchKey || writeResult.offerId}${writeResult.errors.length ? ` (${writeResult.errors.length} line errors)` : ''}`);

            results.push({
                groupName,
                status,
                offerSearchKey: writeResult.searchKey,
                offerId: writeResult.offerId,
                priorOffers,
                deactivatedOffers: deactResult.offersDeactivated,
                deactivatedLines: deactResult.linesDeactivated,
                linesAttempted: lines.length,
                linesWritten: writeResult.linesWritten,
                errors: writeResult.errors,
                ...mapping,
            });
        } catch (e) {
            console.error(`  ${groupName}: FAILED — ${e.message}`);
            results.push({
                groupName,
                status: 'failed',
                error: e.message,
                priorOffers,
                linesAttempted: lines.length,
                ...mapping,
            });
        }
    }

    // The cross-BP audit moved out of this function — see auditCrossBpStrays
    // below. The audit needs to see BOTH writeback results AND carryover
    // refresh results so it can correctly identify what's actually a stray
    // vs an intentional carryover offer. fetchAndProcess calls it after
    // both Step 5 and Step 5b complete.

    // Console summary table
    console.log('\nWrite-back summary:');
    for (const r of results) {
        const tag = r.status === 'success' ? '✓'
                  : r.status === 'partial' ? '⚠'
                  : r.status === 'failed'  ? '✗'
                  : r.status === 'dry-run' ? '·'
                  : '–';
        const detail = r.status === 'success' || r.status === 'partial'
            ? `${r.linesWritten}/${r.linesAttempted} lines, offer ${r.offerSearchKey || r.offerId}`
            : r.status === 'dry-run' ? `${r.linesPlanned} lines planned`
            : r.status === 'failed'  ? r.error
            : r.reason || '';
        console.log(`  ${tag} ${r.groupName.padEnd(28)} ${detail}`);
    }

    return results;
}

/**
 * Reconcile carryover lines against this week's paired-warehouse inventory.
 *
 * For each MPN on the carryover:
 *   - Sum the carryover qty across all date-code lines → carryoverQty
 *   - Sum this week's qty in the paired warehouses for the same MPN → infoQty
 *   - MFR comparison via shared/mfr-equivalence (handles aliases + acquisitions)
 *
 * Decision:
 *   - MPN not in paired warehouses          → keep all lines
 *   - infoQty >= RECONCILE_QTY_THRESHOLD
 *     AND MFR match (or either blank)       → RETIRE all DC lines for this MPN
 *   - infoQty < threshold                    → keep + flag 'partial'
 *   - MFR mismatch (both populated)          → keep + flag 'mfr-mismatch'
 *
 * @param {Array} allLines - carryover lines from OT
 * @param {Array<string>|null} pairedWarehouses - Infor warehouse codes to pair
 * @param {Map<string, Array>} pendingMpnDetails - this week's MPN → [{warehouse, warehouseName, qty, ...}]
 * @returns {{keptLines, retired, flagged}}
 */
function reconcileCarryover(allLines, pairedWarehouses, pendingMpnDetails) {
    // Null pairing → no reconciliation, keep everything
    if (!pairedWarehouses || pairedWarehouses.length === 0) {
        return { keptLines: allLines, retired: [], flagged: [] };
    }

    const { computeMfrMatch } = require('../../shared/mfr-equivalence');
    const pairedSet = new Set(pairedWarehouses);

    // Group carryover lines by MPN
    const byMpn = new Map();  // mpn → [lines]
    for (const line of allLines) {
        const mpn = String(line.Chuboe_MPN || '').trim();
        if (!mpn) continue;
        if (!byMpn.has(mpn)) byMpn.set(mpn, []);
        byMpn.get(mpn).push(line);
    }

    // Decide per MPN
    const retireMpns = new Set();
    const retired = [];
    const flagged = [];

    for (const [mpn, lines] of byMpn) {
        const thisWeek = (pendingMpnDetails.get(mpn) || []).filter(d => pairedSet.has(d.warehouse));
        if (thisWeek.length === 0) continue;  // no paired-warehouse match → keep

        const carryoverQty = lines.reduce((s, l) => s + (Number(l.Qty) || 0), 0);
        const infoQty = thisWeek.reduce((s, d) => s + (Number(d.qty) || 0), 0);

        // MFR check — carryover has one MFR per line (usually all same for one MPN),
        // this-week detail doesn't carry MFR, so pull from pendingMpnDetails raw.
        // Actually pendingMpnDetails is built without MFR — fall back to comparing
        // across all carryover-line MFRs: if ANY carryover line's MFR matches
        // (or either is blank), treat as MFR-OK.
        const carryoverMfrs = [...new Set(lines.map(l => String(l.Chuboe_MFR_Text || '').trim()))];
        const thisWeekMfrs = [...new Set(thisWeek.map(d => String(d.mfr || '').trim()).filter(Boolean))];

        let mfrMatch = true;  // default permissive when we can't compare
        if (thisWeekMfrs.length > 0 && carryoverMfrs.some(m => m)) {
            mfrMatch = carryoverMfrs.some(cMfr => {
                if (!cMfr) return true;  // blank carryover MFR → skip check
                return thisWeekMfrs.some(tMfr => computeMfrMatch(cMfr, tMfr) !== 'MISMATCH');
            });
        }

        const fullyReceived = infoQty >= RECONCILE_QTY_THRESHOLD * carryoverQty;

        // MFR gate is informational only — Infor's MFR ("Name") field on
        // W117 is unreliable (confirmed 2026-04-22: 37/271 Eaton carryover
        // MPNs show random wrong MFRs on Infor side — e.g. PMV450ENEAR
        // tagged "Microchip" when it's Nexperia). The MPN+qty match is the
        // real signal; we log mismatches so the operator can review, but
        // they don't block retirement.
        if (fullyReceived) {
            retireMpns.add(mpn);
            retired.push({
                mpn,
                carryoverQty,
                infoQty,
                qtyRatio: infoQty / carryoverQty,
                carryoverMfrs,
                thisWeekMfrs,
                mfrMatch,
                dcLineCount: lines.length,
                pairedWarehouses: [...pairedSet],
            });
        } else {
            flagged.push({
                mpn,
                reason: 'partial',
                carryoverQty,
                infoQty,
                qtyRatio: infoQty / carryoverQty,
                carryoverMfrs,
                thisWeekMfrs,
                mfrMatch,
                dcLineCount: lines.length,
                pairedWarehouses: [...pairedSet],
            });
        }
    }

    const keptLines = allLines.filter(l => !retireMpns.has(String(l.Chuboe_MPN || '').trim()));
    return { keptLines, retired, flagged };
}

/**
 * Build supplement lines for each WAREHOUSE_WRITEBACK group that has a
 * merged static carryover. Reads the carryover-registry JSONs, runs
 * reconcileCarryover against this week's Infor paired-warehouse rows, and
 * returns the post-reconciliation kept lines mapped to writeOffer line shape.
 *
 * Returns:
 *   {
 *     supplementsByGroup: { GroupName: [{ mpn, mfrText, qty, dateCode, ... }] },
 *     results: [{ label, mergeIntoGroup, status, sourceLines, retired, flagged, overlapMpns, overlapDetails }]
 *   }
 *
 * `results` is the same shape downstream code expects from
 * refreshStaticCarryoverOffers — Step 5d (portal CSV append) and audit-summary
 * code can consume it uniformly. `sourceLines` is OT-line shape (Chuboe_MPN,
 * Chuboe_MFR_Text, Qty, ...) for parity with the standalone-carryover path.
 *
 * Only entries with `mergeIntoGroup` are processed here — un-paired carryovers
 * (GM Stock) continue through refreshStaticCarryoverOffers unchanged.
 *
 * @param {Array} carryovers       - STATIC_CARRYOVER_OFFERS
 * @param {Map<string, Array>} pendingMpnDetails - same map refreshStaticCarryoverOffers uses
 */
function prepareCarryoverSupplements(carryovers, pendingMpnDetails) {
    const supplementsByGroup = {};
    const results = [];

    for (const cfg of carryovers) {
        if (!cfg.mergeIntoGroup) continue;  // standalone carryover — handled later

        let registry;
        try {
            registry = loadCarryoverRegistry(cfg.registrySlug);
        } catch (e) {
            results.push({
                label: cfg.label,
                mergeIntoGroup: cfg.mergeIntoGroup,
                portalWarehouseName: cfg.portalWarehouseName,
                status: 'failed',
                error: e.message,
                sourceLines: [],
            });
            console.error(`  ${cfg.label}: FAILED — registry load: ${e.message}`);
            continue;
        }

        // Convert registry entries to the OT-line shape reconcileCarryover expects.
        // Keep both shapes: `otShape` for reconcile + downstream Step 5d (portal CSV),
        // and a transformed writeOffer shape attached to supplementsByGroup below.
        const otShapeLines = registry.lines.map(l => ({
            Chuboe_MPN:         l.mpn,
            Chuboe_MFR_Text:    l.mfr || '',
            Qty:                l.qty,
            Chuboe_Date_Code:   l.dateCode || '',
            Chuboe_Package_Desc: l.packageDesc || '',
            Description:        l.description || '',
            Chuboe_MOQ:         l.moq || '',
            Chuboe_SPQ:         l.spq || '',
        }));

        const { keptLines, retired, flagged } = reconcileCarryover(
            otShapeLines, cfg.pairedWarehouses, pendingMpnDetails
        );

        // Overlap detail (mirrors refreshStaticCarryoverOffers' overlap CSV)
        const overlapMpnSet = new Set();
        const overlapDetails = [];
        for (const line of otShapeLines) {
            const mpn = String(line.Chuboe_MPN || '').trim();
            if (!mpn) continue;
            const matches = pendingMpnDetails.get(mpn);
            if (!matches || matches.length === 0) continue;
            overlapMpnSet.add(mpn);
            overlapDetails.push({
                mpn,
                carryoverMfr:        line.Chuboe_MFR_Text || '',
                carryoverQty:        line.Qty || 0,
                carryoverDateCode:   line.Chuboe_Date_Code || '',
                carryoverPackageDesc: line.Chuboe_Package_Desc || '',
                thisWeekMatches:     matches,
            });
        }

        // Convert keptLines back to writeOffer line shape for supplementsByGroup.
        // Prefix `[static-seed]` on description for provenance — every line on
        // the merged offer is identifiable as Infor-live vs static-seed by this marker.
        const writeOfferShapeLines = keptLines.map(l => {
            const origDesc = String(l.Description || '').trim();
            const taggedDesc = origDesc ? `[static-seed] ${origDesc}` : '[static-seed]';
            return {
                mpn:         l.Chuboe_MPN,
                mfrText:     l.Chuboe_MFR_Text || null,
                qty:         l.Qty,
                price:       null,  // static seed has no price — consignment guard would blank anyway
                dateCode:    l.Chuboe_Date_Code || null,
                packageDesc: l.Chuboe_Package_Desc || null,
                description: taggedDesc,
                moq:         l.Chuboe_MOQ || null,
                spq:         l.Chuboe_SPQ || null,
            };
        });

        supplementsByGroup[cfg.mergeIntoGroup] = writeOfferShapeLines;

        const retiredQty = retired.reduce((s, r) => s + r.carryoverQty, 0);
        const mfrDiff = retired.filter(r => !r.mfrMatch).length;
        console.log(`  ${cfg.label} → ${cfg.mergeIntoGroup}: reconcile vs ${cfg.pairedWarehouses.join(',')} → retire ${retired.length} MPN(s)/${retiredQty.toLocaleString()} pc${mfrDiff ? ` (${mfrDiff} w/ MFR diff)` : ''}, flag ${flagged.length} MPN(s), supplement ${keptLines.length}/${otShapeLines.length} line(s)`);

        results.push({
            label: cfg.label,
            mergeIntoGroup: cfg.mergeIntoGroup,
            portalWarehouseName: cfg.portalWarehouseName,
            status: 'merged-supplement',
            sourceLines: keptLines,  // OT shape — Step 5d uses this for portal CSV
            retired,
            flagged,
            overlapMpns: [...overlapMpnSet],
            overlapDetails,
            linesAttempted: keptLines.length,
            linesOriginal: otShapeLines.length,
        });
    }

    return { supplementsByGroup, results };
}

/**
 * Refresh static carryover offers — read each, deactivate it, write a fresh
 * copy with a new Created timestamp. Also cross-reference the carryover
 * MPNs against this week's pending Infor inventory so the user gets flagged
 * when a previously-unreceived part finally lands in the inventory report.
 *
 * @param {Array<{label, bootstrapId}>} carryovers - STATIC_CARRYOVER_OFFERS
 * @param {string} dateStr      - YYYY-MM-DD for new description suffix
 * @param {boolean} dryRun
 * @param {Map<string, Array<{warehouse, warehouseName, qty, lot}>>} pendingMpnDetails
 *   - For each MPN in this week's full Infor export, the warehouses + lot
 *     details where it appears. Used to enrich the overlap CSV so the user
 *     can see exactly where in OT each carryover MPN now lives.
 */
async function refreshStaticCarryoverOffers(carryovers, dateStr, dryRun, pendingMpnDetails) {
    const { writeOffer, deactivateOfferById } = require('../../shared/offer-writeback');
    const { apiGet } = require('../../shared/api-client');

    console.log('\n' + '='.repeat(60));
    console.log(dryRun ? 'STATIC CARRYOVER REFRESH (DRY RUN)' : 'STATIC CARRYOVER REFRESH');
    console.log('='.repeat(60));

    const results = [];

    for (const cfg of carryovers) {
        const labelEsc = cfg.label.replace(/'/g, "''");

        // Unified-offer model: entries with mergeIntoGroup are written into
        // the WAREHOUSE_WRITEBACK group's Weekly inventory offer in Step 5
        // (see prepareCarryoverSupplements). Here we only perform a one-time
        // cleanup of any orphan [Carryover] {label} offer left over from the
        // pre-refactor pipeline. Once the orphan is gone, this branch becomes
        // a no-op on subsequent runs.
        if (cfg.mergeIntoGroup) {
            let orphanOfferId = null;
            let orphanHeader = null;
            try {
                const lookup = await apiGet('chuboe_offer', {
                    filter: `IsActive eq true and startswith(Description,'[Carryover] ${labelEsc}')`,
                    select: 'Value,Description',
                    orderby: 'Created desc',
                });
                const found = lookup.records || [];
                if (found.length > 0) {
                    orphanOfferId = found[0].id;
                    orphanHeader = found[0];
                }
            } catch (e) {
                console.warn(`  ! ${cfg.label}: orphan lookup failed (${e.message}) — skipping cleanup`);
            }

            if (!orphanOfferId) {
                console.log(`  ${cfg.label}: merged into ${cfg.mergeIntoGroup} (no orphan to clean up)`);
                results.push({
                    label: cfg.label,
                    mergeIntoGroup: cfg.mergeIntoGroup,
                    portalWarehouseName: cfg.portalWarehouseName,
                    status: 'merged-no-orphan',
                });
                continue;
            }

            if (dryRun) {
                console.log(`  [DRY RUN] ${cfg.label}: merged into ${cfg.mergeIntoGroup} — would deactivate orphan [Carryover] offer ${orphanOfferId} (value ${orphanHeader.Value || '?'})`);
                results.push({
                    label: cfg.label,
                    mergeIntoGroup: cfg.mergeIntoGroup,
                    portalWarehouseName: cfg.portalWarehouseName,
                    status: 'dry-run-cleanup',
                    orphanOfferId,
                    orphanValue: orphanHeader.Value || null,
                });
                continue;
            }

            try {
                const deactResult = await deactivateOfferById(orphanOfferId);
                if (!deactResult.success) throw new Error(deactResult.error || 'deactivate returned non-success');
                console.log(`  ${cfg.label}: merged into ${cfg.mergeIntoGroup} — deactivated orphan [Carryover] offer ${orphanOfferId} (${deactResult.linesDeactivated} lines)`);
                results.push({
                    label: cfg.label,
                    mergeIntoGroup: cfg.mergeIntoGroup,
                    portalWarehouseName: cfg.portalWarehouseName,
                    status: 'merged-orphan-cleaned',
                    orphanOfferId,
                    orphanValue: orphanHeader.Value || null,
                    deactivatedLines: deactResult.linesDeactivated,
                });
            } catch (e) {
                console.error(`  ${cfg.label}: FAILED orphan cleanup — ${e.message}`);
                results.push({
                    label: cfg.label,
                    mergeIntoGroup: cfg.mergeIntoGroup,
                    portalWarehouseName: cfg.portalWarehouseName,
                    status: 'failed-cleanup',
                    error: e.message,
                    orphanOfferId,
                });
            }
            continue;
        }

        let currentOfferId = null;
        let currentHeader = null;

        // Look up by description prefix first (subsequent runs)
        try {
            const lookup = await apiGet('chuboe_offer', {
                filter: `IsActive eq true and startswith(Description,'[Carryover] ${labelEsc}')`,
                select: 'Value,Description,C_BPartner_ID,Chuboe_Offer_Type_ID',
                orderby: 'Created desc',
            });
            const found = lookup.records || [];
            if (found.length > 0) {
                currentOfferId = found[0].id;
                currentHeader = found[0];
                if (found.length > 1) {
                    console.warn(`  ! ${cfg.label}: ${found.length} carryover offers match — using newest (${currentOfferId}). Investigate.`);
                }
            }
        } catch (e) {
            console.warn(`  ! ${cfg.label}: prefix lookup failed (${e.message}) — falling back to bootstrap`);
        }

        // Bootstrap fallback: fetch by PK (first run only)
        if (!currentOfferId) {
            try {
                const bootstrap = await apiGet('chuboe_offer', { id: cfg.bootstrapId });
                if (bootstrap && bootstrap.id && bootstrap.IsActive !== false) {
                    currentOfferId = bootstrap.id;
                    currentHeader = bootstrap;
                    console.log(`  ${cfg.label}: bootstrap from PK ${cfg.bootstrapId}`);
                }
            } catch (e) {
                results.push({ label: cfg.label, status: 'failed', error: `bootstrap lookup failed: ${e.message}` });
                console.error(`  ${cfg.label}: FAILED — bootstrap lookup error: ${e.message}`);
                continue;
            }
        }

        if (!currentOfferId) {
            results.push({ label: cfg.label, status: 'failed', error: 'offer not found by prefix or bootstrap' });
            console.error(`  ${cfg.label}: FAILED — offer not found`);
            continue;
        }

        // Pull BP + OfferType from FK objects
        const bpId = currentHeader.C_BPartner_ID?.id || currentHeader.C_BPartner_ID;
        const offerTypeId = currentHeader.Chuboe_Offer_Type_ID?.id || currentHeader.Chuboe_Offer_Type_ID;
        if (!bpId || !offerTypeId) {
            results.push({ label: cfg.label, status: 'failed', error: 'missing BP or OfferType on source offer' });
            console.error(`  ${cfg.label}: FAILED — header missing BP/OfferType`);
            continue;
        }

        // Fetch all active lines (paginated). For READ-only loops we must
        // advance $skip — the deactivate loop in deactivatePriorOffers gets
        // away with not skipping because each PUT IsActive=false changes
        // the active set, but a pure read needs explicit pagination.
        // iDempiere REST caps $top at 100 server-side regardless of value.
        const allLines = [];
        let pageNum = 0;
        let skip = 0;
        try {
            while (true) {
                const lineResult = await apiGet('chuboe_offer_line', {
                    filter: `chuboe_offer_id eq ${currentOfferId} and IsActive eq true`,
                    select: 'Chuboe_MPN,Chuboe_MPN_Clean,Chuboe_MFR_Text,Qty,PriceEntered,Chuboe_Date_Code,Chuboe_Lead_Time,Chuboe_Package_Desc,Description,Chuboe_MOQ,Chuboe_SPQ',
                    skip,
                    top: 100,
                });
                const batch = lineResult.records || [];
                if (batch.length === 0) break;
                allLines.push(...batch);
                skip += batch.length;
                pageNum++;
                // If we got fewer than the page size, we've reached the end
                if (batch.length < 100) break;
                if (pageNum > 100) {
                    console.error(`  ${cfg.label}: hit page cap (100) reading lines — investigate`);
                    break;
                }
            }
        } catch (e) {
            results.push({ label: cfg.label, status: 'failed', error: `line read failed: ${e.message}`, currentOfferId });
            console.error(`  ${cfg.label}: FAILED — line read error: ${e.message}`);
            continue;
        }

        // Pre-filter reconciliation: for carryovers with a paired Infor
        // warehouse, compare carryover MPNs against this week's paired-wh
        // rows (MPN-aggregate qty). Fully received MPNs are RETIRED from
        // the fresh write; partials are KEPT but logged. MFR differences
        // are informational only (Infor MFR tagging unreliable on W117).
        const { keptLines, retired, flagged } = reconcileCarryover(
            allLines, cfg.pairedWarehouses, pendingMpnDetails
        );
        if (cfg.pairedWarehouses) {
            const retiredQty = retired.reduce((s, r) => s + r.carryoverQty, 0);
            const mfrDiff = retired.filter(r => !r.mfrMatch).length;
            console.log(`  ${cfg.label}: reconcile vs ${cfg.pairedWarehouses.join(',')} → retire ${retired.length} MPN(s)/${retiredQty.toLocaleString()} pc${mfrDiff ? ` (${mfrDiff} w/ MFR diff)` : ''}, flag ${flagged.length} MPN(s), keep ${keptLines.length}/${allLines.length} line(s)`);
            for (const r of retired.slice(0, 10)) {
                const mfrTag = r.mfrMatch ? '' : ` ⚠ MFR: ${r.carryoverMfrs.join('/')} vs ${r.thisWeekMfrs.join('/')}`;
                console.log(`    ✓ retire ${r.mpn.padEnd(25)} carryover=${String(r.carryoverQty).padStart(7)} infor=${String(r.infoQty).padStart(7)} (${(r.qtyRatio * 100).toFixed(0)}%)${mfrTag}`);
            }
            if (retired.length > 10) console.log(`    ... +${retired.length - 10} more retired`);
            for (const f of flagged) {
                const mfrTag = f.mfrMatch ? '' : ` MFR: ${f.carryoverMfrs.join('/')} vs ${f.thisWeekMfrs.join('/')}`;
                console.log(`    ⚠ flag   ${f.mpn.padEnd(25)} ${f.reason.padEnd(13)} ${(f.qtyRatio * 100).toFixed(0)}% received${mfrTag}`);
            }
        }

        // Cross-reference MPNs against this week's full Infor export.
        // overlapDetails captures one row per (carryover line, this-week match)
        // pair so the user can see exactly where each overlapping part now
        // lives in OT (warehouse code, this week's lot quantity, etc.).
        const overlapMpnSet = new Set();
        const overlapDetails = [];
        for (const line of allLines) {
            const mpn = String(line.Chuboe_MPN || '').trim();
            if (!mpn) continue;
            const matches = pendingMpnDetails.get(mpn);
            if (!matches || matches.length === 0) continue;
            overlapMpnSet.add(mpn);
            overlapDetails.push({
                mpn,
                carryoverMfr:        line.Chuboe_MFR_Text || '',
                carryoverQty:        line.Qty || 0,
                carryoverDateCode:   line.Chuboe_Date_Code || '',
                carryoverPackageDesc: line.Chuboe_Package_Desc || '',
                thisWeekMatches:     matches,  // [{warehouse, warehouseName, qty, lot}]
            });
        }
        const overlapMpns = [...overlapMpnSet];

        // Pass the carryover config (portalWarehouseName etc.) through to
        // every result so the downstream portal-CSV builder doesn't have to
        // re-look up STATIC_CARRYOVER_OFFERS by label.
        const cfgPassthrough = {
            label: cfg.label,
            portalWarehouseName: cfg.portalWarehouseName,
        };

        if (allLines.length === 0) {
            // Empty header — leave alone, log for visibility
            console.log(`  ${cfg.label}: source offer ${currentOfferId} has 0 active lines — leaving as-is`);
            results.push({
                ...cfgPassthrough,
                status: 'empty',
                currentOfferId,
                currentValue: currentHeader.Value || null,
                bpId,
                offerTypeId,
                overlapMpns,
                overlapDetails,
                retired,
                flagged,
                sourceLines: [],
            });
            continue;
        }

        if (dryRun) {
            const reconcileNote = cfg.pairedWarehouses
                ? `, retire ${retired.length}, flag ${flagged.length}, write ${keptLines.length}/${allLines.length}`
                : ` (${allLines.length} lines)`;
            console.log(`  [DRY RUN] ${cfg.label}: would refresh offer ${currentOfferId}${reconcileNote}${overlapMpns.length ? ` — ${overlapMpns.length} MPN overlap with full Infor export` : ''}`);
            results.push({
                ...cfgPassthrough,
                status: 'dry-run',
                currentOfferId,
                currentValue: currentHeader.Value || null,
                bpId,
                offerTypeId,
                linesPlanned: keptLines.length,
                linesOriginal: allLines.length,
                overlapMpns,
                overlapDetails,
                retired,
                flagged,
                sourceLines: keptLines,
            });
            continue;
        }

        // LIVE: deactivate old, write fresh
        try {
            const newLines = keptLines.map(l => ({
                mpn: l.Chuboe_MPN,
                mpnClean: l.Chuboe_MPN_Clean,
                mfrText: l.Chuboe_MFR_Text,
                qty: l.Qty,
                price: l.PriceEntered,
                dateCode: l.Chuboe_Date_Code,
                leadTime: l.Chuboe_Lead_Time,
                packageDesc: l.Chuboe_Package_Desc,
                description: l.Description,
                moq: l.Chuboe_MOQ,
                spq: l.Chuboe_SPQ,
            }));

            const deactResult = await deactivateOfferById(currentOfferId);
            if (!deactResult.success) {
                throw new Error(`deactivate failed: ${deactResult.error}`);
            }
            console.log(`  ${cfg.label}: deactivated old offer ${currentOfferId} (${deactResult.linesDeactivated} lines)`);

            const writeResult = await writeOffer({
                bpartnerId: bpId,
                offerTypeId,
                description: `[Carryover] ${cfg.label} — refreshed ${dateStr}`,
                lines: newLines,
            });

            console.log(`  ${cfg.label}: wrote new offer ${writeResult.searchKey || writeResult.offerId} (${writeResult.linesWritten}/${newLines.length} lines)${writeResult.errors.length ? ' [' + writeResult.errors.length + ' line errors]' : ''}`);
            results.push({
                ...cfgPassthrough,
                status: writeResult.errors.length === 0 ? 'success' : 'partial',
                oldOfferId: currentOfferId,
                oldValue: currentHeader.Value || null,
                newOfferId: writeResult.offerId,
                newSearchKey: writeResult.searchKey,
                bpId,
                offerTypeId,
                linesAttempted: newLines.length,
                linesOriginal: allLines.length,
                linesWritten: writeResult.linesWritten,
                errors: writeResult.errors,
                overlapMpns,
                overlapDetails,
                retired,
                flagged,
                sourceLines: keptLines,
            });
        } catch (e) {
            console.error(`  ${cfg.label}: FAILED — ${e.message}`);
            results.push({ ...cfgPassthrough, status: 'failed', error: e.message, currentOfferId, overlapMpns, overlapDetails, retired, flagged, sourceLines: allLines });
        }
    }

    // Console summary
    const totalRetired = results.reduce((s, r) => s + (r.retired?.length || 0), 0);
    const totalFlagged = results.reduce((s, r) => s + (r.flagged?.length || 0), 0);
    const totalOverlap = results.reduce((s, r) => s + (r.overlapMpns?.length || 0), 0);
    if (totalRetired > 0 || totalFlagged > 0) {
        console.log(`\n  Reconciliation: ${totalRetired} MPN(s) retired, ${totalFlagged} flagged (partial/MFR mismatch)`);
    }
    if (totalOverlap > 0) {
        console.log(`  ℹ️  ${totalOverlap} carryover MPN(s) also appear elsewhere in Infor (non-paired warehouses) — informational only.`);
    } else if (totalRetired === 0 && totalFlagged === 0) {
        console.log('\n  ✓ No carryover MPNs overlap with this week\'s Infor inventory.');
    }

    return results;
}

/**
 * Cross-BP audit pass: for each unique (BP, OfferType) the loader manages
 * (via either writeback or carryover paths), list every active chuboe_offer
 * not in the just-written set. Anything left over is a stray that lives
 * outside the loader's control loop and warrants attention.
 *
 * Excluded from "stray" status:
 *   - Offers we just wrote in Step 5 (writebackResults[*].offerId)
 *   - Offers we just wrote in Step 5b (carryoverResults[*].newOfferId)
 *   - Static carryover bootstrap offers we DIDN'T refresh because they're
 *     empty (carryoverResults[*].currentOfferId where status === 'empty')
 *   - Any active offer with description starting `[Carryover]` — these are
 *     historical refreshed carryovers from prior weeks that the loader
 *     manages via the description-prefix lookup pathway, not via the
 *     writeback BP+OfferType+suffix pathway. They're intentional and
 *     shouldn't pollute the audit just because their description shape
 *     differs from the writeback offers.
 *
 * @param {Array} writebackResults  - results from writeInventoryToOT
 * @param {Array} carryoverResults  - results from refreshStaticCarryoverOffers
 * @param {boolean} dryRun
 * @returns {Promise<Array<{bpartnerId, bpName, strays}>>}
 */
async function auditCrossBpStrays(writebackResults, carryoverResults, dryRun) {
    const { apiGet } = require('../../shared/api-client');

    const BP_NAMES = {
        1000332: 'Astute Electronics Inc',
        1000325: 'Astute Electronics - Franchise Stock',
        1003236: 'Astute Electronics - GE Aviation Excess',
        1003621: 'Astute Electronics - Taxan Excess',
        1005225: 'Astute Electronics - Spartronics Excess',
        1010966: 'Astute Electronics Inc - Eaton Consignment',
        1011267: 'Astute Electronics - LAM Consignment',
    };

    // Build (BP → managed offer types) and (BP → expected offer IDs)
    const bpToManagedTypes = {};
    const bpToExpectedIds  = {};

    const addManaged = (bpId, offerTypeId) => {
        if (!bpId || !offerTypeId) return;
        if (!bpToManagedTypes[bpId]) bpToManagedTypes[bpId] = new Set();
        if (!bpToExpectedIds[bpId])  bpToExpectedIds[bpId]  = new Set();
        bpToManagedTypes[bpId].add(offerTypeId);
    };
    const addExpected = (bpId, offerId) => {
        if (!bpId || !offerId) return;
        if (!bpToExpectedIds[bpId]) bpToExpectedIds[bpId] = new Set();
        bpToExpectedIds[bpId].add(offerId);
    };

    // Writeback path
    for (const r of writebackResults) {
        if (!r.bpartnerId) continue;
        addManaged(r.bpartnerId, r.offerTypeId);
        if (r.offerId) addExpected(r.bpartnerId, r.offerId);
        // Dry-run: priorOffers stand in for "what would be written" so they
        // don't get falsely flagged
        if (dryRun && r.priorOffers) {
            for (const po of r.priorOffers) addExpected(r.bpartnerId, po.id);
        }
    }

    // Carryover path
    for (const r of carryoverResults || []) {
        if (!r.bpId) continue;
        addManaged(r.bpId, r.offerTypeId);
        if (r.newOfferId)     addExpected(r.bpId, r.newOfferId);
        if (r.currentOfferId) addExpected(r.bpId, r.currentOfferId); // empty/failed cases
        // Dry-run carryover: bootstrap offer is what would be replaced
        if (dryRun && r.currentOfferId) addExpected(r.bpId, r.currentOfferId);
    }

    // Per-BP audit query
    const auditFindings = [];
    for (const [bpId, typeSet] of Object.entries(bpToManagedTypes)) {
        const typeOr = [...typeSet].map(t => `chuboe_offer_type_id eq ${t}`).join(' or ');
        const filter = `C_BPartner_ID eq ${bpId} and IsActive eq true and (${typeOr})`;
        let activeOffers = [];
        try {
            const result = await apiGet('chuboe_offer', {
                filter,
                select: 'Value,Created,Chuboe_Offer_Type_ID,Description',
                orderby: 'Created desc',
            });
            activeOffers = result.records || [];
        } catch (e) {
            console.warn(`  ! Audit query failed for BP=${bpId}: ${e.message}`);
            continue;
        }

        const expected = bpToExpectedIds[bpId] || new Set();
        const strays = activeOffers
            .map(o => ({
                id: o.id,
                value: o.Value || o.value || null,
                created: o.Created || o.created || null,
                offerTypeId: o.Chuboe_Offer_Type_ID?.id || o.chuboe_offer_type_id?.id || null,
                offerTypeName: o.Chuboe_Offer_Type_ID?.identifier || null,
                description: o.Description || o.description || null,
            }))
            // Drop anything we just wrote / would-write
            .filter(o => !expected.has(o.id))
            // Drop anything that's a refreshed carryover (managed via the
            // description-prefix pathway, not the writeback pathway)
            .filter(o => !String(o.description || '').startsWith('[Carryover]'));

        if (strays.length > 0) {
            const bpIdNum = parseInt(bpId, 10);
            const bpName = BP_NAMES[bpIdNum] || `BP ${bpIdNum}`;
            auditFindings.push({ bpartnerId: bpIdNum, bpName, strays });
            console.log(`  ⚠ Audit: ${bpName} (BP ${bpId}) has ${strays.length} stray active offer(s) outside this run:`);
            for (const s of strays) {
                console.log(`      id=${s.id} key=${s.value} type=${s.offerTypeName || s.offerTypeId} created=${String(s.created || '').split('T')[0]} desc="${s.description || ''}"`);
            }
        }
    }
    if (auditFindings.length === 0) {
        console.log('  ✓ Audit: no stray offers under any managed BP');
    }

    return auditFindings;
}

/**
 * Build an HTML summary email body for the write-back results.
 */
function buildWritebackSummaryHTML(results, dateStr, dryRun, carryoverResults = [], routingInvariants = null) {
    const totals = {
        success: results.filter(r => r.status === 'success').length,
        partial: results.filter(r => r.status === 'partial').length,
        failed:  results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        dryRun:  results.filter(r => r.status === 'dry-run').length,
    };

    // ─── Routing reconciliation block ────────────────────────────────────────
    // Always rendered when routingInvariants is provided. Shows portal vs OT
    // attempted vs OT written totals. Tripwires for drift in routing logic
    // (hard-thrown before this email is built) — this block exists to reassure
    // on a clean run and to surface runtime divergence (OT under-wrote what
    // both sides attempted) when it happens.
    let reconciliationSection = '';
    if (routingInvariants) {
        const ri = routingInvariants;
        const mainGap = ri.otMainAttempted - ri.otMainWritten;
        const cGap    = ri.carryoverOtAttempted - ri.carryoverOtWritten;

        const cell = (n, gap) => {
            const color = gap > 0 ? '#cf222e' : '#1a7f37';
            const weight = gap > 0 ? 'b' : 'span';
            return `<td style="text-align:right;font-family:monospace;color:${color}"><${weight}>${n.toLocaleString()}</${weight}></td>`;
        };
        const plainCell = (n) => `<td style="text-align:right;font-family:monospace">${n.toLocaleString()}</td>`;

        const totalPortal     = ri.portalMainTotal + ri.carryoverPortalTotal;
        const totalAttempted  = ri.otMainAttempted + ri.carryoverOtAttempted;
        const totalWritten    = ri.otMainWritten + ri.carryoverOtWritten;
        const totalGap        = totalAttempted - totalWritten;

        const headerColor = (totalGap > 0) ? '#cf222e' : '#1a7f37';
        const headerLabel = (totalGap > 0) ? `⚠ Routing reconciliation — OT under-wrote ${totalGap.toLocaleString()} line(s)` : '✓ Routing reconciliation — all sides agree';

        let partialRows = '';
        if (ri.carryoverPartial && ri.carryoverPartial.length > 0) {
            const items = ri.carryoverPartial.map(cp =>
                `<li><b>${cp.label}</b>: portal got ${cp.portalLines} line(s), OT wrote ${cp.otWritten} (gap ${cp.gap}, status=${cp.status})${cp.error ? ` — <i style="color:#cf222e">${cp.error}</i>` : ''}</li>`
            ).join('');
            partialRows = `
<div style="background:#ffebe9;padding:10px;border-left:4px solid #cf222e;margin:8px 0;font-size:13px">
    <b style="color:#cf222e">Carryover divergence:</b> the portal CSV advertises stock that OT does not actually hold this week. Affected carryovers:
    <ul style="margin:6px 0 0 0">${items}</ul>
</div>`;
        }

        reconciliationSection = `
<h3 style="margin:12px 0 4px 0;color:${headerColor}">${headerLabel}</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px;margin-bottom:10px">
<thead style="background:#f6f8fa">
<tr><th align="left">Source</th><th align="right">Portal CSV</th><th align="right">OT attempted</th><th align="right">OT written</th></tr>
</thead>
<tbody>
<tr><td><b>Main routing</b><br/><small style="color:#57606a">WAREHOUSE_WRITEBACK groups</small></td>
    ${plainCell(ri.portalMainTotal)}${plainCell(ri.otMainAttempted)}${cell(ri.otMainWritten, mainGap)}</tr>
<tr><td><b>Carryovers</b><br/><small style="color:#57606a">STATIC_CARRYOVER_OFFERS</small></td>
    ${plainCell(ri.carryoverPortalTotal)}${plainCell(ri.carryoverOtAttempted)}${cell(ri.carryoverOtWritten, cGap)}</tr>
<tr style="background:#f6f8fa"><td><b>Total</b></td>
    ${plainCell(totalPortal)}${plainCell(totalAttempted)}${cell(totalWritten, totalGap)}</tr>
</tbody>
</table>
${partialRows}`;
    }
    const totalLinesWritten = results.reduce((s, r) => s + (r.linesWritten || 0), 0);
    const totalLinesPlanned = results.reduce((s, r) => s + (r.linesPlanned || 0), 0);
    const totalDeactivated  = results.reduce((s, r) => s + (r.deactivatedLines || 0), 0);

    // Format a list of priorOffers as old MO IDs
    const fmtOldIds = (priorOffers) => {
        if (!priorOffers || priorOffers.length === 0) return '<i style="color:#57606a">none</i>';
        return priorOffers.map(o => `<span style="font-family:monospace">${o.value || o.id}</span>`).join(', ');
    };

    const rows = results.map(r => {
        const statusColor = r.status === 'success' ? '#1a7f37'
                          : r.status === 'partial' ? '#bf8700'
                          : r.status === 'failed'  ? '#cf222e'
                          : '#57606a';

        const oldIdsCell = fmtOldIds(r.priorOffers);
        let newIdCell = '';
        let detail = '';

        if (r.status === 'success' || r.status === 'partial') {
            newIdCell = `<span style="font-family:monospace;color:#1a7f37"><b>${r.offerSearchKey || r.offerId}</b></span>`;
            detail = `${r.linesWritten}/${r.linesAttempted} lines`;
            if (r.errors && r.errors.length) {
                detail += `<br/><small style="color:#cf222e">${r.errors.length} line error(s): ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? '…' : ''}</small>`;
            }
        } else if (r.status === 'dry-run') {
            newIdCell = '<i style="color:#57606a">(dry-run)</i>';
            detail = `${r.linesPlanned} lines planned`;
        } else if (r.status === 'failed') {
            newIdCell = '<i style="color:#cf222e">FAILED</i>';
            detail = `<span style="color:#cf222e">${r.error}</span>`;
        } else {
            newIdCell = '<i style="color:#57606a">—</i>';
            detail = `<i>${r.reason || 'skipped'}</i>`;
        }

        return `<tr>
            <td><b>${r.groupName}</b></td>
            <td style="color:${statusColor}"><b>${r.status.toUpperCase()}</b></td>
            <td>${oldIdsCell}</td>
            <td>${newIdCell}</td>
            <td>${detail}</td>
        </tr>`;
    }).join('\n');

    // Cross-BP audit section
    let auditSection = '';
    const audit = results._audit || [];
    if (audit.length === 0) {
        auditSection = `<p style="color:#1a7f37"><b>✓ Cross-BP audit:</b> no stray active offers under any managed BP.</p>`;
    } else {
        const auditRows = audit.map(a => {
            const strayList = a.strays.map(s => {
                const created = s.created ? String(s.created).split('T')[0] : '?';
                const typeLabel = s.offerTypeName ? `${s.offerTypeName} (${s.offerTypeId})` : `type ${s.offerTypeId}`;
                return `<li><span style="font-family:monospace">id=${s.id}</span> · key ${s.value || '–'} · ${typeLabel} · created ${created}${s.description ? ` · <i>${s.description}</i>` : ''}</li>`;
            }).join('');
            return `<tr>
                <td><b>${a.bpName || ('BP ' + a.bpartnerId)}</b><br/><small style="color:#57606a">BP ${a.bpartnerId}</small></td>
                <td style="text-align:center"><b>${a.strays.length}</b></td>
                <td><ul style="margin:0;padding-left:18px">${strayList}</ul></td>
            </tr>`;
        }).join('\n');
        auditSection = `
<h3 style="margin:18px 0 4px 0;color:#bf8700">⚠ Cross-BP audit — stray active offers</h3>
<p style="margin:0 0 8px 0;font-size:12px;color:#57606a">
    These offers are active under BPs this run touched, share a managed offer type, but were NOT in the set just written.
    They may be left over from a partial prior run, manual edits, or another loader. Review and deactivate if no longer needed.
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#fff8c5">
<tr><th align="left">Business Partner</th><th align="left"># Stray</th><th align="left">Offers</th></tr>
</thead>
<tbody>
${auditRows}
</tbody>
</table>`;
    }

    const banner = dryRun
        ? '<div style="background:#fff8c5;padding:10px;border-left:4px solid #d4a72c;margin-bottom:12px"><b>DRY RUN</b> — no records were written to OT. The OLD → NEW column shows offers that <i>would</i> have been deactivated and replaced.</div>'
        : '';

    // ─── Carryover refresh section ───────────────────────────────────────────
    let carryoverSection = '';
    let carryoverBanner = '';
    if (carryoverResults && carryoverResults.length > 0) {
        const totalOverlap = carryoverResults.reduce((s, r) => s + (r.overlapMpns?.length || 0), 0);
        if (totalOverlap > 0) {
            const overlapDetails = carryoverResults
                .filter(r => r.overlapMpns && r.overlapMpns.length > 0)
                .map(r => `<li><b>${r.label}</b>: ${r.overlapMpns.length} MPN(s) — ${r.overlapMpns.slice(0, 8).map(m => `<code>${m}</code>`).join(', ')}${r.overlapMpns.length > 8 ? ` <i>(+${r.overlapMpns.length - 8} more)</i>` : ''}</li>`)
                .join('');
            carryoverBanner = `<div style="background:#ffebe9;padding:12px;border-left:4px solid #cf222e;margin-bottom:12px;font-size:14px">
                <b style="color:#cf222e">🚨 ATTENTION:</b> ${totalOverlap} carryover MPN(s) now appear in this week's Infor inventory report. These parts may have been physically received and may no longer need a static carryover. Investigate:
                <ul style="margin:6px 0 0 0">${overlapDetails}</ul>
            </div>`;
        }

        const carryoverRows = carryoverResults.map(r => {
            const statusColor = r.status === 'success' ? '#1a7f37'
                              : r.status === 'partial' ? '#bf8700'
                              : r.status === 'failed'  ? '#cf222e'
                              : r.status === 'empty'   ? '#57606a'
                              : '#57606a';
            let detail = '';
            if (r.status === 'success' || r.status === 'partial') {
                detail = `${r.linesWritten}/${r.linesAttempted} lines · old <span style="font-family:monospace">${r.oldValue || r.oldOfferId}</span> → new <span style="font-family:monospace;color:#1a7f37"><b>${r.newSearchKey || r.newOfferId}</b></span>`;
                if (r.errors && r.errors.length) {
                    detail += `<br/><small style="color:#cf222e">${r.errors.length} line errors</small>`;
                }
            } else if (r.status === 'dry-run') {
                detail = `${r.linesPlanned} lines, would refresh offer <span style="font-family:monospace">${r.currentValue || r.currentOfferId}</span>`;
            } else if (r.status === 'empty') {
                detail = `<i>source offer ${r.currentValue || r.currentOfferId} has 0 active lines — left as-is</i>`;
            } else if (r.status === 'failed') {
                detail = `<span style="color:#cf222e">${r.error}</span>`;
            }
            const overlap = (r.overlapMpns && r.overlapMpns.length > 0)
                ? `<b style="color:#cf222e">${r.overlapMpns.length} MPN match(es)</b>`
                : '<span style="color:#1a7f37">none</span>';
            return `<tr>
                <td><b>${r.label}</b></td>
                <td style="color:${statusColor}"><b>${r.status.toUpperCase()}</b></td>
                <td>${detail}</td>
                <td>${overlap}</td>
            </tr>`;
        }).join('\n');

        carryoverSection = `
<h3 style="margin:18px 0 4px 0">Static carryover refresh</h3>
<p style="margin:0 0 8px 0;font-size:12px;color:#57606a">
    Inventory loaded outside the Infor export (open-PO Eaton, open-PO Philippines, Marvell incoming bid).
    Re-created weekly with fresh Created date until roadmap B4 (open-PO inventory) replaces this workaround.
    Each carryover's MPNs are cross-referenced against this week's Infor data — any overlap means the part may have been received.
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#f6f8fa">
<tr><th align="left">Carryover</th><th align="left">Status</th><th align="left">Detail</th><th align="left">In Infor this week?</th></tr>
</thead>
<tbody>
${carryoverRows}
</tbody>
</table>`;
    }

    return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
${carryoverBanner}
${banner}
<h2 style="margin:0 0 8px 0">OT Inventory Write-back — ${dateStr}</h2>
${reconciliationSection}
<p>
    <b>${totals.success}</b> success ·
    <b style="color:#bf8700">${totals.partial}</b> partial ·
    <b style="color:#cf222e">${totals.failed}</b> failed ·
    <b style="color:#57606a">${totals.skipped}</b> skipped${dryRun ? ` · <b>${totals.dryRun}</b> dry-run` : ''}
    <br/>
    Lines ${dryRun ? 'planned' : 'written'}: <b>${dryRun ? totalLinesPlanned : totalLinesWritten}</b>
    ${dryRun ? '' : ` · Lines deactivated (prior week): <b>${totalDeactivated}</b>`}
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<thead style="background:#f6f8fa">
<tr>
    <th align="left">Group</th>
    <th align="left">Status</th>
    <th align="left">OLD Offer(s) (deactivated)</th>
    <th align="left">NEW Offer</th>
    <th align="left">Detail</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
${auditSection}
${carryoverSection}
</body></html>`;
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

    // Build map from group name to filename (warehouse_codes + group_name)
    const groupToFilename = {};
    for (const [gName, wCodes] of WAREHOUSE_GROUPS) {
        groupToFilename[gName] = `${wCodes.join('_')}_${gName}`;
    }

    for (const groupName of sortedGroups) {
        const rows = groupedRows[groupName];
        if (!rows || rows.length === 0) continue;

        const transformed = rows.map(row => transformToChuboe(row, groupName));
        const filename = groupToFilename[groupName] || groupName;
        const outFile = path.join(outputDir, `${filename}.csv`);
        fs.writeFileSync(outFile, arrayToCSV(transformed, chuboeHeaders));
        chuboeFiles.push(outFile);
        console.log(`  - Saved: ${filename}.csv (${rows.length} rows)`);
    }

    // ==========================================================================
    // STEP 5: Export NetComponents portal files (split: non-authorized + franchise)
    //
    // Two CSVs go to NetComponents under different accounts:
    //   - Non-authorized account #1167233 — all OT-eligible groups EXCEPT
    //     Franchise_Stock. Carryover lines (Eaton/PH/LAM/Marvell/GM Stock)
    //     are appended to this file in Step 5d.
    //   - Franchised account #1126121 — Franchise_Stock only.
    //
    // This split mirrors how OT already represents the inventory: each
    // WAREHOUSE_WRITEBACK key becomes its own chuboe_offer (Franchise_Stock
    // under BP 1000325 "Astute - Franchise Stock", non-franchise free stock
    // under BP 1000332 "Astute Electronics Inc"). The pre-2026-05-05 single
    // portal CSV was lumping these together; the split brings the portal
    // output into line with OT's structure.
    //
    // Groups outside WAREHOUSE_WRITEBACK (HK_Allocated_Warehouse / W105,
    // Allocated_Warehouse / MAIN, LAM_3PL / W111) are intentionally excluded
    // from both OT and both portal files — they are internal-only and not
    // marketed externally.
    // ==========================================================================
    console.log('\nStep 5: Exporting NetComponents portal files...');

    const otGroupNames = Object.keys(WAREHOUSE_WRITEBACK);
    const FRANCHISE_GROUP = 'Franchise_Stock';
    const nonAuthGroupNames = otGroupNames.filter(g => g !== FRANCHISE_GROUP);

    // Load Active Sourcing exclusions — MPNs currently being price-checked
    // are hidden from NC uploads so competitors don't see our inventory.
    // See Trading Analysis/Market Profiling/exclusion-manager.js
    let sourcingExclusions = new Set();
    let exclusionCount = 0;
    const exclusionFile = path.join(process.env.HOME, 'workspace/.sourcing-exclusions.json');
    if (fs.existsSync(exclusionFile)) {
        try {
            const exclusionData = JSON.parse(fs.readFileSync(exclusionFile, 'utf8'));
            const now = new Date();
            // Only active (non-expired) exclusions
            const activeExclusions = (exclusionData.entries || [])
                .filter(e => new Date(e.expiresAt) > now)
                .map(e => e.mpn.toUpperCase());
            sourcingExclusions = new Set(activeExclusions);
            if (sourcingExclusions.size > 0) {
                console.log(`  - Active Sourcing: ${sourcingExclusions.size} MPNs excluded from NC upload`);
            }
        } catch (e) {
            console.warn(`  - Warning: Could not load sourcing exclusions: ${e.message}`);
        }
    }

    const collectRows = (groupNames) => {
        const out = [];
        for (const g of groupNames) out.push(...(groupedRows[g] || []));
        return out;
    };

    // Filter out excluded MPNs from NC portal rows
    const filterExcludedMpns = (rows) => {
        if (sourcingExclusions.size === 0) return rows;
        const before = rows.length;
        const filtered = rows.filter(row => {
            const mpn = String(row['Item'] || '').trim().toUpperCase();
            return !sourcingExclusions.has(mpn);
        });
        exclusionCount = before - filtered.length;
        return filtered;
    };

    const nonAuthSourceRows  = filterExcludedMpns(collectRows(nonAuthGroupNames));
    const franchiseSourceRows = filterExcludedMpns(collectRows([FRANCHISE_GROUP]));

    if (exclusionCount > 0) {
        console.log(`  - Excluded ${exclusionCount} MPNs from NC CSV (Active Sourcing in progress)`);
    }

    const totalPortalRows = nonAuthSourceRows.length + franchiseSourceRows.length;
    const droppedRowCount = uniqueRows.length - totalPortalRows;
    if (droppedRowCount > 0) {
        const droppedGroups = Object.keys(groupedRows)
            .filter(g => !otGroupNames.includes(g))
            .map(g => `${g} (${groupedRows[g].length})`)
            .join(', ');
        console.log(`  - Excluding ${droppedRowCount} rows from non-OT groups: ${droppedGroups || '(none)'}`);
    }

    const portalSourceCols = PORTAL_COLUMNS.filter(col => headers.includes(col));
    const portalOutputHeaders = portalSourceCols.map(c => PORTAL_COLUMN_LABELS[c] || c);
    const toPortalRows = (sourceRows) => sourceRows.map(row => {
        const out = {};
        for (const col of portalSourceCols) {
            let val = String(row[col] || '').trim();
            if (col === 'Lot Quantity') val = cleanNumeric(val);
            out[PORTAL_COLUMN_LABELS[col] || col] = val;
        }
        return out;
    });

    const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const portalFile = path.join(outputDir, `Netcomponents 1167233 ${mmdd}.csv`);
    const nonAuthRows = toPortalRows(nonAuthSourceRows);
    fs.writeFileSync(portalFile, arrayToCSV(nonAuthRows, portalOutputHeaders));
    console.log(`  - Saved: ${path.basename(portalFile)} (${nonAuthRows.length} rows)`);

    const franchisePortalFile = path.join(outputDir, `Netcomponents 1126121 ${mmdd}.csv`);
    const franchiseRows = toPortalRows(franchiseSourceRows);
    fs.writeFileSync(franchisePortalFile, arrayToCSV(franchiseRows, portalOutputHeaders));
    console.log(`  - Saved: ${path.basename(franchisePortalFile)} (${franchiseRows.length} rows)`);

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
        groups: groupedRows,        // raw rows by group (used by writeInventoryToOT)
        unmatched: unmatchedRows.length,
        outputDir: outputDir,
        portalFile: portalFile,
        franchisePortalFile: franchisePortalFile,
        chuboeFiles: chuboeFiles,
        timestamp: timestamp
    };
}

// =============================================================================
// FETCH COMMAND - Email automation
// =============================================================================

async function fetchAndProcess(opts = {}) {
    const dryRun = !!opts.dryRun;
    console.log('='.repeat(60));
    console.log('INVENTORY CLEANUP - AUTOMATED FETCH');
    console.log('='.repeat(60));
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Looking for emails matching: ${EMAIL_CONFIG.subjectPattern}`);
    console.log('-'.repeat(60));

    try {
        // Step 1: Sort inbox - move any inventory emails to Inventory Reports folder
        console.log('\nStep 1: Sorting inbox...');
        const inboxEmails = await listEmails('INBOX');
        const inventoryInInbox = inboxEmails.filter(e => EMAIL_CONFIG.subjectPattern.test(e.subject));
        if (inventoryInInbox.length > 0) {
            console.log(`  Found ${inventoryInInbox.length} inventory email(s) in INBOX, moving to Inventory Reports...`);
            for (const e of inventoryInInbox) {
                await moveEmail(e.id, 'Inventory Reports', 'INBOX');
            }
        } else {
            console.log('  No new inventory emails in INBOX');
        }

        // Step 2: Check Inventory Reports folder for unprocessed emails
        console.log('\nStep 2: Checking Inventory Reports folder...');
        const emails = await listEmails('Inventory Reports');
        console.log(`  Found ${emails.length} emails in Inventory Reports`);

        // Find the most recent matching email (highest task number = most recent report)
        const matchingEmails = emails.filter(e => EMAIL_CONFIG.subjectPattern.test(e.subject));
        const matchingEmail = matchingEmails.sort((a, b) => {
            const numA = (a.subject.match(/(\d{7})/) || [0, 0])[1];
            const numB = (b.subject.match(/(\d{7})/) || [0, 0])[1];
            return parseInt(numB) - parseInt(numA);
        })[0];

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
        console.log('\nStep 3: Downloading attachment...');
        let attachmentPath;
        try {
            attachmentPath = await downloadAttachment(matchingEmail.id, 'Inventory Reports');
            console.log(`  Downloaded: ${attachmentPath}`);

            // Save a persistent copy for Thursday reprocess
            const weekStart = getWeekStartDate();
            const persistentPath = path.join(INVENTORY_STORAGE_DIR, `inventory_${weekStart}.xlsx`);
            fs.copyFileSync(attachmentPath, persistentPath);
            console.log(`  Saved persistent copy: ${persistentPath}`);
        } catch (err) {
            throw new Error(`Failed to download attachment: ${err.message}`);
        }

        // Step 4: Process the file
        console.log('\nStep 4: Processing inventory file...');
        const scriptDir = path.dirname(__filename);
        const result = processInventoryFile(attachmentPath, null);

        const dateStr = new Date().toISOString().split('T')[0];

        // Step 4.5: Build per-MPN pendingMpnDetails BEFORE writeback so the
        // unified-offer supplement builder can reconcile carryover registry
        // entries against this week's Infor paired-warehouse rows.
        const pendingMpnDetails = new Map();
        for (const groupName in result.groups) {
            for (const row of result.groups[groupName]) {
                const mpn = String(row['Item'] || '').trim();
                if (!mpn) continue;
                const detail = {
                    warehouse:     String(row['Warehouse'] || '').trim(),
                    warehouseName: String(row['Warehouse Name'] || '').trim(),
                    mfr:           String(row['Name'] || '').trim(),
                    qty:           cleanNumeric(row['Lot Quantity']),
                    lot:           String(row['Lot'] || '').trim(),
                    location:      String(row['Location'] || '').trim(),
                };
                if (!pendingMpnDetails.has(mpn)) pendingMpnDetails.set(mpn, []);
                pendingMpnDetails.get(mpn).push(detail);
            }
        }

        // Step 4.6: Build carryover supplements for paired-warehouse entries.
        // The unified-offer model (2026-05-12 refactor) merges static-seed
        // lines into the matching WAREHOUSE_WRITEBACK group's weekly write
        // instead of creating a separate [Carryover] offer. Reads
        // carryover-registry/*.json + reconciles vs paired Infor warehouses.
        console.log(`\nStep 4.6: Building carryover supplements (paired-warehouse entries) — ${pendingMpnDetails.size} unique MPNs from this week's Infor data...`);
        const { supplementsByGroup, results: supplementResults } = prepareCarryoverSupplements(
            STATIC_CARRYOVER_OFFERS, pendingMpnDetails
        );

        // Step 5: Write inventory to OT via API. Supplements (post-reconciliation
        // static-seed lines from merged carryovers) are merged into the matching
        // group's writeOffer call here — Infor-row wins on MPN clash.
        console.log(`\nStep 5: Writing inventory to OT (${dryRun ? 'DRY RUN' : 'LIVE'})...`);
        const writebackResults = await writeInventoryToOT(result.groups, dateStr, dryRun, supplementsByGroup);

        // Step 5b: Refresh static carryover offers for entries WITHOUT
        // mergeIntoGroup (un-paired carryovers, e.g. GM Stock). For entries
        // WITH mergeIntoGroup, refreshStaticCarryoverOffers performs a
        // one-time cleanup: deactivates any orphan [Carryover] {label} offer
        // left over from the pre-refactor pipeline. The lines have already
        // been written to OT inside the matching group's Weekly inventory
        // offer in Step 5.
        console.log(`\nStep 5b: Refreshing static carryover offers (${dryRun ? 'DRY RUN' : 'LIVE'}) — un-paired entries + one-time orphan cleanup for merged entries...`);
        const standaloneCarryoverResults = await refreshStaticCarryoverOffers(STATIC_CARRYOVER_OFFERS, dateStr, dryRun, pendingMpnDetails);

        // Unified carryoverResults: supplement results (merged entries) +
        // standalone results (un-paired entries / orphan cleanup). Downstream
        // (Step 5c audit, Step 5d portal append) reads this combined list.
        const carryoverResults = [...supplementResults, ...standaloneCarryoverResults];

        // Step 5c: Cross-BP audit (runs after both writeback and carryover so
        // it sees the full picture and doesn't false-positive on offers we
        // just refreshed in 5b).
        console.log('\nStep 5c: Cross-BP audit...');
        writebackResults._audit = await auditCrossBpStrays(writebackResults, carryoverResults, dryRun);

        // Step 5d: Append carryover lines to the NetComponents portal CSV.
        // The portal CSV is built in processInventoryFile from Infor data
        // only. Until roadmap B4 ships, the carryover stock (Eaton, PH,
        // Marvell) lives outside the Infor export but still needs to be
        // marketed via NetComponents — so we read those lines from the
        // carryover offers and append them to the portal CSV here.
        try {
            const carryoverPortalRows = [];
            for (const r of carryoverResults) {
                if (!r.sourceLines || r.sourceLines.length === 0) continue;
                for (const line of r.sourceLines) {
                    carryoverPortalRows.push({
                        'MPN':          String(line.Chuboe_MPN || '').trim(),
                        'Description':  String(line.Description || '').trim(),
                        'Manufacturer': String(line.Chuboe_MFR_Text || '').trim(),
                        'Qty':          String(line.Qty != null ? line.Qty : ''),
                        'D/C':          String(line.Chuboe_Date_Code || '').trim(),
                    });
                }
            }
            if (carryoverPortalRows.length > 0) {
                // Read the existing portal CSV's header line so we append
                // rows in the exact same column order processInventoryFile
                // chose (which depends on which PORTAL_COLUMNS were found
                // in the Infor source headers).
                const existingCsv = fs.readFileSync(result.portalFile, 'utf-8');
                const firstNL = existingCsv.indexOf('\n');
                const headerLine = firstNL >= 0 ? existingCsv.slice(0, firstNL) : existingCsv;
                const finalHeaders = headerLine.replace(/^\uFEFF/, '').split(',').map(h => h.replace(/^"|"$/g, ''));
                const appendCsv = '\n' + carryoverPortalRows.map(row =>
                    finalHeaders.map(h => {
                        const v = String(row[h] != null ? row[h] : '');
                        if (v.includes(',') || v.includes('"') || v.includes('\n')) {
                            return '"' + v.replace(/"/g, '""') + '"';
                        }
                        return v;
                    }).join(',')
                ).join('\n');
                fs.appendFileSync(result.portalFile, appendCsv);
                console.log(`\nStep 5d: Appended ${carryoverPortalRows.length} carryover lines to ${path.basename(result.portalFile)}`);
            } else {
                console.log('\nStep 5d: No carryover lines to append to portal CSV');
            }
        } catch (e) {
            console.error(`Step 5d: failed to append carryover to portal CSV: ${e.message}`);
        }

        // Step 5e: Routing invariant tripwire. Hard-throws if portal & OT
        // routing have drifted (new group not on both sides, or per-group
        // attempted-row counts disagree). Returns reconciliation totals for
        // the summary email and soft-warn rows for any carryover where the
        // portal CSV got rows but OT failed to write them.
        console.log('\nStep 5e: Routing invariant check...');
        const routingInvariants = assertRoutingInvariants({
            result,
            writebackResults,
            carryoverResults,
            supplementsByGroup,
            mode: 'fetch',
        });
        const reconLine = `  portal=${routingInvariants.portalMainTotal + routingInvariants.carryoverPortalTotal}, ot-attempted=${routingInvariants.otMainAttempted + routingInvariants.carryoverOtAttempted}, ot-written=${routingInvariants.otMainWritten + routingInvariants.carryoverOtWritten}`;
        if (routingInvariants.mainShortfall === 0 && routingInvariants.carryoverShortfall === 0) {
            console.log(`  ✓ Routing OK · ${reconLine.trim()}`);
        } else {
            console.log(`  ⚠ Runtime divergence (routing intact) · ${reconLine.trim()} · main shortfall ${routingInvariants.mainShortfall}, carryover shortfall ${routingInvariants.carryoverShortfall}`);
            for (const cp of routingInvariants.carryoverPartial) {
                console.log(`    · ${cp.label}: portal=${cp.portalLines}, ot-written=${cp.otWritten} (status=${cp.status}${cp.error ? ', ' + cp.error : ''})`);
            }
        }

        // Build overlap CSV if any carryover MPNs match this week's inventory
        let overlapCsvPath = null;
        const totalOverlapCount = carryoverResults.reduce((s, r) => s + (r.overlapDetails?.length || 0), 0);
        if (totalOverlapCount > 0) {
            const csvHeaders = [
                'Carryover',
                'New Offer Search Key',
                'New Offer ID',
                'MPN',
                'Carryover MFR',
                'Carryover Qty',
                'Carryover Date Code',
                'Carryover Package',
                'This Week Warehouse',
                'This Week Warehouse Name',
                'This Week Qty',
                'This Week Lot',
                'This Week Location',
            ];
            const csvRows = [];
            for (const r of carryoverResults) {
                if (!r.overlapDetails || r.overlapDetails.length === 0) continue;
                for (const od of r.overlapDetails) {
                    for (const m of od.thisWeekMatches) {
                        csvRows.push({
                            'Carryover':                r.label,
                            'New Offer Search Key':     r.newSearchKey || r.currentValue || '',
                            'New Offer ID':             r.newOfferId || r.currentOfferId || '',
                            'MPN':                      od.mpn,
                            'Carryover MFR':            od.carryoverMfr,
                            'Carryover Qty':            od.carryoverQty,
                            'Carryover Date Code':      od.carryoverDateCode,
                            'Carryover Package':        od.carryoverPackageDesc,
                            'This Week Warehouse':      m.warehouse,
                            'This Week Warehouse Name': m.warehouseName,
                            'This Week Qty':            m.qty,
                            'This Week Lot':            m.lot,
                            'This Week Location':       m.location,
                        });
                    }
                }
            }
            overlapCsvPath = path.join(result.outputDir, `carryover_overlap_${dateStr}.csv`);
            fs.writeFileSync(overlapCsvPath, arrayToCSV(csvRows, csvHeaders));
            console.log(`  Carryover overlap CSV: ${overlapCsvPath} (${csvRows.length} rows across ${totalOverlapCount} unique MPN match(es))`);
        }

        // Step 6: Send emails
        console.log('\nStep 6: Sending notification emails...');

        // Email 1: NetComponents upload — non-authorized account #1167233
        const sent1 = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Data Upload - Non Authorized Account #1167233',
            `Inventory cleanup completed successfully.

Attached: ${path.basename(result.portalFile)}

Processed: ${result.uniqueRows.toLocaleString()} unique rows
Date: ${dateStr}`,
            [result.portalFile]
        );

        // Email 1b: NetComponents upload — franchised account #1126121
        const sent1b = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Data upload - Franchised account # 1126121',
            `Inventory cleanup completed successfully.

Attached: ${path.basename(result.franchisePortalFile)}

Date: ${dateStr}`,
            [result.franchisePortalFile]
        );

        // Email 1c/1d: Send directly to NetComponents if enabled
        if (NC_UPLOAD_CONFIG.enabled) {
            const ncNotifier = createNotifier({
                fromEmail: NC_UPLOAD_CONFIG.fromEmail,
                fromName: NC_UPLOAD_CONFIG.fromName,
                smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
            });

            if (NC_UPLOAD_CONFIG.nonAuthEmail) {
                console.log(`  Sending non-auth CSV to NetComponents: ${NC_UPLOAD_CONFIG.nonAuthEmail}`);
                await ncNotifier.sendWithAttachment(
                    NC_UPLOAD_CONFIG.nonAuthEmail,
                    'Data Upload - Non-Authorized Account # 1167233',
                    'Hello,\n\nPlease find attached updated stock inventory.\n\nBest regards,\nAstute Electronics',
                    [{ filename: path.basename(result.portalFile), path: result.portalFile }]
                );
            }

            if (NC_UPLOAD_CONFIG.franchiseEmail) {
                console.log(`  Sending franchise CSV to NetComponents: ${NC_UPLOAD_CONFIG.franchiseEmail}`);
                await ncNotifier.sendWithAttachment(
                    NC_UPLOAD_CONFIG.franchiseEmail,
                    'Data upload - Franchised account # 1126121',
                    'Hello,\n\nPlease find attached updated franchise inventory.\n\nBest regards,\nAstute Electronics',
                    [{ filename: path.basename(result.franchisePortalFile), path: result.franchisePortalFile }]
                );
            }
        }

        // Email 2: OT Write-back Summary (HTML, no attachment)
        const writebackOk    = writebackResults.filter(r => r.status === 'success').length;
        const writebackPart  = writebackResults.filter(r => r.status === 'partial').length;
        const writebackFail  = writebackResults.filter(r => r.status === 'failed').length;
        const carryoverOverlap = carryoverResults.reduce((s, r) => s + (r.overlapMpns?.length || 0), 0);
        const overlapTag = carryoverOverlap > 0 ? ` 🚨 ${carryoverOverlap} CARRYOVER MPNS NOW IN INFOR` : '';
        const summarySubject = `${dryRun ? '[DRY RUN] ' : ''}OT Inventory Write-back — ${dateStr} (${writebackOk} ok, ${writebackPart} partial, ${writebackFail} failed)${overlapTag}`;
        const summaryHtml    = buildWritebackSummaryHTML(writebackResults, dateStr, dryRun, carryoverResults, routingInvariants);

        // If we have an overlap CSV, attach it; otherwise send html-only
        let sent2;
        if (overlapCsvPath && fs.existsSync(overlapCsvPath)) {
            sent2 = await notifier.sendWithAttachment(
                EMAIL_CONFIG.recipient,
                summarySubject,
                summaryHtml,
                [{ filename: path.basename(overlapCsvPath), path: overlapCsvPath }],
                { html: true }
            );
        } else {
            sent2 = await notifier.sendEmail(
                EMAIL_CONFIG.recipient,
                summarySubject,
                summaryHtml,
                { html: true }
            );
        }

        // Determine whether the run completed cleanly enough to consume the
        // source email. Any partial / failed writeback group OR any failed
        // carryover refresh leaves the email in `Inventory Reports` so the
        // next cron tick retries (inventory_cleanup is idempotent —
        // deactivate-then-write per group). On retry, partial offers get
        // deactivated and re-written fresh.
        const carryoverFail = carryoverResults.filter(r => r.status === 'failed').length;
        const runOk = (writebackPart === 0) && (writebackFail === 0) && (carryoverFail === 0);

        // Step 7: Move processed email — only on a clean run.
        if (dryRun) {
            console.log('\nStep 7: [DRY RUN] leaving source email in Inventory Reports');
        } else if (runOk) {
            console.log('\nStep 7: Moving email to processed folder...');
            await moveEmail(matchingEmail.id, EMAIL_CONFIG.processedFolder, 'Inventory Reports');
        } else {
            console.log(`\nStep 7: Leaving source email in Inventory Reports for retry — write-back: ${writebackPart} partial, ${writebackFail} failed; carryover: ${carryoverFail} failed`);
        }

        // Step 8: Cleanup attachment
        console.log('\nStep 8: Cleaning up temp files...');
        try {
            fs.unlinkSync(attachmentPath);
        } catch (e) { /* ignore */ }

        console.log('\n' + '='.repeat(60));
        console.log(runOk ? 'FETCH AND PROCESS COMPLETE' : 'FETCH AND PROCESS — INCOMPLETE (will retry)');
        console.log('='.repeat(60));
        console.log(`Emails sent: ${sent1 && sent1b && sent2 ? 'Yes' : 'Partial'}`);
        console.log(`Write-back: ${writebackOk} ok, ${writebackPart} partial, ${writebackFail} failed`);
        console.log(`Carryover failed: ${carryoverFail}`);
        console.log(`Output: ${result.outputDir}`);

        return { success: runOk, result, writebackResults, carryoverResults };

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
// REPROCESS COMMAND - Thursday mode using saved Monday xlsx
// =============================================================================

async function reprocessInventory(xlsxPath, opts = {}) {
    const dryRun = !!opts.dryRun;
    console.log('='.repeat(60));
    console.log('INVENTORY CLEANUP - REPROCESS MODE (Thursday)');
    console.log('='.repeat(60));
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Source file: ${xlsxPath}`);
    console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    console.log('-'.repeat(60));

    try {
        // Step 1: Process the saved file
        console.log('\nStep 1: Processing inventory file...');
        const result = processInventoryFile(xlsxPath, null);
        const dateStr = new Date().toISOString().split('T')[0];

        // Step 2: Skip OT write-back (already done Monday)
        console.log('\nStep 2: Skipping OT write-back (already done on Monday)');

        // Step 3: NC CSVs were regenerated by processInventoryFile
        // The exclusion check in Step 5 of processInventoryFile handles the 200 MPNs
        console.log('\nStep 3: NetComponents CSVs regenerated with current exclusions');
        console.log(`  Non-auth: ${result.portalFile}`);
        console.log(`  Franchise: ${result.franchisePortalFile}`);

        // Step 4: Send emails
        console.log('\nStep 4: Sending notification emails...');

        // Email to Jake
        const sent1 = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Data Upload - Non-Authorized Account # 1167233',
            `Hello,\n\nPlease find attached updated stock inventory.\n\nBest regards,\nAstute Electronics`,
            [result.portalFile]
        );

        const sent1b = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Data upload - Franchised account # 1126121',
            `Hello,\n\nPlease find attached updated franchise inventory.\n\nBest regards,\nAstute Electronics`,
            [result.franchisePortalFile]
        );

        // Email to NetComponents if enabled
        if (NC_UPLOAD_CONFIG.enabled) {
            const ncNotifier = createNotifier({
                fromEmail: NC_UPLOAD_CONFIG.fromEmail,
                fromName: NC_UPLOAD_CONFIG.fromName,
                smtpPass: process.env.WORKMAIL_PASS || process.env.SMTP_PASS
            });

            if (NC_UPLOAD_CONFIG.nonAuthEmail) {
                console.log(`  Sending non-auth CSV to NetComponents: ${NC_UPLOAD_CONFIG.nonAuthEmail}`);
                await ncNotifier.sendWithAttachment(
                    NC_UPLOAD_CONFIG.nonAuthEmail,
                    'Data Upload - Non-Authorized Account # 1167233',
                    'Hello,\n\nPlease find attached updated stock inventory.\n\nBest regards,\nAstute Electronics',
                    [{ filename: path.basename(result.portalFile), path: result.portalFile }]
                );
            }

            if (NC_UPLOAD_CONFIG.franchiseEmail) {
                console.log(`  Sending franchise CSV to NetComponents: ${NC_UPLOAD_CONFIG.franchiseEmail}`);
                await ncNotifier.sendWithAttachment(
                    NC_UPLOAD_CONFIG.franchiseEmail,
                    'Data upload - Franchised account # 1126121',
                    'Hello,\n\nPlease find attached updated franchise inventory.\n\nBest regards,\nAstute Electronics',
                    [{ filename: path.basename(result.franchisePortalFile), path: result.franchisePortalFile }]
                );
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('REPROCESS COMPLETE');
        console.log('='.repeat(60));
        console.log(`Emails sent: ${sent1 && sent1b ? 'Yes' : 'Partial'}`);
        console.log(`Output: ${result.outputDir}`);

        return { success: true, result };

    } catch (err) {
        console.error('\n' + '='.repeat(60));
        console.error('REPROCESS FAILED');
        console.error('='.repeat(60));
        console.error(`Error: ${err.message}`);

        await sendFailureNotice(err.message);

        return { success: false, error: err.message };
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

if (require.main === module) {
    const argv     = process.argv.slice(2);
    const flags    = new Set(argv.filter(a => a.startsWith('--')));
    const args     = argv.filter(a => !a.startsWith('--'));
    const dryRun   = flags.has('--dry-run');
    const writeback = flags.has('--writeback');

    if (args.length < 1) {
        console.log('Usage: node inventory_cleanup.js <input_file.xlsx|csv> [output_directory] [--writeback] [--dry-run]');
        console.log('       node inventory_cleanup.js fetch [--dry-run]');
        console.log('       node inventory_cleanup.js reprocess [--dry-run]');
        console.log('\nCommands:');
        console.log('  fetch                    Fetch from email inbox, process, and write back to OT');
        console.log('  fetch --dry-run          Same, but skip the API write-back (preview only)');
        console.log('  reprocess                Reprocess this week\'s saved xlsx (for Thursday run)');
        console.log('  reprocess --dry-run      Same, but skip the API write-back (preview only)');
        console.log('  <file.xlsx>              Process a specific file (CSVs only)');
        console.log('  <file.xlsx> --writeback  Process and also write back to OT');
        console.log('  <file.xlsx> --writeback --dry-run');
        console.log('                           Process and dry-run write-back (preview only)');
        console.log('\nExamples:');
        console.log('  node inventory_cleanup.js fetch');
        console.log('  node inventory_cleanup.js fetch --dry-run');
        console.log('  node inventory_cleanup.js reprocess               # Thursday: reuse Monday\'s file');
        console.log('  node inventory_cleanup.js ASTItemLotsReportInputs_USS_4544132.xlsx --writeback --dry-run');
        process.exit(1);
    }

    if (args[0] === 'reprocess') {
        // Thursday mode: reuse this week's saved xlsx file
        const savedFile = getThisWeekInventoryFile();
        if (!savedFile) {
            console.error('ERROR: No saved inventory file found for this week.');
            console.error(`Expected: ${path.join(INVENTORY_STORAGE_DIR, `inventory_${getWeekStartDate()}.xlsx`)}`);
            console.error('Run "fetch" first on Monday to save the inventory file.');
            process.exit(1);
        }
        console.log(`Reprocessing saved inventory file: ${savedFile}`);
        reprocessInventory(savedFile, { dryRun })
            .then(result => {
                process.exit(result.success ? 0 : 1);
            })
            .catch(err => {
                console.error('Unexpected error:', err);
                process.exit(1);
            });
    } else if (args[0] === 'fetch') {
        fetchAndProcess({ dryRun })
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
        const result = processInventoryFile(inputFile, outputDir);
        if (writeback) {
            const dateStr = new Date().toISOString().split('T')[0];
            writeInventoryToOT(result.groups, dateStr, dryRun)
                .then(writebackResults => {
                    // Routing invariant tripwire — same check as the cron path,
                    // minus the carryover side which only runs in fetch mode.
                    const ri = assertRoutingInvariants({
                        result,
                        writebackResults,
                        mode: 'manual',
                    });
                    console.log(`\n✓ Routing OK · portal=${ri.portalMainTotal}, ot-attempted=${ri.otMainAttempted}, ot-written=${ri.otMainWritten}${ri.mainShortfall ? ` (shortfall ${ri.mainShortfall})` : ''}`);
                    process.exit(0);
                })
                .catch(err => {
                    console.error('Write-back failed:', err);
                    process.exit(1);
                });
        }
    }
}

module.exports = { processInventoryFile, fetchAndProcess, writeInventoryToOT, WAREHOUSE_WRITEBACK, STATIC_CARRYOVER_OFFERS, assertRoutingInvariants, KNOWN_INTERNAL_GROUPS, buildWritebackSummaryHTML };
