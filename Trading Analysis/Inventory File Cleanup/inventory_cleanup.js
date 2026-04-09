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

// Portal export columns
const PORTAL_COLUMNS = [
    'Item', 'ItemDescription', 'Name', 'Lot Quantity', 'Date Code',
    'Lot Unit Cost', 'Currency', 'Warehouse Name', 'Location'
];

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
async function writeInventoryToOT(groupedRows, dateStr, dryRun = false) {
    const { writeOffer, deactivatePriorOffers } = require('../../shared/offer-writeback');
    const { apiGet } = require('../../shared/api-client');

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

        if (rows.length === 0) {
            console.log(`  ${groupName}: 0 rows — skipping`);
            results.push({ groupName, status: 'skipped', reason: 'no rows', ...mapping });
            continue;
        }

        // Map raw inventory rows → offer-writeback line shape.
        // MFR placeholders ("Not Known Yet" / "Not Known") are scrubbed to
        // null so OT records don't carry junk MFR text — the MFR resolver
        // would otherwise fail to canonicalize them and write the raw string.
        const MFR_PLACEHOLDER_RE = /^(not known( yet)?)$/i;
        const lines = rows.map(row => {
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

    // ─── Cross-BP audit ──────────────────────────────────────────────────────
    // For each unique BP touched by this run, list ALL active offers under
    // any of the writeback-managed offer types for that BP, then subtract
    // the offers we just wrote (or, in dry-run, the offers we already know
    // exist from the priorOffers query — those are the ones the live run
    // would replace). Anything left over is a stray that lives outside the
    // weekly cleanup loop and warrants attention.
    const bpToManagedTypes = {};   // bpId → Set(offerTypeIds we manage)
    const bpToExpectedIds  = {};   // bpId → Set(offerIds we just wrote OR prior IDs in dry-run)
    for (const r of results) {
        if (!r.bpartnerId) continue;
        if (!bpToManagedTypes[r.bpartnerId]) bpToManagedTypes[r.bpartnerId] = new Set();
        if (!bpToExpectedIds[r.bpartnerId])  bpToExpectedIds[r.bpartnerId]  = new Set();
        bpToManagedTypes[r.bpartnerId].add(r.offerTypeId);
        if (r.offerId) bpToExpectedIds[r.bpartnerId].add(r.offerId);
        // In dry-run we have no new IDs, so the "expected" set is the priorOffers
        // we just queried — those are the ones the live run would deactivate
        // and we don't want to flag them as strays in dry-run.
        if (dryRun && r.priorOffers) {
            for (const po of r.priorOffers) bpToExpectedIds[r.bpartnerId].add(po.id);
        }
    }

    // Build a (bpId → human name) lookup from WAREHOUSE_WRITEBACK groups so
    // the audit table can show "Astute Electronics Inc (BP 1000332)" instead
    // of just "BP 1000332" — easier to read at a glance.
    const BP_NAMES = {
        1000332: 'Astute Electronics Inc',
        1000325: 'Astute Electronics - Franchise Stock',
        1003236: 'Astute Electronics - GE Aviation Excess',
        1003621: 'Astute Electronics - Taxan Excess',
        1005225: 'Astute Electronics - Spartronics Excess',
        1010966: 'Astute Electronics Inc - Eaton Consignment',
        1011267: 'Astute Electronics - LAM Consignment',
    };

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
                // FK fields come back as { propertyLabel, id, identifier, ... }
                offerTypeId: o.Chuboe_Offer_Type_ID?.id || o.chuboe_offer_type_id?.id || null,
                offerTypeName: o.Chuboe_Offer_Type_ID?.identifier || null,
                description: o.Description || o.description || null,
            }))
            .filter(o => !expected.has(o.id));
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
    // Stash audit findings on the results array for the email summary
    results._audit = auditFindings;

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
 * Build an HTML summary email body for the write-back results.
 */
