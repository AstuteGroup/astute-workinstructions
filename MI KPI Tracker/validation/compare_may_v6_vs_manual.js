const XLSX = require('xlsx');

console.log('='.repeat(80));
console.log('COMPARING V6 (WITH ADD-ONS) TO MANUAL TRACKER');
console.log('='.repeat(80));
console.log('');

// Read manual tracker
const manualFile = '/home/melissa.bojar/workspace/MI KPIs/Manual OTIN Tracker Austin - May 2026 Finalized.xlsx';
const manualWb = XLSX.readFile(manualFile);
const manualData = XLSX.utils.sheet_to_json(manualWb.Sheets[manualWb.SheetNames[0]], { header: 1, defval: '' });

// Parse manual tracker (line-item format)
const manualOTINs = new Set();
let manualTotalKPI = 0;
const manualByOTIN = {};

for (let i = 2; i < manualData.length; i++) {
    const row = manualData[i];
    const otin = String(row[0] || '').trim();
    const dclc = parseInt(row[1]) || 1;
    const tier = String(row[3] || '').trim().toUpperCase();

    if (!otin || otin === '') continue;

    manualOTINs.add(otin);

    // Standardize tier and get weight
    let weight = 0;
    if (tier.match(/^(1|T1-?P)/i)) weight = 0.75;
    else if (tier.match(/^(1|T1-?A|T1(?!-))/i)) weight = 1.0;
    else if (tier.match(/^(1|T1-?M)/i)) weight = 0.5;
    else if (tier.match(/^(2|T2)/i)) weight = 2.0;
    else if (tier.match(/^(3|T3)/i)) weight = 3.0;
    else if (tier.match(/^(4|T4)/i)) weight = 4.0;
    else weight = 1.0;  // Default

    const kpi = dclc * weight;
    manualTotalKPI += kpi;

    if (!manualByOTIN[otin]) {
        manualByOTIN[otin] = { dclc: 0, tier: tier, weight: 0, kpi: 0 };
    }
    manualByOTIN[otin].dclc += dclc;
    manualByOTIN[otin].weight = Math.max(manualByOTIN[otin].weight, weight);
    manualByOTIN[otin].kpi += kpi;
}

console.log('MANUAL TRACKER:');
console.log(`  Total line items: ${manualData.length - 2}`);
console.log(`  Unique OTINs: ${manualOTINs.size}`);
console.log(`  Total KPI: ${manualTotalKPI.toFixed(2)}`);
console.log('');

// Read automated v6 report
const autoFile = '/home/melissa.bojar/workspace/MI KPIs/mi_kpi_report_2026-05_v6.xlsx';
const autoWb = XLSX.readFile(autoFile);
const autoData = XLSX.utils.sheet_to_json(autoWb.Sheets['Inspection Log'], { header: 1 });

// Parse automated report
const autoOTINs = new Set();
let autoTotalKPI = 0;
const autoByOTIN = {};

for (let i = 1; i < autoData.length; i++) {
    const row = autoData[i];
    const otin = String(row[0] || '').trim();
    const dclc = parseInt(row[14]) || 0;
    const addons = row[15] || '';
    const totalWeight = parseFloat(row[16]) || 0;
    const kpi = parseFloat(row[17]) || 0;

    if (!otin) continue;

    autoOTINs.add(otin);
    autoTotalKPI += kpi;

    autoByOTIN[otin] = {
        dclc: dclc,
        addons: addons,
        totalWeight: totalWeight,
        kpi: kpi
    };
}

console.log('AUTOMATED V6 REPORT:');
console.log(`  Total records: ${autoData.length - 1}`);
console.log(`  Unique OTINs: ${autoOTINs.size}`);
console.log(`  Total KPI: ${autoTotalKPI.toFixed(2)}`);
console.log('');

console.log('='.repeat(80));
console.log('GAP ANALYSIS');
console.log('='.repeat(80));
console.log('');

const gap = manualTotalKPI - autoTotalKPI;
const gapPct = (gap / manualTotalKPI * 100);

console.log(`KPI Gap: ${gap.toFixed(2)} (${gapPct.toFixed(1)}%)`);
console.log(`OTIN Count Difference: ${manualOTINs.size} (manual) vs ${autoOTINs.size} (automated)`);
console.log('');

// Find OTINs in manual but not in automated
const manualOnly = Array.from(manualOTINs).filter(otin => !autoOTINs.has(otin));
const autoOnly = Array.from(autoOTINs).filter(otin => !manualOTINs.has(otin));

console.log('='.repeat(80));
console.log('OTINs IN MANUAL BUT NOT IN AUTOMATED');
console.log('='.repeat(80));
console.log('');

if (manualOnly.length > 0) {
    console.log(`Count: ${manualOnly.length}`);
    console.log('');
    console.log('OTIN       | DC/LC | Tier | Weight | KPI    | Notes');
    console.log('-----------+-------+------+--------+--------+----------------------');

    let lostKPI = 0;
    manualOnly.forEach(otin => {
        const m = manualByOTIN[otin];
        lostKPI += m.kpi;
        console.log(`${otin.padEnd(10)} | ${String(m.dclc).padStart(5)} | ${m.tier.padEnd(4)} | ${m.weight.toFixed(2).padStart(6)} | ${m.kpi.toFixed(2).padStart(6)} | Likely April 30 pick`);
    });

    console.log('');
    console.log(`Total KPI lost from missing OTINs: ${lostKPI.toFixed(2)}`);
} else {
    console.log('None - all manual OTINs are in automated');
}

