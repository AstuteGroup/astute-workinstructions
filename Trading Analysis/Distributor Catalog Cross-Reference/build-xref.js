#!/usr/bin/env node
/**
 * HTC Korea drop-in replacement catalog vs Astute 12mo RFQ history.
 *
 * Mirrors the ATGBICS_RFQ_Cross_Reference_12mo deliverable shipped 5/13:
 *   - htc_summary.csv                    (customer / bp_group / seller / rfq_type)
 *   - htc_by_brand.csv                   (hits where customer asked for HTC's own MPN)
 *   - htc_by_competitor_brand.csv        (hits per mainstream MFR HTC replaces)
 *   - htc_by_mpn.csv                     (per asked MPN roll-up)
 *   - htc_detail.csv                     (one row per RFQ line × MPN hit)
 *   - htc_rfq_detail.csv                 (RFQ × competitor brand)
 *   - htc_rfq_by_customer_seller_type.csv
 *   - HTC_RFQ_Cross_Reference_12mo.xlsx       (workbook combining the above)
 *   - HTC_RFQ_Cross_Reference_12mo_JCI.xlsx   (same shape, JCI-only)
 */

const fs = require('fs');
const path = require('path');
const NM_AW = path.resolve(process.env.HOME, 'workspace/astute-workinstructions/node_modules');
const XLSX = require(NM_AW + '/xlsx');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(process.env.HOME, 'workspace/htc-korea-xref');
const CATALOG = path.join(ROOT, 'htc_catalog.csv');
const JCI_NAME = 'Johnson Controls, Inc.';

// ─── HELPERS ────────────────────────────────────────────────────────────────

function readCsv(p) {
  const lines = fs.readFileSync(p, 'utf-8').replace(/\r/g, '').split('\n').filter(Boolean);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = parseCsvLine(l);
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = cells[i] != null ? cells[i] : '';
    return o;
  });
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') { inQ = true; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(p, header, rows) {
  const out = [header.join(',')];
  for (const r of rows) out.push(header.map(h => csvEscape(r[h])).join(','));
  fs.writeFileSync(p, out.join('\n') + '\n');
}

