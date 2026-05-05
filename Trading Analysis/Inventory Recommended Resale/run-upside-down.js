#!/usr/bin/env node
/**
 * Inventory upside-down analysis — first run.
 *
 * Sources:
 *   GM:  /home/analytics_user/workspace/Trading_Analysis_scratch/gm-cost-list/Ready To Ship - GM GP 11.14.25.xlsx
 *        (Sheet "Stock and Costs", header row 0, cost = "Astute Cost")
 *   LAM: /home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM EPG Award/Lam_EPG_SIPOC.xlsx
 *        (Sheet1, header row 1, cost = "Purchase Price")
 *
 * Per line: searchAllDistributors(mpn, ourQty, {mfr}) — best franchise unit price at our qty,
 *           total franchise stock summed across distys, coverage count.
 *
 * Buckets (cost-spread thresholds locked 2026-05-05):
 *   no_coverage     : zero franchise stock found
 *   broker_validate : best franchise ≥ cost × 2.0
 *   default_markup  : 1.0× to 2.0× cost
 *   underwater      : best franchise < cost
 *
 * Output: one xlsx, two main sheets (GM, LAM), two side sheets (SIPOC missing cost,
 *         OT LAM Dead MPNs not in SIPOC). Emailed to default operator recipient.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('/home/analytics_user/workspace/node_modules/xlsx');

const REPO = '/home/analytics_user/workspace/astute-workinstructions';
const { searchAllDistributors, priceAtQty, extractStockAndLtRows } = require(`${REPO}/shared/franchise-api`);
const { createNotifier } = require(`${REPO}/shared/notifier`);
const { execSync } = require('child_process');

const GM_FILE = '/home/analytics_user/workspace/Trading_Analysis_scratch/gm-cost-list/Ready To Ship - GM GP 11.14.25.xlsx';
const LAM_KITTING_DB = `${REPO}/Trading Analysis/LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx`;

const BROKER_VALIDATE_RATIO = 2.0;
const CONCURRENCY = 4;

function bucketize(cost, bestPrice, totalStock) {
  if (totalStock <= 0 || bestPrice == null || bestPrice <= 0) return 'no_coverage';
  if (cost <= 0) return 'cost_unknown';
  const ratio = bestPrice / cost;
  if (ratio >= BROKER_VALIDATE_RATIO) return 'broker_validate';
  if (ratio < 1.0) return 'underwater';
  return 'default_markup';
}

function loadGM() {
  const wb = XLSX.readFile(GM_FILE);
  const ws = wb.Sheets['Stock and Costs'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // headers row 0: Quoted Part Number | Manufacturer | Lot Code Availability | Qty | GM Cost | Total Price | Blank | Total Cost | Astute Cost | Estimated GP
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mpn = String(r[0] || '').trim();
    const mfr = String(r[1] || '').trim();
    const qty = Number(r[3]) || 0;
    const gmCost = Number(r[4]) || 0;
    const astuteCost = Number(r[8]) || 0;
    if (!mpn || !mfr) continue;
    out.push({ source: 'GM', mpn, mfr, qty, cost: astuteCost, gmCost });
  }
  return out;
}

function loadLAMKittingDB() {
  // INVENTORY sheet headers row 0: Lam P/N | MPN | Manufacturer | Item Description | Lead Time | Base Unit Price | Resale Price | MIN QTY | MOQ | Buyer | Notes
  const wb = XLSX.readFile(LAM_KITTING_DB);
  const ws = wb.Sheets['INVENTORY'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const norm = s => String(s || '').trim().toUpperCase();
  // First, pull on-hand qty from OT LAM_Dead so we can join cost (DB) × qty (OT)
  const otQtyMap = getOTLAMDeadQtyMap();
  const main = [];        // both DB cost AND OT qty present — primary analysis set
  const dbOnly = [];      // on the DB but not held in OT W115 (LAM expects but we haven't sourced)
  const otOnly = [];      // collected separately after the DB pass
  const dbMpns = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lamPN = String(r[0] || '').trim();
    const mpn = String(r[1] || '').trim();
    const mfr = String(r[2] || '').trim();
    const baseUnitPrice = Number(r[5] || 0);
    const resalePrice = Number(r[6] || 0);
    const minQty = Number(r[7] || 0);
    const moq = Number(r[8] || 0);
    if (!mpn) continue;
    dbMpns.add(norm(mpn));
    if (baseUnitPrice <= 0) continue;
    const onHand = otQtyMap.get(norm(mpn));
    if (onHand && onHand.qty > 0) {
      main.push({ source: 'LAM', cpc: lamPN, mpn, mfr, qty: onHand.qty, cost: baseUnitPrice, lamResale: resalePrice, moq, otOfferLineId: onHand.offerLineId });
    } else {
      dbOnly.push({ cpc: lamPN, mpn, mfr, baseUnitPrice, lamResale: resalePrice, moq, minQty });
    }
  }
  // OT-only: in W115 but not on DB
  for (const [mpnNorm, info] of otQtyMap) {
    if (!dbMpns.has(mpnNorm)) {
      otOnly.push({ mpn: info.mpn, mfr: info.mfr, qty: info.qty, otCost: info.cost });
    }
  }
  return { main, dbOnly, otOnly };
}

function getOTLAMDeadQtyMap() {
  const sql = `
    SELECT ol.chuboe_offer_line_id, ol.chuboe_mpn, COALESCE(ol.chuboe_mfr_text,'') AS mfr,
           ol.qty, ol.priceentered AS cost, ol.chuboe_date_code AS dc
    FROM adempiere.chuboe_offer o
    JOIN adempiere.chuboe_offer_line ol ON ol.chuboe_offer_id = o.chuboe_offer_id
    WHERE o.isactive='Y' AND ol.isactive='Y' AND o.description ILIKE '%LAM_Dead%'
  `;
  const out = execSync(`psql -At -F'|' -c "${sql.replace(/\n/g, ' ').trim()}"`, { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [id, mpn, mfr, qty, cost, dc] = line.split('|');
    const key = String(mpn || '').trim().toUpperCase();
    if (!key) continue;
    // If the same MPN appears in multiple W115 lots, sum the qty.
    if (map.has(key)) {
      const cur = map.get(key);
      cur.qty += Number(qty) || 0;
    } else {
      map.set(key, {
        offerLineId: Number(id),
        mpn: (mpn || '').trim(),
        mfr: (mfr || '').trim(),
        qty: Number(qty) || 0,
        cost: Number(cost) || 0,
        dc: (dc || '').trim(),
      });
    }
  }
  return map;
}


function aggregateResult(result, ourQty) {
  let bestPrice = null;
  let totalStock = 0;
  let coverageCount = 0;
  let bestPriceDisty = '';
  if (!result || !Array.isArray(result.distributors)) return { bestPrice, totalStock, coverageCount, bestPriceDisty };
  for (const d of result.distributors) {
    if (!d || !d.found) continue;
    coverageCount++;
    if (d.franchiseQty && d.franchiseQty > 0) totalStock += Number(d.franchiseQty) || 0;
    // collect breaks via extractStockAndLtRows; fall back to franchisePrice
    const ext = extractStockAndLtRows(d, '', ourQty);
    let candidatePrice = null;
    if (ext && Array.isArray(ext)) {
      for (const row of ext) {
        if (row && row.price > 0) {
          if (candidatePrice == null || row.price < candidatePrice) candidatePrice = Number(row.price);
        }
      }
    }
    if (candidatePrice == null) {
      const breaks = d.priceBreaks || d.breaks || (Array.isArray(d.vqLines) ? d.vqLines.map(v => ({ qty: v.qty || 1, price: v.price })) : []);
      const p = priceAtQty(breaks, ourQty) || d.franchisePrice || null;
      if (p && p > 0) candidatePrice = Number(p);
    }
    if (candidatePrice != null && candidatePrice > 0) {
      if (bestPrice == null || candidatePrice < bestPrice) {
        bestPrice = candidatePrice;
        bestPriceDisty = d.name || d.distributor || '';
      }
    }
  }
  return { bestPrice, totalStock, coverageCount, bestPriceDisty };
}

async function runOne(line) {
  try {
    const result = await searchAllDistributors(line.mpn, line.qty || 1, { mfr: line.mfr });
    const agg = aggregateResult(result, line.qty || 1);
    const bucket = bucketize(line.cost, agg.bestPrice, agg.totalStock);
    const spread = (agg.bestPrice && line.cost > 0) ? (agg.bestPrice / line.cost) : null;
    return {
      ...line,
      bestPrice: agg.bestPrice,
      bestPriceDisty: agg.bestPriceDisty,
      totalStock: agg.totalStock,
      coverageCount: agg.coverageCount,
      spreadRatio: spread,
      bucket,
    };
  } catch (e) {
    return { ...line, error: e.message, bucket: 'error' };
  }
}

async function batched(items, fn, n) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
      if ((i + 1) % 10 === 0) process.stderr.write(`  ${i+1}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function fmtCurrency(v) { return (v == null) ? '' : Number(v); }
function asCurrencyCell(v) { return v == null ? { v: '', t: 's' } : { v: Number(v), t: 'n', z: '$#,##0.0000' }; }
function asPercentCell(v) { return v == null ? { v: '', t: 's' } : { v: Number(v), t: 'n', z: '0.0%' }; }
function asQtyCell(v) { return v == null || v === '' ? { v: '', t: 's' } : { v: Number(v), t: 'n', z: '#,##0' }; }
function asTextCell(v) { return { v: v == null ? '' : String(v), t: 's' }; }

function buildSheet(rows, otMpnSet) {
  // columns: Source, MPN, MFR, Our Qty, Our Cost, Best Franchise, Spread Ratio, Best Disty, Total Franchise Stock, Coverage Count, Bucket, In OT?, GM Cost (if GM)
  const aoa = [[
    'Source','CPC','MPN','MFR','Our Qty','Our Cost','Best Franchise','Spread (Franchise/Cost)','Best Disty','Total Franchise Stock','# Distys w/ Stock','Bucket','In OT LAM Dead?','GM Target','Extended Cost','Extended GP at Best Franchise',
  ]];
  for (const r of rows) {
    const inOT = otMpnSet ? (otMpnSet.has(String(r.mpn).toUpperCase()) ? 'Y' : 'N') : '';
    const extCost = (r.cost > 0 && r.qty > 0) ? r.cost * r.qty : null;
    const extGP = (r.bestPrice && r.cost > 0 && r.qty > 0) ? (r.bestPrice - r.cost) * r.qty : null;
    aoa.push([
      r.source || '', r.cpc || '', r.mpn, r.mfr, r.qty, r.cost, r.bestPrice, r.spreadRatio, r.bestPriceDisty || '', r.totalStock, r.coverageCount, r.bucket, inOT, r.gmCost || '', extCost, extGP,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // apply formats — column letters: F=Cost, G=BestFranchise, H=Spread, J=Stock, O=ExtCost, P=ExtGP
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) {
    const set = (col, fmt) => {
      const addr = XLSX.utils.encode_cell({ r: R, c: col });
      if (ws[addr] && typeof ws[addr].v === 'number') ws[addr].z = fmt;
    };
    set(4, '#,##0');         // Our Qty
    set(5, '$#,##0.0000');   // Our Cost
    set(6, '$#,##0.0000');   // Best Franchise
    set(7, '0.00');          // Spread ratio (numeric, not %)
    set(9, '#,##0');         // Total Stock
    set(13, '$#,##0.0000');  // GM Target
    set(14, '$#,##0.00');    // Extended Cost
    set(15, '$#,##0.00');    // Extended GP
  }
  ws['!cols'] = [
    { wch: 7 },{ wch: 18 },{ wch: 30 },{ wch: 22 },{ wch: 10 },{ wch: 13 },{ wch: 15 },{ wch: 10 },{ wch: 14 },{ wch: 16 },{ wch: 9 },{ wch: 18 },{ wch: 8 },{ wch: 12 },{ wch: 14 },{ wch: 18 },
  ];
  return ws;
}

function buildSummarySheet(label, rows) {
  const buckets = {};
  for (const r of rows) {
    const b = r.bucket || 'unknown';
    if (!buckets[b]) buckets[b] = { count: 0, extCost: 0, extGP: 0 };
    buckets[b].count++;
    if (r.cost > 0 && r.qty > 0) buckets[b].extCost += r.cost * r.qty;
    if (r.bestPrice && r.cost > 0 && r.qty > 0) buckets[b].extGP += (r.bestPrice - r.cost) * r.qty;
  }
  const aoa = [[label],[],[
    'Bucket','# Lines','Extended Cost','Extended GP at Best Franchise',
  ]];
  const order = ['broker_validate','default_markup','underwater','no_coverage','cost_unknown','error'];
  for (const k of order) {
    if (!buckets[k]) continue;
    aoa.push([k, buckets[k].count, buckets[k].extCost, buckets[k].extGP]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 20 },{ wch: 10 },{ wch: 18 },{ wch: 22 }];
  // format
  for (let R = 3; R < 3 + order.length; R++) {
    const c2 = XLSX.utils.encode_cell({ r: R, c: 2 });
    const c3 = XLSX.utils.encode_cell({ r: R, c: 3 });
    if (ws[c2]) ws[c2].z = '$#,##0.00';
    if (ws[c3]) ws[c3].z = '$#,##0.00';
  }
  return ws;
}

function bucketRank(b) {
  return { broker_validate: 0, no_coverage: 1, default_markup: 2, underwater: 3, cost_unknown: 4, error: 5 }[b] ?? 9;
}

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const ra = bucketRank(a.bucket), rb = bucketRank(b.bucket);
    if (ra !== rb) return ra - rb;
    const gpa = (a.bestPrice && a.cost > 0) ? (a.bestPrice - a.cost) * (a.qty || 0) : 0;
    const gpb = (b.bestPrice && b.cost > 0) ? (b.bestPrice - b.cost) * (b.qty || 0) : 0;
    return gpb - gpa;
  });
}

(async () => {
  console.log('=== Inventory Upside-Down Analysis ===');
  console.log('Loading sources...');
  const gm = loadGM();
  const { main: lam, dbOnly: lamDBOnly, otOnly: lamOTOnly } = loadLAMKittingDB();
  console.log(`  GM: ${gm.length} lines`);
  console.log(`  LAM Kitting DB matched to W115: ${lam.length} lines (cost from DB, qty from OT)`);
  console.log(`  LAM Kitting DB only (LAM expects, not held): ${lamDBOnly.length}`);
  console.log(`  OT W115 only (held but not on DB): ${lamOTOnly.length}`);

  console.log(`\nRunning franchise APIs (concurrency=${CONCURRENCY})...`);
  const t0 = Date.now();
  console.log('GM:');
  const gmResults = await batched(gm, runOne, CONCURRENCY);
  console.log(`LAM (${lam.length}):`);
  const lamResults = await batched(lam, runOne, CONCURRENCY);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s`);

  // Build xlsx
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, buildSummarySheet('GM Inventory Summary', gmResults), 'GM Summary');
  XLSX.utils.book_append_sheet(wb, buildSheet(sortRows(gmResults), null), 'GM Detail');

  XLSX.utils.book_append_sheet(wb, buildSummarySheet('LAM Kitting Summary', lamResults), 'LAM Summary');
  XLSX.utils.book_append_sheet(wb, buildSheet(sortRows(lamResults), null), 'LAM Detail');

  // Side sheets
  if (lamDBOnly.length > 0) {
    const aoa = [['Lam P/N','MPN','MFR','Base Unit Price','LAM Resale','MOQ','MIN QTY']];
    lamDBOnly.forEach(r => aoa.push([r.cpc, r.mpn, r.mfr, r.baseUnitPrice, r.lamResale, r.moq, r.minQty]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 18 },{ wch: 30 },{ wch: 25 },{ wch: 14 },{ wch: 14 },{ wch: 9 },{ wch: 9 }];
    XLSX.utils.book_append_sheet(wb, ws, 'LAM DB Only (not held)');
  }

  if (lamOTOnly.length > 0) {
    const aoa = [['MPN','MFR (OT)','OT Qty','OT Cost (likely 0)']];
    lamOTOnly.forEach(r => aoa.push([r.mpn, r.mfr, r.qty, r.otCost]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 30 },{ wch: 25 },{ wch: 10 },{ wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'OT W115 Only (not on DB)');
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const today = new Date().toISOString().slice(0, 10);
  const filename = `Inventory Upside Down Analysis ${today}.xlsx`;

  // Build email body summary
  const counts = (rows) => {
    const c = {};
    for (const r of rows) c[r.bucket] = (c[r.bucket] || 0) + 1;
    return c;
  };
  const gmCounts = counts(gmResults);
  const lamCounts = counts(lamResults);

  const html = `
    <p>Inventory upside-down analysis — ${today} (corrected — LAM cost source = LAM Kitting DB Base Unit Price)</p>
    <p><strong>GM (${gmResults.length} lines):</strong> ${JSON.stringify(gmCounts)}</p>
    <p><strong>LAM Kitting (${lamResults.length} lines, DB cost × W115 qty):</strong> ${JSON.stringify(lamCounts)}</p>
    <p>Side reports: ${lamDBOnly.length} on LAM DB but not held in W115 (sourcing gap), ${lamOTOnly.length} held in W115 but not on LAM DB.</p>
    <p>Buckets: <strong>broker_validate</strong> = best franchise ≥ cost × 2.0 → delist + send to brokers.
       <strong>default_markup</strong> = 1×–2× cost → tack on 15%.
       <strong>underwater</strong> = franchise &lt; cost → 15% anyway, flag stuck.
       <strong>no_coverage</strong> = zero franchise stock → broker validate (true scarcity).</p>
  `;

  console.log('\nSending email...');
  const notifier = createNotifier({ fromEmail: 'stockRFQ@orangetsunami.com', fromName: 'Inventory Upside-Down' });
  await notifier.sendWithAttachment(
    'jake.harris@Astutegroup.com',
    `Inventory Upside-Down Analysis (corrected) — GM + LAM Kitting — ${today}`,
    html,
    [{ filename, content: buf }],
    { html: true }
  );
  console.log('Email sent.');
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
