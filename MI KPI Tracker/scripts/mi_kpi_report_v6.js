const { spawnSync } = require('child_process');
const fs = require('fs');
const XLSX = require('xlsx');

// Configuration
const AUSTIN_INSPECTORS = [
    'Jacob DeWit',      // JACOB D.
    'Daisy Mendoza',    // DAISY M.
    'Ofelio Martinez',  // OFELIO M.
    'Juan Serrano',     // JUAN S.
    'Jacob Palmertree', // JACOB P.
    'Sharanya Sarkar'   // SHARANYA S.
];

// Parameterized report month (like validation_date.js)
const REPORT_MONTH = process.argv[2] || new Date().toISOString().slice(0, 7); // Default to current month YYYY-MM
const START_DATE = `${REPORT_MONTH}-01`;
// Calculate END_DATE dynamically (first day of next month)
const [year, month] = REPORT_MONTH.split('-').map(Number);
const nextMonth = month === 12 ? 1 : month + 1;
const nextYear = month === 12 ? year + 1 : year;
const END_DATE = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

// Include last day of previous month (e.g., April 30 for May report)
// This matches manual tracker methodology
const prevMonth = month === 1 ? 12 : month - 1;
const prevYear = month === 1 ? year - 1 : year;
const prevMonthDays = new Date(year, month - 1, 0).getDate();
const PREV_MONTH_LAST_DAY = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${prevMonthDays}`;

// MI Target (monthly MI KPI Score target per inspector)
// Target is 90+ MI KPI Score per inspector per month (weighted score, not OTIN count)
const MI_KPI_TARGET_PER_INSPECTOR = 90;

// Tier weights from inspection weight chart (5.06.26)
// INCLUDES Additional Inspection weights (+0.2 each)
const TIER_WEIGHTS = {
    'Tier 1 Passive Inspection': 0.75,
    'Tier 1 Active Inspection': 1,
    'Tier 1 Inspection': 1,
    'MASTER OTIN reference': 0.5,
    'Tier 2 Inspection': 2,
    'Tier 3 Inspection': 3,
    'AS6171': 4,
    // Additional Inspections (+0.2 each)
    'Additional Inspection: Decapsulation': 0.2,
    'Additional Inspection: Solderability': 0.2,
    'Additional Inspection: SEM': 0.2,
    'Additional Inspection: Scrape': 0.2,
    'Additional Inspection: Destructive Sampling': 0.2,
    'Additional Inspection: Non-conforming conditions': 0.2
};

// Tier codes for display
const TIER_CODES = {
    'Tier 1 Passive Inspection': 'T1-P',
    'Tier 1 Active Inspection': 'T1-A',
    'Tier 1 Inspection': 'T1',
    'MASTER OTIN reference': 'T1-M',
    'Tier 2 Inspection': 'T2',
    'Tier 3 Inspection': 'T3',
    'AS6171': 'T4'
};

// Short names for inspector display
const SHORT_NAMES = {
    'Jacob DeWit': 'JACOB D.',
    'Daisy Mendoza': 'DAISY M.',
    'Ofelio Martinez': 'OFELIO M.',
    'Juan Serrano': 'JUAN S.',
    'Jacob Palmertree': 'JACOB P.',
    'Sharanya Sarkar': 'SHARANYA S.'
};

function runQueryFromFile(queryFile) {
    try {
        const result = spawnSync('psql', ['-t', '-A', '-F\t', '-f', queryFile], { encoding: 'utf-8' });
        if (result.error) throw result.error;
        const output = result.stdout || '';
        const lines = output.trim().split('\n').filter(l => l.trim() && !l.startsWith('SET'));
        return lines.map(line => line.split('\t'));
    } catch (e) {
        console.error('Query error:', e.message);
        return [];
    }
}

// Write queries to temp files
const queryDir = '/home/melissa.bojar/workspace/MI KPIs/queries';
if (!fs.existsSync(queryDir)) fs.mkdirSync(queryDir, { recursive: true });

// =============================================================================
// QUERY 1: Main inspection data with AGGREGATED inspection weights per OTIN
// INCLUDES base tiers + Additional Inspections
// NO DSQR LOGIC
// =============================================================================
const mainQuery = `
WITH austin_inspectors AS (
    SELECT ad_user_id, name FROM adempiere.ad_user
    WHERE name IN ('Jacob DeWit', 'Daisy Mendoza', 'Ofelio Martinez', 'Juan Serrano', 'Jacob Palmertree', 'Sharanya Sarkar')
),
-- Get all picks for Austin inspectors in date range (includes last day of prev month)
all_picks AS (
    SELECT
        pick.chuboe_po_userpick_id,
        pick.chuboe_insp_lot_id,
        pick.startdate AS pick_date,
        pick.enddate AS pick_end,
        u.name AS inspector,
        u.ad_user_id,
        CASE
            WHEN pick.startdate < '${START_DATE}' THEN true
            ELSE false
        END AS from_prev_month
    FROM adempiere.chuboe_po_userpick pick
    JOIN austin_inspectors u ON pick.chuboe_po_pickeduser_id = u.ad_user_id
    WHERE pick.startdate >= '${PREV_MONTH_LAST_DAY}' AND pick.startdate < '${END_DATE}'
      AND pick.isactive = 'Y'
),
-- AGGREGATE ALL inspection weights per OTIN (base tiers + Additional Inspections)
inspection_weights_agg AS (
    SELECT
        v.chuboe_insp_lot_id,
        SUM(CASE
            WHEN i.name = 'Tier 1 Passive Inspection' THEN 0.75
            WHEN i.name = 'Tier 1 Active Inspection' THEN 1.0
            WHEN i.name = 'Tier 1 Inspection' THEN 1.0
            WHEN i.name = 'MASTER OTIN reference' THEN 0.5
            WHEN i.name = 'Tier 2 Inspection' THEN 2.0
            WHEN i.name = 'Tier 3 Inspection' THEN 3.0
            WHEN i.name = 'AS6171' THEN 4.0
            WHEN i.name LIKE '%Decapsulation%' THEN 0.2
            WHEN i.name LIKE '%Solderability%' THEN 0.2
            WHEN i.name LIKE '%SEM%' THEN 0.2
            WHEN i.name LIKE '%Scrape%' THEN 0.2
            WHEN i.name LIKE '%Destructive Sampling%' THEN 0.2
            WHEN i.name LIKE '%Non-conforming%' THEN 0.2
            ELSE 0
        END) AS total_weight_per_otin,
        -- Keep base tier for display purposes (highest weight tier)
        (ARRAY_AGG(i.name ORDER BY CASE
            WHEN i.name = 'AS6171' THEN 4
            WHEN i.name = 'Tier 3 Inspection' THEN 3
            WHEN i.name = 'Tier 2 Inspection' THEN 2
            WHEN i.name IN ('Tier 1 Active Inspection', 'Tier 1 Inspection') THEN 1
            WHEN i.name = 'Tier 1 Passive Inspection' THEN 0.75
            WHEN i.name = 'MASTER OTIN reference' THEN 0.5
            ELSE 0
        END DESC))[1] AS base_tier,
        -- Track if Additional Inspections are present
        STRING_AGG(DISTINCT
            CASE WHEN i.name LIKE 'Additional Inspection:%'
            THEN REPLACE(i.name, 'Additional Inspection: ', '')
            END, ', ') FILTER (WHERE i.name LIKE 'Additional Inspection:%') AS additional_inspections
    FROM all_picks ap
    JOIN adempiere.chuboe_insp_mpnlot_v v ON ap.chuboe_insp_lot_id = v.chuboe_insp_lot_id
    JOIN adempiere.chuboe_insp_lot_lnk lnk ON v.chuboe_insp_lot_id = lnk.chuboe_insp_lot_id
    JOIN adempiere.chuboe_insp i ON lnk.chuboe_insp_id = i.chuboe_insp_id
    WHERE lnk.isactive = 'Y'
    GROUP BY v.chuboe_insp_lot_id
),
-- Aggregate pick info per OTIN/inspection
pick_summary AS (
    SELECT
        ap.chuboe_insp_lot_id,
        COUNT(*) AS total_picks,
        COUNT(DISTINCT ap.inspector) AS inspector_count,
        COUNT(DISTINCT DATE(ap.pick_date)) AS unique_dates,
        MIN(ap.pick_date) AS first_pick,
        MAX(ap.pick_date) AS last_pick,
        STRING_AGG(DISTINCT ap.inspector, ', ' ORDER BY ap.inspector) AS all_inspectors,
        -- Same day collaboration: inspectors who worked same OTIN on same day
        (SELECT STRING_AGG(DISTINCT sub.inspector, ', ' ORDER BY sub.inspector)
         FROM all_picks sub
         WHERE sub.chuboe_insp_lot_id = ap.chuboe_insp_lot_id
           AND DATE(sub.pick_date) = DATE(MIN(ap.pick_date))
         HAVING COUNT(DISTINCT sub.inspector) > 1
        ) AS same_day_collab
    FROM all_picks ap
    GROUP BY ap.chuboe_insp_lot_id
),
-- First pick per OTIN (for unique counting and month attribution)
first_picks AS (
    SELECT DISTINCT ON (ap.chuboe_insp_lot_id)
        ap.chuboe_po_userpick_id,
        ap.chuboe_insp_lot_id,
        ap.pick_date,
        ap.pick_end,
        ap.inspector,
        ap.from_prev_month
    FROM all_picks ap
    ORDER BY ap.chuboe_insp_lot_id, ap.pick_date
),
-- Date/Lot code aggregation (across ALL inspections for this OTIN)
datelot_agg AS (
    SELECT
        dlc.chuboe_insp_lot_id,
        COUNT(DISTINCT NULLIF(dlc.lotcode, '')) AS lotcode_count,
        COUNT(DISTINCT NULLIF(dlc.datecode, '')) AS datecode_count,
        STRING_AGG(DISTINCT dlc.datecode, '; ' ORDER BY dlc.datecode) AS datecodes,
        STRING_AGG(DISTINCT dlc.lotcode, '; ' ORDER BY dlc.lotcode) AS lotcodes,
        STRING_AGG(DISTINCT dlc.coo, '; ' ORDER BY dlc.coo) AS coos
    FROM adempiere.chuboe_insp_datelotcode dlc
    JOIN inspection_weights_agg iwa ON dlc.chuboe_insp_lot_id = iwa.chuboe_insp_lot_id
    WHERE dlc.isactive = 'Y'
    GROUP BY dlc.chuboe_insp_lot_id
),
-- Current shelf location
current_shelf AS (
    SELECT DISTINCT ON (chuboe_insp_lot_id)
        chuboe_insp_lot_id,
        ws.name AS current_shelf_name
    FROM adempiere.chuboe_po_userpick pick
    JOIN adempiere.chuboe_warehouse_shelf ws ON pick.chuboe_warehouse_shelf_id = ws.chuboe_warehouse_shelf_id
    WHERE pick.isactive = 'Y'
    ORDER BY chuboe_insp_lot_id, pick.startdate DESC
),
-- Warehouse info
warehouse_info AS (
    SELECT
        v.chuboe_insp_lot_id,
        w.name AS warehouse_name
    FROM adempiere.chuboe_insp_mpnlot_v v
    JOIN adempiere.chuboe_warehouse w ON v.chuboe_warehouse_id = w.chuboe_warehouse_id
),
-- Validation info
validation_info AS (
    SELECT
        lnk.chuboe_insp_lot_id,
        MAX(CASE WHEN lnk.isvalidate = 'Y' THEN 'Y' ELSE 'N' END) AS isvalidate,
        MAX(lnk.updated) AS validation_time
    FROM adempiere.chuboe_insp_lot_lnk lnk
    JOIN inspection_weights_agg iwa ON lnk.chuboe_insp_lot_id = iwa.chuboe_insp_lot_id
    WHERE lnk.isactive = 'Y'
    GROUP BY lnk.chuboe_insp_lot_id
)
SELECT
    TO_CHAR(fp.pick_date, 'YYYY-MM-DD') AS pick_date,
    TO_CHAR(fp.pick_date, 'Dy') AS day_of_week,
    fp.inspector,
    fp.from_prev_month,
    v.chuboe_otin_search AS otin,
    iwa.base_tier AS inspection_tier,
    -- Multiple pick info
    CASE WHEN ps.total_picks > 1 THEN 'Y' ELSE 'N' END AS multiple_pick,
    ps.total_picks AS pick_count,
    CASE WHEN ps.inspector_count > 1 THEN ps.inspector_count - 1 ELSE 0 END AS handoff_count,
    -- Re-work info
    CASE WHEN ps.unique_dates > 1 THEN 'Y' ELSE 'N' END AS rework,
    CASE WHEN ps.unique_dates > 1 THEN TO_CHAR(ps.last_pick, 'YYYY-MM-DD') ELSE '' END AS rework_date,
    -- Same day collaboration
    COALESCE(ps.same_day_collab, '') AS same_day_collab,
    -- Current shelf
    COALESCE(cs.current_shelf_name, '') AS current_shelf,
    -- Warehouse
    COALESCE(wi.warehouse_name, '') AS warehouse_name,
    -- Date/Lot codes - use lotcode count if available, else datecode count
    CASE
        WHEN COALESCE(da.lotcode_count, 0) > 0 THEN da.lotcode_count
        ELSE COALESCE(da.datecode_count, 0)
    END AS dclc_count,
    COALESCE(da.datecodes, '') AS datecodes,
    COALESCE(da.lotcodes, '') AS lotcodes,
    COALESCE(da.coos, '') AS coos,
    -- Additional Inspections
    COALESCE(iwa.additional_inspections, '') AS additional_inspections,
    -- Total weight per OTIN (base + add-ons)
    COALESCE(iwa.total_weight_per_otin, 0) AS total_weight,
    -- MI KPI Score (DC/LC Count × total_weight_per_otin)
    (CASE
        WHEN COALESCE(da.lotcode_count, 0) > 0 THEN da.lotcode_count
        ELSE COALESCE(da.datecode_count, 0)
    END * COALESCE(iwa.total_weight_per_otin, 0)) AS mi_kpi_score,
    -- Times
    TO_CHAR(fp.pick_date, 'HH24:MI') AS mi_start_time,
    TO_CHAR(fp.pick_end, 'HH24:MI') AS mi_end_time,
    -- Validation
    CASE WHEN vi.isvalidate = 'Y' THEN 'Yes' ELSE 'No' END AS validated,
    TO_CHAR(vi.validation_time, 'YYYY-MM-DD HH24:MI') AS validation_time
