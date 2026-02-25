/**
 * Test RFQ flow - click on supplier name to open RFQ
 * Skip franchised suppliers (ones with triangle icon)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `click_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: click_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    console.log('========================================');
    console.log(`Testing RFQ click flow for: ${partNumber}`);
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
        await screenshot(page, '01_results');

        // Find all data rows in the results table
        // The supplier column appears to be one of the later columns
        // Looking for links/clickable elements that are supplier names

        console.log('Looking for supplier links...\n');

        // Get all table rows that have data-id (these should be supplier rows)
        const supplierRows = await page.$$('tr[data-id]');
        console.log(`Found ${supplierRows.length} supplier rows`);

        // Analyze first few rows to understand structure
        for (let i = 0; i < Math.min(5, supplierRows.length); i++) {
            const row = supplierRows[i];
            const dataId = await row.getAttribute('data-id');
            const rowClass = await row.getAttribute('class');

            // Check if this is a franchised supplier (has triangle icon)
            const hasTriangle = await row.$('.fa-exclamation-triangle, .franchise-icon, [class*="franchise"], [class*="authorized"]');

            // Find the supplier name cell (usually has a link)
            const supplierLink = await row.$('a[href*="supplier"], td a, .supplier-name a');
            let supplierName = '';
            if (supplierLink) {
                supplierName = (await supplierLink.innerText()).trim();
            }

            // Get all cells to find supplier column
            const cells = await row.$$('td');

            console.log(`Row ${i}: data-id="${dataId}" franchised=${!!hasTriangle} cells=${cells.length}`);

            // Print cell contents to find supplier column
            for (let c = 0; c < Math.min(cells.length, 12); c++) {
                const cellText = (await cells[c].innerText()).trim().substring(0, 25);
                const hasLink = await cells[c].$('a');
                if (cellText) {
                    console.log(`    [${c}] "${cellText}" ${hasLink ? '(LINK)' : ''}`);
                }
            }
        }

        // Find the supplier column - look for cells with links that aren't part numbers
        console.log('\nLooking for clickable supplier names...');

        // The supplier name is typically in a cell with a link
        // Let's find all links in the table that look like supplier names
        const allLinks = await page.$$('table#trv_0 td a');
        console.log(`Found ${allLinks.length} links in table`);

        // Filter to find supplier links (not MPN links)
        let supplierLinks = [];
        for (const link of allLinks) {
            const href = await link.getAttribute('href');
            const text = (await link.innerText()).trim();
            const parent = await link.evaluateHandle(el => el.closest('td'));
            const parentClass = await parent.evaluate(el => el.className);

            // Check if this looks like a supplier link
            // Supplier links typically go to /supplier/ path or have specific class
            if (href && (href.includes('/supplier/') || href.includes('supplierinfo'))) {
                // Check if the row has a franchise indicator
                const row = await link.evaluateHandle(el => el.closest('tr'));
                const rowHtml = await row.evaluate(el => el.innerHTML);
                const isFranchised = rowHtml.includes('fa-exclamation-triangle') ||
                                    rowHtml.includes('franchise') ||
                                    rowHtml.includes('authorized');

                supplierLinks.push({
                    text,
                    href,
                    isFranchised,
                    element: link
                });
            }
        }

        console.log(`\nFound ${supplierLinks.length} supplier links:`);
        const nonFranchised = supplierLinks.filter(s => !s.isFranchised);
        const franchised = supplierLinks.filter(s => s.isFranchised);
        console.log(`  Non-franchised (brokers): ${nonFranchised.length}`);
        console.log(`  Franchised (skip): ${franchised.length}`);

        // Show first few non-franchised suppliers
        console.log('\nNon-franchised suppliers:');
        for (let i = 0; i < Math.min(5, nonFranchised.length); i++) {
            console.log(`  ${i + 1}. ${nonFranchised[i].text}`);
        }

        // Click on the first non-franchised supplier to open RFQ
        if (nonFranchised.length > 0) {
            console.log(`\nClicking on supplier: ${nonFranchised[0].text}`);
            await nonFranchised[0].element.click();
            await delay(3000);
            await screenshot(page, '02_after_click');

            // Check if a modal/form opened
            const modal = await page.$('.modal:visible, .popup:visible, [class*="modal"]:visible');
            if (modal) {
                console.log('Modal/popup opened!');

                // Analyze the modal content
                const modalHtml = await modal.innerHTML();
                console.log(`Modal HTML length: ${modalHtml.length}`);

                // Look for form fields
                const inputs = await modal.$$('input:visible, select:visible, textarea:visible');
                console.log(`Form inputs: ${inputs.length}`);

                for (const inp of inputs) {
                    const id = await inp.getAttribute('id');
                    const name = await inp.getAttribute('name');
                    const type = await inp.getAttribute('type');
                    const placeholder = await inp.getAttribute('placeholder');
                    console.log(`  id="${id}" name="${name}" type="${type}" placeholder="${placeholder}"`);
                }

                // Look for submit button
                const submitBtns = await modal.$$('button, input[type="submit"]');
                console.log(`Buttons in modal: ${submitBtns.length}`);
                for (const btn of submitBtns) {
                    const text = (await btn.innerText().catch(() => '')).trim();
                    console.log(`  Button: "${text}"`);
                }
            } else {
                console.log('No modal detected - checking page changes...');
                console.log(`Current URL: ${page.url()}`);
            }

            await screenshot(page, '03_modal_or_page');
        }

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
