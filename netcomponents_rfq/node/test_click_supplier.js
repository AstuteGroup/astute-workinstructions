/**
 * Click on supplier name to open RFQ
 * Supplier is in column 15 (last column)
 * Skip franchised suppliers (check for triangle icon in row)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `sup_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: sup_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    console.log('========================================');
    console.log(`Clicking supplier for: ${partNumber}`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // Login & Search
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

        console.log('Searching...');
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('Search complete\n');

        await screenshot(page, '01_results');

        // Get all rows in the table (skip header rows)
        const rows = await page.$$('table#trv_0 tbody tr');
        console.log(`Total rows: ${rows.length}\n`);

        // Collect suppliers
        const suppliers = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowClass = await row.getAttribute('class') || '';

            // Skip header rows
            if (rowClass.includes('header')) continue;

            // Get the cells
            const cells = await row.$$('td');
            if (cells.length < 15) continue;  // Not a data row

            // Supplier is in cell 15 (or last cell with content)
            const supplierCell = cells[15] || cells[cells.length - 1];
            const link = await supplierCell.$('a');

            if (link) {
                const supplierName = (await link.innerText()).trim();
                if (!supplierName) continue;

                // Check if franchised (row has triangle icon)
                const rowHtml = await row.innerHTML();
                const isFranchised = rowHtml.includes('fa-exclamation-triangle');

                // Get quantity and other data
                const qtyCell = cells[8];
                const qty = qtyCell ? (await qtyCell.innerText()).trim() : '';

                suppliers.push({
                    name: supplierName,
                    isFranchised,
                    qty,
                    link,
                    rowIndex: i
                });
            }
        }

        console.log(`Found ${suppliers.length} suppliers:`);
        const brokers = suppliers.filter(s => !s.isFranchised);
        const franchised = suppliers.filter(s => s.isFranchised);
        console.log(`  Brokers: ${brokers.length}`);
        console.log(`  Franchised (skip): ${franchised.length}\n`);

        // Show broker suppliers
        console.log('Broker suppliers:');
        for (let i = 0; i < Math.min(10, brokers.length); i++) {
            console.log(`  ${i + 1}. ${brokers[i].name} (qty: ${brokers[i].qty})`);
        }

        // Click on first broker supplier
        if (brokers.length > 0) {
            const supplier = brokers[0];
            console.log(`\n>>> Clicking on: ${supplier.name}`);

            await supplier.link.click();
            await delay(3000);

            await screenshot(page, '02_after_click');

            // Check what opened
            console.log(`\nCurrent URL: ${page.url()}`);

            // Look for modal/popup
            const modals = await page.$$('.modal, .popup, [class*="modal"], [role="dialog"]');
            console.log(`Modals found: ${modals.length}`);

            // Look for visible overlays
            const visibleOverlays = await page.$$('.modal.in, .modal.show, .popup:visible, .overlay:visible');
            console.log(`Visible overlays: ${visibleOverlays.length}`);

            // Check for any new forms
            const forms = await page.$$('form');
            console.log(`Forms on page: ${forms.length}`);

            // Look for RFQ-related text
            const pageText = await page.content();
            if (pageText.includes('Request for Quote') || pageText.includes('RFQ')) {
                console.log('Page contains RFQ text!');
            }
            if (pageText.includes('Message') || pageText.includes('message')) {
                console.log('Page contains Message text!');
            }

            // Find any new inputs that appeared
            const allInputs = await page.$$('input:visible, textarea:visible, select:visible');
            console.log(`\nVisible inputs: ${allInputs.length}`);

            for (const inp of allInputs.slice(0, 15)) {
                const id = await inp.getAttribute('id');
                const name = await inp.getAttribute('name');
                const placeholder = await inp.getAttribute('placeholder');
                const type = await inp.getAttribute('type');
                if (id || name) {
                    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}"`);
                }
            }

            await screenshot(page, '03_state');
        }

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