console.log('');
console.log('='.repeat(80));
console.log('OTINs IN AUTOMATED BUT NOT IN MANUAL');
console.log('='.repeat(80));
console.log('');

if (autoOnly.length > 0) {
    console.log(`Count: ${autoOnly.length}`);
    console.log('');
    console.log('OTIN       | DC/LC | Addons                  | Weight | KPI');
    console.log('-----------+-------+-------------------------+--------+--------');

    let extraKPI = 0;
    autoOnly.slice(0, 20).forEach(otin => {
        const a = autoByOTIN[otin];
        extraKPI += a.kpi;
        console.log(`${otin.padEnd(10)} | ${String(a.dclc).padStart(5)} | ${(a.addons || '').substring(0, 23).padEnd(23)} | ${a.totalWeight.toFixed(2).padStart(6)} | ${a.kpi.toFixed(2).padStart(6)}`);
    });

    if (autoOnly.length > 20) {
        console.log(`... and ${autoOnly.length - 20} more`);
    }

    console.log('');
    console.log(`Total KPI from extra OTINs: ${extraKPI.toFixed(2)}`);
} else {
    console.log('None - all automated OTINs are in manual');
}

console.log('');
console.log('='.repeat(80));
console.log('DC/LC COUNT DIFFERENCES (COMMON OTINs)');
console.log('='.repeat(80));
console.log('');

const commonOTINs = Array.from(manualOTINs).filter(otin => autoOTINs.has(otin));
console.log(`Common OTINs: ${commonOTINs.length}`);
console.log('');

let dclcMismatchCount = 0;
const dclcMismatches = [];

commonOTINs.forEach(otin => {
    const m = manualByOTIN[otin];
    const a = autoByOTIN[otin];

    if (m.dclc !== a.dclc) {
        dclcMismatchCount++;
        dclcMismatches.push({
            otin: otin,
            manualDCLC: m.dclc,
            autoDCLC: a.dclc,
            diff: m.dclc - a.dclc,
            manualKPI: m.kpi,
            autoKPI: a.kpi,
            kpiDiff: m.kpi - a.kpi
        });
    }
});

console.log(`OTINs with DC/LC differences: ${dclcMismatchCount} (${(dclcMismatchCount / commonOTINs.length * 100).toFixed(1)}%)`);

if (dclcMismatchCount > 0) {
    console.log('');
    console.log('Top 10 by KPI impact:');
    console.log('OTIN       | Manual DC/LC | Auto DC/LC | Diff | Manual KPI | Auto KPI | KPI Diff');
    console.log('-----------+--------------+------------+------+------------+----------+---------');

    dclcMismatches.sort((a, b) => Math.abs(b.kpiDiff) - Math.abs(a.kpiDiff))
                  .slice(0, 10)
                  .forEach(item => {
        console.log(`${item.otin.padEnd(10)} | ${String(item.manualDCLC).padStart(12)} | ${String(item.autoDCLC).padStart(10)} | ${String(item.diff).padStart(4)} | ${item.manualKPI.toFixed(2).padStart(10)} | ${item.autoKPI.toFixed(2).padStart(8)} | ${item.kpiDiff.toFixed(2).padStart(8)}`);
    });

    const totalDCLCImpact = dclcMismatches.reduce((sum, item) => sum + item.kpiDiff, 0);
    console.log('');
    console.log(`Total KPI impact from DC/LC differences: ${totalDCLCImpact.toFixed(2)}`);
}

console.log('');
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log('');

console.log('Gap Breakdown (estimated):');
console.log(`  Missing OTINs (likely April 30): ${(manualOnly.length > 0 ? manualOnly.reduce((sum, otin) => sum + manualByOTIN[otin].kpi, 0) : 0).toFixed(2)}`);
console.log(`  Extra OTINs in automated: -${(autoOnly.length > 0 ? autoOnly.reduce((sum, otin) => sum + autoByOTIN[otin].kpi, 0) : 0).toFixed(2)}`);
console.log(`  DC/LC count differences: ${(dclcMismatches.length > 0 ? dclcMismatches.reduce((sum, item) => sum + item.kpiDiff, 0) : 0).toFixed(2)}`);
console.log('');

const expectedGap = (manualOnly.length > 0 ? manualOnly.reduce((sum, otin) => sum + manualByOTIN[otin].kpi, 0) : 0)
                  - (autoOnly.length > 0 ? autoOnly.reduce((sum, otin) => sum + autoByOTIN[otin].kpi, 0) : 0)
                  + (dclcMismatches.length > 0 ? dclcMismatches.reduce((sum, item) => sum + item.kpiDiff, 0) : 0);

console.log(`Expected total gap: ${expectedGap.toFixed(2)}`);
console.log(`Actual gap: ${gap.toFixed(2)}`);
console.log(`Unexplained difference: ${(gap - expectedGap).toFixed(2)}`);
console.log('');

console.log('NEXT STEPS:');
console.log('1. Review missing OTINs - should April 30 picks be included?');
console.log('2. Investigate DC/LC count calculation differences');
console.log('3. If acceptable, replace v5 with v6 as the official automated report');