function cleanMpn(s) {
  if (s == null) return '';
  return String(s).toUpperCase().replace(/[\s\-_/\\.]/g, '');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Loading catalog...');
  const catalog = readCsv(CATALOG);
  console.log(`  ${catalog.length} catalog rows`);

  // Build lookups keyed by cleaned competitor_mpn → array of catalog entries
  const byClean = new Map();
  for (const c of catalog) {
    const k = cleanMpn(c.competitor_mpn);
    if (!k) continue;
    if (!byClean.has(k)) byClean.set(k, []);
    byClean.get(k).push(c);
  }
  const cleanKeys = [...byClean.keys()];
  console.log(`  ${cleanKeys.length} distinct cleaned MPNs`);

  // Write the MPN list to a temp file we'll splice into the SQL via a VALUES clause.
  // We do a single round-trip per key-set; that's much faster than 2,652 row-by-row
  // and avoids the SASL auth fight with the pg npm client (psql peer-auths cleanly).
  function queryByKeys(keys, label) {
    console.log(`Querying ${label} (${keys.length} keys)...`);
    // Build a values clause: (mpn1),(mpn2),...  All keys are already cleaned MPNs (uppercased, stripped).
    const valuesClause = keys.map(k => `(${pgLit(k)})`).join(',');
    const sql = `
WITH keys(k) AS (VALUES ${valuesClause})
SELECT
  r.chuboe_rfq_id,
  r.value             AS rfq_number,
  to_char(r.created, 'YYYY-MM-DD') AS rfq_date,
  bp.c_bpartner_id    AS customer_bp_id,
  bp.name             AS customer_name,
  COALESCE(grp.name,'') AS bp_group,
  COALESCE(sr.name,'')  AS seller_name,
  COALESCE(rt.name,'')  AS rfq_type,
  lm.chuboe_mpn       AS asked_mpn,
  COALESCE(lm.chuboe_mpn_clean, lm.chuboe_mpn) AS asked_mpn_clean,
  COALESCE(lm.chuboe_mfr_text,'') AS asked_mfr,
  COALESCE(lm.qty,0)  AS asked_qty,
  rl.chuboe_rfq_line_id AS rfq_line_id,
  COALESCE(rl.chuboe_cpc,'') AS cpc,
  COALESCE(rl.qty, 0) AS line_qty
FROM adempiere.chuboe_rfq_line_mpn lm
JOIN adempiere.chuboe_rfq_line      rl  ON rl.chuboe_rfq_line_id = lm.chuboe_rfq_line_id
JOIN adempiere.chuboe_rfq           r   ON r.chuboe_rfq_id = lm.chuboe_rfq_id
JOIN adempiere.c_bpartner           bp  ON bp.c_bpartner_id = r.c_bpartner_id
LEFT JOIN adempiere.c_bp_group      grp ON grp.c_bp_group_id = bp.c_bp_group_id
LEFT JOIN adempiere.ad_user         sr  ON sr.ad_user_id = r.salesrep_id
LEFT JOIN adempiere.chuboe_rfq_type rt  ON rt.chuboe_rfq_type_id = r.chuboe_rfq_type_id
WHERE lm.isactive='Y'
  AND r.isactive='Y'
  AND rl.isactive='Y'
  AND r.created >= NOW() - INTERVAL '12 months'
  AND UPPER(REGEXP_REPLACE(COALESCE(lm.chuboe_mpn_clean, lm.chuboe_mpn), '[\\s\\-_/\\\\.]', '', 'g'))
      IN (SELECT k FROM keys);
`;
    const tmpSql = path.join(ROOT, `_tmp_${label.replace(/[^a-z]/gi, '_')}.sql`);
    fs.writeFileSync(tmpSql, sql);
    const tsv = execFileSync('psql', ['-A', '-F', '\t', '-X', '-t', '-f', tmpSql], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    fs.unlinkSync(tmpSql);
    const rows = tsv.split('\n').filter(Boolean).map(line => {
      const c = line.split('\t');
      return {
        chuboe_rfq_id: Number(c[0]),
        rfq_number: c[1],
        rfq_date: c[2],
        customer_bp_id: Number(c[3]),
        customer_name: c[4],
        bp_group: c[5],
        seller_name: c[6],
        rfq_type: c[7],
        asked_mpn: c[8],
        asked_mpn_clean: c[9],
        asked_mfr: c[10],
        asked_qty: Number(c[11]) || 0,
        rfq_line_id: Number(c[12]),
        cpc: c[13] || '',
        line_qty: Number(c[14]) || 0,
      };
    });
    console.log(`  ${rows.length} hits`);
    return rows;
  }

  function pgLit(s) {
    return "'" + String(s).replace(/'/g, "''") + "'";
  }

  const res = { rows: queryByKeys(cleanKeys, 'competitor') };
  const htcKeys = [...new Set(catalog.map(c => cleanMpn(c.htc_mpn)).filter(Boolean))];
  const resHtc = { rows: queryByKeys(htcKeys, 'htc-direct') };

  // ─── BUILD HIT ROWS (competitor-mpn matches) ───────────────────────────────
  // Each hit cross-joins with all catalog entries that share the cleaned MPN
  // (some original MPNs map to multiple TAEJIN replacements).
  const hits = [];
  for (const r of res.rows) {
    const cat = byClean.get(cleanMpn(r.asked_mpn_clean || r.asked_mpn)) || [];
    for (const c of cat) {
      hits.push({
        rfq_id: r.chuboe_rfq_id,
        rfq_line_id: r.rfq_line_id,
        cpc: r.cpc || '',
        line_qty: r.line_qty || 0,
        rfq_number: r.rfq_number,
        rfq_date: r.rfq_date,
        customer_bp_id: r.customer_bp_id,
        customer_name: r.customer_name,
        bp_group: r.bp_group || '',
        seller_name: r.seller_name || '',
        rfq_type: r.rfq_type || '',
        asked_mpn: r.asked_mpn,
        asked_mfr: r.asked_mfr || '',
        asked_qty: r.asked_qty || 0,
        match_kind: 'competitor-mpn',
        xref_htc_mpn: c.htc_mpn,
        competitor_brand: c.vendor,
        match_grade: c.match_grade,
        target_pkg: c.target_pkg,
        htc_pkg: c.htc_pkg,
        source_file: c.source_file,
      });
    }
  }
  // Direct-HTC hits (customer asked for TAEJIN MPN itself)
  const htcByClean = new Map();
  for (const c of catalog) {
    const k = cleanMpn(c.htc_mpn);
    if (!k) continue;
    if (!htcByClean.has(k)) htcByClean.set(k, []);
    htcByClean.get(k).push(c);
  }
  for (const r of resHtc.rows) {
    const cat = htcByClean.get(cleanMpn(r.asked_mpn_clean || r.asked_mpn)) || [];
    for (const c of cat) {
      hits.push({
        rfq_id: r.chuboe_rfq_id,
        rfq_line_id: r.rfq_line_id,
        cpc: r.cpc || '',
        line_qty: r.line_qty || 0,
        rfq_number: r.rfq_number,
        rfq_date: r.rfq_date,
        customer_bp_id: r.customer_bp_id,
        customer_name: r.customer_name,
        bp_group: r.bp_group || '',
        seller_name: r.seller_name || '',
        rfq_type: r.rfq_type || '',
        asked_mpn: r.asked_mpn,
        asked_mfr: r.asked_mfr || '',
        asked_qty: r.asked_qty || 0,
        match_kind: 'htc-mpn-direct',
        xref_htc_mpn: c.htc_mpn,
        competitor_brand: c.vendor,
        match_grade: c.match_grade,
        target_pkg: c.target_pkg,
        htc_pkg: c.htc_pkg,
        source_file: c.source_file,
      });
    }
  }
  console.log(`Total xref rows (hit × catalog): ${hits.length}`);

  // ─── BUILD ROLL-UPS ─────────────────────────────────────────────────────────

  function buildOutputs(rows, label) {
    // detail.csv — per-hit
    const detail = rows.map(h => ({
      rfq_number: h.rfq_number,
      rfq_date: h.rfq_date,
      customer_name: h.customer_name,
      bp_group: h.bp_group,
      seller_name: h.seller_name,
      rfq_type: h.rfq_type,
      asked_mpn: h.asked_mpn,
      asked_mfr: h.asked_mfr,
      asked_qty: h.asked_qty,
      xref_htc_mpn: h.xref_htc_mpn,
      competitor_brand: h.competitor_brand,
      match_grade: h.match_grade,
      target_pkg: h.target_pkg,
      htc_pkg: h.htc_pkg,
      match_kind: h.match_kind,
      source_file: h.source_file,
    }));

    // summary.csv — customer × bp_group × seller × rfq_type
    const sumMap = new Map();
    for (const h of rows) {
      const k = [h.customer_name, h.bp_group, h.seller_name, h.rfq_type].join('|||');
      if (!sumMap.has(k)) sumMap.set(k, {
        customer_name: h.customer_name, bp_group: h.bp_group,
        seller_name: h.seller_name, rfq_type: h.rfq_type,
        hit_lines: 0, _rfqs: new Set(), _brands: new Set(),
        total_qty_asked: 0, first_hit: h.rfq_date, last_hit: h.rfq_date,
      });
      const s = sumMap.get(k);
      s.hit_lines++;
      s._rfqs.add(h.rfq_id);
      s._brands.add(h.competitor_brand);
      s.total_qty_asked += Number(h.asked_qty || 0);
      if (h.rfq_date && h.rfq_date < s.first_hit) s.first_hit = h.rfq_date;
      if (h.rfq_date && h.rfq_date > s.last_hit) s.last_hit = h.rfq_date;
    }
    const summary = [...sumMap.values()].map(s => ({
      customer_name: s.customer_name, bp_group: s.bp_group,
      seller_name: s.seller_name, rfq_type: s.rfq_type,
      hit_lines: s.hit_lines, rfqs: s._rfqs.size,
      distinct_competitor_brands: s._brands.size,
      total_qty_asked: s.total_qty_asked,
      first_hit: s.first_hit, last_hit: s.last_hit,
    })).sort((a, b) => b.hit_lines - a.hit_lines);

    // by_competitor_brand
    const cbMap = new Map();
    for (const h of rows) {
      const k = h.competitor_brand;
      if (!cbMap.has(k)) cbMap.set(k, {
        competitor_brand: k, hit_lines: 0, _rfqs: new Set(),
        _customers: new Set(), _mpns: new Set(),
      });
      const c = cbMap.get(k);
      c.hit_lines++; c._rfqs.add(h.rfq_id); c._customers.add(h.customer_name);
      c._mpns.add((h.asked_mpn || '').toUpperCase());
    }
    const by_competitor_brand = [...cbMap.values()].map(c => ({
      competitor_brand: c.competitor_brand,
      hit_lines: c.hit_lines, rfqs: c._rfqs.size,
      customers: c._customers.size, distinct_mpns_asked: c._mpns.size,
    })).sort((a, b) => b.hit_lines - a.hit_lines);

    // by_brand — direct-HTC-mpn hits aggregated
    const directRows = rows.filter(h => h.match_kind === 'htc-mpn-direct');
    const bMap = new Map();
    for (const h of directRows) {
      const k = h.competitor_brand;
      if (!bMap.has(k)) bMap.set(k, {
        competitor_brand: k, hit_lines: 0, _rfqs: new Set(),
        _customers: new Set(), _mpns: new Set(),
      });
      const c = bMap.get(k);
      c.hit_lines++; c._rfqs.add(h.rfq_id); c._customers.add(h.customer_name);
      c._mpns.add((h.asked_mpn || '').toUpperCase());
    }
    const by_brand = [...bMap.values()].map(c => ({
      competitor_brand: c.competitor_brand,
      hit_lines: c.hit_lines, rfqs: c._rfqs.size,
      customers: c._customers.size, distinct_mpns_asked: c._mpns.size,
    })).sort((a, b) => b.hit_lines - a.hit_lines);

    // by_mpn
    const mpnMap = new Map();
    for (const h of rows) {
      const k = (h.asked_mpn || '').toUpperCase();
      if (!mpnMap.has(k)) mpnMap.set(k, {
        asked_mpn_clean: k, asked_mpn_display: h.asked_mpn,
        asked_mfr_first: h.asked_mfr,
        htc_equivalent: h.xref_htc_mpn,
        competitor_brand: h.competitor_brand,
        match_grade: h.match_grade,
        target_pkg: h.target_pkg, htc_pkg: h.htc_pkg,
        hit_lines: 0, _rfqs: new Set(), _customers: new Set(),
        total_qty_asked: 0,
        _customer_names: new Set(), _sellers: new Set(), _types: new Set(),
        first_hit: h.rfq_date, last_hit: h.rfq_date,
      });
      const m = mpnMap.get(k);
      m.hit_lines++; m._rfqs.add(h.rfq_id);
      m._customers.add(h.customer_name);
      m._customer_names.add(h.customer_name);
      m._sellers.add(h.seller_name);
      m._types.add(h.rfq_type);
      m.total_qty_asked += Number(h.asked_qty || 0);
      if (h.rfq_date && h.rfq_date < m.first_hit) m.first_hit = h.rfq_date;
      if (h.rfq_date && h.rfq_date > m.last_hit) m.last_hit = h.rfq_date;
    }
    const by_mpn = [...mpnMap.values()].map(m => ({
      asked_mpn_clean: m.asked_mpn_clean,
      asked_mpn_display: m.asked_mpn_display,
      asked_mfr_first: m.asked_mfr_first,
      htc_equivalent: m.htc_equivalent,
      competitor_brand: m.competitor_brand,
      match_grade: m.match_grade,
      target_pkg: m.target_pkg,
      htc_pkg: m.htc_pkg,
      hit_lines: m.hit_lines, rfqs: m._rfqs.size,
      distinct_customers: m._customers.size,
      total_qty_asked: m.total_qty_asked,
      customers: [...m._customer_names].filter(Boolean).join(' | '),
      sellers: [...m._sellers].filter(Boolean).join(' | '),
      rfq_types: [...m._types].filter(Boolean).join(' | '),
      first_hit: m.first_hit, last_hit: m.last_hit,
    })).sort((a, b) => b.hit_lines - a.hit_lines);

    // rfq_detail (RFQ × competitor brand)
    const rfqDetail = rows.map(h => ({
      chuboe_rfq_id: h.rfq_id,
      rfq_number: h.rfq_number,
      customer_name: h.customer_name,
      bp_group: h.bp_group,
      seller_name: h.seller_name,
      rfq_type: h.rfq_type,
      rfq_date: h.rfq_date,
      asked_mpn: h.asked_mpn,
      asked_mfr: h.asked_mfr,
      xref_htc_mpn: h.xref_htc_mpn,
      competitor_brand: h.competitor_brand,
      match_grade: h.match_grade,
    }));

    // rfq_by_customer_seller_type
    const csMap = new Map();
    for (const h of rows) {
      const k = [h.customer_bp_id, h.customer_name, h.bp_group, h.seller_name, h.rfq_type].join('|||');
      if (!csMap.has(k)) csMap.set(k, {
        c_bpartner_id: h.customer_bp_id,
        customer_name: h.customer_name, bp_group: h.bp_group,
        seller_name: h.seller_name, rfq_type: h.rfq_type,
        hit_lines: 0, _rfqs: new Set(), _brands: new Set(),
        first_hit: h.rfq_date, last_hit: h.rfq_date,
      });
      const c = csMap.get(k);
      c.hit_lines++; c._rfqs.add(h.rfq_id); c._brands.add(h.competitor_brand);
      if (h.rfq_date && h.rfq_date < c.first_hit) c.first_hit = h.rfq_date;
      if (h.rfq_date && h.rfq_date > c.last_hit) c.last_hit = h.rfq_date;
    }
    const rfq_by_cst = [...csMap.values()].map(c => ({
      c_bpartner_id: c.c_bpartner_id,
      customer_name: c.customer_name, bp_group: c.bp_group,
      seller_name: c.seller_name, rfq_type: c.rfq_type,
      hit_lines: c.hit_lines, rfqs: c._rfqs.size,
      distinct_competitor_brands: c._brands.size,
      first_hit: c.first_hit, last_hit: c.last_hit,
    })).sort((a, b) => b.hit_lines - a.hit_lines);

    // by_cpc — collapse AVL alternates onto a single customer ask
    // Bucket per (cpc, rfq_line_id). Each bucket = ONE customer ask. Then aggregate
    // bucket-level totals (qty taken from rfq_line.qty, deduped per line).
    const lineBucket = new Map(); // (cpc||rfq_line_id) -> bucket state
    for (const h of rows) {
      // CPCs can be empty — fall back to rfq_line_id so a line with no CPC still
      // gets collapsed (and doesn't double-count across MPN variants).
      const key = (h.cpc && h.cpc.trim()) ? `CPC:${h.cpc}` : `LINE:${h.rfq_line_id}`;
      const lineKey = `${key}|${h.rfq_line_id}`;
      if (!lineBucket.has(lineKey)) {
        lineBucket.set(lineKey, {
          cpc: h.cpc || '',
          rfq_line_id: h.rfq_line_id,
          rfq_id: h.rfq_id,
          rfq_number: h.rfq_number,
          rfq_date: h.rfq_date,
          customer_name: h.customer_name,
          seller_name: h.seller_name,
          rfq_type: h.rfq_type,
          // qty from the rfq_line (deduped per line — same regardless of MPN variant)
          line_qty: h.line_qty || h.asked_qty || 0,
          mpns: new Set(),
          mfrs: new Set(),
          competitor_brands: new Set(),
          htc_mpns: new Set(),
          match_grades: new Set(),
        });
      }
      const b = lineBucket.get(lineKey);
      if (h.asked_mpn) b.mpns.add(h.asked_mpn);
      if (h.asked_mfr) b.mfrs.add(h.asked_mfr);
      if (h.competitor_brand) b.competitor_brands.add(h.competitor_brand);
      if (h.xref_htc_mpn) b.htc_mpns.add(h.xref_htc_mpn);
      if (h.match_grade) b.match_grades.add(h.match_grade);
    }

    // Now aggregate buckets up to the CPC level
    const cpcMap = new Map();
    for (const b of lineBucket.values()) {
      const key = b.cpc || `(no CPC, line ${b.rfq_line_id})`;
      if (!cpcMap.has(key)) cpcMap.set(key, {
        cpc: b.cpc,
        rfq_line_count: 0,
        _rfqs: new Set(),
        _sellers: new Set(),
        _types: new Set(),
        _mpns: new Set(),
        _mfrs: new Set(),
        _competitor_brands: new Set(),
        _htc_mpns: new Set(),
        _match_grades: new Set(),
        total_qty_asked: 0,
        first_hit: b.rfq_date, last_hit: b.rfq_date,
      });
      const c = cpcMap.get(key);
      c.rfq_line_count++;
      c._rfqs.add(b.rfq_id);
      c._sellers.add(b.seller_name);
      c._types.add(b.rfq_type);
      b.mpns.forEach(x => c._mpns.add(x));
      b.mfrs.forEach(x => c._mfrs.add(x));
      b.competitor_brands.forEach(x => c._competitor_brands.add(x));
      b.htc_mpns.forEach(x => c._htc_mpns.add(x));
      b.match_grades.forEach(x => c._match_grades.add(x));
      c.total_qty_asked += Number(b.line_qty || 0);
      if (b.rfq_date && b.rfq_date < c.first_hit) c.first_hit = b.rfq_date;
      if (b.rfq_date && b.rfq_date > c.last_hit) c.last_hit = b.rfq_date;
    }
    const by_cpc = [...cpcMap.values()].map(c => ({
      cpc: c.cpc || '(no CPC)',
      rfq_lines: c.rfq_line_count,
      rfqs: c._rfqs.size,
      total_qty_asked: c.total_qty_asked,
      distinct_mpn_variants: c._mpns.size,
      mpn_variants_seen: [...c._mpns].join(' | '),
      mfr_seen: [...c._mfrs].filter(Boolean).join(' | '),
      competitor_brands: [...c._competitor_brands].filter(Boolean).join(' | '),
      htc_replacements: [...c._htc_mpns].filter(Boolean).join(' | '),
      match_grades: [...c._match_grades].filter(Boolean).join(' | '),
      sellers: [...c._sellers].filter(Boolean).join(' | '),
      rfq_types: [...c._types].filter(Boolean).join(' | '),
      first_hit: c.first_hit, last_hit: c.last_hit,
    })).sort((a, b) => b.rfq_lines - a.rfq_lines);

    return { detail, summary, by_competitor_brand, by_brand, by_mpn, rfqDetail, rfq_by_cst, by_cpc };
  }

  const full = buildOutputs(hits, 'all');
  const jciHits = hits.filter(h => (h.customer_name || '').includes('Johnson Controls'));
  const jci = buildOutputs(jciHits, 'jci');
  console.log(`JCI subset: ${jciHits.length} hits`);

  // ─── WRITE CSVs (full set, mirroring ATGBICS) ───────────────────────────────
  writeCsv(path.join(ROOT, 'htc_detail.csv'),
    ['rfq_number','rfq_date','customer_name','bp_group','seller_name','rfq_type','asked_mpn','asked_mfr','asked_qty','xref_htc_mpn','competitor_brand','match_grade','target_pkg','htc_pkg','match_kind','source_file'],
    full.detail);
  writeCsv(path.join(ROOT, 'htc_summary.csv'),
    ['customer_name','bp_group','seller_name','rfq_type','hit_lines','rfqs','distinct_competitor_brands','total_qty_asked','first_hit','last_hit'],
    full.summary);
  writeCsv(path.join(ROOT, 'htc_by_brand.csv'),
    ['competitor_brand','hit_lines','rfqs','customers','distinct_mpns_asked'],
    full.by_brand);
  writeCsv(path.join(ROOT, 'htc_by_competitor_brand.csv'),
    ['competitor_brand','hit_lines','rfqs','customers','distinct_mpns_asked'],
    full.by_competitor_brand);
  writeCsv(path.join(ROOT, 'htc_by_mpn.csv'),
    ['asked_mpn_clean','asked_mpn_display','asked_mfr_first','htc_equivalent','competitor_brand','match_grade','target_pkg','htc_pkg','hit_lines','rfqs','distinct_customers','total_qty_asked','customers','sellers','rfq_types','first_hit','last_hit'],
    full.by_mpn);
  writeCsv(path.join(ROOT, 'htc_rfq_detail.csv'),
    ['chuboe_rfq_id','rfq_number','customer_name','bp_group','seller_name','rfq_type','rfq_date','asked_mpn','asked_mfr','xref_htc_mpn','competitor_brand','match_grade'],
    full.rfqDetail);
  writeCsv(path.join(ROOT, 'htc_rfq_by_customer_seller_type.csv'),
    ['c_bpartner_id','customer_name','bp_group','seller_name','rfq_type','hit_lines','rfqs','distinct_competitor_brands','first_hit','last_hit'],
    full.rfq_by_cst);

  // ─── WRITE XLSX (full + JCI) ────────────────────────────────────────────────
  function makeWorkbook(set, label, opts = {}) {
    const wb = XLSX.utils.book_new();

    function addSheet(name, rows, header, formats) {
      if (!rows.length) {
        // still emit an empty tab with header for parity
        const empty = [header];
        const ws = XLSX.utils.aoa_to_sheet(empty);
        ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length + 2) }));
        XLSX.utils.book_append_sheet(wb, ws, name);
        return;
      }
      const aoa = [header, ...rows.map(r => header.map(h => r[h] != null ? r[h] : ''))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Apply formats
      if (formats) {
        for (const [col, fmt] of Object.entries(formats)) {
          const cidx = header.indexOf(col);
          if (cidx < 0) continue;
          for (let r = 1; r < aoa.length; r++) {
            const addr = XLSX.utils.encode_cell({ c: cidx, r });
            const cell = ws[addr];
            if (cell && typeof cell.v === 'number') cell.z = fmt;
          }
        }
      }
      // Column widths
      ws['!cols'] = header.map(h => {
        const maxLen = Math.max(h.length, ...rows.slice(0, 100).map(r => String(r[h] || '').length));
        return { wch: Math.min(50, Math.max(10, maxLen + 2)) };
      });
      XLSX.utils.book_append_sheet(wb, ws, name);
    }

    addSheet('Summary', set.summary,
      ['customer_name','bp_group','seller_name','rfq_type','hit_lines','rfqs','distinct_competitor_brands','total_qty_asked','first_hit','last_hit'],
      { total_qty_asked: '#,##0' });
    if (opts.includeCpc) {
      addSheet('By CPC', set.by_cpc,
        ['cpc','rfq_lines','rfqs','total_qty_asked','distinct_mpn_variants','mpn_variants_seen','mfr_seen','competitor_brands','htc_replacements','match_grades','sellers','rfq_types','first_hit','last_hit'],
        { total_qty_asked: '#,##0' });
    }
    addSheet('By Competitor Brand', set.by_competitor_brand,
      ['competitor_brand','hit_lines','rfqs','customers','distinct_mpns_asked']);
    addSheet('By HTC Brand', set.by_brand,
      ['competitor_brand','hit_lines','rfqs','customers','distinct_mpns_asked']);
    addSheet('By MPN', set.by_mpn,
      ['asked_mpn_display','asked_mfr_first','htc_equivalent','competitor_brand','match_grade','target_pkg','htc_pkg','hit_lines','rfqs','distinct_customers','total_qty_asked','customers','sellers','rfq_types','first_hit','last_hit'],
      { total_qty_asked: '#,##0' });
    addSheet('Customer × Seller × Type', set.rfq_by_cst,
      ['c_bpartner_id','customer_name','bp_group','seller_name','rfq_type','hit_lines','rfqs','distinct_competitor_brands','first_hit','last_hit']);
    addSheet('Detail (per hit)', set.detail,
      ['rfq_number','rfq_date','customer_name','bp_group','seller_name','rfq_type','asked_mpn','asked_mfr','asked_qty','xref_htc_mpn','competitor_brand','match_grade','target_pkg','htc_pkg','match_kind','source_file'],
      { asked_qty: '#,##0' });
    return wb;
  }

  const fullWb = makeWorkbook(full, 'all');
  XLSX.writeFile(fullWb, path.join(ROOT, 'HTC_RFQ_Cross_Reference_12mo.xlsx'));
  console.log(`Wrote HTC_RFQ_Cross_Reference_12mo.xlsx (${full.detail.length} detail rows)`);

  const jciWb = makeWorkbook(jci, 'jci', { includeCpc: true });
  XLSX.writeFile(jciWb, path.join(ROOT, 'HTC_RFQ_Cross_Reference_12mo_JCI.xlsx'));
  console.log(`Wrote HTC_RFQ_Cross_Reference_12mo_JCI.xlsx (${jci.detail.length} detail rows)`);

  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
