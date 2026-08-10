#!/usr/bin/env node

/**
 * BOS Metrics Report Generator
 * Generates monthly CSE activity report and emails it
 *
 * Usage: node generate-bos-metrics.js [--email recipient@example.com]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const XlsxPopulate = require('xlsx-populate');
const { createNotifier } = require('../astute-workinstructions/shared/notifier');

// Configuration
const DEFAULT_EMAIL = 'justin.oberhofer@astutegroup.com,leah.griffin@astutegroup.com';
const OUTPUT_DIR = '/home/justin.oberhofer/workspace';

// CSE Users
const CSE_USERS = ['Bhuvan', 'Vimal', 'Mohan', 'Julie White', 'Haritharan', 'Ricky Atajar', 'Rosalyn Cana', 'Gopalakrishnan'];

// Get previous month info
function getPreviousMonth() {
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = prevMonth.getFullYear();
    const month = prevMonth.getMonth(); // 0-indexed
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return {
        year,
        month: month + 1, // 1-indexed for SQL
        monthName: monthNames[month],
        monthShort: monthShort[month],
        startDate: `${year}-${String(month + 1).padStart(2, '0')}-01`,
        endDate: new Date(year, month + 1, 1).toISOString().split('T')[0],
        display: `${monthNames[month]} ${year}`,
        fileDate: `${monthShort[month]} ${year}`
    };
}

// Get 12-month date range (ending with previous month)
function get12MonthRange() {
    const now = new Date();
    const endMonth = new Date(now.getFullYear(), now.getMonth(), 1); // First of current month
    const startMonth = new Date(now.getFullYear(), now.getMonth() - 12, 1); // 12 months back
    return {
        start: startMonth.toISOString().split('T')[0],
        end: endMonth.toISOString().split('T')[0]
    };
}

// Run SQL query and return results
function runQuery(sql) {
    const result = execSync(`psql -t -A -F',' -c "${sql.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
    });
    return result.trim().split('\n').filter(line => line).map(line => line.split(','));
}

// Get user ID to name mapping
function getUserMapping() {
    const rows = runQuery(`SELECT ad_user_id, name FROM adempiere.ad_user WHERE isactive = 'Y'`);
    const mapping = {};
    rows.forEach(([id, name]) => { mapping[id] = name; });
    return mapping;
}

// Get CSE user IDs
function getCSEUserIds(userMapping) {
    const ids = new Set();
    Object.entries(userMapping).forEach(([id, name]) => {
        if (CSE_USERS.includes(name)) ids.add(id);
    });
    return ids;
}

// Fetch data
function fetchData(dateRange, cseUserIds, userMapping) {
    console.log(`Fetching data for ${dateRange.start} to ${dateRange.end}...`);

    // Claims
    const claimsRaw = runQuery(`
        SELECT TO_CHAR(cl.created, 'YYYY-MM') as month, cl.createdby as user_id, COUNT(*) as cnt
        FROM adempiere.ad_changelog cl
        WHERE cl.ad_table_id = 417 AND cl.ad_column_id = 13488 AND cl.oldvalue = '1000006'
        AND cl.created >= '${dateRange.start}' AND cl.created < '${dateRange.end}'
        GROUP BY 1, 2
    `);

    // Answered
    const answeredRaw = runQuery(`
        SELECT TO_CHAR(cl.created, 'YYYY-MM') as month, cl.createdby as user_id, COUNT(*) as cnt
        FROM adempiere.ad_changelog cl
        WHERE cl.ad_table_id = 417 AND cl.ad_column_id = 13484 AND cl.newvalue = '1000003'
        AND cl.created >= '${dateRange.start}' AND cl.created < '${dateRange.end}'
        GROUP BY 1, 2
    `);

    // Closed
    const closedRaw = runQuery(`
        SELECT TO_CHAR(cl.created, 'YYYY-MM') as month, cl.createdby as user_id, COUNT(*) as cnt
        FROM adempiere.ad_changelog cl
        WHERE cl.ad_table_id = 417 AND cl.ad_column_id = 13484
        AND cl.newvalue IN ('1000002', '1000025', '1000026', '1000030', '102')
        AND cl.created >= '${dateRange.start}' AND cl.created < '${dateRange.end}'
        GROUP BY 1, 2
    `);

    // Process into combined structure
    const combined = {};

    function addData(rows, field) {
        rows.forEach(([month, userId, count]) => {
            if (!cseUserIds.has(userId)) return;
            if (!combined[month]) combined[month] = {};
            if (!combined[month][userId]) combined[month][userId] = { claims: 0, answered: 0, closed: 0 };
            combined[month][userId][field] = parseInt(count) || 0;
        });
    }

    addData(claimsRaw, 'claims');
    addData(answeredRaw, 'answered');
    addData(closedRaw, 'closed');

    return combined;
}

// Generate Excel report
async function generateReport(prevMonth, combined, userMapping) {
    const wb = await XlsxPopulate.fromBlankAsync();
    const months = Object.keys(combined).sort();

    // Calculate user totals for sorting
    const userTotals = {};
    months.forEach(month => {
        Object.entries(combined[month] || {}).forEach(([userId, d]) => {
            if (!userTotals[userId]) userTotals[userId] = { claims: 0, answered: 0, closed: 0 };
            userTotals[userId].claims += d.claims;
            userTotals[userId].answered += d.answered;
            userTotals[userId].closed += d.closed;
        });
    });

    const sortedUserIds = Object.keys(userTotals).sort((a, b) =>
        (userTotals[b].answered + userTotals[b].closed) - (userTotals[a].answered + userTotals[a].closed)
    );

    // Sheet 1: Previous Month Summary
    const ws1 = wb.sheet(0).name(prevMonth.display);
    ws1.cell('A1').value(`CSE Activity - ${prevMonth.display}`).style({ bold: true, fontSize: 14 });
    ws1.cell('A3').value('User').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws1.cell('B3').value('Claims').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws1.cell('C3').value('Answered').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws1.cell('D3').value('Closed').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws1.cell('E3').value('Total (Ans+Cls)').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });

    const prevMonthKey = `${prevMonth.year}-${String(prevMonth.month).padStart(2, '0')}`;
    const prevMonthData = combined[prevMonthKey] || {};

    let row = 4;
    let totals = { claims: 0, answered: 0, closed: 0 };
    sortedUserIds.forEach(userId => {
        const d = prevMonthData[userId] || { claims: 0, answered: 0, closed: 0 };
        ws1.cell(`A${row}`).value(userMapping[userId]);
        ws1.cell(`B${row}`).value(d.claims);
        ws1.cell(`C${row}`).value(d.answered);
        ws1.cell(`D${row}`).value(d.closed);
        ws1.cell(`E${row}`).value(d.answered + d.closed);
        totals.claims += d.claims;
        totals.answered += d.answered;
        totals.closed += d.closed;
        row++;
    });

    ws1.cell(`A${row}`).value('TOTAL').style({ bold: true });
    ws1.cell(`B${row}`).value(totals.claims).style({ bold: true });
    ws1.cell(`C${row}`).value(totals.answered).style({ bold: true });
    ws1.cell(`D${row}`).value(totals.closed).style({ bold: true });
    ws1.cell(`E${row}`).value(totals.answered + totals.closed).style({ bold: true });

    ws1.column('A').width(18);
    ws1.column('B').width(10);
    ws1.column('C').width(12);
    ws1.column('D').width(10);
    ws1.column('E').width(15);

    // Sheet 2: User Monthly Detail (Pivot)
    const ws2 = wb.addSheet('User Monthly Detail');
    ws2.cell('A1').value('User').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    months.forEach((m, i) => {
        ws2.cell(1, i + 2).value(m).style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    });

    sortedUserIds.forEach((userId, rowIdx) => {
        ws2.cell(`A${rowIdx + 2}`).value(userMapping[userId]);
        months.forEach((month, colIdx) => {
            const d = combined[month]?.[userId];
            ws2.cell(rowIdx + 2, colIdx + 2).value(d ? (d.answered + d.closed) : 0);
        });
    });
    ws2.column('A').width(18);

    // Sheet 3: Requests Answered-Closed by User
    const ws3 = wb.addSheet('Requests Ans-Cls by User');
    ws3.cell('A1').value('Month').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws3.cell('B1').value('User').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws3.cell('C1').value('Claims').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws3.cell('D1').value('Answered').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws3.cell('E1').value('Closed').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws3.cell('F1').value('Total (Ans+Cls)').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });

    row = 2;
    months.forEach(month => {
        Object.entries(combined[month] || {})
            .sort((a, b) => (b[1].answered + b[1].closed) - (a[1].answered + a[1].closed))
            .forEach(([userId, d]) => {
                ws3.cell(`A${row}`).value(month);
                ws3.cell(`B${row}`).value(userMapping[userId]);
                ws3.cell(`C${row}`).value(d.claims);
                ws3.cell(`D${row}`).value(d.answered);
                ws3.cell(`E${row}`).value(d.closed);
                ws3.cell(`F${row}`).value(d.answered + d.closed);
                row++;
            });
    });
    ws3.column('A').width(12);
    ws3.column('B').width(18);

    // Sheet 4: Monthly Totals
    const ws4 = wb.addSheet('Requests Ans-Cls prev 12 Mo');
    ws4.cell('A1').value('Month').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws4.cell('B1').value('Claims').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws4.cell('C1').value('Answered').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws4.cell('D1').value('Closed').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });
    ws4.cell('E1').value('Total (Ans+Cls)').style({ bold: true, fill: '4472C4', fontColor: 'FFFFFF' });

    months.forEach((month, i) => {
        let mClaims = 0, mAnswered = 0, mClosed = 0;
        Object.values(combined[month] || {}).forEach(d => {
            mClaims += d.claims;
            mAnswered += d.answered;
            mClosed += d.closed;
        });
        ws4.cell(`A${i + 2}`).value(month);
        ws4.cell(`B${i + 2}`).value(mClaims);
        ws4.cell(`C${i + 2}`).value(mAnswered);
        ws4.cell(`D${i + 2}`).value(mClosed);
        ws4.cell(`E${i + 2}`).value(mAnswered + mClosed);
    });
    ws4.column('A').width(12);
    ws4.column('E').width(15);

    // Save
    const filename = `BOS Metrics - ${prevMonth.display}.xlsx`;
    const filepath = path.join(OUTPUT_DIR, filename);
    await wb.toFileAsync(filepath);

    console.log(`Report saved: ${filepath}`);
    return filepath;
}

// Send email with attachment using shared notifier
async function sendEmail(filepath, recipient, prevMonth) {
    const filename = path.basename(filepath);
    const subject = `BOS Metrics Report - ${prevMonth.display}`;
    const body = `BOS Metrics Report for ${prevMonth.display}

This automated report shows CSE queue activity for the previous month.

Sheets included:
1. ${prevMonth.display} - Previous month summary by user
2. User Monthly Detail - User totals by month (12 months)
3. Requests Answered-Closed by User - Detailed breakdown
4. Requests Ans-Cls prev 12 Mo - Monthly totals

Metrics:
- Claims: Requests claimed from CSE queue
- Answered: Requests set to Answered status
- Closed: Requests set to Closed status
- Total: Answered + Closed

Report generated: ${new Date().toISOString()}
`;

    try {
        const notifier = createNotifier({
            fromEmail: 'bizops@orangetsunami.com',
            fromName: 'BOS Metrics Report'
        });

        // Split comma-separated recipients into array for notifier
        const recipientList = recipient.includes(',') ? recipient.split(',').map(r => r.trim()) : recipient;

        const success = await notifier.sendWithAttachment(
            recipientList,
            subject,
            body,
            [{ filename: filename, path: filepath }]
        );

        if (success) {
            console.log(`Email sent to: ${recipient}`);
        } else {
            console.error('Email send failed - check SMTP configuration');
            console.log('Report file saved at:', filepath);
        }
    } catch (err) {
        console.error('Email error:', err.message);
        console.log('Please manually send the report:', filepath);
    }
}

// Main
async function main() {
    const args = process.argv.slice(2);
    let email = DEFAULT_EMAIL;

    // Parse args
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email' && args[i + 1]) {
            email = args[i + 1];
        }
    }

    console.log('=== BOS Metrics Report Generator ===\n');

    const prevMonth = getPreviousMonth();
    console.log(`Previous month: ${prevMonth.display}`);

    const dateRange = get12MonthRange();
    console.log(`Date range: ${dateRange.start} to ${dateRange.end}`);

    const userMapping = getUserMapping();
    const cseUserIds = getCSEUserIds(userMapping);
    console.log(`CSE users: ${CSE_USERS.join(', ')}`);

    const combined = fetchData(dateRange, cseUserIds, userMapping);
    console.log(`Months with data: ${Object.keys(combined).sort().join(', ')}`);

    const filepath = await generateReport(prevMonth, combined, userMapping);

    if (email) {
        await sendEmail(filepath, email, prevMonth);
    }

    console.log('\nDone!');
}

main().catch(console.error);
