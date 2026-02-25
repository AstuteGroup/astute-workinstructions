/**
 * Submit RFQs to qualifying in-stock suppliers
 *
 * Criteria:
 * - In-stock inventory only (skip brokered)
 * - Skip franchised/authorized distributors
 * - Skip Asia/Other region (separate purchasing group)
 * - Supplier qty must be >= requested qty (or take largest if none qualify)
 * - Max 3-4 suppliers per region
 * - Europe suppliers: add "Please confirm country of origin" message
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const MAX_SUPPLIERS_PER_REGION = 3;
// Franchised/authorized distributors are identified by 'ncauth' class in DOM
// Independent distributors have 'ncnoauth' class - no hardcoded name list needed

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `rfq_${name}.png`);
    await page.screenshot({ path: filename, fullPage: false });
    console.log(`    Screenshot: rfq_${name}.png`);
}

async function main() {
    const partNumber = process.argv[2];
    const quantity = parseInt(process.argv[3], 10);

    if (!partNumber || !quantity) {
        console.log('Usage: node submit_rfqs.js <part_number> <quantity>');
        console.log('Example: node submit_rfqs.js "DS3231SN#" 1000');
        process.exit(1);
    }

    console.log('========================================');
    console.log('NetComponents RFQ Submission');
    console.log(`Part: ${partNumber}`);
    console.log(`Quantity: ${quantity}`);
    console.log(`Max suppliers per region: ${MAX_SUPPLIERS_PER_REGION}`);
    console.log('========================================\n');

    const startTime = Date.now();
    const timing = {
        login: 0,
        search: 0,
        suppliers: [],
        total: 0
    };

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    const results = [];

    try {
        // 1. Login
        console.log('1. Logging in...');
        const loginStart = Date.now();
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);
        timing.login = (Date.now() - loginStart) / 1000;
        console.log(`   Done (${timing.login.toFixed(1)}s)\n`);

        // 2. Search for part
        console.log(`2. Searching for ${partNumber}...`);
        const searchStart = Date.now();
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        timing.search = (Date.now() - searchStart) / 1000;
        console.log(`   Done (${timing.search.toFixed(1)}s)\n`);

        // 3. Parse all suppliers and aggregate by supplier name
        console.log('3. Finding qualifying suppliers...');
        const rows = await page.$$('table#trv_0 tbody tr');

        const supplierData = {};  // key: "name|region", value: {name, region, totalQty, rows: [rowElements]}
        let inStockSection = false;
        let currentRegion = 'Unknown';

        for (const row of rows) {
            const rowText = (await row.innerText().catch(() => '')).toLowerCase();

            // Track region headers
            if (rowText.includes('americas') && !rowText.includes('inventory') && rowText.length < 50) {
                currentRegion = 'Americas';
                continue;
            }
            if (rowText.includes('europe') && !rowText.includes('inventory') && rowText.length < 50) {
                currentRegion = 'Europe';
                continue;
            }
            if ((rowText.includes('asia') || rowText.includes('other')) && !rowText.includes('inventory') && rowText.length < 50) {
                currentRegion = 'Asia/Other';
                continue;
            }

            // Check for section subheader rows
            if ((rowText.startsWith('in stock') || rowText.startsWith('in-stock')) && rowText.length < 100) {
                inStockSection = true;
                continue;
            }
            if ((rowText.startsWith('brokered inventory') || rowText.startsWith('brokered')) && rowText.length < 100) {
                inStockSection = false;
                continue;
            }

            // Skip if not in-stock section or Asia/Other
            if (!inStockSection) continue;
            if (currentRegion === 'Asia/Other') continue;

            const cells = await row.$$('td');
            if (cells.length < 16) continue;

            // Get supplier name
            const supplierCell = cells[15];
            const link = await supplierCell.$('a');
            if (!link) continue;
            const supplierName = (await link.innerText()).trim();
            if (!supplierName) continue;

            // Skip franchised/authorized distributors (marked with 'ncauth' class)
            const authIcon = await supplierCell.$('.ncauth');
            if (authIcon) continue;

            // Get quantity from column 8
            let qty = 0;
            try {
                const qtyText = (await cells[8].innerText()).trim();
                const qtyMatch = qtyText.replace(/,/g, '').match(/^(\d+)/);
                if (qtyMatch) qty = parseInt(qtyMatch[1], 10);
            } catch (e) {}

            // Aggregate by supplier
            const key = `${supplierName}|${currentRegion}`;
            if (!supplierData[key]) {
                supplierData[key] = { name: supplierName, region: currentRegion, totalQty: 0, link: link };
            }
            supplierData[key].totalQty += qty;
            // Keep the link with highest qty
            if (qty > 0) {
                supplierData[key].link = link;
            }
        }

        // Convert to array and sort by qty
        const allSuppliers = Object.values(supplierData).sort((a, b) => b.totalQty - a.totalQty);

        // Split by region and filter by qty
        const americas = allSuppliers.filter(s => s.region === 'Americas');
        const europe = allSuppliers.filter(s => s.region === 'Europe');

        // Select suppliers: prefer those meeting qty, fallback to largest
        const americasMeetQty = americas.filter(s => s.totalQty >= quantity);
        const europeMeetQty = europe.filter(s => s.totalQty >= quantity);

        const selectedAmericas = americasMeetQty.length > 0
            ? americasMeetQty.slice(0, MAX_SUPPLIERS_PER_REGION)
            : americas.slice(0, MAX_SUPPLIERS_PER_REGION);

        const selectedEurope = europeMeetQty.length > 0
            ? europeMeetQty.slice(0, MAX_SUPPLIERS_PER_REGION)
            : europe.slice(0, MAX_SUPPLIERS_PER_REGION);

        console.log(`   Americas: ${selectedAmericas.length} suppliers selected`);
        selectedAmericas.forEach(s => console.log(`     - ${s.name} (${s.totalQty.toLocaleString()})`));
        console.log(`   Europe: ${selectedEurope.length} suppliers selected`);
        selectedEurope.forEach(s => console.log(`     - ${s.name} (${s.totalQty.toLocaleString()})`));
        console.log('');

        const allSelected = [...selectedAmericas, ...selectedEurope];

        if (allSelected.length === 0) {
            console.log('   No qualifying suppliers found!');
            return;
        }

        // 4. Submit RFQs to each supplier
        console.log(`4. Submitting RFQs to ${allSelected.length} suppliers...\n`);

        for (let i = 0; i < allSelected.length; i++) {
            const supplier = allSelected[i];
            const supplierStart = Date.now();
            console.log(`   [${i + 1}/${allSelected.length}] ${supplier.name} (${supplier.region})...`);

            try {
                // Re-do search to get fresh page state
                await page.goto(config.BASE_URL);
                await delay(2000);
                await page.fill('#PartsSearched_0__PartNumber', partNumber);
                await page.click('#btnSearch');
                await delay(6000);

                // Find and click the supplier
                const supplierLink = await page.$(`a:has-text("${supplier.name}")`);
                if (!supplierLink) {
                    console.log(`    ERROR: Could not find supplier link`);
                    results.push({ supplier: supplier.name, region: supplier.region, status: 'FAILED', error: 'Supplier not found' });
                    continue;
                }

                await supplierLink.click();
                await delay(2000);

                // Click E-Mail RFQ link
                const rfqLink = await page.$('a:has-text("E-Mail RFQ")');
                if (!rfqLink) {
                    console.log(`    ERROR: E-Mail RFQ option not available`);
                    results.push({ supplier: supplier.name, region: supplier.region, status: 'FAILED', error: 'No RFQ option' });
                    // Close panel if open
                    await page.keyboard.press('Escape');
                    await delay(1000);
                    continue;
                }

                await rfqLink.click();
                await delay(2000);

                // Fill the RFQ form
                // Wait for form to load
                await delay(1000);

                // Check part checkbox
                const partCheckbox = await page.$('#Parts_0__Selected');
                if (partCheckbox) {
                    const isChecked = await partCheckbox.isChecked();
                    if (!isChecked) {
                        await partCheckbox.check();
                        console.log(`    Checked part selection`);
                    }
                } else {
                    console.log(`    WARNING: Part checkbox not found`);
                }

                // Fill quantity - try multiple selectors
                let qtyInput = await page.$('#Parts_0__Quantity');
                if (!qtyInput) {
                    qtyInput = await page.$('input[name="Parts[0].Quantity"]');
                }
                if (!qtyInput) {
                    // Try to find any input in the Qty Requested column area
                    qtyInput = await page.$('input[type="text"][placeholder*="Qty"]');
                }
                if (!qtyInput) {
                    // Look for input near "Qty Requested" text
                    const inputs = await page.$$('input[type="text"]');
                    for (const inp of inputs) {
                        const name = await inp.getAttribute('name');
                        const id = await inp.getAttribute('id');
                        if ((name && name.toLowerCase().includes('quantity')) ||
                            (id && id.toLowerCase().includes('quantity'))) {
                            qtyInput = inp;
                            break;
                        }
                    }
                }

                if (qtyInput) {
                    await qtyInput.click();
                    await qtyInput.fill(quantity.toString());
                    console.log(`    Entered quantity: ${quantity}`);
                } else {
                    console.log(`    WARNING: Quantity input not found`);
                }

                // Add Europe message
                if (supplier.region === 'Europe') {
                    let commentsField = await page.$('#Comments');
                    if (!commentsField) {
                        commentsField = await page.$('textarea[name="Comments"]');
                    }
                    if (!commentsField) {
                        commentsField = await page.$('textarea');
                    }
                    if (commentsField) {
                        await commentsField.fill('Please confirm country of origin.');
                        console.log(`    Added Europe COO message`);
                    }
                }

                await delay(1000);
                await screenshot(page, `${i + 1}_form_filled`);

                // Find Send RFQ button - it's an INPUT type="button"
                let sendBtn = await page.$('input[type="button"].action-btn');
                if (!sendBtn) {
                    sendBtn = await page.$('input[value="Send RFQ"]');
                }
                if (!sendBtn) {
                    sendBtn = await page.$('input.btn-primary[type="button"]');
                }

                if (sendBtn) {
                    const isDisabled = await sendBtn.getAttribute('disabled');
                    const btnText = (await sendBtn.innerText().catch(() => '')).trim();
                    console.log(`    Found button: "${btnText}" disabled=${isDisabled !== null}`);

                    if (isDisabled === null) {
                        await sendBtn.click();
                        await delay(3000);
                        await screenshot(page, `${i + 1}_after_send`);
                        const supplierTime = (Date.now() - supplierStart) / 1000;
                        console.log(`    SUCCESS: RFQ sent (${supplierTime.toFixed(1)}s)`);
                        timing.suppliers.push({ name: supplier.name, time: supplierTime, status: 'SENT' });
                        results.push({
                            supplier: supplier.name,
                            region: supplier.region,
                            qty: quantity,
                            status: 'SENT',
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        console.log(`    ERROR: Send button disabled`);
                        await screenshot(page, `${i + 1}_disabled`);
                        results.push({ supplier: supplier.name, region: supplier.region, status: 'FAILED', error: 'Send button disabled' });
                    }
                } else {
                    console.log(`    ERROR: Send RFQ button not found`);
                    await screenshot(page, `${i + 1}_no_button`);
                    results.push({ supplier: supplier.name, region: supplier.region, status: 'FAILED', error: 'No Send button' });
                }

                // Close the form/modal
                await page.keyboard.press('Escape');
                await delay(1000);

            } catch (error) {
                const supplierTime = (Date.now() - supplierStart) / 1000;
                console.log(`    ERROR: ${error.message} (${supplierTime.toFixed(1)}s)`);
                timing.suppliers.push({ name: supplier.name, time: supplierTime, status: 'FAILED' });
                results.push({ supplier: supplier.name, region: supplier.region, status: 'FAILED', error: error.message });
            }
        }

        // 5. Summary
        timing.total = (Date.now() - startTime) / 1000;
        const avgPerSupplier = timing.suppliers.length > 0
            ? timing.suppliers.reduce((sum, s) => sum + s.time, 0) / timing.suppliers.length
            : 0;

        console.log('\n========================================');
        console.log('RFQ SUBMISSION SUMMARY');
        console.log('========================================');
        console.log(`Part: ${partNumber}`);
        console.log(`Quantity: ${quantity}`);
        console.log(`Total submitted: ${results.filter(r => r.status === 'SENT').length}/${results.length}`);
        console.log('');
        results.forEach(r => {
            const status = r.status === 'SENT' ? '✓' : '✗';
            const supplierTiming = timing.suppliers.find(s => s.name === r.supplier);
            const timeStr = supplierTiming ? ` (${supplierTiming.time.toFixed(1)}s)` : '';
            console.log(`${status} ${r.supplier} (${r.region}) - ${r.status}${timeStr}${r.error ? ': ' + r.error : ''}`);
        });

        console.log('\n========================================');
        console.log('TIMING');
        console.log('========================================');
        console.log(`Login:              ${timing.login.toFixed(1)}s`);
        console.log(`Initial search:     ${timing.search.toFixed(1)}s`);
        console.log(`Avg per supplier:   ${avgPerSupplier.toFixed(1)}s`);
        console.log(`Total runtime:      ${timing.total.toFixed(1)}s (${(timing.total / 60).toFixed(1)} min)`);
        console.log(`Suppliers/minute:   ${(timing.suppliers.length / (timing.total / 60)).toFixed(1)}`);

    } catch (error) {
        console.error('\nFATAL ERROR:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
