/**
 * Test login and RFQ flow on NetComponents
 * Run with: node test_login.js [part_number]
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
    const filename = path.join(config.SCREENSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: ${name}.png`);
    return filename;
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function login(page) {
    console.log('\n=== LOGGING IN ===\n');
    console.log(`Account: ${config.NETCOMPONENTS_ACCOUNT}`);
    console.log(`Username: ${config.NETCOMPONENTS_USERNAME}`);

    await page.goto(config.BASE_URL);
    await delay(2000);

    // Click login link to open modal
    const loginLink = await page.$(config.SELECTORS.login_link);
    if (loginLink) {
        console.log('Opening login modal...');
        await loginLink.click();
        await delay(2000);

        // Fill login form
        const accountInput = await page.$(config.SELECTORS.login_account);
        if (accountInput) await accountInput.fill(config.NETCOMPONENTS_ACCOUNT);

        const usernameInput = await page.$(config.SELECTORS.login_username);
        if (usernameInput) await usernameInput.fill(config.NETCOMPONENTS_USERNAME);

        const passwordInput = await page.$(config.SELECTORS.login_password);
        if (passwordInput) {
            await passwordInput.fill(config.NETCOMPONENTS_PASSWORD);
            await passwordInput.press('Enter');
        }

        await delay(5000);
        await screenshot(page, '01_after_login');

        // Check if login succeeded
        const pageContent = await page.content();
        if (pageContent.includes('Logout') || pageContent.includes('Log Out')) {
            console.log('LOGIN SUCCESSFUL!');
            return true;
        }
    }
    return false;
}

async function searchPart(page, partNumber) {
    console.log(`\n=== SEARCHING: ${partNumber} ===\n`);

    // After login, we might be on a different page
    // Let's explore what search interface is available
    console.log('Current URL:', page.url());

    // Log all visible inputs
    const inputs = await page.$$('input:visible');
    console.log(`\nVisible inputs: ${inputs.length}`);
    for (const inp of inputs) {
        const id = await inp.getAttribute('id');
        const name = await inp.getAttribute('name');
        const placeholder = await inp.getAttribute('placeholder');
        console.log(`  id="${id}" name="${name}" placeholder="${placeholder}"`);
    }

    // Log all visible buttons
    const buttons = await page.$$('button:visible');
    console.log(`\nVisible buttons: ${buttons.length}`);
    for (const btn of buttons) {
        const text = (await btn.innerText().catch(() => '')).trim().substring(0, 30);
        const id = await btn.getAttribute('id');
        if (text || id) console.log(`  id="${id}" text="${text}"`);
    }

    // Try to find search input - could be different when logged in
    let searchInput = await page.$('#FullSearch_PartsSearched_0__PartNumber');
    if (!searchInput) searchInput = await page.$('input[name*="PartNumber"]');
    if (!searchInput) searchInput = await page.$('input[placeholder*="Part"]');
    if (!searchInput) searchInput = await page.$('input.form-control');

    if (searchInput) {
        console.log('\nFound search input, entering part number...');
        await searchInput.fill('');  // Clear by filling empty
        await searchInput.fill(partNumber);
        await screenshot(page, '02_search_filled');

        // Look for search/submit button - we discovered it's #btnSearch
        let submitBtn = await page.$('#btnSearch');
        if (!submitBtn) submitBtn = await page.$('button[type="submit"]:visible');
        if (!submitBtn) submitBtn = await page.$('.btn-primary:visible');

        if (submitBtn) {
            console.log('Clicking search button...');
            await submitBtn.click();
        } else {
            console.log('Pressing Enter to search...');
            await searchInput.press('Enter');
        }

        // Wait for results
        console.log('Waiting for results...');
        await delay(8000);
        await screenshot(page, '03_search_results');

        // Check current URL and page content
        console.log('Result URL:', page.url());

        // Analyze results
        await analyzeResults(page);
    } else {
        console.log('Could not find search input');
        await screenshot(page, 'no_search_input');
    }
}

async function analyzeResults(page) {
    console.log('\n=== ANALYZING RESULTS ===\n');

    // Find all tables
    const tables = await page.$$('table');
    console.log(`Tables found: ${tables.length}`);

    // Find potential result rows
    const rows = await page.$$('table tr');
    console.log(`Table rows: ${rows.length}`);

    if (rows.length > 1) {
        // Show first data row
        const firstDataRow = rows[1];
        const cells = await firstDataRow.$$('td');
        console.log(`Cells in first row: ${cells.length}`);

        for (let i = 0; i < Math.min(cells.length, 8); i++) {
            const text = (await cells[i].innerText()).trim().substring(0, 40);
            console.log(`  [${i}]: "${text}"`);
        }
    }

    // Look for RFQ elements
    console.log('\nLooking for RFQ controls...');

    const checkboxes = await page.$$('input[type="checkbox"]:visible');
    console.log(`Checkboxes: ${checkboxes.length}`);

    // Look for any buttons/links with RFQ text
    const allText = await page.content();
    if (allText.includes('RFQ')) console.log('Page contains "RFQ" text');
    if (allText.includes('Quote')) console.log('Page contains "Quote" text');
    if (allText.includes('Request')) console.log('Page contains "Request" text');

    // Find specific RFQ elements
    const rfqBtns = await page.$$('[class*="rfq"], [id*="rfq"], button:has-text("RFQ"), a:has-text("RFQ")');
    console.log(`RFQ elements: ${rfqBtns.length}`);

    for (const btn of rfqBtns) {
        const tag = await btn.evaluate(e => e.tagName);
        const id = await btn.getAttribute('id');
        const className = await btn.getAttribute('class');
        const text = (await btn.innerText().catch(() => '')).trim().substring(0, 30);
        console.log(`  ${tag}: id="${id}" class="${className}" text="${text}"`);
    }
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    console.log('========================================');
    console.log('NetComponents Login & RFQ Test');
    console.log(`Part: ${partNumber}`);
    console.log('========================================');

    if (!config.validateCredentials()) {
        console.log('Credentials not set');
        return;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    const page = await context.newPage();

    try {
        await login(page);
        await searchPart(page, partNumber);

        console.log('\n========================================');
        console.log('Test complete');
        console.log('========================================');
    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
