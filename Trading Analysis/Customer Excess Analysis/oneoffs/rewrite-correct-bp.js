'use strict';
/**
 * Rewrite the 7 wrong-BP customer-excess offers under the correct BPs.
 *
 * For each offer:
 *   1. SELECT all active lines + line_mpn sub-rows from the wrong-BP offer
 *   2. POST a new chuboe_offer with correct BP (and correct type for 1026196)
 *   3. writeOffer with copied line data
 *   4. Deactivate the old offer
 *
 * Run with --commit. Optional --offer <searchKey> to target one at a time.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
const { execSync } = require('child_process');

const { writeOffer } = require('../../../shared/offer-writeback');
const { patchRecord } = require('../../../shared/record-updater');

const COMMIT = process.argv.includes('--commit');
const SINGLE_SK = (() => {
  const i = process.argv.indexOf('--offer');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const TARGETS = [
  { srcOfferId: 1026177, srcSk: '1026070', bp: 1000732, bpName: 'GE Healthcare',                 offerType: 1000000, label: 'FW: Excess (GE Healthcare via Naneesh)' },
  { srcOfferId: 1026181, srcSk: '1026074', bp: 1003549, bpName: 'Syrma SGS Technology Limited',  offerType: 1000000, label: 'FW: Excess - Syrma' },
  { srcOfferId: 1026182, srcSk: '1026075', bp: 1005030, bpName: 'Schneider Electric',            offerType: 1000000, label: 'FW: Excess inventory - Schneider Electric Pvt. Ltd.' },
  { srcOfferId: 1026196, srcSk: '1026089', bp: 1000328, bpName: 'Future Electronics Corporation', offerType: 1000001, label: 'FW: Liquidation List (Future Electronics — broker offer, not customer excess)' },
  { srcOfferId: 1026199, srcSk: '1026092', bp: 1000732, bpName: 'GE Healthcare',                 offerType: 1000000, label: 'FW: 5AGXMB5G4F40C5G (GE Healthcare via Naneesh)' },
  { srcOfferId: 1026220, srcSk: '1026113', bp: 1008058, bpName: 'Matrix Comesec Pvt Ltd',         offerType: 1000000, label: 'FW: Matrix comsec - Search key#1009991' },
  { srcOfferId: 1026222, srcSk: '1026115', bp: 1000732, bpName: 'GE Healthcare',                 offerType: 1000000, label: 'FW: Altera Excess Inventory (GE Healthcare via Aguilar)' },
];

function readLines(srcOfferId) {
  // Use COPY to TSV to avoid CSV-quoting ambiguity with commas in MPN/description
  const sql = `
    COPY (
      SELECT
        COALESCE(ol.chuboe_mpn, ''),
        COALESCE(ol.chuboe_mfr_text, ''),
        COALESCE(ol.chuboe_cpc, ''),
        COALESCE(ol.qty::text, ''),
        COALESCE(ol.priceentered::text, ''),
        COALESCE(ol.chuboe_date_code, ''),
        COALESCE(ol.chuboe_lead_time, ''),
        COALESCE(ol.c_country_id::text, ''),
        COALESCE(ol.c_currency_id::text, ''),
        COALESCE(ol.chuboe_moq, ''),
        COALESCE(ol.chuboe_spq, ''),
        COALESCE(ol.description, '')
      FROM adempiere.chuboe_offer_line ol
      WHERE ol.chuboe_offer_id = ${srcOfferId}
        AND ol.isactive = 'Y'
      ORDER BY ol.line
    ) TO STDOUT WITH (FORMAT text, DELIMITER E'\\t')
  `;
  const out = execSync(`psql -A -t -c "${sql.replace(/\n\s+/g, ' ')}"`, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  const lines = [];
  for (const row of out.split('\n')) {
    if (!row.trim()) continue;
    const cols = row.split('\t');
    const [mpn, mfrText, cpc, qty, price, dateCode, leadTime, countryId, currencyId, moq, spq, description] = cols;
    if (!mpn) continue;
    const lineRec = { mpn };
    if (mfrText) lineRec.mfrText = mfrText;
    if (cpc) lineRec.cpc = cpc;
    if (qty) lineRec.qty = Number(qty);
    if (price) lineRec.price = Number(price);
    if (dateCode) lineRec.dateCode = dateCode;
    if (leadTime) lineRec.leadTime = leadTime;
    if (countryId) lineRec.countryId = Number(countryId);
    if (currencyId) lineRec.currencyId = Number(currencyId);
    if (moq) lineRec.moq = moq;
    if (spq) lineRec.spq = spq;
    if (description) lineRec.description = description;
    lines.push(lineRec);
  }
  return lines;
}

(async () => {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}\n`);

  const targets = SINGLE_SK ? TARGETS.filter(t => t.srcSk === SINGLE_SK) : TARGETS;
  if (targets.length === 0) { console.error(`No targets matching ${SINGLE_SK}`); process.exit(1); }

  for (const t of targets) {
    console.log('═'.repeat(110));
    console.log(`${t.srcSk} (id ${t.srcOfferId}) → ${t.bpName} (${t.bp}), type=${t.offerType}`);
    console.log(`  Label: ${t.label}`);

    const lines = readLines(t.srcOfferId);
    console.log(`  Read ${lines.length} active lines from source.`);
    if (lines.length === 0) { console.log(`  → SKIP (no lines)`); continue; }

    if (!COMMIT) { console.log(`  [dry-run] would writeOffer + deactivate ${t.srcOfferId}`); continue; }

    const today = new Date().toISOString().slice(0,10).replace(/-/g, '.');
    const slug = t.bpName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const description = `${today}-${slug}-rewrite-from-${t.srcSk}`;

    console.log(`  Calling writeOffer (BP=${t.bp}, type=${t.offerType}, lines=${lines.length})...`);
    const t0 = Date.now();
    let result;
    try {
      result = await writeOffer({
        bpartnerId: t.bp,
        offerTypeId: t.offerType,
        description,
        lines,
      });
    } catch (e) {
      console.log(`  → writeOffer threw: ${e.message}`);
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  → writeOffer done: searchKey=${result.searchKey} offerId=${result.offerId} lines=${result.linesWritten}/${lines.length} errors=${result.errors.length} elapsed=${elapsed}s`);
    if (result.errors.length > 0) {
      console.log(`  ⚠ first errors: ${result.errors.slice(0, 3).join(' | ')}`);
    }

    if (result.offerId) {
      console.log(`  Deactivating source offer ${t.srcOfferId}...`);
      try {
        const r = await patchRecord('chuboe_offer', t.srcOfferId, { IsActive: 'N' }, { source: 'rewrite-correct-bp-2026-05-07' });
        console.log(`  → ${r.status}`);
      } catch (e) {
        console.log(`  → deactivate ERROR ${e.message}`);
      }
    } else {
      console.log(`  ⚠ Skipping deactivate — no new offer was created`);
    }
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