FROM first_picks fp
JOIN adempiere.chuboe_insp_mpnlot_v v ON fp.chuboe_insp_lot_id = v.chuboe_insp_lot_id
JOIN inspection_weights_agg iwa ON fp.chuboe_insp_lot_id = iwa.chuboe_insp_lot_id
JOIN pick_summary ps ON fp.chuboe_insp_lot_id = ps.chuboe_insp_lot_id
LEFT JOIN datelot_agg da ON fp.chuboe_insp_lot_id = da.chuboe_insp_lot_id
LEFT JOIN current_shelf cs ON fp.chuboe_insp_lot_id = cs.chuboe_insp_lot_id
LEFT JOIN warehouse_info wi ON fp.chuboe_insp_lot_id = wi.chuboe_insp_lot_id
LEFT JOIN validation_info vi ON fp.chuboe_insp_lot_id = vi.chuboe_insp_lot_id
WHERE iwa.total_weight_per_otin > 0  -- Exclude OTINs with no recognized inspection types
ORDER BY fp.pick_date, fp.inspector;
`;

// =============================================================================
// QUERY 2: Summary - Attribute each OTIN to FIRST inspector only (matches manual)
// INCLUDES aggregated weights (base + Additional Inspections)
// =============================================================================
const summaryQuery = `
WITH austin_inspectors AS (
    SELECT ad_user_id, name FROM adempiere.ad_user
    WHERE name IN ('Jacob DeWit', 'Daisy Mendoza', 'Ofelio Martinez', 'Juan Serrano', 'Jacob Palmertree', 'Sharanya Sarkar')
),
-- Aggregate inspection weights per OTIN
inspection_weights_agg AS (
    SELECT
        v.chuboe_insp_lot_id,
        (ARRAY_AGG(i.name ORDER BY CASE
            WHEN i.name = 'AS6171' THEN 4
            WHEN i.name = 'Tier 3 Inspection' THEN 3
            WHEN i.name = 'Tier 2 Inspection' THEN 2
            WHEN i.name IN ('Tier 1 Active Inspection', 'Tier 1 Inspection') THEN 1
            WHEN i.name = 'Tier 1 Passive Inspection' THEN 0.75
            WHEN i.name = 'MASTER OTIN reference' THEN 0.5
            ELSE 0
        END DESC))[1] AS base_tier
    FROM adempiere.chuboe_insp_mpnlot_v v
    JOIN adempiere.chuboe_insp_lot_lnk lnk ON v.chuboe_insp_lot_id = lnk.chuboe_insp_lot_id
    JOIN adempiere.chuboe_insp i ON lnk.chuboe_insp_id = i.chuboe_insp_id
    WHERE lnk.isactive = 'Y'
    GROUP BY v.chuboe_insp_lot_id
),
-- Get first pick per OTIN (to attribute to primary inspector)
first_inspector_per_otin AS (
    SELECT DISTINCT ON (v.chuboe_otin_search)
        v.chuboe_otin_search AS otin,
        u.name AS inspector,
        iwa.base_tier AS tier,
        pick.startdate
    FROM adempiere.chuboe_po_userpick pick
    JOIN austin_inspectors u ON pick.chuboe_po_pickeduser_id = u.ad_user_id
    JOIN adempiere.chuboe_insp_mpnlot_v v ON pick.chuboe_insp_lot_id = v.chuboe_insp_lot_id
    JOIN inspection_weights_agg iwa ON v.chuboe_insp_lot_id = iwa.chuboe_insp_lot_id
    WHERE pick.startdate >= '${START_DATE}' AND pick.startdate < '${END_DATE}'
      AND pick.isactive = 'Y'
      AND iwa.base_tier IN ('Tier 1 Passive Inspection', 'Tier 1 Active Inspection', 'Tier 1 Inspection',
                            'MASTER OTIN reference', 'Tier 2 Inspection', 'Tier 3 Inspection', 'AS6171')
    ORDER BY v.chuboe_otin_search, pick.startdate
)
SELECT
    inspector,
    tier AS inspection_tier,
    COUNT(*) AS otin_count
