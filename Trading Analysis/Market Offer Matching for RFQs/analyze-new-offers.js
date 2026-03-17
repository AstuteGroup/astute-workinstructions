/**
 * Analyze New Offers Against RFQs
 *
 * Takes a freshly extracted offer CSV (from Market Offer Uploading) and matches
 * those MPNs against open RFQs in the database. No database import required.
 *
 * Usage:
 *   node analyze-new-offers.js <offer-csv-file>
 *   node analyze-new-offers.js ../Market\ Offer\ Uploading/output/OFFER_UPLOAD_20260317_Honeywell.csv
 *
 * Output:
 *   - Console summary of matches
 *   - CSV file: RFQ_Matches_<source>_<date>.csv
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const OUTPUT_DIR = __dirname;
const RFQ_LOOKBACK_DAYS = 180;
const MIN_OPPORTUNITY_VALUE = 500;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseCSV(content) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return { headers: [], rows: [] };

    // Simple CSV parsing (handles quoted fields)
    const parseLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    };

    const headers = parseLine(lines[0]);
    const rows = lines.slice(1).map(parseLine);

    return { headers, rows };
}

function runQuery(sql) {
    try {
        const result = execSync(`psql -t -A -F '|' -c "${sql.replace(/"/g, '\\"')}"`, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024
        });
        return result.trim();
    } catch (e) {
        log(`ERROR: Query failed: ${e.message}`);
        return null;
    }
}

function extractMPNsFromOfferCSV(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf8');
    const { headers, rows } = parseCSV(content);

    // Find MPN column (Chuboe_MPN)
    const mpnIdx = headers.findIndex(h =>
        h.toLowerCase().includes('chuboe_mpn') ||
        h.toLowerCase() === 'mpn'
    );

    if (mpnIdx === -1) {
        log('ERROR: Could not find MPN column in CSV');
        return [];
    }

    // Find other useful columns
    const qtyIdx = headers.findIndex(h => h.toLowerCase() === 'qty');
    const priceIdx = headers.findIndex(h =>
        h.toLowerCase() === 'priceentered' ||
        h.toLowerCase() === 'price'
    );
    const partnerIdx = headers.findIndex(h =>
        h.toLowerCase().includes('partner') ||
        h.toLowerCase().includes('business')
    );

    const offers = [];
    for (const row of rows) {
        const mpn = row[mpnIdx]?.trim();
        if (mpn) {
            offers.push({
                mpn: mpn,
                qty: qtyIdx >= 0 ? parseFloat(row[qtyIdx]) || 0 : 0,
                price: priceIdx >= 0 ? parseFloat(row[priceIdx]) || 0 : 0,
                partner: partnerIdx >= 0 ? row[partnerIdx]?.trim() : 'Unknown'
            });
        }
    }

    return offers;
}

function matchOffersToRFQs(offers) {
    if (offers.length === 0) {
        log('No offers to match');
        return [];
    }

    // Get unique MPNs
    const mpns = [...new Set(offers.map(o => o.mpn.toUpperCase()))];
    log(`Matching ${mpns.length} unique MPNs against RFQs...`);

    // Build MPN list for SQL
    const mpnList = mpns.map(m => `'${m.replace(/'/g, "''")}'`).join(',');

    const sql = `
        SELECT
            r.value as rfq_search_key,
            r.created as rfq_date,
            rt.name as rfq_type,
            bp.name as customer_name,
            bp.c_bpartner_id as customer_id,
            rl.chuboe_mpn as rfq_mpn,
            rl.qty as rfq_qty,
            rl.priceentered as rfq_target_price,
            u.name as salesperson
        FROM adempiere.chuboe_rfq r
        JOIN adempiere.chuboe_rfq_line rl ON r.chuboe_rfq_id = rl.chuboe_rfq_id
        LEFT JOIN adempiere.chuboe_rfq_type rt ON r.chuboe_rfq_type_id = rt.chuboe_rfq_type_id
        LEFT JOIN adempiere.c_bpartner bp ON r.c_bpartner_id = bp.c_bpartner_id
        LEFT JOIN adempiere.ad_user u ON r.salesrep_id = u.ad_user_id
        WHERE r.isactive = 'Y'
        AND rl.isactive = 'Y'
        AND r.created >= CURRENT_DATE - INTERVAL '${RFQ_LOOKBACK_DAYS} days'
        AND UPPER(rl.chuboe_mpn) IN (${mpnList})
        ORDER BY r.created DESC
    `;

    const result = runQuery(sql);
    if (!result) return [];

    // Parse results
    const rfqMatches = result.split('\n').filter(l => l.trim()).map(line => {
        const parts = line.split('|');
        return {
            rfq_search_key: parts[0],
            rfq_date: parts[1],
            rfq_type: parts[2],
            customer_name: parts[3],
            customer_id: parts[4],
            rfq_mpn: parts[5],
            rfq_qty: parseFloat(parts[6]) || 0,
            rfq_target_price: parseFloat(parts[7]) || 0,
            salesperson: parts[8]
        };
    });

    return rfqMatches;
}

function calculateOpportunities(offers, rfqMatches) {
    // Create offer lookup by MPN
    const offersByMPN = {};
    for (const offer of offers) {
        const key = offer.mpn.toUpperCase();
        if (!offersByMPN[key]) offersByMPN[key] = [];
        offersByMPN[key].push(offer);
    }

    const opportunities = [];

    for (const rfq of rfqMatches) {
        const key = rfq.rfq_mpn.toUpperCase();
        const matchingOffers = offersByMPN[key] || [];

        for (const offer of matchingOffers) {
            // Calculate coverage and value
            const coverage_pct = rfq.rfq_qty > 0
                ? Math.round((offer.qty / rfq.rfq_qty) * 100 * 10) / 10
                : 0;

            const valuation_price = offer.price > 0 ? offer.price
                : rfq.rfq_target_price > 0 ? rfq.rfq_target_price
                : 0;

            const est_value = offer.qty * valuation_price;

            // Determine tier
            let tier, tier_reason;
            if (est_value >= 5000 && coverage_pct >= 50) {
                tier = 'TIER_1';
                tier_reason = 'High value + good coverage';
            } else if (est_value >= 1000) {
                tier = 'TIER_2';
                tier_reason = 'Moderate value';
            } else {
                tier = 'TIER_3';
                tier_reason = 'Low value';
            }

            if (est_value >= MIN_OPPORTUNITY_VALUE) {
                opportunities.push({
                    tier,
                    tier_reason,
                    rfq_search_key: rfq.rfq_search_key,
                    rfq_date: rfq.rfq_date,
                    rfq_type: rfq.rfq_type,
                    customer_name: rfq.customer_name,
                    salesperson: rfq.salesperson,
                    rfq_mpn: rfq.rfq_mpn,
                    rfq_qty: rfq.rfq_qty,
                    rfq_target_price: rfq.rfq_target_price,
                    offer_partner: offer.partner,
                    offer_mpn: offer.mpn,
                    offer_qty: offer.qty,
                    offer_price: offer.price,
                    coverage_pct,
                    est_opportunity_value: Math.round(est_value * 100) / 100,
                    flag_low_coverage: coverage_pct < 20,
                    flag_no_pricing: valuation_price === 0
                });
            }
        }
    }

    // Sort by tier then value
    opportunities.sort((a, b) => {
        const tierOrder = { TIER_1: 1, TIER_2: 2, TIER_3: 3 };
        if (tierOrder[a.tier] !== tierOrder[b.tier]) {
            return tierOrder[a.tier] - tierOrder[b.tier];
        }
        return b.est_opportunity_value - a.est_opportunity_value;
    });

    return opportunities;
}

function writeOutputCSV(opportunities, sourceName) {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const outputFile = path.join(OUTPUT_DIR, `RFQ_Matches_${sourceName}_${dateStr}.csv`);

    const headers = [
        'tier', 'tier_reason', 'rfq_search_key', 'rfq_date', 'rfq_type',
        'customer_name', 'salesperson', 'rfq_mpn', 'rfq_qty', 'rfq_target_price',
        'offer_partner', 'offer_mpn', 'offer_qty', 'offer_price',
        'coverage_pct', 'est_opportunity_value', 'flag_low_coverage', 'flag_no_pricing'
    ];

    const rows = opportunities.map(o => headers.map(h => {
        const val = o[h];
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`;
        }
        return val ?? '';
    }).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(outputFile, csv);

    return outputFile;
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node analyze-new-offers.js <offer-csv-file>');
        console.log('');
        console.log('Example:');
        console.log('  node analyze-new-offers.js "../Market Offer Uploading/output/OFFER_UPLOAD_20260317_Honeywell.csv"');
        process.exit(1);
    }

    const csvPath = args[0];

    if (!fs.existsSync(csvPath)) {
        log(`ERROR: File not found: ${csvPath}`);
        process.exit(1);
    }

    log('='.repeat(60));
    log('Analyzing New Offers Against RFQs');
    log(`Source: ${csvPath}`);
    log('='.repeat(60));

    // Step 1: Extract MPNs from offer CSV
    log('Step 1: Extracting offers from CSV...');
    const offers = extractMPNsFromOfferCSV(csvPath);
    log(`  Found ${offers.length} offer lines`);

    if (offers.length === 0) {
        log('No offers found in CSV. Exiting.');
        return;
    }

    // Step 2: Match against RFQs in database
    log(`Step 2: Matching against RFQs (last ${RFQ_LOOKBACK_DAYS} days)...`);
    const rfqMatches = matchOffersToRFQs(offers);
    log(`  Found ${rfqMatches.length} RFQ line matches`);

    if (rfqMatches.length === 0) {
        log('No matching RFQs found. Analysis complete.');
        return;
    }

    // Step 3: Calculate opportunities
    log('Step 3: Calculating opportunities...');
    const opportunities = calculateOpportunities(offers, rfqMatches);
    log(`  ${opportunities.length} opportunities >= $${MIN_OPPORTUNITY_VALUE}`);

    // Step 4: Write output
    const sourceName = path.basename(csvPath, '.csv').replace(/^OFFER_UPLOAD_/, '');
    const outputFile = writeOutputCSV(opportunities, sourceName);
    log(`Step 4: Saved to ${path.basename(outputFile)}`);

    // Summary
    log('');
    log('='.repeat(60));
    log('SUMMARY');
    log('='.repeat(60));

    const tier1 = opportunities.filter(o => o.tier === 'TIER_1');
    const tier2 = opportunities.filter(o => o.tier === 'TIER_2');
    const tier3 = opportunities.filter(o => o.tier === 'TIER_3');

    const totalValue = opportunities.reduce((sum, o) => sum + o.est_opportunity_value, 0);

    log(`TIER_1 (High value + coverage): ${tier1.length} opportunities`);
    log(`TIER_2 (Moderate value):        ${tier2.length} opportunities`);
    log(`TIER_3 (Low value):             ${tier3.length} opportunities`);
    log(`Total estimated value:          $${totalValue.toLocaleString()}`);

    if (tier1.length > 0) {
        log('');
        log('TOP TIER_1 OPPORTUNITIES:');
        tier1.slice(0, 5).forEach((o, i) => {
            log(`  ${i + 1}. ${o.rfq_mpn} - ${o.customer_name} (RFQ ${o.rfq_search_key})`);
            log(`     Offer: ${o.offer_qty} pcs @ $${o.offer_price} from ${o.offer_partner}`);
            log(`     Est. Value: $${o.est_opportunity_value.toLocaleString()} | Coverage: ${o.coverage_pct}%`);
        });
    }

    log('');
    log('='.repeat(60));
}

main().catch(e => {
    log(`FATAL: ${e.message}`);
    process.exit(1);
});
