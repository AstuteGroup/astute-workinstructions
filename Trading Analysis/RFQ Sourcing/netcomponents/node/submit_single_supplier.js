/**
 * Submit RFQ to a single specific supplier
 * Usage: node submit_single_supplier.js <part_number> <quantity> <supplier_name>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    const partNumber = process.argv[2];
    const quantity = parseInt(process.argv[3], 10);
    const supplierName = process.argv[4];

    if (!partNumber || !quantity || !supplierName) {
        console.log('Usage: node submit_single_supplier.js <part_number> <quantity> <supplier_name>');
        console.log('Example: node submit_single_supplier.js "MMA8451QR1" 5000 "Component Search LLC"');
        process.exit(1);
    }

    console.log('========================================');
    console.log('Single Supplier RFQ Submission');
    console.log(`Part: ${partNumber}`);
    console.log(`Quantity: ${quantity}`);
    console.log(`Supplier: ${supplierName}`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    try {
        // Login
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
        console.log('   Done\n');

        // Search
        console.log('2. Searching...');
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('   Done\n');

        // Find supplier in table
        console.log('3. Finding supplier...');
        let supplierLink = null;
        const rows = await page.$$('table#trv_0 tbody tr');

        for (const row of rows) {
            const cells = await row.$$('td');
            if (cells.length < 16) continue;
            const supplierCell = cells[15];
            const link = await supplierCell.$('a');
            if (!link) continue;
            const linkText = (await link.innerText()).trim();
            if (linkText === supplierName) {
                supplierLink = link;
                break;
            }
        }

        if (!supplierLink) {
            console.log(`   ERROR: Could not find "${supplierName}" in results`);
            await browser.close();
            return;
        }
        console.log('   Found!\n');

        // Click supplier
        console.log('4. Opening supplier panel...');
        await supplierLink.click();
        await delay(2000);

        // Click E-Mail RFQ
        const rfqLink = await page.$('a:has-text("E-Mail RFQ")');
        if (!rfqLink) {
            console.log('   ERROR: E-Mail RFQ not available');
            await browser.close();
            return;
        }
        await rfqLink.click();
        await delay(2000);
        console.log('   Done\n');

        // Fill form
        console.log('5. Filling RFQ form...');

        // Check part
        const partCheckbox = await page.$('#Parts_0__Selected');
        if (partCheckbox) {
            const isChecked = await partCheckbox.isChecked();
            if (!isChecked) await partCheckbox.check();
            console.log('   Checked part');
        }

        // Enter quantity
        const qtyInput = await page.$('#Parts_0__Quantity');
        if (qtyInput) {
            await qtyInput.fill(quantity.toString());
            console.log(`   Entered quantity: ${quantity}`);
        }

        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'single_supplier_form.png') });
        console.log('   Screenshot: single_supplier_form.png\n');

        // Find and click send button
        console.log('6. Sending RFQ...');
        const sendButton = await page.$('input[type="submit"][value*="Send"], button:has-text("Send"), input[value="Send RFQ"]');
        if (!sendButton) {
            // Try finding by the specific button pattern
            const allInputs = await page.$$('input[type="submit"]');
            for (const inp of allInputs) {
                const val = await inp.getAttribute('value');
                if (val && val.toLowerCase().includes('send')) {
                    await inp.click();
                    break;
                }
            }
        } else {
            await sendButton.click();
        }

        await delay(3000);
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'single_supplier_sent.png') });
        console.log('   Screenshot: single_supplier_sent.png');
        console.log('\n========================================');
        console.log('SUCCESS: RFQ sent to ' + supplierName);
        console.log('========================================');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
})();