function buildWritebackSummaryHTML(results, dateStr, dryRun) {
    const totals = {
        success: results.filter(r => r.status === 'success').length,
        partial: results.filter(r => r.status === 'partial').length,
        failed:  results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        dryRun:  results.filter(r => r.status === 'dry-run').length,
    };
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

    return `<html><body style="font-family:Arial,sans-serif;font-size:13px">
${banner}
<h2 style="margin:0 0 8px 0">OT Inventory Write-back — ${dateStr}</h2>
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
        groups: groupedRows,        // raw rows by group (used by writeInventoryToOT)
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
        } catch (err) {
            throw new Error(`Failed to download attachment: ${err.message}`);
        }

        // Step 4: Process the file
        console.log('\nStep 4: Processing inventory file...');
        const scriptDir = path.dirname(__filename);
        const result = processInventoryFile(attachmentPath, null);

        const dateStr = new Date().toISOString().split('T')[0];

        // Step 5: Write inventory to OT via API (replaces zipped CSV upload path)
        console.log(`\nStep 5: Writing inventory to OT (${dryRun ? 'DRY RUN' : 'LIVE'})...`);
        const writebackResults = await writeInventoryToOT(result.groups, dateStr, dryRun);

        // Step 6: Send emails
        console.log('\nStep 6: Sending notification emails...');

        // Email 1: Netcomponents Upload (consolidated portal CSV — unchanged)
        const sent1 = await sendEmail(
            EMAIL_CONFIG.recipient,
            'Netcomponents Upload',
            `Inventory cleanup completed successfully.

Attached: Consolidated portal file for Netcomponents upload.

Processed: ${result.uniqueRows.toLocaleString()} unique rows
Date: ${dateStr}`,
            [result.portalFile]
        );

        // Email 2: OT Write-back Summary (HTML, no attachment)
        const writebackOk    = writebackResults.filter(r => r.status === 'success').length;
        const writebackPart  = writebackResults.filter(r => r.status === 'partial').length;
        const writebackFail  = writebackResults.filter(r => r.status === 'failed').length;
        const summarySubject = `${dryRun ? '[DRY RUN] ' : ''}OT Inventory Write-back — ${dateStr} (${writebackOk} ok, ${writebackPart} partial, ${writebackFail} failed)`;
        const summaryHtml    = buildWritebackSummaryHTML(writebackResults, dateStr, dryRun);

        const sent2 = await notifier.sendEmail(
            EMAIL_CONFIG.recipient,
            summarySubject,
            summaryHtml,
            { html: true }
        );

        // Step 7: Move processed email (skip on dry-run so the source can be replayed)
        if (!dryRun) {
            console.log('\nStep 7: Moving email to processed folder...');
            await moveEmail(matchingEmail.id, EMAIL_CONFIG.processedFolder, 'Inventory Reports');
        } else {
            console.log('\nStep 7: [DRY RUN] leaving source email in Inventory Reports');
        }

        // Step 8: Cleanup attachment
        console.log('\nStep 8: Cleaning up temp files...');
        try {
            fs.unlinkSync(attachmentPath);
        } catch (e) { /* ignore */ }

        console.log('\n' + '='.repeat(60));
        console.log('FETCH AND PROCESS COMPLETE');
        console.log('='.repeat(60));
        console.log(`Emails sent: ${sent1 && sent2 ? 'Yes' : 'Partial'}`);
        console.log(`Write-back: ${writebackOk} ok, ${writebackPart} partial, ${writebackFail} failed`);
        console.log(`Output: ${result.outputDir}`);

        return { success: true, result, writebackResults };

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
    const argv     = process.argv.slice(2);
    const flags    = new Set(argv.filter(a => a.startsWith('--')));
    const args     = argv.filter(a => !a.startsWith('--'));
    const dryRun   = flags.has('--dry-run');
    const writeback = flags.has('--writeback');

    if (args.length < 1) {
        console.log('Usage: node inventory_cleanup.js <input_file.xlsx|csv> [output_directory] [--writeback] [--dry-run]');
        console.log('       node inventory_cleanup.js fetch [--dry-run]');
        console.log('\nCommands:');
        console.log('  fetch                    Fetch from email inbox, process, and write back to OT');
        console.log('  fetch --dry-run          Same, but skip the API write-back (preview only)');
        console.log('  <file.xlsx>              Process a specific file (CSVs only)');
        console.log('  <file.xlsx> --writeback  Process and also write back to OT');
        console.log('  <file.xlsx> --writeback --dry-run');
        console.log('                           Process and dry-run write-back (preview only)');
        console.log('\nExamples:');
        console.log('  node inventory_cleanup.js fetch');
        console.log('  node inventory_cleanup.js fetch --dry-run');
        console.log('  node inventory_cleanup.js ASTItemLotsReportInputs_USS_4544132.xlsx --writeback --dry-run');
        process.exit(1);
    }

    if (args[0] === 'fetch') {
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
                .then(() => process.exit(0))
                .catch(err => {
                    console.error('Write-back failed:', err);
                    process.exit(1);
                });
        }
    }
}

module.exports = { processInventoryFile, fetchAndProcess, writeInventoryToOT, WAREHOUSE_WRITEBACK };
