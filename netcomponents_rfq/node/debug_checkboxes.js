/**
 * Debug script to find checkbox selectors
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = 'SI5341B-D-GMR';

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
    });
    const page = await context.newPage();

    try {
        // Login
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);
        console.log('Logged in');

        // Search
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('Search complete');

        // Debug: Find ALL checkboxes
        console.log('\n=== ALL CHECKBOXES ===\n');
        const allCheckboxes = await page.$$('input[type="checkbox"]');
        console.log(`Total checkboxes: ${allCheckboxes.length}`);

        for (let i = 0; i < Math.min(allCheckboxes.length, 10); i++) {
            const cb = allCheckboxes[i];
            const id = await cb.getAttribute('id');
            const name = await cb.getAttribute('name');
            const className = await cb.getAttribute('class');
            const value = await cb.getAttribute('value');
            const visible = await cb.isVisible();
            console.log(`  [${i}] id="${id}" name="${name}" class="${className}" value="${value}" visible=${visible}`);
        }

        // Debug: Look at table structure
        console.log('\n=== TABLE STRUCTURE ===\n');
        const tables = await page.$$('table');
        console.log(`Tables: ${tables.length}`);

        for (let t = 0; t < tables.length; t++) {
            const table = tables[t];
            const id = await table.getAttribute('id');
            const className = await table.getAttribute('class');
            console.log(`\nTable ${t}: id="${id}" class="${className}"`);

            // Get first few rows
            const rows = await table.$$('tr');
            console.log(`  Rows: ${rows.length}`);

            for (let r = 0; r < Math.min(rows.length, 3); r++) {
                const row = rows[r];
                const rowClass = await row.getAttribute('class');
                const cells = await row.$$('td, th');
                console.log(`  Row ${r}: class="${rowClass}" cells=${cells.length}`);

                // Check for checkboxes in this row
                const rowCbs = await row.$$('input[type="checkbox"]');
                if (rowCbs.length > 0) {
                    console.log(`    Contains ${rowCbs.length} checkbox(es)`);
                    for (const rcb of rowCbs) {
                        const rcbId = await rcb.getAttribute('id');
                        const rcbName = await rcb.getAttribute('name');
                        console.log(`      id="${rcbId}" name="${rcbName}"`);
                    }
                }
            }
        }

        // Debug: Look for Create RFQ button
        console.log('\n=== CREATE RFQ BUTTON ===\n');
        const rfqButtons = await page.$$('button, a, input[type="submit"]');
        for (const btn of rfqButtons) {
            const text = (await btn.innerText().catch(() => '')).toLowerCase();
            const value = (await btn.getAttribute('value') || '').toLowerCase();
            if (text.includes('rfq') || value.includes('rfq')) {
                const tag = await btn.evaluate(e => e.tagName);
                const id = await btn.getAttribute('id');
                const className = await btn.getAttribute('class');
                console.log(`${tag}: id="${id}" class="${className}" text/value="${text || value}"`);
            }
        }

        // Save a snippet of HTML for analysis
        const html = await page.content();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'debug_page.html'), html);
        console.log('\nSaved page HTML to screenshots/debug_page.html');

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'debug_results.png'), fullPage: true });
        console.log('Saved screenshot');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
