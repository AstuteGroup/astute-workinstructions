/**
 * Test RFQ flow v2 - handle custom checkboxes and scroll to buttons
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `v2_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: v2_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    console.log('========================================');
    console.log(`Testing RFQ flow for: ${partNumber}`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
    });
    const page = await context.newPage();

    try {
        // Login
        console.log('Logging in...');
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);
        console.log('Logged in\n');

        // Search
        console.log(`Searching for ${partNumber}...`);
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('Search complete\n');

        await screenshot(page, '01_results_top');

        // Find the table and its data rows (skip header rows)
        const table = await page.$('table#trv_0');
        if (!table) {
            console.log('Results table not found');
            return;
        }

        // Get all rows and filter to data rows only
        const allRows = await table.$$('tr');
        console.log(`Total rows: ${allRows.length}`);

        // Find clickable elements in first column (might be icons or custom checkboxes)
        const firstColCells = await table.$$('td:first-child');
        console.log(`First column cells: ${firstColCells.length}`);

        // Check what's in the first few cells
        console.log('\nAnalyzing first column content:');
        for (let i = 0; i < Math.min(10, firstColCells.length); i++) {
            const cell = firstColCells[i];
            const html = await cell.innerHTML();
            const text = (await cell.innerText()).trim();

            // Look for any clickable elements
            const clickable = await cell.$$('a, button, span, i, div.clickable, [onclick], [data-id]');
            console.log(`  Cell ${i}: text="${text.substring(0,20)}" clickables=${clickable.length} html_len=${html.length}`);

            if (html.length < 500) {
                console.log(`    HTML: ${html.substring(0, 200)}`);
            }
        }

        // Look for the Create RFQ button by scrolling down
        console.log('\nScrolling to bottom to find Create RFQ button...');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);
        await screenshot(page, '02_scrolled_bottom');

        // Look for Create RFQ button with various selectors
        const rfqSelectors = [
            'button:has-text("Create RFQ")',
            'a:has-text("Create RFQ")',
            'input[value*="RFQ"]',
            '#btnCreateRFQ',
            '.btn-rfq',
            '[onclick*="rfq"]',
            'button.btn-success',  // Green button
        ];

        console.log('\nSearching for Create RFQ button:');
        for (const sel of rfqSelectors) {
            const btn = await page.$(sel);
            if (btn) {
                const visible = await btn.isVisible();
                const text = await btn.innerText().catch(() => '');
                console.log(`  ${sel}: found, visible=${visible}, text="${text.trim()}"`);
            }
        }

        // Find ALL buttons/links at the bottom
        console.log('\nAll visible buttons at page bottom:');
        const footerButtons = await page.$$('button:visible, a.btn:visible, input[type="submit"]:visible');
        for (const btn of footerButtons) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const id = await btn.getAttribute('id');
            const className = await btn.getAttribute('class');
            const href = await btn.getAttribute('href');
            if (text || id) {
                console.log(`  id="${id}" class="${className?.substring(0,30)}" text="${text}" href="${href?.substring(0,30)}"`);
            }
        }

        // Try to find the specific action buttons section
        const actionSection = await page.$('.action-buttons, .footer-buttons, .result-actions, #resultActions');
        if (actionSection) {
            console.log('\nFound action section!');
            const sectionHtml = await actionSection.innerHTML();
            console.log(sectionHtml.substring(0, 500));
        }

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
