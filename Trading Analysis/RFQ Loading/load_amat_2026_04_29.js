#!/usr/bin/env node
// One-off AMAT RFQ load — Josh's "FW: AMAT RFQs - 0429" workbook → 98 OT RFQs
// Customer: Applied Materials (BP 1000724)
// RFQ Type: PPV (per Jake)
// Workbook: ~/workspace/.tmp-attach/Book1.xlsx (already parsed → amat_grouped.json)
//
// Run:
//   node load_amat_2026_04_29.js                  # dry-run preview
//   node load_amat_2026_04_29.js --commit         # actually write

const fs = require('fs');
const path = require('path');

const SHARED = '/home/analytics_user/workspace/astute-workinstructions/shared';
const { writeRFQ } = require(path.join(SHARED, 'rfq-writer'));

const COMMIT = process.argv.includes('--commit');
const DATA = JSON.parse(fs.readFileSync('/home/analytics_user/workspace/.tmp-attach/amat_grouped.json'));

const AMAT_BP = 1000724;
const SALESREP_ID = 1000004; // Jake Harris (default)

// Buyer first-name → ad_user_id (resolved against c_bpartner_id=1000724)
// Per Jake: Kalmesh for missing buyers, Shashank Singh for "Shashank", Akshay Raj for "Akshay"
const BUYER_MAP = {
  'Pallavi':   1047866,  // Pallavi Anand Dixit
  'Kalmesh':   1046143,  // Kalmesh Nyamagoud (also used as fallback)
  'Vishal':    1046343,  // Vishal Gurav
  'Bhaskar':   1045872,  // Bhaskar Vijayanarasimha
  'Moon Zhao': 1049386,
  'Yongmei':   1042557,  // Yongmei Cao
  'Jeevan':    1046502,  // Jeevan Kumar
  'Abhishek':  1047205,  // Abhishek S
  'Nehal':     1045567,  // Nehal Clarence Pinto
  'Li Jin':    1049743,
  'Andrew':    1014942,  // Andrew Luca (only active Andrew)
  'Shashank':  1049557,  // Shashank Singh — per Jake
  'Akshay':    1048849,  // Akshay Raj    — per Jake
  // Missing-from-OT buyers → Kalmesh per Jake
  'Ulises':    1046143,
  'Kishan':    1046143,
  'Pooja':     1046143,
  'Mithun':    1046143,
};

// First names where we proxied to Kalmesh — flag in description for visibility
const PROXIED = new Set(['Ulises','Kishan','Pooja','Mithun']);

function buildLines(group) {
  return group.lines.map((l) => {
    const qtyRaw = String(l.qty || '').trim();
    const qty = (!qtyRaw || Number(qtyRaw) === 0) ? 1 : Number(qtyRaw);
    return {
      mpn: l.mpn || '',
      mfrText: l.mfr || '',     // includes "ANY VENDORS" — preserved as-is
      qty,
      cpc: l.cpc || '',
      description: l.description || '',
    };
  });
}

function buildHeaderDescription(group) {
  const ariba = String(group.aribaNo || '').trim();
  // Strip "Doc" prefix if present so format reads "Doc # 5565550563"
  const doc = String(group.doc || '').replace(/^Doc\s*/i, '').trim();
  const head = doc
    ? `AMAT RFQ - Ariba # ${ariba} (Doc # ${doc}) - 2026.04.29`
    : `AMAT RFQ - Ariba # ${ariba} - 2026.04.29`;
  return head;
}

async function main() {
  console.log(`AMAT load — ${DATA.length} RFQ groups — mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}\n`);

  const summary = [];
  let totalLines = 0;
  let writtenRfqs = 0;
  let writtenLines = 0;
  const errors = [];

  for (let i = 0; i < DATA.length; i++) {
    const g = DATA[i];
    const userId = BUYER_MAP[g.buyer];
    if (!userId) { errors.push(`Unmapped buyer: ${g.buyer}  (group: ${g.label})`); continue; }

    const lines = buildLines(g);
    totalLines += lines.length;
    const description = buildHeaderDescription(g);

    if (!COMMIT) {
      summary.push({
        idx: i + 1,
        label: g.label,
        buyer: g.buyer,
        userId,
        proxied: PROXIED.has(g.buyer),
        lines: lines.length,
        sampleLine: lines[0],
      });
      continue;
    }

    process.stdout.write(`[${i+1}/${DATA.length}] ${g.label} (${g.buyer}, ${lines.length} lines)... `);
    try {
      const r = await writeRFQ({
        bpartnerId: AMAT_BP,
        type: 'PPV',
        salesrepId: SALESREP_ID,
        userId,
        description,
        lines,
      });
      if (r.errors && r.errors.length) {
        console.log(`PARTIAL — RFQ#${r.searchKey || '?'}, ${r.linesWritten}/${lines.length} lines, ${r.errors.length} errors`);
        errors.push(`${g.label}: ${r.errors.join(' | ')}`);
      } else {
        console.log(`OK → RFQ#${r.searchKey} (${r.linesWritten} lines, ${r.mpnsWritten} MPNs)`);
      }
      if (r.rfqId) {
        writtenRfqs++;
        writtenLines += r.linesWritten;
      }
      // Save running result file so we can resume if interrupted
      fs.appendFileSync(
        '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/RFQ Loading/output/amat_2026_04_29_results.jsonl',
        JSON.stringify({ ariba: g.label, buyer: g.buyer, rfqId: r.rfqId, searchKey: r.searchKey, linesWritten: r.linesWritten, errors: r.errors }) + '\n'
      );
    } catch (e) {
      console.log(`FAIL — ${e.message}`);
      errors.push(`${g.label}: ${e.message}`);
    }
  }

  if (!COMMIT) {
    console.log(`Total RFQs: ${DATA.length}`);
    console.log(`Total lines: ${totalLines}`);
    console.log(`Total errors: ${errors.length}`);
    console.log();
    console.log('Buyer breakdown:');
    const byBuyer = {};
    for (const s of summary) {
      byBuyer[s.buyer] = byBuyer[s.buyer] || { rfqs: 0, lines: 0, proxied: s.proxied };
      byBuyer[s.buyer].rfqs++;
      byBuyer[s.buyer].lines += s.lines;
    }
    for (const [b, v] of Object.entries(byBuyer).sort((a,c) => c[1].rfqs - a[1].rfqs)) {
      console.log(`  ${b.padEnd(12)}  ${String(v.rfqs).padStart(3)} RFQs  ${String(v.lines).padStart(4)} lines${v.proxied ? '  (→ Kalmesh)' : ''}`);
    }
    console.log();
    console.log('First 3 sample RFQs:');
    for (const s of summary.slice(0, 3)) {
      console.log(`  [${s.idx}] ${s.label}`);
      console.log(`    buyer=${s.buyer} (uid=${s.userId})  lines=${s.lines}`);
      console.log(`    sample line: cpc=${s.sampleLine.cpc} mpn=${s.sampleLine.mpn} mfr=${s.sampleLine.mfrText} qty=${s.sampleLine.qty}`);
    }
    if (errors.length) {
      console.log('\nErrors:');
      errors.forEach(e => console.log('  ' + e));
    }
  } else {
    console.log(`\n=== COMMIT SUMMARY ===`);
    console.log(`RFQs written: ${writtenRfqs} / ${DATA.length}`);
    console.log(`Lines written: ${writtenLines} / ${totalLines}`);
    if (errors.length) {
      console.log(`Errors: ${errors.length}`);
      errors.forEach(e => console.log('  ' + e));
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
