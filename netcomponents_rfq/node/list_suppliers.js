/**
 * List all in-stock suppliers for a part number
 * Shows which suppliers would be targeted for RFQ submission
 * Filters by minimum quantity if provided
 */

const { chromium } = require('playwright');
const path = require('path');
const config = require('./config');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const partNumber = process.argv[2] || 'SI5341B-D-GMR';
    const minQty = parseInt(process.argv[3], 10) || 0;  // Minimum quantity required

    console.log('========================================');
    console.log('NetComponents Supplier Search');
    console.log(`Part: ${partNumber}`);
    console.log(`Min Qty Required: ${minQty || 'Any'}`);
    console.log('========================================\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();

    try {
        // 1. Login
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

        // 2. Search
        console.log(`Searching for ${partNumber}...\n`);
        await page.fill('#PartsSearched_0__PartNumber', partNumber);
        await page.click('#btnSearch');
        await delay(8000);

        // 3. Parse all suppliers from results
        // Franchised/authorized distributors are identified by 'ncauth' class in DOM
        const rows = await page.$$('table#trv_0 tbody tr');

        let inStockSection = false;
        let currentRegion = '';
        const inStockSuppliers = [];
        const brokeredSuppliers = [];
        const skippedFranchised = [];

        for (const row of rows) {
            const rowText = (await row.innerText().catch(() => '')).toLowerCase();

            // Check for region headers
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

            // Check for section headers - must start with the section text (not contain it in description)
            // Section headers are short rows that just contain the section name
            if ((rowText.startsWith('in stock') || rowText.startsWith('in-stock')) && rowText.length < 100) {
                inStockSection = true;
                continue;
            }
            if ((rowText.startsWith('brokered inventory') || rowText.startsWith('brokered')) && rowText.length < 100) {
                inStockSection = false;
                continue;
            }

            // Get supplier info from cells
            const cells = await row.$$('td');
            if (cells.length < 16) continue;

            const supplierCell = cells[15];
            const link = await supplierCell.$('a');
            if (!link) continue;
            const supplierName = (await link.innerText()).trim();
            if (!supplierName) continue;

            // Check if franchised/authorized (marked with 'ncauth' class)
            const authIcon = await supplierCell.$('.ncauth');
            const isFranchised = authIcon !== null;

            // Get quantity from column 8 (the "Qty" column)
            let qtyText = '';
            let qty = 0;
            try {
                qtyText = (await cells[8].innerText()).trim();
                // Parse number, removing commas
                const qtyMatch = qtyText.replace(/,/g, '').match(/^(\d+)/);
                if (qtyMatch) {
                    qty = parseInt(qtyMatch[1], 10);
                }
            } catch (e) {}

            // Get part number from column 0
            let partNum = '';
            try {
                partNum = (await cells[0].innerText()).trim();
            } catch (e) {}

            const supplierInfo = {
                name: supplierName,
                region: currentRegion,
                qty: qty,
                qtyText: qtyText,
                partNum: partNum
            };

            if (isFranchised) {
                skippedFranchised.push(supplierInfo);
            } else if (inStockSection) {
                inStockSuppliers.push(supplierInfo);
            } else {
                brokeredSuppliers.push(supplierInfo);
            }
        }

        // Aggregate quantities by supplier name and region
        const supplierTotals = {};
        for (const s of inStockSuppliers) {
            // Skip Asia/Other region
            if (s.region === 'Asia/Other') continue;

            const key = `${s.name}|${s.region}`;
            if (!supplierTotals[key]) {
                supplierTotals[key] = { name: s.name, region: s.region, totalQty: 0, lines: 0, parts: [] };
            }
            supplierTotals[key].totalQty += s.qty;
            supplierTotals[key].lines++;
            if (s.qty > 0) {
                supplierTotals[key].parts.push(`${s.partNum}: ${s.qty}`);
            }
        }

        // Convert to array and sort by quantity
        const aggregatedSuppliers = Object.values(supplierTotals)
            .sort((a, b) => b.totalQty - a.totalQty);

        // Split by region
        const americas = aggregatedSuppliers.filter(s => s.region === 'Americas');
        const europe = aggregatedSuppliers.filter(s => s.region === 'Europe');

        // Filter by minimum quantity if specified
        const americasMeetQty = minQty > 0 ? americas.filter(s => s.totalQty >= minQty) : americas;
        const europeMeetQty = minQty > 0 ? europe.filter(s => s.totalQty >= minQty) : europe;

        // Output results
        console.log('========================================');
        console.log('AMERICAS - IN-STOCK SUPPLIERS');
        console.log('========================================');
        if (americasMeetQty.length > 0) {
            console.log(`  Meeting qty >= ${minQty || 'any'}:`);
            americasMeetQty.slice(0, 10).forEach((s, i) => {
                const lineNote = s.lines > 1 ? ` (${s.lines} lines)` : '';
                console.log(`    ${i + 1}. ${s.name} - Qty: ${s.totalQty.toLocaleString()}${lineNote}`);
                if (s.parts.length > 0) {
                    s.parts.forEach(p => console.log(`       - ${p}`));
                }
            });
        } else {
            console.log(`  None with qty >= ${minQty}`);
            console.log(`  Largest available:`);
            americas.slice(0, 5).forEach((s, i) => {
                const lineNote = s.lines > 1 ? ` (${s.lines} lines)` : '';
                console.log(`    ${i + 1}. ${s.name} - Qty: ${s.totalQty.toLocaleString()}${lineNote}`);
            });
        }

        console.log('\n========================================');
        console.log('EUROPE - IN-STOCK SUPPLIERS');
        console.log('========================================');
        if (europeMeetQty.length > 0) {
            console.log(`  Meeting qty >= ${minQty || 'any'}:`);
            europeMeetQty.slice(0, 10).forEach((s, i) => {
                const lineNote = s.lines > 1 ? ` (${s.lines} lines)` : '';
                console.log(`    ${i + 1}. ${s.name} - Qty: ${s.totalQty.toLocaleString()}${lineNote}`);
                if (s.parts.length > 0) {
                    s.parts.forEach(p => console.log(`       - ${p}`));
                }
            });
        } else {
            console.log(`  None with qty >= ${minQty}`);
            console.log(`  Largest available:`);
            europe.slice(0, 5).forEach((s, i) => {
                const lineNote = s.lines > 1 ? ` (${s.lines} lines)` : '';
                console.log(`    ${i + 1}. ${s.name} - Qty: ${s.totalQty.toLocaleString()}${lineNote}`);
            });
        }

        console.log('\n========================================');
        console.log('SUMMARY');
        console.log('========================================');
        console.log(`  Americas suppliers: ${americas.length} (${americasMeetQty.length} meet qty)`);
        console.log(`  Europe suppliers:   ${europe.length} (${europeMeetQty.length} meet qty)`);
        console.log(`  Asia/Other:         Excluded`);
        console.log(`  Brokered:           ${brokeredSuppliers.length} (skipped)`);
        console.log(`  Franchised:         ${skippedFranchised.length} (skipped)`);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