FROM first_inspector_per_otin
GROUP BY inspector, tier
ORDER BY inspector, tier;
`;

// =============================================================================
// QUERY 3: Kickbacks
// =============================================================================
const kickbackQuery = `
WITH shelf_sequence AS (
    SELECT
        v.chuboe_otin_search,
        v.chuboe_insp_lot_id,
        ws.name AS shelf,
        pick.startdate,
        pick.description,
        LAG(ws.name) OVER (PARTITION BY v.chuboe_otin_search ORDER BY pick.startdate) AS prev_shelf
    FROM adempiere.chuboe_po_userpick pick
    JOIN adempiere.chuboe_insp_mpnlot_v v ON pick.chuboe_insp_lot_id = v.chuboe_insp_lot_id
    JOIN adempiere.chuboe_warehouse_shelf ws ON pick.chuboe_warehouse_shelf_id = ws.chuboe_warehouse_shelf_id
    WHERE pick.startdate >= '${START_DATE}' AND pick.startdate < '${END_DATE}'
      AND pick.isactive = 'Y'
)
SELECT
    chuboe_otin_search AS otin,
    prev_shelf AS from_shelf,
    'MI QUEUE' AS to_shelf,
    TO_CHAR(startdate, 'YYYY-MM-DD') AS kickback_date,
    COALESCE(description, 'No reason logged') AS kickback_reason,
    CASE
        WHEN prev_shelf = 'SHIPPING QUEUE' THEN 'SHIPPING'
        WHEN prev_shelf = 'QI QUEUE' THEN 'QI'
        WHEN prev_shelf = 'LOGISTICS SHIPPING HOLD' THEN 'LSH'
        ELSE 'OTHER'
    END AS kickback_type
