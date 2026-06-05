const { spawnSync } = require('child_process');
const fs = require('fs');
const XLSX = require('xlsx');

// Configuration
const AUSTIN_INSPECTORS = [
    'Jacob DeWit',
    'Daisy Mendoza',
    'Ofelio Martinez',
    'Juan Serrano',
    'Jacob Palmertree',
    'Sharanya Sarkar'
];

const REPORT_MONTH = process.argv[2] || new Date().toISOString().slice(0, 7);
const START_DATE = `${REPORT_MONTH}-01`;
const [year, month] = REPORT_MONTH.split('-').map(Number);
const nextMonth = month === 12 ? 1 : month + 1;
const nextYear = month === 12 ? year + 1 : year;
const END_DATE = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

// Include last day of previous month (e.g., April 30 for May report)
const prevMonth = month === 1 ? 12 : month - 1;
const prevYear = month === 1 ? year - 1 : year;
const prevMonthDays = new Date(year, month - 1, 0).getDate(); // Last day of previous month
const PREV_MONTH_LAST_DAY = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${prevMonthDays}`;

const MI_KPI_TARGET_PER_INSPECTOR = 90;

// Base tier weights ONLY (no add-ons) - FLAT WEIGHTS matching manual methodology
// Manual uses flat Tier 1 = 1.0 for ALL T1 types (not differentiated)
const BASE_TIER_WEIGHTS = {
    'Tier 1 Passive Inspection': 1.0,   // Flat (manual uses 1.0, not 0.75)
    'Tier 1 Active Inspection': 1.0,
    'Tier 1 Inspection': 1.0,
    'MASTER OTIN reference': 1.0,       // Flat (manual uses 1.0, not 0.5)
    'Tier 2 Inspection': 2.0,
    'Tier 3 Inspection': 3.0,
    'AS6171': 4.0
};

const TIER_CODES = {
    'Tier 1 Passive Inspection': 'T1-P',
    'Tier 1 Active Inspection': 'T1-A',
    'Tier 1 Inspection': 'T1',
    'MASTER OTIN reference': 'T1-M',
    'Tier 2 Inspection': 'T2',
    'Tier 3 Inspection': 'T3',
    'AS6171': 'T4'
};

const SHORT_NAMES = {
    'Jacob DeWit': 'JACOB D.',
    'Daisy Mendoza': 'DAISY M.',
    'Ofelio Martinez': 'OFELIO M.',
    'Juan Serrano': 'JUAN S.',
    'Jacob Palmertree': 'JACOB P.',
    'Sharanya Sarkar': 'SHARANYA S.'
};

function runQuery(query) {
    const result = spawnSync('psql', ['-t', '-A', '-F\t', '-c', query], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.error) throw result.error;
    const output = result.stdout || '';
    return output.trim().split('\n').filter(l => l.trim() && !l.startsWith('SET'));
}

console.log('Generating Manual Method Report for ' + REPORT_MONTH + '...\n');

// Query: Get each OTIN-INSPECTION combination as a SEPARATE LINE
// This matches manual methodology where each base tier inspection record is a separate line
// NOTE: This query shows each inspection TYPE per OTIN, not each pick session
// So OTINs with multiple base tier types (rare) will appear multiple times
const query = `
WITH austin_inspectors AS (
    SELECT ad_user_id, name FROM adempiere.ad_user
    WHERE name IN ('Jacob DeWit', 'Daisy Mendoza', 'Ofelio Martinez', 'Juan Serrano', 'Jacob Palmertree', 'Sharanya Sarkar')
),
-- Get first pick per OTIN-inspection combination
first_pick_per_inspection AS (
    SELECT DISTINCT ON (v.chuboe_insp_lot_id, lnk.chuboe_insp_id)
        pick.chuboe_insp_lot_id,
        lnk.chuboe_insp_id,
        pick.startdate AS pick_date,
        u.name AS inspector,
        CASE
            WHEN pick.startdate < '${START_DATE}' THEN 'PREV_MONTH'
            ELSE 'CURRENT_MONTH'
        END AS month_flag
    FROM adempiere.chuboe_po_userpick pick
    JOIN austin_inspectors u ON pick.chuboe_po_pickeduser_id = u.ad_user_id
    JOIN adempiere.chuboe_insp_mpnlot_v v ON pick.chuboe_insp_lot_id = v.chuboe_insp_lot_id
    JOIN adempiere.chuboe_insp_lot_lnk lnk ON v.chuboe_insp_lot_id = lnk.chuboe_insp_lot_id
    WHERE pick.startdate >= '${PREV_MONTH_LAST_DAY}' AND pick.startdate < '${END_DATE}'
      AND pick.isactive = 'Y'
      AND lnk.isactive = 'Y'
    ORDER BY v.chuboe_insp_lot_id, lnk.chuboe_insp_id, pick.startdate
),
datelot_agg AS (
    SELECT
        chuboe_insp_lot_id,
        chuboe_insp_id,
        CASE
            WHEN COUNT(DISTINCT NULLIF(lotcode, '')) > 0
            THEN COUNT(DISTINCT NULLIF(lotcode, ''))
            ELSE COALESCE(COUNT(DISTINCT NULLIF(datecode, '')), 0)
        END AS dclc_count
    FROM adempiere.chuboe_insp_datelotcode
    WHERE isactive = 'Y'
    GROUP BY chuboe_insp_lot_id, chuboe_insp_id
)
SELECT
    v.chuboe_otin_search AS otin,
    TO_CHAR(fp.pick_date, 'YYYY-MM-DD') AS pick_date,
    fp.inspector,
    fp.month_flag,
    i.name AS inspection_tier,
    COALESCE(da.dclc_count, 0) AS dclc_count,
    CASE
        -- FLAT WEIGHTS: All Tier 1 types = 1.0 (matches manual methodology)
        WHEN i.name IN ('Tier 1 Passive Inspection', 'Tier 1 Active Inspection',
                        'Tier 1 Inspection', 'MASTER OTIN reference') THEN 1.0
        WHEN i.name = 'Tier 2 Inspection' THEN 2.0
        WHEN i.name = 'Tier 3 Inspection' THEN 3.0
        WHEN i.name = 'AS6171' THEN 4.0
        ELSE 0
    END AS tier_weight,
    COALESCE(da.dclc_count, 0) * CASE
        -- FLAT WEIGHTS: All Tier 1 types = 1.0 (matches manual methodology)
        WHEN i.name IN ('Tier 1 Passive Inspection', 'Tier 1 Active Inspection',
                        'Tier 1 Inspection', 'MASTER OTIN reference') THEN 1.0
        WHEN i.name = 'Tier 2 Inspection' THEN 2.0
        WHEN i.name = 'Tier 3 Inspection' THEN 3.0
        WHEN i.name = 'AS6171' THEN 4.0
        ELSE 0
    END AS kpi_score
