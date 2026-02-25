/**
 * Test finding RFQ button in supplier info panel
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filename = path.join(SCREENSHOTS_DIR, `panel_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: panel_${name}.png`);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // Login & Search
        console.log('Logging in & searching...');
        await page.goto(config.BASE_URL);
        await delay(2000);
        await page.click('a:has-text("Login")');
        await delay(2000);
        await page.fill('#AccountNumber', config.NETCOMPONENTS_ACCOUNT);
        await page.fill('#UserName', config.NETCOMPONENTS_USERNAME);
        await page.fill('#Password', config.NETCOMPONENTS_PASSWORD);
        await page.press('#Password', 'Enter');
        await delay(5000);

        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);
        console.log('Search complete\n');

        // Find suppliers - now look for "Authorized" text to identify franchised
        const rows = await page.$$('table#trv_0 tbody tr');
        const suppliers = [];

        for (const row of rows) {
            const rowClass = await row.getAttribute('class') || '';
            if (rowClass.includes('header')) continue;

            const cells = await row.$$('td');
            if (cells.length < 15) continue;

            const supplierCell = cells[15];
            const link = await supplierCell?.$('a');
            if (!link) continue;

            const supplierName = (await link.innerText()).trim();
            if (!supplierName) continue;

            suppliers.push({ name: supplierName, link });
        }

        console.log(`Found ${suppliers.length} suppliers`);

        // Click on a non-Mouser supplier (skip the big franchised ones)
        const franchisedNames = ['mouser', 'digikey', 'arrow', 'avnet', 'newark', 'element14', 'farnell', 'rs components', 'tme'];
        const broker = suppliers.find(s =>
            !franchisedNames.some(f => s.name.toLowerCase().includes(f))
        );

        if (broker) {
            console.log(`\nClicking on broker: ${broker.name}`);
            await broker.link.click();
            await delay(3000);

            await screenshot(page, '01_supplier_panel');

            // Look for buttons/actions in the supplier panel
            console.log('\n=== SUPPLIER PANEL ANALYSIS ===\n');

            // Find the supplier info panel
            const panel = await page.$('.supplier-info, #supplierInfo, [class*="supplier"]');
            console.log(`Supplier panel found: ${!!panel}`);

            // Look for all buttons and links in the visible area
            console.log('\nAll visible buttons:');
            const buttons = await page.$$('button:visible, a.btn:visible, [role="button"]:visible');
            for (const btn of buttons) {
                const text = (await btn.innerText().catch(() => '')).trim().substring(0, 40);
                const id = await btn.getAttribute('id');
                const className = await btn.getAttribute('class');
                const title = await btn.getAttribute('title');
                if (text || title) {
                    console.log(`  text="${text}" id="${id}" title="${title}" class="${className?.substring(0, 30)}"`);
                }
            }

            // Look for icons that might be clickable (RFQ, message, etc)
            console.log('\nClickable icons:');
            const icons = await page.$$('i.fa:visible, span.icon:visible, [class*="icon"]:visible');
            for (const icon of icons.slice(0, 20)) {
                const className = await icon.getAttribute('class');
                const parent = await icon.evaluateHandle(el => el.parentElement);
                const parentTag = await parent.evaluate(el => el.tagName);
                const parentTitle = await parent.evaluate(el => el.title || el.getAttribute('title') || '');
                if (className?.includes('fa-')) {
                    console.log(`  ${className.substring(0, 40)} parent=${parentTag} title="${parentTitle}"`);
                }
            }

            // Look for RFQ/Message/Contact links
            console.log('\nRFQ/Message/Contact elements:');
            const rfqElements = await page.$$('*:has-text("RFQ"):visible, *:has-text("Quote"):visible, *:has-text("Message"):visible, *:has-text("Contact"):visible');
            for (const el of rfqElements.slice(0, 10)) {
                const tag = await el.evaluate(e => e.tagName);
                const text = (await el.innerText().catch(() => '')).trim().substring(0, 30);
                const isClickable = tag === 'A' || tag === 'BUTTON';
                console.log(`  ${tag}: "${text}" clickable=${isClickable}`);
            }

            // Look specifically in the panel header area for action buttons
            console.log('\nPanel header buttons:');
            const headerBtns = await page.$$('.panel-header button, .panel-header a, .modal-header button, .header-actions button');
            for (const btn of headerBtns) {
                const text = (await btn.innerText().catch(() => '')).trim();
                const title = await btn.getAttribute('title');
                console.log(`  "${text}" title="${title}"`);
            }

            // Try to find the specific RFQ or message icon/button
            // Often it's a envelope or quote icon
            const msgIcons = await page.$$('.fa-envelope, .fa-comment, .fa-quote-left, .fa-file-text, [title*="Message"], [title*="RFQ"], [title*="Quote"]');
            console.log(`\nMessage/quote icons found: ${msgIcons.length}`);
            for (const icon of msgIcons) {
                const className = await icon.getAttribute('class');
                const title = await icon.getAttribute('title');
                console.log(`  class="${className}" title="${title}"`);
            }

        } else {
            console.log('No broker suppliers found');
        }

    } catch (error) {
        console.error('Error:', error.message);
        await screenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