FROM shelf_sequence
WHERE prev_shelf IN ('SHIPPING QUEUE', 'QI QUEUE', 'LOGISTICS SHIPPING HOLD')
  AND shelf = 'MI QUEUE'
ORDER BY startdate;
`;

// =============================================================================
// QUERY 4: Service sends
// =============================================================================
const serviceQuery = `
SELECT
    v.chuboe_otin_search AS otin,
    TO_CHAR(pick.startdate, 'YYYY-MM-DD') AS service_out_date,
    TO_CHAR(pick.enddate, 'YYYY-MM-DD') AS service_return_date,
    CASE WHEN pick.enddate IS NOT NULL
         THEN EXTRACT(DAY FROM (pick.enddate - pick.startdate))::int
         ELSE NULL END AS days_at_service,
    COALESCE(pick.description, '') AS service_notes
FROM adempiere.chuboe_po_userpick pick
JOIN adempiere.chuboe_insp_mpnlot_v v ON pick.chuboe_insp_lot_id = v.chuboe_insp_lot_id
JOIN adempiere.chuboe_warehouse_shelf ws ON pick.chuboe_warehouse_shelf_id = ws.chuboe_warehouse_shelf_id
WHERE ws.name = 'OUT TO SERVICE'
  AND pick.startdate >= '${START_DATE}' AND pick.startdate < '${END_DATE}'
  AND pick.isactive = 'Y'