FROM first_pick_per_inspection fp
JOIN adempiere.chuboe_insp_mpnlot_v v ON fp.chuboe_insp_lot_id = v.chuboe_insp_lot_id
JOIN adempiere.chuboe_insp i ON fp.chuboe_insp_id = i.chuboe_insp_id
LEFT JOIN datelot_agg da ON fp.chuboe_insp_lot_id = da.chuboe_insp_lot_id
                          AND fp.chuboe_insp_id = da.chuboe_insp_id
WHERE i.name IN ('Tier 1 Passive Inspection', 'Tier 1 Active Inspection', 'Tier 1 Inspection',
                 'MASTER OTIN reference', 'Tier 2 Inspection', 'Tier 3 Inspection', 'AS6171')
ORDER BY fp.pick_date, v.chuboe_otin_search;
`;

console.log('Running query...');
const results = runQuery(query);
console.log(`Found ${results.length} inspection records\n`);

// Parse results
const inspectionRecords = [];
const uniqueOTINs = new Set();
let totalKPI = 0;
let prevMonthCount = 0;
let prevMonthKPI = 0;
const tierCounts = { 'T1-P': 0, 'T1-A': 0, 'T1': 0, 'T1-M': 0, 'T2': 0, 'T3': 0, 'T4': 0 };

results.forEach(line => {
    const [otin, pickDate, inspector, monthFlag, tier, dclc, weight, kpi] = line.split('\t');

    uniqueOTINs.add(otin);
    totalKPI += parseFloat(kpi);

    if (monthFlag === 'PREV_MONTH') {
        prevMonthCount++;
        prevMonthKPI += parseFloat(kpi);
    }

    const tierCode = TIER_CODES[tier] || tier;
    if (tierCounts[tierCode] !== undefined) {
        tierCounts[tierCode]++;
    }

    inspectionRecords.push({
        otin,
        pickDate,
        inspector,
        monthFlag,
        tier,
        tierCode,
        dclc: parseInt(dclc),
        weight: parseFloat(weight),
        kpi: parseFloat(kpi)
    });
});

console.log('Summary:');
console.log(`  Total inspection records (lines): ${inspectionRecords.length}`);
console.log(`  Unique OTINs: ${uniqueOTINs.size}`);
console.log(`  Total KPI: ${totalKPI.toFixed(2)}`);
console.log('');
console.log(`  Records from previous month last day: ${prevMonthCount}`);
console.log(`  KPI from previous month picks: ${prevMonthKPI.toFixed(2)}`);
console.log('');
console.log('Tier breakdown (line counts):');
Object.entries(tierCounts).forEach(([tier, count]) => {
    console.log(`  ${tier}: ${count}`);
});
console.log('');

// Create Excel workbook
const wb = XLSX.utils.book_new();

// Sheet 1: Inspection Log (line-by-line)
const logSheet = [
    [''],
    ['', '', '', 'MI KPI REPORT - MANUAL METHODOLOGY'],
    [''],
    ['', 'Site:', 'Austin (ATX)', '', '', 'Report Period:', `${REPORT_MONTH}`],
    ['', 'Methodology:', 'Line-by-line (non-distinct OTINs)', '', '', 'Generated:', new Date().toISOString().split('T')[0]],
    [''],
    ['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════'],
    ['', '', '', '', '', 'INSPECTION LOG (EACH RECORD AS SEPARATE LINE)'],
    ['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════'],
    [''],
    ['', 'OTIN', 'Pick Date', 'Inspector', 'Tier', 'DC/LC Count', 'Tier Weight', 'KPI Score', 'Note']
];

inspectionRecords.forEach(rec => {
    const note = rec.monthFlag === 'PREV_MONTH' ? 'Prev Month Pick' : '';
    logSheet.push([
        '',
        rec.otin,
        rec.pickDate,
        rec.inspector,
        rec.tierCode,
        rec.dclc,
        rec.weight,
        rec.kpi,
        note
    ]);
});

// Add totals
logSheet.push(['']);
logSheet.push(['', '───────────────────────────────────────────────────────────────────────────────────────────────────────────']);
logSheet.push(['', 'TOTALS', '', '', '', '', '', totalKPI.toFixed(2), '']);
logSheet.push(['']);
logSheet.push(['', `Total Inspection Records: ${inspectionRecords.length}`]);
logSheet.push(['', `Unique OTINs: ${uniqueOTINs.size}`]);
logSheet.push(['']);
logSheet.push(['', `NOTE: ${prevMonthCount} records (${prevMonthKPI.toFixed(2)} KPI) were picked on the last day of previous month`]);
logSheet.push(['', `      and are included in this report per manual tracker methodology.`]);

const ws1 = XLSX.utils.aoa_to_sheet(logSheet);
ws1['!cols'] = [
    { wch: 3 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 }
];
XLSX.utils.book_append_sheet(wb, ws1, 'Inspection Log');

// Sheet 2: Summary by Tier
const summarySheet = [
    [''],
    ['', '', '', 'SUMMARY BY TIER'],
    [''],
    ['', 'Tier', 'Line Count', 'Weight', 'Total KPI'],
    ['']
];

let summaryTotal = 0;
Object.entries(tierCounts).forEach(([tier, count]) => {
    const weight = Object.entries(TIER_CODES).find(([name, code]) => code === tier)?.[0];
    const tierWeight = BASE_TIER_WEIGHTS[weight] || 0;

    // Calculate total KPI for this tier from inspection records
    const tierKPI = inspectionRecords
        .filter(rec => rec.tierCode === tier)
        .reduce((sum, rec) => sum + rec.kpi, 0);

    summaryTotal += tierKPI;

    summarySheet.push([
        '',
        tier,
        count,
        tierWeight,
        tierKPI.toFixed(2)
    ]);
});

summarySheet.push(['']);
summarySheet.push(['', '───────────────────────────────────────']);
summarySheet.push(['', 'TOTAL', inspectionRecords.length, '', summaryTotal.toFixed(2)]);

const ws2 = XLSX.utils.aoa_to_sheet(summarySheet);
ws2['!cols'] = [
    { wch: 3 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
];
XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

// Sheet 3: Methodology Notes
const notesSheet = [
    ['METHODOLOGY NOTES - MANUAL METHOD REPLICATION'],
    [''],
    ['This report replicates the current manual tracking methodology used by the MI Manager.'],
    [''],
    ['═'.repeat(80)],
    ['COUNTING METHODOLOGY'],
    ['═'.repeat(80)],
    [''],
    ['Line-by-Line Counting (Non-Distinct OTINs):'],
    ['  - Each inspection record is counted as a SEPARATE LINE'],
    ['  - If an OTIN has multiple inspection types, it appears on multiple lines'],
    ['  - Total line count may exceed unique OTIN count'],
    [''],
    ['Example:'],
    ['  OTIN 1234567 with Tier 2 + Tier 3 appears as:'],
    ['    Line 1: OTIN 1234567, Tier 2, KPI = X'],
    ['    Line 2: OTIN 1234567, Tier 3, KPI = Y'],
    ['  Total lines: 2'],
    ['  Unique OTINs: 1'],
    [''],
    ['═'.repeat(80)],
    ['WEIGHT CALCULATION'],
    ['═'.repeat(80)],
    [''],
    ['Base Tier Weights ONLY (No Additional Inspections):'],
    ['  - FLAT WEIGHTS (manual methodology):'],
    ['  - All Tier 1 types (T1-P, T1-A, T1, T1-M): 1.00'],
    ['  - Tier 2 (T2): 2.00'],
    ['  - Tier 3 (T3): 3.00'],
    ['  - Tier 4/AS6171 (T4): 4.00'],
    [''],
    ['  NOTE: Manual tracker uses FLAT Tier 1 = 1.0 for all T1 types'],
    ['        (Not differentiated like the inspection weight chart)'],
    [''],
    ['Additional Inspections NOT INCLUDED:'],
    ['  - Decapsulation, Solderability, SEM, Scrape, etc. are NOT counted'],
    ['  - This matches the current manual tracker methodology'],
    [''],
    ['═'.repeat(80)],
    ['KPI FORMULA'],
    ['═'.repeat(80)],
    [''],
    ['Formula per line: KPI = DC/LC Count × Base Tier Weight'],
    [''],
    ['Example:'],
    ['  OTIN with 3 DC/LC, Tier 2:'],
    ['  KPI = 3 × 2.0 = 6.0'],
    [''],
    ['═'.repeat(80)],
    ['COMPARISON TO MANUAL TRACKER'],
    ['═'.repeat(80)],
    [''],
    ['Manual Tracker (MI Manager):'],
    ['  - Line items ("OTINs"): 190'],
    ['  - Total KPI: 590.00'],
    [''],
    ['Automated Replication:'],
    [`  - Line items: ${inspectionRecords.length}`],
    [`  - Unique OTINs: ${uniqueOTINs.size}`],
    [`  - Total KPI: ${totalKPI.toFixed(2)}`],
    [''],
    ['Match Status:'],
    [`  - Line count difference: ${Math.abs(190 - inspectionRecords.length)}`],
    [`  - KPI difference: ${Math.abs(590 - totalKPI).toFixed(2)}`],
    [''],
    ['═'.repeat(80)],
    ['DATE RANGE'],
    ['═'.repeat(80)],
    [''],
    [`Report period: ${START_DATE} to ${END_DATE} (exclusive)`],
    ['Attribution method: First pick date in month'],
    [''],
    ['Note: OTINs picked on the last day of previous month may be excluded'],
    ['from this report based on pick date filtering.'],
    [''],
    ['═'.repeat(80)],
    ['NEXT STEPS'],
    ['═'.repeat(80)],
    [''],
    ['This report validates that the automated system can replicate the manual'],
    ['methodology. The next phase will implement the NEW methodology:'],
    [''],
    ['  1. Distinct OTIN counting (each OTIN counted once)'],
    ['  2. Additional Inspection weights included (+0.2 each)'],
    ['  3. Aggregated inspection weights per OTIN'],
    [''],
    ['See "MI KPI Report v6" for the new methodology implementation.']
];

const ws3 = XLSX.utils.aoa_to_sheet(notesSheet);
ws3['!cols'] = [{ wch: 100 }];
XLSX.utils.book_append_sheet(wb, ws3, 'Methodology Notes');

// Write file
const filename = `/home/melissa.bojar/workspace/MI KPIs/mi_kpi_report_${REPORT_MONTH}_MANUAL_METHOD.xlsx`;
XLSX.writeFile(wb, filename);

console.log('='.repeat(60));
console.log('REPORT GENERATED: ' + filename);
console.log('='.repeat(60));
console.log('');
console.log('METHODOLOGY: Manual Method Replication');
console.log('  - Line-by-line counting (non-distinct OTINs)');
console.log('  - Base tier weights only (no add-ons)');
console.log('  - Formula: KPI = DC/LC × Base Weight');
console.log('');
console.log('RESULTS:');
console.log(`  Total inspection records: ${inspectionRecords.length}`);
console.log(`  Unique OTINs: ${uniqueOTINs.size}`);
console.log(`  Total KPI: ${totalKPI.toFixed(2)}`);
console.log('');
console.log('COMPARISON TO MANUAL TRACKER:');
console.log(`  Manual line items: 190`);
console.log(`  Automated line items: ${inspectionRecords.length}`);
console.log(`  Difference: ${Math.abs(190 - inspectionRecords.length)}`);
console.log('');
console.log(`  Manual KPI: 590.00`);
console.log(`  Automated KPI: ${totalKPI.toFixed(2)}`);
console.log(`  Difference: ${Math.abs(590 - totalKPI).toFixed(2)}`);
