/**
 * Carryover operations — label-agnostic primitives for static-carryover
 * lifecycle. The weekly refresh (`refreshStaticCarryoverOffers` in
 * inventory_cleanup.js) is the steady-state owner; this module handles
 * the human-driven moments: bootstrap, bulk-add, per-MPN retire.
 *
 * Source of truth: the current `[Carryover] {label} — refreshed …` offer
 * in OT. Each operation looks it up by description prefix, mutates, and
 * lets the weekly refresh propagate the change forward.
 *
 * Audit log: every bootstrap / add / retire appends to carryover-audit.csv
 * (sibling of inventory_cleanup.js) so we have a git-trackable record of
 * "what changed, when, why."
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(process.env.HOME, 'workspace', '.env') });

const { apiGet, apiPost } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/api-client'));
const { writeOffer } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/offer-writeback'));
const { patchRecord } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/record-updater'));
const { readCSVFile } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/csv-utils'));
const { resolveMfrForRow } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/mfr-resolver'));
const { cleanMpn } = require(path.join(process.env.HOME, 'workspace/astute-workinstructions/shared/db-helpers'));

const AUDIT_PATH = path.join(__dirname, '..', 'carryover-audit.csv');
const AUDIT_HEADERS = ['timestamp', 'action', 'label', 'offerId', 'mpn', 'qty', 'reason', 'operator'];

// ─── CSV INGEST ──────────────────────────────────────────────────────────────

/**
 * Parse a bootstrap/add CSV. Required columns (case-insensitive): MPN, MFR, Qty.
 * Optional: DateCode, PackageDesc, Price, MOQ, SPQ, LineDescription.
 * @returns {Array<{mpn, mfrText, qty, dateCode?, packageDesc?, price?, moq?, spq?, description?}>}
 */
function parseCarryoverCsv(csvPath) {
    if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
    const csv = readCSVFile(csvPath);
    const lower = csv.headers.map(h => h.trim().toLowerCase());
    const find = (...names) => {
        for (const n of names) {
            const i = lower.indexOf(n.toLowerCase());
            if (i >= 0) return i;
        }
        return -1;
    };
    const idx = {
        mpn:         find('mpn', 'part', 'partnumber', 'part_number'),
        mfr:         find('mfr', 'manufacturer', 'mfrtext'),
        qty:         find('qty', 'quantity'),
        dateCode:    find('datecode', 'date_code', 'd/c', 'dc'),
        packageDesc: find('packagedesc', 'package', 'package_desc'),
        price:       find('price', 'unitprice', 'unit_price', 'priceentered'),
        moq:         find('moq'),
        spq:         find('spq'),
        description: find('linedescription', 'description'),
    };
    if (idx.mpn < 0 || idx.mfr < 0 || idx.qty < 0) {
        throw new Error(`CSV missing required columns. Need MPN, MFR, Qty. Got: ${csv.headers.join(', ')}`);
    }
    const out = [];
    for (let i = 0; i < csv.rows.length; i++) {
        const r = csv.rows[i];
        const mpn = String(r[idx.mpn] || '').trim();
        if (!mpn) continue;
        const qty = Number(String(r[idx.qty] || '').replace(/[,$]/g, ''));
        if (!Number.isFinite(qty) || qty <= 0) {
            throw new Error(`Row ${i + 2}: qty must be positive numeric (got "${r[idx.qty]}")`);
        }
        const line = {
            mpn,
            mfrText: String(r[idx.mfr] || '').trim() || undefined,
            qty,
        };
        if (idx.dateCode    >= 0 && r[idx.dateCode])    line.dateCode    = String(r[idx.dateCode]).trim();
        if (idx.packageDesc >= 0 && r[idx.packageDesc]) line.packageDesc = String(r[idx.packageDesc]).trim();
        if (idx.price       >= 0 && r[idx.price]) {
            const p = Number(String(r[idx.price]).replace(/[,$]/g, ''));
            if (Number.isFinite(p)) line.price = p;
        }
        if (idx.moq         >= 0 && r[idx.moq])         line.moq         = String(r[idx.moq]).trim();
        if (idx.spq         >= 0 && r[idx.spq])         line.spq         = String(r[idx.spq]).trim();
        if (idx.description >= 0 && r[idx.description]) line.description = String(r[idx.description]).trim();
        out.push(line);
    }
    return out;
}