ORDER BY pick.startdate;
`;

// Write queries to files
fs.writeFileSync(`${queryDir}/main_v6.sql`, mainQuery);
fs.writeFileSync(`${queryDir}/summary_v6.sql`, summaryQuery);
fs.writeFileSync(`${queryDir}/kickback.sql`, kickbackQuery);
fs.writeFileSync(`${queryDir}/service.sql`, serviceQuery);

// =============================================================================
// RUN QUERIES
// =============================================================================
console.log('Running MI KPI Report v6 (with Additional Inspections) for ' + REPORT_MONTH + '...\n');

console.log('Query 1: Main inspection data (base + Additional Inspections)...');
const mainData = runQueryFromFile(`${queryDir}/main_v6.sql`);
console.log(`  Found ${mainData.length} unique inspection records`);

console.log('Query 2: Summary (COUNT DISTINCT methodology)...');
const summaryData = runQueryFromFile(`${queryDir}/summary_v6.sql`);
console.log(`  Found ${summaryData.length} summary rows`);

console.log('Query 3: Kickback analysis...');
const kickbackData = runQueryFromFile(`${queryDir}/kickback.sql`);
console.log(`  Found ${kickbackData.length} kickbacks`);

console.log('Query 4: Service sends...');
const serviceData = runQueryFromFile(`${queryDir}/service.sql`);
console.log(`  Found ${serviceData.length} service sends\n`);

// =============================================================================
// BUILD EXCEL WORKBOOK
// =============================================================================
const wb = XLSX.utils.book_new();

// -----------------------------------------------------------------------------
// Sheet 1: Summary by Inspector (using actual KPI scores from Inspection Log)
// -----------------------------------------------------------------------------
const summaryByInspector = {};
AUSTIN_INSPECTORS.forEach(insp => {
    summaryByInspector[insp] = { 'T1-P': 0, 'T1-A': 0, 'T1': 0, 'T1-M': 0, 'T2': 0, 'T3': 0, 'T4': 0, totalOtins: 0, weightedScore: 0 };
});

// Count OTINs per inspector/tier from summaryData
summaryData.forEach(row => {
    const [inspector, tier, count] = row;
    const tierCode = TIER_CODES[tier] || 'Other';
    const cnt = parseInt(count) || 0;

    if (summaryByInspector[inspector] && tierCode !== 'Other') {
        summaryByInspector[inspector][tierCode] = cnt;
        summaryByInspector[inspector].totalOtins += cnt;
    }
});

// Calculate weighted scores by summing actual KPI scores from mainData
mainData.forEach(row => {
    const inspector = row[2];  // Inspector column
    const miKpiScore = parseFloat(row[20]) || 0;  // MI KPI Score column (0-indexed from SQL result, shifted by from_prev_month flag)

    if (summaryByInspector[inspector]) {
        summaryByInspector[inspector].weightedScore += miKpiScore;
    }
});

const summarySheet = [
    [''],
    ['', '', '', 'MI KPI PERFORMANCE REPORT'],
    [''],
    ['', 'Site:', 'Austin (ATX)', '', '', 'Report Period:', `${REPORT_MONTH}`],
    ['', 'MI KPI Target:', `${MI_KPI_TARGET_PER_INSPECTOR}+ per inspector`, '', '', 'Generated:', new Date().toISOString().split('T')[0]],
    [''],
    ['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════'],
    ['', '', '', '', '', 'INSPECTOR PERFORMANCE SUMMARY'],
    ['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════'],
    [''],
    ['', 'Inspector', 'Short Name', 'T1-P', 'T1-A', 'T1', 'T1-M', 'T2', 'T3', 'T4', 'Total OTINs', 'MI KPI Score', 'Target', '% Target', 'Status']
];

let totalT1P = 0, totalT1A = 0, totalT1 = 0, totalT1M = 0, totalT2 = 0, totalT3 = 0, totalT4 = 0, totalOtins = 0, totalScore = 0;

AUSTIN_INSPECTORS.forEach(insp => {
    const s = summaryByInspector[insp];
    const pctOfTargetNum = (s.weightedScore / MI_KPI_TARGET_PER_INSPECTOR) * 100;
    const pctOfTarget = pctOfTargetNum.toFixed(1) + '%';
    const status = pctOfTargetNum >= 100 ? 'ACHIEVED' : pctOfTargetNum >= 75 ? 'ON TRACK' : 'BELOW TARGET';
    summarySheet.push([
        '', insp, SHORT_NAMES[insp] || '', s['T1-P'], s['T1-A'], s['T1'], s['T1-M'], s['T2'], s['T3'], s['T4'],
        s.totalOtins, s.weightedScore.toFixed(2), MI_KPI_TARGET_PER_INSPECTOR, pctOfTarget, status
    ]);
    totalT1P += s['T1-P'];
    totalT1A += s['T1-A'];
    totalT1 += s['T1'];
    totalT1M += s['T1-M'];
    totalT2 += s['T2'];
    totalT3 += s['T3'];
    totalT4 += s['T4'];
    totalOtins += s.totalOtins;
    totalScore += s.weightedScore;
});

// Add separator and total row
summarySheet.push(['', '───────────────────────────────────────────────────────────────────────────────────────────────────────────']);
const avgPctOfTargetNum = (totalScore / AUSTIN_INSPECTORS.length / MI_KPI_TARGET_PER_INSPECTOR) * 100;
const avgPctOfTarget = avgPctOfTargetNum.toFixed(1) + '%';
const teamStatus = avgPctOfTargetNum >= 100 ? 'ACHIEVED' : avgPctOfTargetNum >= 75 ? 'ON TRACK' : 'BELOW TARGET';
summarySheet.push(['', 'TEAM TOTAL', '', totalT1P, totalT1A, totalT1, totalT1M, totalT2, totalT3, totalT4, totalOtins, totalScore.toFixed(2), `${MI_KPI_TARGET_PER_INSPECTOR}×6`, avgPctOfTarget, teamStatus]);

summarySheet.push(['']);
summarySheet.push(['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════']);
summarySheet.push(['', '', '', '', '', 'TIER WEIGHT REFERENCE']);
summarySheet.push(['', '═══════════════════════════════════════════════════════════════════════════════════════════════════════════']);
summarySheet.push(['']);
summarySheet.push(['', 'Tier', 'Weight', '', 'Description']);
summarySheet.push(['', 'T1-P (Passive)', '0.75', '', 'Tier 1 Passive Inspection']);
summarySheet.push(['', 'T1-A (Active)', '1.00', '', 'Tier 1 Active Inspection']);
summarySheet.push(['', 'T1', '1.00', '', 'Tier 1 Inspection']);
summarySheet.push(['', 'T1-M (Master)', '0.50', '', 'Master OTIN Reference']);
summarySheet.push(['', 'T2', '2.00', '', 'Tier 2 Inspection']);
summarySheet.push(['', 'T3', '3.00', '', 'Tier 3 Inspection']);
summarySheet.push(['', 'T4 (AS6171)', '4.00', '', 'AS6171 Inspection']);
summarySheet.push(['', 'Add-ons', '+0.20 each', '', 'Decap, Solder, SEM, Scrape, etc.']);

summarySheet.push(['']);
summarySheet.push(['', 'MI KPI Score Formula: DC/LC Count × (Base Tier Weight + Sum of Additional Inspections)']);

const ws1 = XLSX.utils.aoa_to_sheet(summarySheet);
ws1['!cols'] = [
    { wch: 3 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
    { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 14 }
];
XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

// -----------------------------------------------------------------------------
// Sheet 2: Detailed Inspection Log (Enhanced with Additional Inspections)
// -----------------------------------------------------------------------------
const detailSheet = [
    ['OTIN', 'Date Inspected', 'Day', 'Tier', 'Inspector', 'Short Name', 'Warehouse (Austin)',
     'Multiple Pick', 'Pick Count', 'Handoffs', 'Re-work', 'Re-work Date', 'Same Day Collab',
     'Current Shelf', 'DC/LC Count', 'Additional Inspections', 'Total Weight', 'MI KPI Score',
     'Date Codes', 'Lot Codes', 'COO', 'MI Start', 'MI End', 'Validated', 'Validation Time', 'Note']
];

let prevMonthCount = 0;
let prevMonthKPI = 0;

mainData.forEach(row => {
    const [pickDate, dayOfWeek, inspector, fromPrevMonth, otin, tier, multiplePick, pickCount, handoffCount,
           rework, reworkDate, sameDayCollab, currentShelf, warehouse, dclcCount,
           datecodes, lotcodes, coos, additionalInspections, totalWeight, miKpiScore,
           miStart, miEnd, validated, validationTime] = row;

    const tierCode = TIER_CODES[tier] || tier;
    const note = fromPrevMonth === 't' || fromPrevMonth === 'true' ? 'Prev Month Pick' : '';

    if (fromPrevMonth === 't' || fromPrevMonth === 'true') {
        prevMonthCount++;
        prevMonthKPI += parseFloat(miKpiScore) || 0;
    }

    detailSheet.push([
        otin,
        pickDate,
        dayOfWeek,
        tierCode,
        inspector,
        SHORT_NAMES[inspector] || '',
        warehouse || 'Austin',
        multiplePick,
        parseInt(pickCount) || 1,
        parseInt(handoffCount) || 0,
        rework,
        reworkDate,
        sameDayCollab,
        currentShelf,
        parseInt(dclcCount) || 0,
        additionalInspections || '',
        parseFloat(totalWeight) || 0,
        parseFloat(miKpiScore) || 0,
        datecodes,
        lotcodes,
        coos,
        miStart,
        miEnd,
        validated,
        validationTime,
        note
    ]);
});

// Add note about previous month picks
if (prevMonthCount > 0) {
    detailSheet.push(['']);
    detailSheet.push([`NOTE: ${prevMonthCount} OTINs (${prevMonthKPI.toFixed(2)} KPI) were picked on the last day of previous month and are included in this report.`]);
}

const ws2 = XLSX.utils.aoa_to_sheet(detailSheet);
ws2['!cols'] = [
    { wch: 10 }, { wch: 12 }, { wch: 6 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 18 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 25 },
    { wch: 18 }, { wch: 12 }, { wch: 30 }, { wch: 12 }, { wch: 12 },
    { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 20 }
];
XLSX.utils.book_append_sheet(wb, ws2, 'Inspection Log');

// -----------------------------------------------------------------------------
// Sheet 3: Kickbacks
// -----------------------------------------------------------------------------
const kickbackSheet = [
    ['Kickback Analysis - OTINs Returned to MI Queue'],
    [''],
    ['OTIN', 'From Shelf', 'Kickback Date', 'Kickback Type', 'Reason']
];

const kickbackSummary = { SHIPPING: 0, QI: 0, LSH: 0, OTHER: 0 };

kickbackData.forEach(row => {
    const [otin, fromShelf, toShelf, kickbackDate, reason, kickbackType] = row;
    kickbackSheet.push([otin, fromShelf, kickbackDate, kickbackType, reason]);
    kickbackSummary[kickbackType] = (kickbackSummary[kickbackType] || 0) + 1;
});

kickbackSheet.push(['']);
kickbackSheet.push(['Summary:']);
kickbackSheet.push(['From Shipping Queue', kickbackSummary.SHIPPING]);
kickbackSheet.push(['From QI Queue', kickbackSummary.QI]);
kickbackSheet.push(['From Logistics Shipping Hold', kickbackSummary.LSH]);
kickbackSheet.push(['From Other', kickbackSummary.OTHER]);
kickbackSheet.push(['TOTAL KICKBACKS', Object.values(kickbackSummary).reduce((a, b) => a + b, 0)]);

const ws3 = XLSX.utils.aoa_to_sheet(kickbackSheet);
ws3['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 40 }];
XLSX.utils.book_append_sheet(wb, ws3, 'Kickbacks');

// -----------------------------------------------------------------------------
// Sheet 4: Service Sends
// -----------------------------------------------------------------------------
const serviceSheet = [
    ['Service Analysis - OTINs Sent to External Testing'],
    [''],
    ['OTIN', 'Service Out Date', 'Service Return Date', 'Days at Service', 'Status', 'Notes']
];

let servicePending = 0, serviceReturned = 0, totalServiceDays = 0;

serviceData.forEach(row => {
    const [otin, outDate, returnDate, daysAtService, notes] = row;
    const status = returnDate && returnDate !== '' ? 'Returned' : 'Pending';
    serviceSheet.push([otin, outDate, returnDate || 'Pending', daysAtService || '', status, notes]);

    if (status === 'Pending') servicePending++;
    else {
        serviceReturned++;
        totalServiceDays += parseInt(daysAtService) || 0;
    }
});

const avgServiceDays = serviceReturned > 0 ? (totalServiceDays / serviceReturned).toFixed(1) : 'N/A';

serviceSheet.push(['']);
serviceSheet.push(['Summary:']);
serviceSheet.push(['Total Service Sends', serviceData.length]);
serviceSheet.push(['Returned', serviceReturned]);
serviceSheet.push(['Still Pending', servicePending]);
serviceSheet.push(['Avg Days at Service (returned only)', avgServiceDays]);

const ws4 = XLSX.utils.aoa_to_sheet(serviceSheet);
ws4['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 40 }];
XLSX.utils.book_append_sheet(wb, ws4, 'Service Sends');

// -----------------------------------------------------------------------------
// Sheet 5: Daily Volume with MI KPI Scores
// -----------------------------------------------------------------------------
const dailyVolume = {};
const dailyKpiScore = {};

mainData.forEach(row => {
    const date = row[0];
    const tier = row[4];
    const dclcCount = parseInt(row[14]) || 0;  // DC/LC count column
    const miKpiScore = parseFloat(row[18]) || 0;  // MI KPI Score column

    if (!dailyVolume[date]) {
        dailyVolume[date] = { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };
        dailyKpiScore[date] = { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };
    }
    dailyVolume[date].total++;

    // Determine tier
    let tierKey = '';
    if (tier && (tier.includes('Tier 1') || tier === 'MASTER OTIN reference')) {
        tierKey = 'T1';
    } else if (tier === 'Tier 2 Inspection') {
        tierKey = 'T2';
    } else if (tier === 'Tier 3 Inspection') {
        tierKey = 'T3';
    } else if (tier === 'AS6171') {
        tierKey = 'T4';
    }

    if (tierKey) {
        dailyVolume[date][tierKey]++;
        dailyKpiScore[date][tierKey] += miKpiScore;
        dailyKpiScore[date].total += miKpiScore;
    }
});

const dailySheet = [
    ['DAILY VOLUME & MI KPI SCORE ANALYSIS - Austin Inspectors'],
    [''],
    ['INSPECTION COUNTS BY DAY'],
    [''],
    ['Date', 'Total', 'T1', 'T2', 'T3', 'T4', '', 'MI KPI Score', 'T1 Score', 'T2 Score', 'T3 Score', 'T4 Score']
];

// Monthly totals
let monthlyTotals = { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };
let monthlyKpi = { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };

Object.keys(dailyVolume).sort().forEach(date => {
    const d = dailyVolume[date];
    const k = dailyKpiScore[date] || { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };

    dailySheet.push([
        date, d.total, d.T1, d.T2, d.T3, d.T4, '',
        k.total.toFixed(2), k.T1.toFixed(2), k.T2.toFixed(2), k.T3.toFixed(2), k.T4.toFixed(2)
    ]);

    // Accumulate monthly totals
    monthlyTotals.total += d.total;
    monthlyTotals.T1 += d.T1;
    monthlyTotals.T2 += d.T2;
    monthlyTotals.T3 += d.T3;
    monthlyTotals.T4 += d.T4;
    monthlyKpi.total += k.total;
    monthlyKpi.T1 += k.T1;
    monthlyKpi.T2 += k.T2;
    monthlyKpi.T3 += k.T3;
    monthlyKpi.T4 += k.T4;
});

// Add monthly total row
dailySheet.push(['']);
dailySheet.push([
    'MONTHLY TOTAL', monthlyTotals.total, monthlyTotals.T1, monthlyTotals.T2, monthlyTotals.T3, monthlyTotals.T4, '',
    monthlyKpi.total.toFixed(2), monthlyKpi.T1.toFixed(2), monthlyKpi.T2.toFixed(2), monthlyKpi.T3.toFixed(2), monthlyKpi.T4.toFixed(2)
]);

// Add daily averages
const numDays = Object.keys(dailyVolume).length;
dailySheet.push([
    'DAILY AVERAGE',
    (monthlyTotals.total / numDays).toFixed(1),
    (monthlyTotals.T1 / numDays).toFixed(1),
    (monthlyTotals.T2 / numDays).toFixed(1),
    (monthlyTotals.T3 / numDays).toFixed(1),
    (monthlyTotals.T4 / numDays).toFixed(1), '',
    (monthlyKpi.total / numDays).toFixed(2),
    (monthlyKpi.T1 / numDays).toFixed(2),
    (monthlyKpi.T2 / numDays).toFixed(2),
    (monthlyKpi.T3 / numDays).toFixed(2),
    (monthlyKpi.T4 / numDays).toFixed(2)
]);

dailySheet.push(['']);
dailySheet.push(['Note: Data is formatted for easy chart creation in Excel.']);
dailySheet.push(['Select columns A-F (Date through T4) for Inspection Count chart.']);
dailySheet.push(['Select columns A, H-L (Date and Score columns) for MI KPI Score chart.']);

const ws5 = XLSX.utils.aoa_to_sheet(dailySheet);
ws5['!cols'] = [
    { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 3 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }
];
XLSX.utils.book_append_sheet(wb, ws5, 'Daily Volume');

// -----------------------------------------------------------------------------
// Sheet 6: Recommendations
// -----------------------------------------------------------------------------
const recommendationsSheet = [
    ['RECOMMENDATIONS FOR MI KPI REPORT AUTOMATION'],
    [''],
    ['Generated:', new Date().toISOString().split('T')[0]],
    [''],
    ['=' .repeat(80)],
    ['VERSION 6 CHANGES - ADDITIONAL INSPECTIONS IMPLEMENTED'],
    ['=' .repeat(80)],
    [''],
    ['CRITICAL FIX: Additional Inspection Weights'],
    ['   - Added support for Additional Inspections (+0.2 each):'],
    ['     • Decapsulation'],
    ['     • Solderability'],
    ['     • SEM'],
    ['     • Scrape'],
    ['     • Destructive Sampling'],
    ['     • Non-conforming conditions'],
    [''],
    ['   - NEW FORMULA: DC/LC Count × (Base Tier Weight + Sum of Additional Inspections)'],
    ['   - Example: OTIN with Tier 2 + Solder + Decap'],
    ['     • Base Weight: 2.0'],
    ['     • Solder: +0.2'],
    ['     • Decap: +0.2'],
    ['     • Total Weight: 2.4'],
    ['     • If 3 DC/LC: KPI = 3 × 2.4 = 7.2'],
    [''],
    ['   - Query now aggregates ALL inspection types per OTIN'],
    ['   - Inspection Log now shows "Additional Inspections" column'],
    ['   - "Total Weight" column shows aggregated weight (base + add-ons)'],
    [''],
    ['CROSS-MONTH ACTIVITY HANDLING:'],
    ['   - OTINs are attributed to the month of FIRST PICK DATE'],
    ['   - Includes OTINs picked on last day of previous month (matches manual methodology)'],
    ['   - Each OTIN counted once per month (no duplication across months)'],
    [''],
    ['   - Future Enhancement: Track incremental work across months'],
    ['     • If OTIN picked in May, then additional work in June'],
    ['     • May: count base inspection KPI'],
    ['     • June: count only additional inspection KPI (no double-counting)'],
    ['     • Requires tracking inspection state over time (not currently implemented)'],
    [''],
    ['=' .repeat(80)],
    ['IMPLEMENTED METHODOLOGY'],
    ['=' .repeat(80)],
    [''],
    ['1. COUNT DISTINCT Methodology'],
    ['   - Each OTIN is counted once, attributed to FIRST inspector who picked it'],
    ['   - Matches manual tracking methodology'],
    ['   - Prevents double-counting on handoffs'],
    [''],
    ['2. Inspection Weight Aggregation'],
    ['   - Base Tier Weights: T1-P=0.75, T1-A/T1=1.0, T1-M=0.5, T2=2.0, T3=3.0, T4=4.0'],
    ['   - Additional Inspection Weights: +0.2 each'],
    ['   - Multiple Additional Inspections stack (e.g., Decap + Solder = +0.4)'],
    ['   - Total weight = Base + Sum(Add-ons)'],
    [''],
    ['3. MI KPI Score Calculation'],
    ['   - Formula: DC/LC Count × total_weight_per_otin'],
    ['   - Lotcode count used if available, else datecode count'],
    ['   - Weights aggregated per OTIN before KPI calculation'],
    [''],
    ['4. Enhanced Tracking Metrics'],
    ['   - Multiple Pick (Y/N) - identifies OTINs with multiple touches'],
    ['   - Pick Count & Handoffs - quantifies work complexity'],
    ['   - Re-work tracking - identifies OTINs worked on multiple days'],
    ['   - Same Day Collaboration - shows inspector teamwork'],
    ['   - DC/LC Count - for MI KPI multiplier calculation'],
    ['   - Additional Inspections - shows add-on types per OTIN'],
    ['   - Total Weight - base + add-ons per OTIN'],
    [''],
    ['=' .repeat(80)],
    ['RECOMMENDED PROCESS IMPROVEMENTS'],
    ['=' .repeat(80)],
    [''],
    ['1. Reconciliation with Manual Tracker'],
    ['   CURRENT STATUS: v6 implements manager-confirmed formula'],
    ['   NEXT STEP: Compare v6 May report to manual tracker'],
    ['   EXPECTED: Gap should be significantly reduced with Additional Inspections'],
    [''],
    ['2. Monthly Reconciliation Process'],
    ['   RECOMMENDATION: Run automated report weekly during month'],
    ['   BENEFIT: Catch discrepancies early, reduce end-of-month reconciliation work'],
    [''],
    ['3. Eliminate Manual Tracking'],
    ['   TARGET: Once v6 methodology is validated'],
    ['   RECOMMENDATION: Use automated report as source of truth'],
    ['   BENEFIT: Reduced manual effort, single source of truth, real-time visibility'],
    [''],
    ['=' .repeat(80)],
    ['USAGE NOTES'],
    ['=' .repeat(80)],
    [''],
    ['Run for specific month:'],
    ['  node mi_kpi_report_v6.js 2026-03'],
    [''],
    ['Run for current month:'],
    ['  node mi_kpi_report_v6.js'],
    [''],
    ['Output:'],
    ['  mi_kpi_report_YYYY-MM_v6.xlsx']
];

const ws6 = XLSX.utils.aoa_to_sheet(recommendationsSheet);
ws6['!cols'] = [{ wch: 100 }];
XLSX.utils.book_append_sheet(wb, ws6, 'Recommendations');

// =============================================================================
// WRITE FILE
// =============================================================================
const filename = `/home/melissa.bojar/workspace/MI KPIs/mi_kpi_report_${REPORT_MONTH}_v6.xlsx`;
XLSX.writeFile(wb, filename);

console.log('='.repeat(60));
console.log('REPORT GENERATED: ' + filename);
console.log('='.repeat(60));
console.log('');
console.log('VERSION 6 CHANGES:');
console.log('  - IMPLEMENTED: Additional Inspection weights (+0.2 each)');
console.log('  - NEW FORMULA: DC/LC Count × (Base + Sum(Add-ons))');
console.log('  - AGGREGATES: All inspection types per OTIN');
console.log('  - DISPLAYS: Additional Inspections column in detail log');
console.log('  - SHOWS: Total Weight (base + add-ons) per OTIN');
console.log('');
console.log('SHEETS:');
console.log('  1. Summary             - Inspector scores with MI Target');
console.log('  2. Inspection Log      - Enhanced with Additional Inspections');
console.log('  3. Kickbacks           - OTINs returned from shipping/QI');
console.log('  4. Service Sends       - OTINs sent to external testing');
console.log('  5. Daily Volume        - Daily inspection counts & KPI scores');
console.log('  6. Recommendations     - Process improvement suggestions');
console.log('');
console.log('KEY METRICS:');
console.log(`  T1-Passive: ${totalT1P}`);
console.log(`  T1-Active: ${totalT1A}`);
console.log(`  T1: ${totalT1}`);
console.log(`  T1-Master: ${totalT1M}`);
console.log(`  T1 (all types): ${totalT1P + totalT1A + totalT1 + totalT1M}`);
console.log(`  T2: ${totalT2}`);
console.log(`  T3: ${totalT3}`);
console.log(`  T4 (AS6171): ${totalT4}`);
console.log(`  Total Unique OTINs: ${totalOtins}`);
console.log(`  Total MI KPI Score: ${totalScore.toFixed(2)}`);
console.log(`  MI KPI Target: ${MI_KPI_TARGET_PER_INSPECTOR}+ per inspector`);
console.log(`  Avg % of Target: ${avgPctOfTarget}`);
console.log(`  Kickbacks: ${kickbackData.length}`);
console.log(`  Service Sends: ${serviceData.length}`);
console.log('');
console.log('ADDITIONAL INSPECTIONS:');
console.log('  Formula now aggregates base tier + add-ons per OTIN');
console.log('  Example: Tier 2 (2.0) + Solder (0.2) + Decap (0.2) = 2.4 total');
console.log('  With 3 DC/LC: KPI = 3 × 2.4 = 7.2');
console.log('');
console.log('USAGE:');
console.log('  node mi_kpi_report_v6.js 2026-05   # Run for May 2026');
console.log('  node mi_kpi_report_v6.js           # Run for current month');
console.log('');
