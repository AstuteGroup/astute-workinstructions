/**
 * Test the full RFQ submission flow on NetComponents
 * Run with: node test_rfq.js [part_number]
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
    const filename = path.join(config.SCREENSHOTS_DIR, `rfq_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: rfq_${name}.png`);
    return filename;
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function login(page) {
    console.log('\n=== LOGGING IN ===\n');

    await page.goto(config.BASE_URL);
    await delay(2000);

    const loginLink = await page.$(config.SELECTORS.login_link);
    if (loginLink) {
        await loginLink.click();
        await delay(2000);

        await page.fill(config.SELECTORS.login_account, config.NETCOMPONENTS_ACCOUNT);
        await page.fill(config.SELECTORS.login_username, config.NETCOMPONENTS_USERNAME);
        await page.fill(config.SELECTORS.login_password, config.NETCOMPONENTS_PASSWORD);
        await page.press(config.SELECTORS.login_password, 'Enter');

        await delay(5000);
        console.log('Login complete');
        return true;
    }
    return false;
}

async function searchPart(page, partNumber) {
    console.log(`\n=== SEARCHING: ${partNumber} ===\n`);

    // Should already be on /search after login
    await delay(2000);

    // Fill search input
    const searchInput = await page.$('#PartsSearched_0__PartNumber, input[name="PartsSearched[0].PartNumber"]');
    if (searchInput) {
        await searchInput.fill(partNumber);

        // Click search button
        const searchBtn = await page.$('#btnSearch');
        if (searchBtn) {
            await searchBtn.click();
        }

        await delay(8000);
        console.log('Search complete');
        return true;
    }
    return false;
}

async function selectSuppliers(page, maxPerRegion = 2) {
    console.log(`\n=== SELECTING SUPPLIERS (max ${maxPerRegion} per region) ===\n`);

    await screenshot(page, '01_results');

    // Get all result rows with checkboxes
    // The table structure has regional headers and data rows
    const checkboxes = await page.$$('input[type="checkbox"][name*="Selected"]');
    console.log(`Found ${checkboxes.length} selectable suppliers`);

    // For now, just select the first few checkboxes as a test
    const toSelect = Math.min(checkboxes.length, 3);
    console.log(`Selecting first ${toSelect} suppliers...`);

    for (let i = 0; i < toSelect; i++) {
        const checkbox = checkboxes[i];
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
            await checkbox.click();
            console.log(`  Selected supplier ${i + 1}`);
            await delay(500);
        }
    }

    await screenshot(page, '02_selected');
    return toSelect;
}

async function clickCreateRFQ(page) {
    console.log('\n=== CREATING RFQ ===\n');

    // Look for Create RFQ button
    const rfqBtn = await page.$('button:has-text("Create RFQ"), a:has-text("Create RFQ"), input[value*="RFQ"]');

    if (rfqBtn) {
        console.log('Found Create RFQ button, clicking...');
        await rfqBtn.click();
        await delay(5000);
        await screenshot(page, '03_rfq_form');

        // Analyze the RFQ form
        await analyzeRFQForm(page);
        return true;
    } else {
        console.log('Create RFQ button not found');

        // Try to find it by looking at all buttons
        const allButtons = await page.$$('button, input[type="submit"], a.btn');
        console.log(`\nAll buttons on page:`);
        for (const btn of allButtons) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const value = await btn.getAttribute('value');
            if (text || value) {
                console.log(`  "${text || value}"`);
            }
        }
        return false;
    }
}

async function analyzeRFQForm(page) {
    console.log('\n=== RFQ FORM ANALYSIS ===\n');

    console.log('URL:', page.url());

    // Find all form inputs
    const inputs = await page.$$('input:visible, select:visible, textarea:visible');
    console.log(`\nForm fields: ${inputs.length}`);

    for (const input of inputs) {
        const tag = await input.evaluate(e => e.tagName);
        const id = await input.getAttribute('id');
        const name = await input.getAttribute('name');
        const type = await input.getAttribute('type');
        const placeholder = await input.getAttribute('placeholder');

        if (id || name) {
            console.log(`  ${tag}: id="${id}" name="${name}" type="${type}" placeholder="${placeholder}"`);
        }
    }

    // Find submit buttons
    const submitBtns = await page.$$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send")');
    console.log(`\nSubmit buttons: ${submitBtns.length}`);

    for (const btn of submitBtns) {
        const text = (await btn.innerText().catch(() => '')).trim();
        const id = await btn.getAttribute('id');
        console.log(`  id="${id}" text="${text}"`);
    }
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';
    const dryRun = process.argv.includes('--dry-run');

    console.log('========================================');
    console.log('NetComponents RFQ Flow Test');
    console.log(`Part: ${partNumber}`);
    console.log(`Dry Run: ${dryRun}`);
    console.log('========================================');

    if (!config.validateCredentials()) {
        console.log('Credentials not set');
        return;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    const page = await context.newPage();

    try {
        await login(page);
        const searched = await searchPart(page, partNumber);

        if (searched) {
            const selected = await selectSuppliers(page, 2);

            if (selected > 0) {
                await clickCreateRFQ(page);
            }
        }

        console.log('\n========================================');
        console.log('Test complete - check screenshots');
        console.log('========================================');
    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