// ─── OT LOOKUPS ──────────────────────────────────────────────────────────────

/**
 * Find the current `[Carryover] {label} — …` offer by description prefix.
 * Returns null if no active carryover offer exists for this label yet
 * (i.e. it hasn't been bootstrapped or has been fully retired).
 */
async function findCarryoverOffer(label) {
    const labelEsc = label.replace(/'/g, "''");
    const result = await apiGet('chuboe_offer', {
        filter: `IsActive eq true and startswith(Description,'[Carryover] ${labelEsc}')`,
        select: 'Value,Description,C_BPartner_ID,Chuboe_Offer_Type_ID',
        orderby: 'Created desc',
    });
    const records = result.records || [];
    if (records.length === 0) return null;
    if (records.length > 1) {
        console.warn(`  ! ${label}: ${records.length} active carryover offers match prefix — using newest. Investigate the duplicates.`);
    }
    const h = records[0];
    return {
        offerId: h.id,
        searchKey: h.Value || null,
        description: h.Description,
        bpId: h.C_BPartner_ID?.id ?? h.C_BPartner_ID,
        offerTypeId: h.Chuboe_Offer_Type_ID?.id ?? h.Chuboe_Offer_Type_ID,
    };
}

async function readActiveLines(offerId) {
    const out = [];
    let skip = 0;
    let pages = 0;
    while (true) {
        const result = await apiGet('chuboe_offer_line', {
            filter: `chuboe_offer_id eq ${offerId} and IsActive eq true`,
            select: 'Chuboe_MPN,Chuboe_MFR_Text,Qty,Chuboe_Date_Code,Chuboe_Package_Desc',
            skip,
            top: 100,
        });
        const batch = result.records || [];
        if (batch.length === 0) break;
        out.push(...batch);
        skip += batch.length;
        pages++;
        if (batch.length < 100) break;
        if (pages > 200) throw new Error(`readActiveLines: page cap hit on offer ${offerId}`);
    }
    return out;
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────

function ensureAuditFile() {
    if (!fs.existsSync(AUDIT_PATH)) {
        fs.writeFileSync(AUDIT_PATH, AUDIT_HEADERS.join(',') + '\n', 'utf-8');
    }
}

function appendAudit(entries) {
    ensureAuditFile();
    const escape = v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = entries.map(e =>
        AUDIT_HEADERS.map(h => escape(e[h])).join(',')
    ).join('\n') + '\n';
    fs.appendFileSync(AUDIT_PATH, lines, 'utf-8');
}

// ─── OPERATIONS ──────────────────────────────────────────────────────────────

/**
 * Bootstrap a brand-new carryover offer. Fails if an active `[Carryover] {label}`
 * already exists — use `add` to extend an existing carryover.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} opts.bpId
 * @param {number} opts.offerTypeId
 * @param {string} opts.csvPath
 * @param {string[]} [opts.pairedWarehouses] - for the suggested registry block
 * @param {string} [opts.portalWarehouseName] - for the suggested registry block
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.operator]
 */
async function bootstrap(opts) {
    const { label, bpId, offerTypeId, csvPath, pairedWarehouses, portalWarehouseName, dryRun, operator = process.env.USER || 'unknown' } = opts;
    if (!label || !bpId || !offerTypeId || !csvPath) {
        throw new Error('bootstrap requires: label, bpId, offerTypeId, csvPath');
    }

    const existing = await findCarryoverOffer(label);
    if (existing) {
        throw new Error(`bootstrap: active carryover '[Carryover] ${label}' already exists as offer ${existing.offerId}. Use 'add' to extend it, or retire it first.`);
    }

    const lines = parseCarryoverCsv(csvPath);
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const today = new Date().toISOString().slice(0, 10);
    const description = `[Carryover] ${label} — refreshed ${today}`;

    console.log(`\n=== BOOTSTRAP: ${label} ===`);
    console.log(`  bpId:        ${bpId}`);
    console.log(`  offerTypeId: ${offerTypeId}`);
    console.log(`  description: ${description}`);
    console.log(`  lines:       ${lines.length}`);
    console.log(`  total qty:   ${totalQty.toLocaleString()}`);
    console.log(`  csv:         ${csvPath}`);

    if (dryRun) {
        console.log(`\n[DRY RUN] No writes. Sample of first 5 rows:`);
        for (const l of lines.slice(0, 5)) {
            console.log(`    ${l.mpn.padEnd(25)} | ${(l.mfrText || '').padEnd(12)} | ${String(l.qty).padStart(9)}`);
        }
        if (lines.length > 5) console.log(`    ... +${lines.length - 5} more`);
        return { dryRun: true, label, planned: lines.length, totalQty };
    }

    const result = await writeOffer({ bpartnerId: bpId, offerTypeId, description, lines });
    if (result.errors && result.errors.length) {
        console.error(`\n!! Errors during bootstrap (${result.errors.length}):`);
        for (const e of result.errors.slice(0, 10)) console.error(`   - ${e}`);
    }
    if (!result.offerId) throw new Error('bootstrap: writeOffer returned no offerId');

    appendAudit([{
        timestamp: new Date().toISOString(),
        action: 'bootstrap',
        label,
        offerId: result.offerId,
        mpn: '',
        qty: totalQty,
        reason: `bootstrap from ${path.basename(csvPath)} (${result.linesWritten} lines)`,
        operator,
    }]);

    console.log(`\n✓ Bootstrap complete. offerId=${result.offerId}, lines written=${result.linesWritten}/${lines.length}`);
    console.log(`\nNext: add to STATIC_CARRYOVER_OFFERS in inventory_cleanup.js:`);
    console.log(`\n    {`);
    console.log(`        label: '${label}',`);
    console.log(`        bootstrapId: ${result.offerId},`);
    if (portalWarehouseName) console.log(`        portalWarehouseName: '${portalWarehouseName}',`);
    if (pairedWarehouses && pairedWarehouses.length) {
        console.log(`        pairedWarehouses: [${pairedWarehouses.map(w => `'${w}'`).join(', ')}],`);
    }
    console.log(`    },\n`);

    return result;
}

/**
 * Extend an existing carryover offer with new lines from a CSV. Idempotent
 * by (MPN, DateCode) — rows already present on the offer are skipped.
 *
 * NOTE: this POSTs additional lines onto the in-flight carryover header.
 * Next Monday's refresh will then read offer.IsActive=true lines (which now
 * includes the new ones) and copy them forward. No further action needed.
 */
async function add(opts) {
    const { label, csvPath, dryRun, operator = process.env.USER || 'unknown' } = opts;
    if (!label || !csvPath) throw new Error('add requires: label, csvPath');

    const offer = await findCarryoverOffer(label);
    if (!offer) {
        throw new Error(`add: no active '[Carryover] ${label}' found. Run bootstrap first.`);
    }

    const existing = await readActiveLines(offer.offerId);
    const existingKeys = new Set(existing.map(l =>
        `${(l.Chuboe_MPN || '').trim()}||${(l.Chuboe_Date_Code || '').trim()}`
    ));

    const incoming = parseCarryoverCsv(csvPath);
    const toAdd = [];
    const dupes = [];
    for (const l of incoming) {
        const key = `${l.mpn.trim()}||${(l.dateCode || '').trim()}`;
        if (existingKeys.has(key)) dupes.push(l);
        else toAdd.push(l);
    }

    console.log(`\n=== ADD: ${label} ===`);
    console.log(`  current offer:    ${offer.offerId} (${offer.description})`);
    console.log(`  current lines:    ${existing.length}`);
    console.log(`  incoming rows:    ${incoming.length}`);
    console.log(`  to add (new):     ${toAdd.length}`);
    console.log(`  to skip (dupes):  ${dupes.length}`);

    if (dryRun) {
        console.log(`\n[DRY RUN] No writes. Sample of first 5 to-add:`);
        for (const l of toAdd.slice(0, 5)) {
            console.log(`    ${l.mpn.padEnd(25)} | ${(l.mfrText || '').padEnd(12)} | ${String(l.qty).padStart(9)} | ${l.dateCode || ''}`);
        }
        return { dryRun: true, toAdd: toAdd.length, dupes: dupes.length };
    }

    if (toAdd.length === 0) {
        console.log(`  Nothing new to add (all ${dupes.length} rows already on offer).`);
        return { added: 0, skipped: dupes.length };
    }

    // Determine starting line number — read max existing Line column
    const lineNumResult = await apiGet('chuboe_offer_line', {
        filter: `chuboe_offer_id eq ${offer.offerId}`,
        select: 'Line',
        orderby: 'Line desc',
        top: 1,
    });
    let nextLine = ((lineNumResult.records?.[0]?.Line) || 0) + 10;

    const errors = [];
    let added = 0;
    const auditEntries = [];
    for (const l of toAdd) {
        const mpnClean = cleanMpn(l.mpn);
        const payload = {
            Chuboe_Offer_ID: offer.offerId,
            Line: nextLine,
            Chuboe_MPN: l.mpn,
            Chuboe_MPN_Clean: mpnClean,
            Qty: l.qty,
        };
        const mfrResult = resolveMfrForRow({ mfrText: l.mfrText, mpn: l.mpn });
        if (mfrResult.canonical) payload.Chuboe_MFR_Text = mfrResult.canonical;
        if (mfrResult.id && !mfrResult.isSystem) payload.Chuboe_MFR_ID = mfrResult.id;
        if (l.dateCode) payload.Chuboe_Date_Code = l.dateCode;
        if (l.packageDesc) payload.Chuboe_Package_Desc = l.packageDesc;
        if (l.price != null) payload.PriceEntered = l.price;
        if (l.moq) payload.Chuboe_MOQ = l.moq;
        if (l.spq) payload.Chuboe_SPQ = l.spq;
        if (l.description) payload.Description = l.description;

        try {
            await apiPost('chuboe_offer_line', payload, {
                naturalKeyFields: ['Chuboe_Offer_ID', 'Chuboe_MPN'],
            });
            added++;
            nextLine += 10;
            auditEntries.push({
                timestamp: new Date().toISOString(),
                action: 'add',
                label,
                offerId: offer.offerId,
                mpn: l.mpn,
                qty: l.qty,
                reason: `add from ${path.basename(csvPath)}`,
                operator,
            });
        } catch (e) {
            errors.push(`${l.mpn}: ${e.message}`);
        }
    }

    if (auditEntries.length) appendAudit(auditEntries);

    console.log(`\n✓ Added ${added}/${toAdd.length} lines. Skipped ${dupes.length} duplicates.`);
    if (errors.length) {
        console.error(`\n!! ${errors.length} errors:`);
        for (const e of errors.slice(0, 10)) console.error(`   - ${e}`);
    }
    return { added, skipped: dupes.length, errors };
}

/**
 * Retire one or more MPNs from the current carryover by deactivating their
 * line rows (and child offer_line_mpn rows). The weekly refresh's
 * `IsActive eq true` filter then skips them, so they never propagate forward.
 *
 * Also defensively walks back through STATIC_CARRYOVER_OFFERS[label].bootstrapId
 * (if registry is provided) so the bootstrap-fallback path can't resurrect them.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string[]} opts.mpns
 * @param {string} opts.reason - required, written to audit log
 * @param {object} [opts.registryEntry] - the matching STATIC_CARRYOVER_OFFERS entry
 *   (so we can also retire on bootstrapId). Optional but recommended.
 * @param {boolean} [opts.dryRun]
 */
async function retire(opts) {
    const { label, mpns, reason, registryEntry, dryRun, operator = process.env.USER || 'unknown' } = opts;
    if (!label || !mpns || mpns.length === 0) throw new Error('retire requires: label, mpns[]');
    if (!reason) throw new Error('retire requires: reason (audit-log mandatory)');

    const offer = await findCarryoverOffer(label);
    if (!offer) throw new Error(`retire: no active '[Carryover] ${label}' found`);

    const wanted = new Set(mpns.map(m => m.trim()));
    const lines = await readActiveLines(offer.offerId);
    const targets = lines.filter(l => wanted.has((l.Chuboe_MPN || '').trim()));
    const found = new Set(targets.map(l => l.Chuboe_MPN.trim()));
    const notFound = [...wanted].filter(m => !found.has(m));

    console.log(`\n=== RETIRE: ${label} ===`);
    console.log(`  current offer:  ${offer.offerId} (${offer.description})`);
    console.log(`  reason:         ${reason}`);
    console.log(`  requested MPNs: ${mpns.length}`);
    console.log(`  matched lines:  ${targets.length} (across ${found.size} MPNs)`);
    if (notFound.length) console.log(`  not found:      ${notFound.join(', ')}`);

    for (const t of targets) {
        console.log(`    - line ${t.id}: ${(t.Chuboe_MPN || '').padEnd(25)} qty=${String(t.Qty).padStart(9)} dc=${t.Chuboe_Date_Code || ''}`);
    }

    if (dryRun) {
        console.log(`\n[DRY RUN] No writes.`);
        return { dryRun: true, targets: targets.length, notFound };
    }

    if (targets.length === 0) {
        return { retired: 0, notFound };
    }

    const errors = [];
    const auditEntries = [];
    let retired = 0;
    const source = `manage-carryover.retire (${operator})`;

    for (const t of targets) {
        try {
            const r = await patchRecord('chuboe_offer_line', t.id, { IsActive: false }, { source });
            if (r.status !== 'patched') throw new Error(`patch status=${r.status} (${r.error || ''})`);
            // Find + deactivate the child offer_line_mpn row(s) too
            const children = await apiGet('chuboe_offer_line_mpn', {
                filter: `chuboe_offer_line_id eq ${t.id} and IsActive eq true`,
                select: 'id',
            });
            for (const c of (children.records || [])) {
                await patchRecord('chuboe_offer_line_mpn', c.id, { IsActive: false }, { source });
            }
            retired++;
            auditEntries.push({
                timestamp: new Date().toISOString(),
                action: 'retire',
                label,
                offerId: offer.offerId,
                mpn: t.Chuboe_MPN,
                qty: t.Qty,
                reason,
                operator,
            });
        } catch (e) {
            errors.push(`line ${t.id} (${t.Chuboe_MPN}): ${e.message}`);
        }
    }

    // Defense in depth: also retire on bootstrap offer (so bootstrap-fallback
    // path in refreshStaticCarryoverOffers can't resurrect retired MPNs)
    if (registryEntry?.bootstrapId && registryEntry.bootstrapId !== offer.offerId) {
        const bootLines = await readActiveLines(registryEntry.bootstrapId);
        const bootTargets = bootLines.filter(l => wanted.has((l.Chuboe_MPN || '').trim()));
        if (bootTargets.length) {
            console.log(`\n  defense-in-depth: also retiring ${bootTargets.length} line(s) on bootstrap offer ${registryEntry.bootstrapId}`);
            for (const bt of bootTargets) {
                try {
                    await patchRecord('chuboe_offer_line', bt.id, { IsActive: false }, { source });
                    auditEntries.push({
                        timestamp: new Date().toISOString(),
                        action: 'retire-bootstrap',
                        label,
                        offerId: registryEntry.bootstrapId,
                        mpn: bt.Chuboe_MPN,
                        qty: bt.Qty,
                        reason,
                        operator,
                    });
                } catch (e) {
                    errors.push(`bootstrap line ${bt.id} (${bt.Chuboe_MPN}): ${e.message}`);
                }
            }
        }
    }

    if (auditEntries.length) appendAudit(auditEntries);

    console.log(`\n✓ Retired ${retired}/${targets.length} line(s).${errors.length ? ` ${errors.length} errors.` : ''}`);
    if (errors.length) for (const e of errors.slice(0, 10)) console.error(`   - ${e}`);
    return { retired, notFound, errors };
}

async function list(opts) {
    const { label } = opts;
    if (!label) throw new Error('list requires: label');
    const offer = await findCarryoverOffer(label);
    if (!offer) {
        console.log(`No active '[Carryover] ${label}' found.`);
        return { lines: [] };
    }
    const lines = await readActiveLines(offer.offerId);
    const totalQty = lines.reduce((s, l) => s + (Number(l.Qty) || 0), 0);
    console.log(`\n=== ${label} ===`);
    console.log(`  offer ${offer.offerId}: ${offer.description}`);
    console.log(`  ${lines.length} active line(s), total qty ${totalQty.toLocaleString()}\n`);
    console.log(`  ${'MPN'.padEnd(28)} ${'MFR'.padEnd(15)} ${'Qty'.padStart(10)}  DateCode`);
    console.log(`  ${'-'.repeat(28)} ${'-'.repeat(15)} ${'-'.repeat(10)}  --------`);
    for (const l of lines) {
        console.log(`  ${(l.Chuboe_MPN || '').padEnd(28)} ${(l.Chuboe_MFR_Text || '').padEnd(15)} ${String(l.Qty || 0).padStart(10)}  ${l.Chuboe_Date_Code || ''}`);
    }
    return { offerId: offer.offerId, lines };
}

module.exports = {
    parseCarryoverCsv,
    findCarryoverOffer,
    readActiveLines,
    bootstrap,
    add,
    retire,
    list,
    appendAudit,
    AUDIT_PATH,
};
