/**
 * Find the Send RFQ button in the form
 */
const { chromium } = require('playwright');
const config = require('./config');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

    try {
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
        await page.fill('#PartsSearched_0__PartNumber', 'DS3231SN#');
        await page.click('#btnSearch');
        await delay(6000);

        console.log('Clicking supplier...');
        const supplierLink = await page.$('a:has-text("Diverse Electronics")');
        await supplierLink.click();
        await delay(2000);

        console.log('Opening RFQ form...');
        const rfqLink = await page.$('a:has-text("E-Mail RFQ")');
        await rfqLink.click();
        await delay(3000);

        // Fill form
        const checkbox = await page.$('#Parts_0__Selected');
        if (checkbox) await checkbox.check();
        const qtyInput = await page.$('#Parts_0__Quantity');
        if (qtyInput) await qtyInput.fill('1000');
        await delay(1000);

        // Search for ALL elements containing "Send RFQ"
        console.log('\nSearching for Send RFQ elements...\n');

        const sendElements = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('*').forEach(el => {
                const text = el.textContent || '';
                if (text.includes('Send RFQ') && el.children.length === 0) {
                    results.push({
                        tag: el.tagName,
                        text: el.textContent.trim(),
                        class: el.className,
                        id: el.id,
                        type: el.type,
                        onclick: el.onclick ? 'yes' : 'no',
                        html: el.outerHTML
                    });
                }
            });
            return results;
        });

        console.log('Elements with exact "Send RFQ" text (no children):');
        sendElements.forEach((el, i) => {
            console.log(`\n[${i}] ${el.tag}`);
            console.log(`    text: "${el.text}"`);
            console.log(`    class: "${el.class}"`);
            console.log(`    id: "${el.id}"`);
            console.log(`    onclick: ${el.onclick}`);
            console.log(`    HTML: ${el.html}`);
        });

        // Also check for any btn-success buttons
        console.log('\n\nAll btn-success buttons:');
        const successBtns = await page.$$('.btn-success');
        for (const btn of successBtns) {
            const text = (await btn.innerText().catch(() => '')).trim();
            const tag = await btn.evaluate(el => el.tagName);
            const visible = await btn.isVisible();
            console.log(`  ${tag}: "${text}" visible=${visible}`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
