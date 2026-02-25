/**
 * Debug links in the results table
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = 'SI5341B-D-GMR';

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // Login & Search
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);

        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('Search complete\n');

        // Get sample of links in the table
        console.log('=== SAMPLE LINKS IN TABLE ===\n');

        const links = await page.$$('table#trv_0 a');
        console.log(`Total links: ${links.length}\n`);

        // Show unique href patterns
        const hrefPatterns = new Set();
        for (const link of links.slice(0, 50)) {
            const href = await link.getAttribute('href') || '';
            const text = (await link.innerText()).trim().substring(0, 30);

            // Get href pattern (first part of path)
            const pattern = href.split('?')[0].replace(/\/\d+/g, '/{id}');
            hrefPatterns.add(pattern);

            // Show first 20 links
            if (hrefPatterns.size <= 20) {
                console.log(`href="${href.substring(0, 60)}" text="${text}"`);
            }
        }

        console.log('\n=== UNIQUE HREF PATTERNS ===\n');
        for (const p of hrefPatterns) {
            console.log(p);
        }

        // Look at table structure more carefully
        console.log('\n=== TABLE ROW STRUCTURE ===\n');

        const rows = await page.$$('table#trv_0 tbody tr');
        console.log(`Total rows: ${rows.length}\n`);

        // Show first 3 data rows (skip header rows)
        let dataRowCount = 0;
        for (let i = 0; i < rows.length && dataRowCount < 3; i++) {
            const row = rows[i];
            const rowClass = await row.getAttribute('class') || '';

            // Skip header rows
            if (rowClass.includes('header')) continue;

            dataRowCount++;
            console.log(`Row ${i} (class="${rowClass}"):`);

            const cells = await row.$$('td');
            for (let c = 0; c < cells.length; c++) {
                const cellText = (await cells[c].innerText()).trim().substring(0, 35);
                const cellClass = await cells[c].getAttribute('class') || '';
                const hasLink = await cells[c].$('a');

                if (cellText || hasLink) {
                    console.log(`  [${c}] class="${cellClass.substring(0, 20)}" text="${cellText}" ${hasLink ? 'HAS_LINK' : ''}`);
                }
            }
            console.log('');
        }

        // Find the supplier column specifically
        console.log('=== LOOKING FOR SUPPLIER COLUMN ===\n');

        // The supplier name should be a distinct column, likely with class containing 'supplier' or 'vendor'
        const supplierCells = await page.$$('td[class*="supplier"], td.supplier, td.vendor, [data-column="supplier"]');
        console.log(`Cells with supplier class: ${supplierCells.length}`);

        // Try finding by data attribute
        const dataColCells = await page.$$('td[data-col], td[data-column]');
        console.log(`Cells with data-col: ${dataColCells.length}`);

        // The last column in each row is often the supplier
        const lastCells = await page.$$('table#trv_0 tbody tr td:last-child');
        console.log(`Last cells in rows: ${lastCells.length}`);

        if (lastCells.length > 0) {
            console.log('\nSample last cells (likely suppliers):');
            for (let i = 0; i < Math.min(5, lastCells.length); i++) {
                const text = (await lastCells[i].innerText()).trim().substring(0, 40);
                const link = await lastCells[i].$('a');
                if (text && link) {
                    const href = await link.getAttribute('href');
                    console.log(`  "${text}" href="${href?.substring(0, 50)}"`);
                }
            }
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
