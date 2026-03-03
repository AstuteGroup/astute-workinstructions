/**
 * Test complete RFQ flow - fill form to enable Send button
 * DRY RUN - won't actually submit
 *
 * Criteria:
 * - In-stock suppliers only (skip brokered inventory)
 * - Skip franchised/authorized distributors
 * - For Europe suppliers: add "please confirm country of origin" message
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `complete_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: complete_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';
    const quantity = process.argv[3] || '100';
    const targetSupplier = process.argv[4] || null;  // Optional: target specific supplier

    console.log('========================================');
    console.log('Complete RFQ Flow Test (DRY RUN)');
    console.log(`Part: ${partNumber}`);
    console.log(`Quantity: ${quantity}`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // 1. Login
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
        console.log('   Done');

        // 2. Search
        console.log(`2. Searching for ${partNumber}...`);
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('   Done');

        // 3. Find in-stock broker suppliers (skip franchised, brokered, and Asia)
        console.log('3. Finding in-stock broker suppliers...');
        if (targetSupplier) {
            console.log(`   Target: ${targetSupplier}`);
        }
        const franchisedNames = ['mouser', 'digikey', 'arrow', 'avnet', 'newark', 'element14', 'farnell', 'future', 'rochester', 'tti', 'symmetry'];
        const rows = await page.$$('table#trv_0 tbody tr');

        // Collect all in-stock suppliers with their quantities
        const allSuppliers = [];
        let inStockSection = false;
        let currentRegion = 'Unknown';

        for (const row of rows) {
            const rowText = (await row.innerText().catch(() => '')).toLowerCase();

            // Track region headers
            if (rowText.includes('americas') && !rowText.includes('inventory')) {
                currentRegion = 'Americas';
                continue;
            }
            if (rowText.includes('europe') && !rowText.includes('inventory')) {
                currentRegion = 'Europe';
                continue;
            }
            if ((rowText.includes('asia') || rowText.includes('other')) && !rowText.includes('inventory')) {
                currentRegion = 'Asia/Other';
                continue;
            }

            // Check for section subheader rows
            // These are distinct rows under each region that say "In-Stock Inventory" or "Brokered Inventory Listings"
            // They start with the section text and are short rows (not data rows with these words in description)
            if ((rowText.startsWith('in stock') || rowText.startsWith('in-stock')) && rowText.length < 100) {
                inStockSection = true;
                continue;
            }
            if ((rowText.startsWith('brokered inventory') || rowText.startsWith('brokered')) && rowText.length < 100) {
                inStockSection = false;
                continue;
            }

            // Skip if not in-stock section or if Asia/Other region
            if (!inStockSection) continue;
            if (currentRegion === 'Asia/Other') continue;

            const cells = await row.$$('td');
            if (cells.length < 16) continue;
            const link = await cells[15].$('a');
            if (!link) continue;
            const name = (await link.innerText()).trim();
            if (!name) continue;

            // Skip franchised/authorized distributors
            if (franchisedNames.some(f => name.toLowerCase().includes(f))) {
                continue;
            }

            // If targeting specific supplier, check for match
            if (targetSupplier && !name.toLowerCase().includes(targetSupplier.toLowerCase())) {
                continue;
            }

            // Get quantity from column 2 (third column in the table)
            let qtyText = '';
            try {
                qtyText = (await cells[2].innerText()).trim();
            } catch (e) {}

            // Parse quantity - remove commas and extract number
            const qtyMatch = qtyText.replace(/,/g, '').match(/(\d+)/);
            const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 0;

            allSuppliers.push({
                link,
                name,
                region: currentRegion,
                qty,
                qtyText
            });
        }

        // Sort by quantity (highest first) within each region
        allSuppliers.sort((a, b) => b.qty - a.qty);

        // Show top suppliers found
        console.log(`   Found ${allSuppliers.length} in-stock suppliers (Americas + Europe only):`);
        const americasSuppliers = allSuppliers.filter(s => s.region === 'Americas').slice(0, 4);
        const europeSuppliers = allSuppliers.filter(s => s.region === 'Europe').slice(0, 4);

        console.log(`\n   Americas (top ${americasSuppliers.length}):`);
        americasSuppliers.forEach((s, i) => {
            console.log(`     ${i + 1}. ${s.name} - Qty: ${s.qty || s.qtyText || 'N/A'}`);
        });

        console.log(`\n   Europe (top ${europeSuppliers.length}):`);
        europeSuppliers.forEach((s, i) => {
            console.log(`     ${i + 1}. ${s.name} - Qty: ${s.qty || s.qtyText || 'N/A'}`);
        });

        // For this test, select the top supplier overall (by qty)
        const topSupplier = allSuppliers[0];
        if (!topSupplier) {
            console.log('\n   No in-stock broker found');
            return;
        }

        const brokerLink = topSupplier.link;
        const brokerName = topSupplier.name;
        const brokerRegion = topSupplier.region;
        console.log(`\n   Selected for test: ${brokerName} (${brokerRegion}) - Qty: ${topSupplier.qty}`);

        // 4. Click supplier to open panel
        console.log('4. Opening supplier panel...');
        await brokerLink.click();
        await delay(3000);
        await screenshot(page, '01_supplier_panel');
        console.log('   Done');

        // 5. Look for E-Mail RFQ button (list all buttons for debugging)
        console.log('5. Looking for RFQ options...');
        const panelButtons = await page.$$('button');
        console.log(`   Found ${panelButtons.length} buttons on page:`);
        for (const btn of panelButtons) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const isVisible = await btn.isVisible().catch(() => false);
            if (text && isVisible) {
                console.log(`   - "${text}"`);
            }
        }

        // Also check for links that might be RFQ options
        const rfqLinks = await page.$$('a');
        for (const link of rfqLinks) {
            const text = (await link.innerText().catch(() => '')).trim().toLowerCase();
            if (text.includes('rfq') || text.includes('quote') || text.includes('email')) {
                const isVisible = await link.isVisible().catch(() => false);
                if (isVisible) {
                    console.log(`   - Link: "${text}"`);
                }
            }
        }

        // Try link first (more common), then button
        let rfqElement = await page.$('a:has-text("E-Mail RFQ")');
        if (!rfqElement) {
            rfqElement = await page.$('button:has-text("E-Mail RFQ")');
        }
        if (!rfqElement) {
            rfqElement = await page.$('a:has-text("RFQ")');
        }
        if (!rfqElement) {
            console.log('   E-Mail RFQ option not found for this supplier');
            console.log('   This supplier may not support email RFQ');
            return;
        }
        console.log('   Found E-Mail RFQ option - clicking...');
        await rfqElement.click();
        await delay(3000);
        await screenshot(page, '01_form_empty');
        console.log('   Done');

        // 6. Fill the form to enable Send button
        console.log('6. Filling RFQ form...');

        // Check if part checkbox exists and check it
        const partCheckbox = await page.$('#Parts_0__Selected');
        if (partCheckbox) {
            const isChecked = await partCheckbox.isChecked();
            if (!isChecked) {
                await partCheckbox.check();
                console.log('   - Checked part selection');
            } else {
                console.log('   - Part already selected');
            }
        }

        // Fill quantity
        const qtyInput = await page.$('#Parts_0__Quantity');
        if (qtyInput) {
            await qtyInput.fill(quantity);
            console.log(`   - Entered quantity: ${quantity}`);
        }

        // For Europe suppliers, add country of origin message
        if (brokerRegion === 'Europe') {
            const commentsField = await page.$('#Comments') || await page.$('textarea[name="Comments"]');
            if (commentsField) {
                await commentsField.fill('Please confirm country of origin.');
                console.log('   - Added Europe message: "Please confirm country of origin."');
            } else {
                console.log('   - WARNING: Could not find comments field for Europe message');
            }
        }

        await delay(1000);
        await screenshot(page, '02_form_filled');
        console.log('   Done');

        // 7. Find the Send RFQ button now that form is filled
        console.log('7. Looking for Send RFQ button...');

        // Look for all buttons and find Send RFQ
        const allButtons = await page.$$('button');
        console.log(`   Total buttons: ${allButtons.length}`);

        for (const btn of allButtons) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const disabled = await btn.getAttribute('disabled');
            const className = await btn.getAttribute('class');

            if (text.toLowerCase().includes('send')) {
                const isVisible = await btn.isVisible();
                const isEnabled = disabled === null;
                console.log(`   FOUND: "${text}" visible=${isVisible} enabled=${isEnabled}`);
                console.log(`          class="${className}"`);
            }
        }

        // Also look for input submit buttons
        const submitInputs = await page.$$('input[type="submit"]');
        console.log(`   Submit inputs: ${submitInputs.length}`);
        for (const inp of submitInputs) {
            const value = await inp.getAttribute('value');
            const disabled = await inp.getAttribute('disabled');
            console.log(`   - value="${value}" disabled=${disabled !== null}`);
        }

        await screenshot(page, '03_ready_to_send');

        console.log('\n========================================');
        console.log('DRY RUN COMPLETE - Did not submit');
        console.log('Check screenshots for Send button state');
        console.log('========================================');

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
