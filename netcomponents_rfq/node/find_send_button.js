/**
 * Find the Send RFQ button
 */
const { chromium } = require('playwright');
const config = require('./config');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Login
    await page.goto('https://www.netcomponents.com');
    await new Promise(r => setTimeout(r, 2000));
    await page.click('a:has-text("Login")');
    await new Promise(r => setTimeout(r, 2000));
    await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
    await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
    await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
    await page.press('#Password', 'Enter');
    await new Promise(r => setTimeout(r, 5000));

    // Search
    await page.fill('#PartsSearched_0__PartNumber', 'SI5341B-D-GMR');
    await page.click('#btnSearch');
    await new Promise(r => setTimeout(r, 8000));

    // Click first non-Mouser supplier
    const rows = await page.$$('table#trv_0 tbody tr');
    for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length < 15) continue;
        const link = await cells[15].$('a');
        if (!link) continue;
        const name = await link.innerText();
        if (name && !name.toLowerCase().includes('mouser')) {
            await link.click();
            break;
        }
    }
    await new Promise(r => setTimeout(r, 3000));

    // Click E-Mail RFQ
    const rfqBtn = await page.$('button:has-text("E-Mail RFQ")');
    if (rfqBtn) await rfqBtn.click();
    await new Promise(r => setTimeout(r, 3000));

    // Find ALL buttons with send/rfq/submit text
    console.log('=== SEARCHING FOR SEND RFQ BUTTON ===\n');

    const allButtons = await page.$$('button, input[type="submit"], a.btn');
    console.log(`Total buttons/links: ${allButtons.length}\n`);

    for (const btn of allButtons) {
        const text = (await btn.innerText().catch(() => '')).trim();
        const value = await btn.getAttribute('value') || '';
        const id = await btn.getAttribute('id') || '';
        const cls = await btn.getAttribute('class') || '';
        const visible = await btn.isVisible();

        const searchText = (text + value).toLowerCase();
        if (searchText.includes('send') || searchText.includes('submit') || id.toLowerCase().includes('send')) {
            console.log(`MATCH: text="${text}" value="${value}" id="${id}" visible=${visible}`);
            console.log(`       class="${cls.substring(0, 60)}"`);
        }
    }

    // Also look for the form and its submit
    console.log('\n=== FORMS ===\n');
    const forms = await page.$$('form');
    for (let i = 0; i < forms.length; i++) {
        const form = forms[i];
        const id = await form.getAttribute('id');
        const action = await form.getAttribute('action');
        console.log(`Form ${i}: id="${id}" action="${action}"`);

        const formSubmits = await form.$$('button[type="submit"], input[type="submit"]');
        for (const s of formSubmits) {
            const sText = (await s.innerText().catch(() => '')).trim();
            const sVal = await s.getAttribute('value');
            console.log(`  Submit: text="${sText}" value="${sVal}"`);
        }
    }

    await browser.close();
})();
