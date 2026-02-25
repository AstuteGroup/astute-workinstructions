/**
 * NetComponents Exploration Script
 * Run with: node explore.js [part_number]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure directories exist
[config.SESSION_DIR, config.SCREENSHOTS_DIR, config.OUTPUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function screenshot(page, name) {
    const filename = path.join(config.SCREENSHOTS_DIR, `${name}_${Date.now()}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: ${filename}`);
    return filename;
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchPart(page, partNumber) {
    console.log(`\n=== SEARCHING: ${partNumber} ===\n`);

    await page.goto(config.BASE_URL);
    await delay(3000);

    // The search input selector we discovered
    const searchInput = await page.$('input[name="PartsSearched[0].PartNumber"]');

    if (searchInput) {
        console.log('Found search input, entering part number...');
        await searchInput.fill(partNumber);
        await screenshot(page, '01_search_filled');

        // Find and click the search button
        const submitBtn = await page.$('button[type="submit"], .btn-primary');
        if (submitBtn) {
            console.log('Clicking search button...');
            await submitBtn.click();
        } else {
            await searchInput.press('Enter');
        }

        // Wait for results to load
        console.log('Waiting for results...');
        await delay(5000);
        await screenshot(page, '02_search_results');

        // Analyze the results table
        await analyzeResultsTable(page);
    } else {
        console.log('Could not find search input');
    }
}

async function analyzeResultsTable(page) {
    console.log('\n=== RESULTS TABLE ANALYSIS ===\n');

    // Get all tables
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables on page`);

    // Analyze each table
    for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const id = await table.getAttribute('id');
        const className = await table.getAttribute('class');
        const rows = await table.$$('tr');

        console.log(`\nTable ${t}: id="${id}" class="${className}" rows=${rows.length}`);

        if (rows.length > 1) {
            // Get header row
            const headerCells = await rows[0].$$('th');
            if (headerCells.length > 0) {
                console.log('  Headers:');
                for (let i = 0; i < headerCells.length; i++) {
                    const text = (await headerCells[i].innerText()).trim();
                    console.log(`    [${i}] "${text}"`);
                }
            }

            // Get first data row
            if (rows.length > 1) {
                const dataCells = await rows[1].$$('td');
                if (dataCells.length > 0) {
                    console.log('  First data row:');
                    for (let i = 0; i < Math.min(dataCells.length, 10); i++) {
                        const text = (await dataCells[i].innerText()).trim().substring(0, 50);
                        const className = await dataCells[i].getAttribute('class');
                        console.log(`    [${i}] class="${className}" text="${text}"`);
                    }
                }
            }
        }
    }

    // Look for RFQ-related elements
    console.log('\n=== RFQ ELEMENTS ===\n');

    const rfqPatterns = [
        'input[type="checkbox"]',
        'button:has-text("RFQ")',
        'button:has-text("Quote")',
        'a:has-text("RFQ")',
        '.rfq-btn',
        '[class*="rfq"]',
        '[class*="quote"]',
    ];

    for (const pattern of rfqPatterns) {
        const els = await page.$$(pattern);
        if (els.length > 0) {
            console.log(`${pattern}: ${els.length} elements`);
        }
    }

    // Extract sample supplier data
    console.log('\n=== SAMPLE DATA ===\n');

    // Try to find supplier column by looking at table structure
    const dataRows = await page.$$('table tbody tr, table tr:not(:first-child)');
    console.log(`Data rows found: ${dataRows.length}`);

    if (dataRows.length > 0) {
        // Sample first 3 rows
        for (let i = 0; i < Math.min(3, dataRows.length); i++) {
            const row = dataRows[i];
            const cells = await row.$$('td');
            if (cells.length >= 5) {
                const data = [];
                for (const cell of cells.slice(0, 6)) {
                    data.push((await cell.innerText()).trim().substring(0, 25));
                }
                console.log(`  Row ${i}: ${JSON.stringify(data)}`);
            }
        }
    }

    // Current URL
    console.log(`\nCurrent URL: ${page.url()}`);
}

async function exploreLogin(page) {
    console.log('\n=== LOGIN EXPLORATION ===\n');

    await page.goto(config.BASE_URL);
    await delay(2000);

    // Click login link
    const loginLink = await page.$('a:has-text("Login")');
    if (loginLink) {
        console.log('Clicking login link...');
        await loginLink.click();
        await delay(3000);
        await screenshot(page, '03_login_page');

        // Find login form fields
        console.log('\nLooking for login form fields...');

        const inputs = await page.$$('input:visible');
        console.log(`Visible inputs: ${inputs.length}`);

        for (const input of inputs) {
            const id = await input.getAttribute('id');
            const name = await input.getAttribute('name');
            const type = await input.getAttribute('type');
            const placeholder = await input.getAttribute('placeholder');
            if (type !== 'hidden') {
                console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}"`);
            }
        }

        // Find submit button
        const buttons = await page.$$('button:visible, input[type="submit"]:visible');
        console.log(`\nButtons: ${buttons.length}`);
        for (const btn of buttons) {
            const text = await btn.innerText().catch(() => '');
            const type = await btn.getAttribute('type');
            console.log(`  type="${type}" text="${text.trim().substring(0, 30)}"`);
        }
    }
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    console.log('========================================');
    console.log('NetComponents Exploration');
    console.log(`Part: ${partNumber}`);
    console.log('========================================');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    const page = await context.newPage();

    try {
        await searchPart(page, partNumber);
        await exploreLogin(page);

        console.log('\n========================================');
        console.log('Exploration complete');
        console.log('========================================');
    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
