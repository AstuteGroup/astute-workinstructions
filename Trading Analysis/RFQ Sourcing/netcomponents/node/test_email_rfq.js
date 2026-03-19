/**
 * Test the full RFQ flow - click supplier, then E-Mail RFQ button
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `email_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: email_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';
    const dryRun = true;  // Don't actually submit

    console.log('========================================');
    console.log(`Testing E-Mail RFQ flow for: ${partNumber}`);
    console.log(`Dry run: ${dryRun} (won't submit)`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // Login & Search
        console.log('1. Logging in...');
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);
        console.log('   Logged in');

        console.log(`2. Searching for ${partNumber}...`);
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('   Search complete');

        // Find a broker supplier (skip known franchised distributors)
        console.log('3. Finding broker supplier...');
        const rows = await page.$$('table#trv_0 tbody tr');
        const franchisedNames = ['mouser', 'digikey', 'arrow', 'avnet', 'newark', 'element14', 'farnell', 'rs components', 'tme', 'future', 'microchip'];

        let brokerLink = null;
        let brokerName = '';

        for (const row of rows) {
            const rowClass = await row.getAttribute('class') || '';
            if (rowClass.includes('header')) continue;

            const cells = await row.$$('td');
            if (cells.length < 15) continue;

            const supplierCell = cells[15];
            const link = await supplierCell?.$('a');
            if (!link) continue;

            const name = (await link.innerText()).trim();
            if (!name) continue;

            // Skip franchised
            if (franchisedNames.some(f => name.toLowerCase().includes(f))) continue;

            brokerLink = link;
            brokerName = name;
            break;
        }

        if (!brokerLink) {
            console.log('   No broker supplier found');
            return;
        }

        console.log(`   Found broker: ${brokerName}`);

        // Click on supplier
        console.log('4. Opening supplier panel...');
        await brokerLink.click();
        await delay(3000);
        await screenshot(page, '01_supplier_panel');
        console.log('   Supplier panel opened');

        // Click E-Mail RFQ button
        console.log('5. Clicking E-Mail RFQ button...');
        const rfqBtn = await page.$('button:has-text("E-Mail RFQ"), a:has-text("E-Mail RFQ")');

        if (!rfqBtn) {
            console.log('   E-Mail RFQ button not found');
            return;
        }

        await rfqBtn.click();
        await delay(3000);
        await screenshot(page, '02_rfq_form');
        console.log('   RFQ form opened');

        // Analyze the RFQ form
        console.log('\n=== RFQ FORM ANALYSIS ===\n');

        console.log('URL:', page.url());

        // Find all form inputs
        const inputs = await page.$$('input:visible, textarea:visible, select:visible');
        console.log(`\nForm fields (${inputs.length}):`);

        for (const inp of inputs) {
            const tag = await inp.evaluate(e => e.tagName);
            const id = await inp.getAttribute('id');
            const name = await inp.getAttribute('name');
            const type = await inp.getAttribute('type');
            const placeholder = await inp.getAttribute('placeholder');
            const value = await inp.inputValue().catch(() => '');

            if (id || name) {
                console.log(`  ${tag}: id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" value="${value?.substring(0, 30)}"`);
            }
        }

        // Find labels
        console.log('\nForm labels:');
        const labels = await page.$$('label:visible');
        for (const label of labels.slice(0, 15)) {
            const text = (await label.innerText()).trim().substring(0, 40);
            const forAttr = await label.getAttribute('for');
            if (text) {
                console.log(`  "${text}" for="${forAttr}"`);
            }
        }

        // Find submit button
        console.log('\nSubmit buttons:');
        const submitBtns = await page.$$('button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Send"):visible, button:has-text("Submit"):visible');
        for (const btn of submitBtns) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const id = await btn.getAttribute('id');
            console.log(`  id="${id}" text="${text}"`);
        }

        await screenshot(page, '03_form_analyzed');

        if (dryRun) {
            console.log('\n[DRY RUN] Not submitting - form analysis complete');
        }

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
